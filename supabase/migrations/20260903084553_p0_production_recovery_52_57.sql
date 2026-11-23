-- P0 production recovery: restore the exact invoker chain required by the
-- protected flag/report wrappers. Browser roles retain no direct access.
revoke execute on function exam_delivery.list_flags(uuid,uuid),
  exam_delivery.set_flag(uuid,uuid,uuid,boolean,uuid),
  exam_delivery.report_question_issue(uuid,uuid,uuid,text,uuid)
  from public,anon,authenticated,service_role;
grant execute on function exam_delivery.list_flags(uuid,uuid),
  exam_delivery.set_flag(uuid,uuid,uuid,boolean,uuid),
  exam_delivery.report_question_issue(uuid,uuid,uuid,text,uuid)
  to service_role;

-- Self-directed assessment review is released only after the server has
-- atomically completed and scored the attempt. Assigned assessments remain
-- governed by their assignment-specific release contract.
update exam_delivery.practice_policies
set review_release_policy='after_submission',
    answer_release_policy='after_submission',
    updated_at=statement_timestamp()
where purpose='self_directed_exam'
  and enabled
  and (review_release_policy,answer_release_policy) is distinct from
      ('after_submission','after_submission');

-- Review payloads were captured immutably at submission even while the policy
-- was incorrect. Advance only completed, self-directed, currently authorized
-- snapshots through the existing one-way withheld -> released transition.
update exam_delivery.review_snapshots rs
set release_status='released',released_at=statement_timestamp()
from exam_delivery.attempts a
join exam_delivery.package_versions pv on pv.id=a.package_version_id
join exam_delivery.package_profiles pp on pp.id=a.package_profile_id
join exam_delivery.practice_policies p
  on p.canonical_exam_key=exam_delivery.normalize_exam_key(pv.exam_key)
 and p.package_version=pv.package_version
 and p.profile_key=pp.profile_key
 and p.purpose=a.purpose
where rs.attempt_id=a.id
  and rs.release_status='withheld'
  and a.status='completed'
  and a.purpose='self_directed_exam'
  and p.enabled
  and p.review_release_policy='after_submission'
  and p.answer_release_policy='after_submission';

update public.exam_reports er
set report_snapshot=jsonb_set(er.report_snapshot,'{reviewStatus}','"released"'::jsonb,true)
from exam_delivery.attempts a
join exam_delivery.review_snapshots rs on rs.attempt_id=a.id
where er.attempt_id=a.id
  and er.report_type='study_report_snapshot'
  and a.status='completed'
  and a.purpose='self_directed_exam'
  and rs.release_status='released'
  and er.report_snapshot->>'reviewStatus' is distinct from 'released';
