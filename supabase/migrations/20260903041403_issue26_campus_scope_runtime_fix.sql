create or replace function exam_delivery.staff_scope_options(p_actor_id uuid,p_request jsonb)
returns jsonb language plpgsql stable security definer set search_path='' set statement_timeout='5s' as $$
declare v_role text; v_org uuid; v_global boolean:=false;
begin
  if p_actor_id is null then return jsonb_build_object('ok',false,'code','invalid_request'); end if;
  select case
    when exists(select 1 from public.memberships where user_id=p_actor_id and status='active' and role='platform_owner') then 'platform_owner'
    when exists(select 1 from public.memberships where user_id=p_actor_id and status='active' and role='developer') then 'developer'
    when exists(select 1 from public.memberships where user_id=p_actor_id and status='active' and role='college_admin') then 'college_admin'
    when exists(select 1 from public.memberships where user_id=p_actor_id and status='active' and role='campus_admin') then 'campus_admin'
    when exists(select 1 from public.memberships where user_id=p_actor_id and status='active' and role='trainer') then 'trainer' end into v_role;
  if v_role is null then return jsonb_build_object('ok',false,'code','access_not_granted'); end if;
  v_global:=v_role in ('platform_owner','developer');
  begin v_org:=nullif(p_request->>'organisationId','')::uuid;
  exception when others then return jsonb_build_object('ok',false,'code','invalid_request'); end;
  if not v_global then
    select organisation_id into v_org from public.memberships
    where user_id=p_actor_id and status='active' and role=v_role order by created_at limit 1;
  elsif v_org is not null and not exists(select 1 from public.organisations where id=v_org and status='active') then
    return jsonb_build_object('ok',false,'code','scope_forbidden');
  end if;
  return jsonb_build_object('ok',true,'role',v_role,
    'locks',jsonb_build_object('organisation',not v_global,'campus',v_role='campus_admin' and
      (select count(distinct m.campus_id) from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role='campus_admin')=1),
    'selection',jsonb_build_object('organisationId',v_org,'campusId',case when v_role='campus_admin' and
      (select count(distinct m.campus_id) from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role='campus_admin')=1 then
      (select m.campus_id from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role='campus_admin'
       order by m.created_at,m.id limit 1) end),
    'organisations',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'name',o.name) order by o.name,o.id)
      from public.organisations o where o.status='active' and (v_global or o.id=v_org)),'[]'::jsonb),
    'campuses',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name) order by c.name,c.id)
      from public.campuses c where c.status='active' and c.organisation_id=v_org
        and (v_role<>'campus_admin' or exists(select 1 from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role='campus_admin' and m.campus_id=c.id))),'[]'::jsonb),
    'groups',coalesce((select jsonb_agg(jsonb_build_object('id',g.id,'name',g.name,'campusId',g.campus_id) order by g.name,g.id)
      from public.groups g where g.status='active' and g.organisation_id=v_org
        and (v_role<>'trainer' or exists(select 1 from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role='trainer' and m.group_id=g.id))),'[]'::jsonb),
    'assignments',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'name',a.title,'organisationId',a.organisation_id,
      'campusId',a.campus_id,'groupId',a.group_id,'examKey',exam_delivery.normalize_exam_key(a.exam_key),'status',a.status) order by a.title,a.id)
      from public.exam_assignments a where a.status<>'archived' and a.organisation_id=v_org
        and (v_role<>'campus_admin' or exists(select 1 from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role='campus_admin' and m.campus_id=a.campus_id))
        and (v_role<>'trainer' or exists(select 1 from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role='trainer' and m.group_id=a.group_id))),'[]'::jsonb),
    'exams',coalesce((select jsonb_agg(jsonb_build_object('id',exam_key,'name',exam_key) order by exam_key) from
      (select distinct exam_delivery.normalize_exam_key(a.exam_key) exam_key from public.exam_assignments a where a.status<>'archived' and a.organisation_id=v_org
        and (v_role<>'campus_admin' or exists(select 1 from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role='campus_admin' and m.campus_id=a.campus_id))
        and (v_role<>'trainer' or exists(select 1 from public.memberships m where m.user_id=p_actor_id and m.status='active' and m.role='trainer' and m.group_id=a.group_id))) e),'[]'::jsonb)
  );
end $$;

alter function exam_delivery.staff_scope_options(uuid,jsonb) owner to postgres;
revoke execute on function exam_delivery.staff_scope_options(uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function exam_delivery.staff_scope_options(uuid,jsonb) to service_role;
