-- Expose the trusted result-authority marker consistently with protected
-- history and printable summaries. The value comes only from the constrained
-- server_authoritative result row and is never accepted from learner input.
create or replace function exam_delivery.get_result(p_actor_id uuid, p_attempt_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
set statement_timeout = '15s'
as $$
  select coalesce(
    (
      select jsonb_build_object(
        'ok', true,
        'result', ar.result_summary || jsonb_build_object(
          'attemptId', a.id,
          'examKey', pv.exam_key,
          'profileKey', pp.profile_key,
          'completedAt', ar.completed_at,
          'domainBreakdown', ar.domain_summary,
          'reviewStatus', rs.release_status,
          'serverAuthoritative', ar.server_authoritative
        )
      )
      from exam_delivery.attempts a
      join exam_delivery.package_versions pv on pv.id = a.package_version_id
      join exam_delivery.package_profiles pp on pp.id = a.package_profile_id
      join exam_delivery.attempt_results ar on ar.attempt_id = a.id
      join exam_delivery.review_snapshots rs on rs.attempt_id = a.id
      where a.id = p_attempt_id
        and a.owner_id = p_actor_id
        and a.status = 'completed'
        and ar.server_authoritative = true
    ),
    jsonb_build_object('ok', false, 'code', 'attempt_not_found')
  )
$$;

alter function exam_delivery.get_result(uuid, uuid) owner to postgres;
revoke execute on function exam_delivery.get_result(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function exam_delivery.get_result(uuid, uuid) to service_role;
