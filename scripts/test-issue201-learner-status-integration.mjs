import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { normalizeCompletionStatus, normalizePendingCompletionPage } from '../src/lib/protectedCompletionStatus.js';

// Invoked only by the existing signed loopback bridge/provider-sim fixture.
// No source of successful grading evidence exists in this driver.
export async function runLearnerStatusAcceptance(ctx) {
  const { sql, json, eq, rpc, pkg: template, organisation, administrator, newBridge, next, cursor, finish, arm, held, counters } = ctx;
  const api = process.env.SUPABASE_URL, service = process.env.SUPABASE_SERVICE_ROLE_KEY, anon = process.env.SUPABASE_ANON_KEY;
  const ui = process.env.ISSUE201_STATUS_UI_URL ?? 'http://127.0.0.1:4179';
  for (const value of [api, ui]) if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(value).hostname)) throw Error('DISPOSABLE_LOOPBACK_REQUIRED');
  const quote = (v) => "'" + String(v).replaceAll("'", "''") + "'";
  const js = (v) => quote(JSON.stringify(v)) + '::jsonb';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function bounded(promise, label, timeoutMs = 20000) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('UI_DRIVER_TIMEOUT_' + label)), timeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
  const metadata = {};
  function seed(kind, examKey = 'pythonnextgeneration') {
    const p = randomUUID(), profile = randomUUID(), form = randomUUID();
    const packageHash = createHash('sha256').update('synthetic-learner-status|' + p).digest('hex');
    const profileKey = kind === 'lab' ? 'pythonnextgeneration-lab' : examKey === 'pythonnextgeneration' ? 'pythonnextgeneration-no-lab' : 'synthetic-status';
    const count = kind === 'lab' ? 9 : 2;
    const starter = { interactionVersion: 'executable-python-lab-v1', task: 'Synthetic Python task',
      instructions: ['Save the synthetic workspace.'], allowedFilenames: ['main.py'],
      starterWorkspace: { entryPoint: 'main.py', files: [{ path: 'main.py', content: 'def sample():\n    pass # LEARNER_SOURCE_SENTINEL\n' }] } };
    sql(`insert into exam_delivery.package_versions(id,exam_key,package_version,source_commit_sha,validation_hash,package_hash,package_schema_version,generator_version,scorer_version,status,declared_review_release_policy,declared_answer_release_policy)
      select '${p}',${quote(examKey)},${quote(kind === 'lab' ? '1.0.0' : '2.0.0')},source_commit_sha,validation_hash,${quote(packageHash)},package_schema_version,generator_version,scorer_version,'draft','never','never' from exam_delivery.package_versions where id='${template}';
      insert into exam_delivery.package_profiles(id,package_version_id,profile_key,display_name,question_count,time_limit_minutes,selection_config)
      values('${profile}','${p}',${quote(profileKey)},'Synthetic ${kind}',${count},1,'{}');
      insert into exam_delivery.package_questions(id,package_version_id,question_id,question_type,domain_key,section_key,source_ordinal,presentation_payload,content_hash)
      select gen_random_uuid(),'${p}',question_id,question_type,domain_key,'standard',source_ordinal,
        case when question_type='executable-python-lab-v1' then ${js(starter)} else presentation_payload end,content_hash
      from exam_delivery.package_questions where package_version_id='${template}' ${kind === 'lab' ? '' : "and question_type<>'executable-python-lab-v1'"};
      insert into exam_delivery.package_question_protected_content(question_id,package_version_id,scoring_payload,review_payload,authoring_metadata)
      select n.id,'${p}',c.scoring_payload,c.review_payload,c.authoring_metadata
      from exam_delivery.package_questions n join exam_delivery.package_questions old on old.question_id=n.question_id and old.package_version_id='${template}'
      join exam_delivery.package_question_protected_content c on c.question_id=old.id where n.package_version_id='${p}';
      insert into exam_delivery.package_forms(id,package_version_id,package_profile_id,form_key,form_ordinal,question_count,membership_hash,blueprint_contract)
      values('${form}','${p}','${profile}','a',1,${count},repeat('e',64),'{}');
      insert into exam_delivery.package_form_questions(form_id,package_profile_id,package_version_id,package_question_id,presentation_ordinal)
      select '${form}','${profile}','${p}',id,row_number() over(order by source_ordinal)::integer from exam_delivery.package_questions where package_version_id='${p}';
      update exam_delivery.package_versions set status='published',published_at=clock_timestamp() where id='${p}';
      insert into public.exam_catalog(exam_key,slug,title,lifecycle,exam_type,current_version,status)
      values(${quote(examKey)},${quote(examKey + '-learner-status')},'Synthetic learner status','production_ready','certification',${quote(kind === 'lab' ? '1.0.0' : '2.0.0')},'active') on conflict(exam_key) do nothing;
      insert into exam_delivery.exam_access_policies(canonical_exam_key,access_mode,enabled,enabled_at)
      values(${quote(examKey)},'open_authenticated',true,now()) on conflict(canonical_exam_key) do update set access_mode='open_authenticated',enabled=true,enabled_at=now();
      insert into exam_delivery.exam_profile_activations(package_version_id,package_profile_id,enabled,activation_kind,enabled_at,created_by)
      values('${p}','${profile}',true,'production',now(),'${administrator}');
      insert into exam_delivery.package_profile_defaults(canonical_exam_key,profile_key,purpose,package_version_id,package_profile_id,configured_by)
      values(${quote(examKey)},${quote(profileKey)},'self_directed_exam','${p}','${profile}','${administrator}');
      insert into exam_delivery.practice_policies(canonical_exam_key,package_version,profile_key,purpose,access_mode,enabled,maximum_session_items,immediate_feedback,review_release_policy,answer_release_policy)
      values(${quote(examKey)},${quote(kind === 'lab' ? '1.0.0' : '2.0.0')},${quote(profileKey)},'self_directed_exam','open_authenticated',true,10,false,'never','never');`);
    return { pkg: p, profile, profileKey, examKey, count, kind };
  }
  metadata.lab = seed('lab'); metadata.standard = seed('no-lab');
  metadata.other = seed('no-lab', 'issue201other');
  console.log('LEARNER_STATUS_SYNTHETIC_SEED=PASS');
  sql(`create function public.issue201_status_fixture_clock() returns trigger language plpgsql as $$begin
    if new.package_version_id in ('${metadata.lab.pkg}'::uuid,'${metadata.standard.pkg}'::uuid,'${metadata.other.pkg}'::uuid)
    then new.expires_at=clock_timestamp()+interval '12 seconds';end if;return new;end$$;
    create trigger issue201_status_fixture_clock before insert on exam_delivery.attempts for each row execute function public.issue201_status_fixture_clock();`);
  const headers = (token) => ({ apikey: anon, Authorization: 'Bearer ' + token });
  async function account(role = 'student') {
    const email = 'learner-status-' + randomUUID() + '@example.invalid', password = randomUUID();
    const response = await fetch(api + '/auth/v1/admin/users', { method: 'POST',
      headers: { apikey: service, Authorization: 'Bearer ' + service, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, email_confirm: true }) });
    eq(response.ok, true, 'synthetic Auth user created');
    const actor = await response.json();
    sql(`update public.profiles set status='active' where id='${actor.id}';
      insert into public.memberships(user_id,organisation_id,role,status) values('${actor.id}','${organisation}',${quote(role)},'active');`);
    const login = async () => {
      const r = await fetch(api + '/auth/v1/token?grant_type=password', { method: 'POST',
        headers: { apikey: anon, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
      eq(r.ok, true, 'synthetic signed login'); const session = await r.json();
      eq(Boolean(session.access_token && session.user?.id === actor.id), true, 'verified Auth session identity');
      if (process.env.GITHUB_ACTIONS) for (const token of [session.access_token, session.refresh_token]) {
        if (token) process.stdout.write('::add-mask::' + token + '\n');
      }
      return session;
    };
    return { id: actor.id, login, session: await login() };
  }
  const actor = await account(), otherActor = await account(), ownerActor = await account('platform_owner'), trainer = await account('trainer');
  async function edge(path, token = actor.session.access_token) {
    const response = await fetch(api + '/functions/v1/certsim-protected-exam' + path, {
      headers: { ...headers(token), Origin: ui }, cache: 'no-store', signal: AbortSignal.timeout(15000) });
    const body = await response.json();
    eq(response.headers.get('cache-control')?.includes('no-store'), true, 'private response no-store');
    return { code: response.status, body };
  }
  const availabilityQuery = '/practice/availability?' + new URLSearchParams({ examKey: metadata.standard.examKey, profileId: metadata.standard.profileKey, purpose: 'self_directed_exam', count: '2', includePbqs: 'true', mixStrategy: 'balanced' });
  eq((await edge(availabilityQuery)).code, 403, 'ordinary student without entitlement remains denied');
  // The existing Edge aliases access_not_granted to not_allowlisted. Use the
  // established learner entitlement, not a pilot allowlist or staff bypass.
  for (const who of [actor, otherActor]) for (const fixture of Object.values(metadata)) {
    sql(`insert into exam_delivery.exam_entitlements(package_version_id,package_profile_id,target_type,learner_id,enabled,valid_from,reason_code,created_by)
      values('${fixture.pkg}','${fixture.profile}','learner','${who.id}',true,now(),'synthetic_acceptance','${administrator}')`);
  }
  eq((await edge(availabilityQuery)).code, 200, 'entitled ordinary learner uses normal availability');
  const read = async (attemptId, who = actor) => {
    const response = await edge('/attempts/' + attemptId + '/completion-status', who.session.access_token);
    eq(response.code, 200, 'actual authenticated Edge status');
    return normalizeCompletionStatus(response.body.status, attemptId);
  };
  const list = async (who = actor, query = '') => {
    const response = await edge('/completion-status/pending?pageSize=1' + query, who.session.access_token);
    eq(response.code, 200, 'actual authenticated Edge pending page');
    return normalizePendingCompletionPage(response.body);
  };
  function fingerprint() {
    const tables = json("select jsonb_agg(tablename order by tablename) from pg_tables where schemaname='exam_delivery'");
    return tables.map((name) => {
      if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw Error('FIXTURE_TABLE_NAME');
      return name + ':' + sql('select md5(coalesce(jsonb_agg(row_value order by row_value::text)::text,\'[]\')) from (select to_jsonb(t) row_value from exam_delivery.' + name + ' t) rows');
    }).join('|') + '|' + sql("select md5(coalesce(jsonb_agg(t order by t::text)::text,'[]')) from (select to_jsonb(a) t from public.exam_attempts a union all select to_jsonb(r) from public.exam_results r union all select to_jsonb(p) from public.exam_reports p) source");
  }
  const preflight = await edge('/completion-status/pending?pageSize=1');
  console.log(JSON.stringify({ stage: 'pending-contract-preflight', status: preflight.code, code: preflight.body.error?.code ?? 'ok' }));
  if (preflight.code !== 200) json(`set role service_role;select public.certsim_protected_list_pending_completions('${actor.id}')`);
  eq(preflight.code, 200, 'actual pending contract before UI mount');
  normalizePendingCompletionPage(preflight.body);
  const browser = await chromium.launch({ headless: true });
  let page, context, browserCounts = { mutations: 0, submits: 0, resumes: 0, workerCalls: 0, reads: 0 }, blocked = 0;
  let requestFailures = 0, scriptErrors = 0;
  const httpOutcomes = [];
  async function fresh(session, kind, view = 'runner') {
    await context?.close();
    context = await browser.newContext();
    page = await context.newPage();
    page.on('pageerror', () => { scriptErrors++; });
    page.on('requestfailed', () => { requestFailures++; });
    page.on('response', async (response) => {
      const path = new URL(response.url()).pathname;
      if (!path.includes('/certsim-protected-exam/') || httpOutcomes.length >= 20) return;
      const operation = path.includes('completion-status') ? 'status' : path.endsWith('current-bindings') ? 'discovery' : path.endsWith('availability') ? 'availability' : 'other';
      let code = null;
      if (response.status() >= 400) {
        const body = await response.json().catch(() => null);
        if (/^[a-z_]{1,64}$/.test(body?.error?.code ?? '')) code = body.error.code;
      }
      httpOutcomes.push({ operation, status: response.status(), code });
    });
    await page.route('**/*', (route) => {
      if (['127.0.0.1', 'localhost', '[::1]'].includes(new URL(route.request().url()).hostname)) return route.continue();
      blocked++; return route.abort('blockedbyclient');
    });
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (!url.pathname.includes('/functions/v1/')) return;
      if (!url.pathname.includes('/certsim-protected-exam/')) browserCounts.workerCalls++;
      if (request.method() !== 'GET' && request.method() !== 'OPTIONS') browserCounts.mutations++;
      if (url.pathname.endsWith('/submit')) browserCounts.submits++;
      if (/\/certsim-protected-exam\/attempts\/[0-9a-f-]+$/.test(url.pathname)) browserCounts.resumes++;
      if (url.pathname.includes('/completion-status')) browserCounts.reads++;
    });
    await page.goto(ui + '/tests/r3g/issue201-learner-status-harness.html');
    await page.waitForFunction(() => typeof window.__mountLearnerStatusFixture === 'function');
    await page.evaluate((config) => window.__mountLearnerStatusFixture(config), { session, kind, view, count: kind === 'lab' ? 9 : 2 });
  }
  async function visible(role, name, label, timeout = 20000) {
    const target = role === 'status' ? page.getByRole('status').filter({ hasText: name }) : page.getByRole(role, { name });
    try { await target.first().waitFor({ state: 'visible', timeout }); }
    catch {
      console.log(JSON.stringify({ stage: 'visible-assertion', label, httpOutcomes, requestFailures, scriptErrors, blocked }));
      throw Error('UI_ASSERTION_FAILED_' + label);
    }
    eq(true, true, label);
  }
  async function pendingThenComplete(kind) {
    const fixture = kind === 'lab' ? metadata.lab : metadata.standard;
    await fresh(await actor.login(), kind);
    try { await page.getByRole('button', { name: /Start exam/i }).click({ timeout: 20000 }); }
    catch {
      console.log(JSON.stringify({ stage: 'normal-start-action', httpOutcomes, requestFailures, scriptErrors, blocked }));
      throw Error('UI_ASSERTION_FAILED_normal_start_action');
    }
    await visible('region', /Python exam workspace/i, 'normal real runner opened');
    const attemptId = sql(`select id from exam_delivery.attempts where owner_id='${actor.id}' and package_version_id='${fixture.pkg}' order by started_at desc,id desc limit 1`);
    eq(Boolean(attemptId), true, 'normal synthetic managed attempt created');
    const initial = await read(attemptId);
    eq(initial.expiryManaged, true, 'future-only authority positively identified');
    eq(initial.state, 'active', 'server answering authority');
    if (kind === 'lab') {
      await page.getByRole('button', { name: 'Save code', exact: true }).click();
      await visible('status', /Revision 1/, 'real workspace acknowledged before deadline');
    } else {
      // Pass through to the real Edge/SQL save, then hold only its already
      // committed acknowledgment across the deadline. This is not a fake lifecycle.
      let acknowledged;
      const accepted = new Promise((resolve) => { acknowledged = resolve; });
      await page.route('**/functions/v1/certsim-protected-exam/attempts/' + attemptId + '/items/*/response', async (route) => {
        const response = await route.fetch();
        eq(response.ok(), true, 'real save accepted before deadline');
        acknowledged();
        await sleep(Math.max(0, Date.parse(initial.deadline) - Date.now()) + 350);
        await route.fulfill({ response });
      });
      await page.locator('input[type=checkbox]').first().check();
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      await bounded(accepted, 'real_save_acknowledgment');
      eq(sql(`select count(*) from exam_delivery.attempt_responses where attempt_id='${attemptId}'`), '1', 'current-item navigation save persisted');
    }
    await visible('heading', 'Time expired', 'real deadline locks runner', 25000);
    eq(await page.locator('input[type=checkbox],.cm-editor').count(), 0, 'answering/editor removed');
    if (kind !== 'lab') {
      await sleep(500);
      eq(await page.locator('input[type=checkbox]').count(), 0, 'late actual save acknowledgment cannot restore editing');
    }
    await sleep(Math.max(0, Date.parse(initial.deadline) - Date.now()) + 100);
    const pending = await read(attemptId);
    eq(pending.state, 'awaiting_processing', 'paused driver leaves honest pending');
    eq((await list(actor)).items.some((item) => item.attemptId === attemptId), true, 'actual owner list contains this expired managed attempt');
    const before = fingerprint(), providerBefore = counters();
    await read(attemptId); await list(actor);
    eq(fingerprint(), before, 'actual SQL and Edge status/list mutate no exam/provider state');
    eq(counters(), providerBefore, 'status does not invoke provider or cleanup');
    const beforeBrowser = { ...browserCounts };
    await fresh(await actor.login(), kind, 'history');
    await visible('heading', 'Pending work', 'fresh login opens separate pending history');
    await visible('status', 'Your saved work is awaiting marking.', 'same attempt rediscovered after unmount');
    eq(browserCounts.mutations, beforeBrowser.mutations, 'fresh history causes zero exam writes');
    eq(browserCounts.resumes, beforeBrowser.resumes, 'fresh history does not resume');
    eq(browserCounts.submits, 0, 'browser never submits expired managed work');
    eq(browserCounts.workerCalls, 0, 'browser never calls internal worker');
    // Only the explicitly authorized driver now invokes the existing worker.
    if (kind === 'lab') {
      sql('select exam_delivery.set_python_worker_dispatch(true)');
      await newBridge();
      cursor(); await finish({ id: attemptId });
      eq(Number(sql(`select count(*) from exam_delivery.python_grading_evidence e join exam_delivery.python_execution_runs r on r.id=e.run_id where r.attempt_id='${attemptId}'`)) > 0, true, 'real worker retained verified Lab evidence');
      eq(counters().creates > providerBefore.creates, true, 'signed real bridge used simulated provider substrate');
    } else {
      sql('select exam_delivery.set_expiry_worker(true)');
      for (let n = 0; n < 4 && sql(`select count(*) from exam_delivery.attempt_results where attempt_id='${attemptId}'`) === '0'; n++) {
        const r = await fetch(api + '/functions/v1/certsim-expiry-worker', { method: 'POST', headers: { apikey: service }, signal: AbortSignal.timeout(120000) });
        eq(r.ok, true, 'separate driver invokes actual internal Edge worker');
      }
    }
    const completed = await read(attemptId);
    eq(completed.state, 'completed', 'status waits for actual authoritative result');
    eq(Date.parse(completed.completedAt) >= Date.parse(completed.deadline), true, 'actual completion and deadline preserved separately');
    await page.getByRole('button', { name: 'Refresh pending status' }).click();
    try { await page.waitForFunction((expected) => document.querySelectorAll('.saved-result-item').length === expected, kind === 'lab' ? 2 : 1, { timeout: 15000 }); } catch { throw Error('UI_ASSERTION_FAILED_completed_history_handoff'); }
    eq(await page.locator('.saved-result-item').count(), kind === 'lab' ? 2 : 1, 'completed history counts each actual result once');
    eq(await page.getByText('Your saved work is awaiting marking.', { exact: true }).count(), 0, 'pending retired only after result/history handoff');
    eq(sql(`select count(*) from exam_delivery.attempt_results where attempt_id='${attemptId}'`), '1', 'one authoritative result');
    const resultRead = await edge('/attempts/' + attemptId + '/result');
    eq(resultRead.body.result?.serverAuthoritative, true, 'existing result authority marker');
    const reviewRead = await edge('/attempts/' + attemptId + '/review');
    eq(reviewRead.code, 403, 'frozen withheld review retained');
    return attemptId;
  }
  try {
    // Worker/capability/fencing gates only inside this disposable fixture.
    sql('select exam_delivery.set_expiry_worker(false);select exam_delivery.set_python_worker_dispatch(false)');
    const standardAttempt = await pendingThenComplete('no-lab');
    console.log('LEARNER_STATUS_NON_EXECUTABLE_HANDOFF=PASS');
    sql('select exam_delivery.set_python_worker_dispatch(false)');
    const labAttempt = await pendingThenComplete('lab');
    console.log('LEARNER_STATUS_SIGNED_LAB_HANDOFF=PASS');
    // Complete results/status remain strictly owner scoped, even for Platform Owner.
    for (const who of [otherActor, ownerActor, trainer]) {
      eq((await edge('/attempts/' + labAttempt + '/completion-status', who.session.access_token)).code, 404, 'cross-owner status denied');
      const own = await list(who); eq(own.items.length, 0, 'cross-owner pending discovery empty');
    }
    eq((await edge('/attempts/' + labAttempt + '/completion-status', anon)).code, 401, 'anonymous status denied');
    eq((await edge('/completion-status/pending?pageSize=21')).code, 400, 'strict Edge page bound');
    eq((await edge('/completion-status/pending?ownerId=' + otherActor.id)).code, 400, 'caller owner parameter denied');
    for (const role of ['anon', 'authenticated']) {
      eq(sql(`select has_function_privilege('${role}','public.certsim_protected_get_completion_status(uuid,uuid)','execute')`), 'f', 'untrusted direct status RPC denied');
      eq(sql(`select has_function_privilege('${role}','public.certsim_protected_list_pending_completions(uuid,text,text,text,uuid,text,integer,uuid[])','execute')`), 'f', 'untrusted pending RPC denied');
    }
    const before = fingerprint();
    for (let n = 0; n < 6; n++) { await read(standardAttempt); await read(labAttempt); await list(actor); }
    eq(fingerprint(), before, 'repeated actual status/list reads do not change activity, deadline, jobs, admission, audit or results');
    const statusBytes = JSON.stringify([await read(standardAttempt), await read(labAttempt), await list(actor)]);
    for (const sentinel of ['SENSITIVE_SENTINEL', 'LEARNER_SOURCE_SENTINEL', 'leaseToken', 'submissionId', 'executionId', 'providerId', 'gradingMaterial', 'receipt']) eq(statusBytes.includes(sentinel), false, 'sensitive sentinel absent from status DTO');
    // Durable manual freeze before deadline is pending, not permission to resume
    // or manufacture the lost browser submission identity after a cold remount.
    async function createAttempt(who, fixture) {
      const r = await fetch(api + '/functions/v1/certsim-protected-exam/practice/sessions', { method: 'POST',
        headers: { ...headers(who.session.access_token), Origin: ui, 'content-type': 'application/json' },
        body: JSON.stringify({ examKey: fixture.examKey, profileId: fixture.profileKey, purpose: 'self_directed_exam',
          count: fixture.count, includePbqs: true, mixStrategy: 'balanced', clientRequestId: randomUUID() }) });
      eq(r.status, 201, 'normal authenticated synthetic start'); const payload = await r.json();
      return { id: payload.attempt.attemptId, items: payload.items };
    }
    async function due(id) {
      const remaining = Number(sql(`select greatest(0,extract(epoch from expires_at-clock_timestamp())) from exam_delivery.attempts where id='${id}'`));
      await sleep(Math.ceil(remaining * 1000) + 50);
    }
    function claim(id) {
      const c = json(`set role service_role;select exam_delivery.claim_expiry('${id}')`);
      eq(c.ok, true, 'fixed foundation claim'); return c;
    }
    function finalize(id, c) {
      const r = json(`set role service_role;select exam_delivery.finalize_expiry('${id}','${c.leaseToken}')`);
      eq(r.ok, true, 'real foundation finalization'); return r;
    }
    const manual = await createAttempt(actor, metadata.standard), originalSubmission = randomUUID();
    const prepared = await rpc('certsim_service_prepare_python_submission_grading',
      { p_actor_id: actor.id, p_attempt_id: manual.id, p_submission_id: originalSubmission });
    eq(prepared.ok, true, 'timely manual preparation freezes original identity');
    const frozen = await read(manual.id);
    eq(Date.parse(frozen.deadline) > Date.parse(frozen.observedAt), true, 'manual freeze observed before original deadline');
    eq(frozen.closureReason, 'manual_submission', 'safe durable manual closure reason');
    eq(frozen.answeringAllowed, false, 'manual freeze does not reopen answering before deadline');
    eq(frozen.state, 'awaiting_processing', 'old grading session alone is not active processing proof');
    const frozenBefore = fingerprint();
    await fresh(await actor.login(), 'no-lab');
    await visible('heading', 'Submission pending', 'cold remount is read-only without lost manual ID');
    eq(await page.getByRole('button', { name: 'Continue submission', exact: true }).count(), 0, 'cold remount gains no Submit authority');
    eq(fingerprint(), frozenBefore, 'cold remount does not resume, save, reconcile or replace manual work');
    eq(sql(`select submission_id from exam_delivery.expiry_bindings where attempt_id='${manual.id}'`), originalSubmission, 'original manual identity preserved');
    const completedManual = json(`set role service_role;select public.certsim_protected_submit_attempt('${actor.id}','${manual.id}','${originalSubmission}')`);
    eq(completedManual.ok, true, 'existing same-ID manual completion remains compatible');

    // Two normal synthetic exam contexts prove keyset completion transitions.
    const first = await createAttempt(otherActor, metadata.standard), second = await createAttempt(otherActor, metadata.other);
    await due(second.id);
    const paged = await list(otherActor);
    eq(paged.items.length, 1, 'strict pending page size');
    eq(Boolean(paged.nextCursor), true, 'bounded keyset pagination');
    const firstId = paged.items[0].attemptId;
    const live = claim(firstId);
    eq((await read(firstId, otherActor)).state, 'processing', 'live processing lease is affirmative processing proof');
    const activeBefore = fingerprint();
    await read(firstId, otherActor); await list(otherActor);
    eq(fingerprint(), activeBefore, 'status does not renew a live processing lease or acquire attempt locks');
    finalize(firstId, live);
    const transition = await edge('/completion-status/pending?pageSize=1&cursor=' + encodeURIComponent(paged.nextCursor) + '&watch=' + firstId, otherActor.session.access_token);
    eq(transition.code, 200, 'actual HTTP status/list transition during pagination');
    const nextPage = normalizePendingCompletionPage(transition.body, [firstId]);
    eq(nextPage.watched[0].state, 'completed', 'bounded watch set retains completion after it leaves pending page');
    eq(nextPage.items.length, 1, 'next pending page not lost during concurrent completion');
    const remainingId = nextPage.items[0].attemptId;
    finalize(remainingId, claim(remainingId));
    for (const attempt of [first, second]) eq(sql(`select count(*) from exam_delivery.attempt_results where attempt_id='${attempt.id}'`), '1', 'pagination does not duplicate results');
    sql('set enable_seqscan=off');
    const indexPlan = sql(`set enable_seqscan=off;explain select attempt_id,deadline from exam_delivery.expiry_authority where owner_id='${actor.id}' order by deadline desc,attempt_id desc limit 65`);
    eq(indexPlan.includes('expiry_authority_owner_status_page'), true, 'bounded owner/deadline index supports discovery');
    eq(sql("select provolatile from pg_proc where oid='public.certsim_protected_get_completion_status(uuid,uuid)'::regprocedure"), 's', 'status wrapper declares stable reads');
    eq(sql("select 'statement_timeout=3s'=any(proconfig) from pg_proc where oid='public.certsim_protected_list_pending_completions(uuid,text,text,text,uuid,text,integer,uuid[])'::regprocedure"), 't', 'finite public RPC statement timeout');
    // Own Platform Owner access is allowed; cross-student access remains denied.
    const owned = await createAttempt(ownerActor, metadata.standard);
    eq((await read(owned.id, ownerActor)).state, 'active', 'Platform Owner reads own status only');
    const abandoned = await fetch(api + '/functions/v1/certsim-protected-exam/attempts/' + owned.id + '/abandon', { method: 'POST',
      headers: { ...headers(ownerActor.session.access_token), Origin: ui, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID() }) });
    eq(abandoned.ok, true, 'deliberate abandon retains existing operation');
    eq((await read(owned.id, ownerActor)).state, 'closed', 'abandoned work is not pending or completed');
    // Unknown provider state must retain admission. Inspection has no recovery power.
    const unknown = await createAttempt(otherActor, metadata.lab);
    const task = unknown.items.find((item) => item.questionType === 'executable-python-lab-v1');
    const saved = await fetch(api + '/functions/v1/certsim-protected-exam/attempts/' + unknown.id + '/items/' + task.itemId + '/python/workspace', {
      method: 'PUT', headers: { ...headers(otherActor.session.access_token), Origin: ui, 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: { entryPoint: 'main.py', files: [{ path: 'main.py', content: 'def sample():\n    pass\n' }] }, expectedRevision: 0, requestId: randomUUID() }) });
    eq(saved.ok, true, 'normal saved Lab workspace for blocked recovery case');
    await due(unknown.id); await newBridge(); arm('lost_create'); cursor();
    eq((await next()).state, 'recovery_blocked', 'actual unknown provider transport retains admission');
    eq(held() !== 'none', true, 'admission remains held');
    eq((await read(unknown.id, otherActor)).state, 'needs_attention', 'durable recovery block is attention, not a fabricated zero');
    sql('select exam_delivery.set_python_worker_dispatch(false)');
    const heldBefore = fingerprint(), heldProvider = counters(), heldIdentity = held();
    for (let n = 0; n < 3; n++) { await read(unknown.id, otherActor); await list(otherActor); }
    eq(fingerprint(), heldBefore, 'held-admission status reads perform no lifecycle or recovery writes');
    eq(counters(), heldProvider, 'held-admission status never calls provider');
    eq(held(), heldIdentity, 'status does not release admission');
    await fresh(await otherActor.login(), 'lab', 'history');
    await visible('status', 'Marking needs attention. A final result is not available yet.', 'blocked work stays discoverable with dispatch paused');
    eq(sql(`select count(*) from exam_delivery.attempt_results where attempt_id='${unknown.id}'`), '0', 'blocked work has no synthetic successful result');
    eq(blocked, 0, 'browser uses loopback only');
    eq(browserCounts.submits, 0, 'central browser Submit count zero');
    eq(browserCounts.workerCalls, 0, 'central browser worker count zero');
    const summary = { suite: 'learner-status-real-react-sql-edge-workers', privateSourceSha: process.env.GITHUB_SHA, ciRun: process.env.GITHUB_RUN_ID, central: ['non-executable', 'python-lab'],
      actualEdge: true, actualPostgreSQL: true, actualReact: true, driverSuccessfulEvidenceInserts: 0,
      browserSubmitCalls: browserCounts.submits, browserWorkerCalls: browserCounts.workerCalls,
      browserStatusReads: browserCounts.reads, simulatedProvider: counters(), expectedRecoveryBlocked: true, admissionRetained: true, productionActions: 0, realProviderCalls: 0, passed: true };
    writeFileSync(resolve(process.env.RUNNER_TEMP, 'learner-status-acceptance.json'), JSON.stringify(summary, null, 2) + '\n');
    console.log(JSON.stringify(summary));
  } finally { await context?.close(); await browser.close(); }
}
