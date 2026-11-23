import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { assertDisposableTargets } from './assert-disposable-targets.mjs';

for (const script of ['test-generic-protected-lifecycle-integration.mjs', 'test-protected-access-history-integration.mjs']) {
  for (const remote of ['api', 'database']) test(`${script} refuses remote ${remote} before fixture creation`, () => {
    const result = spawnSync(process.execPath, [`scripts/${script}`], {
      encoding: 'utf8', timeout: 10000,
      env: { ...process.env,
        SUPABASE_URL: remote === 'api' ? 'https://must-not-contact.invalid' : 'http://127.0.0.1:54321',
        SUPABASE_DB_URL: remote === 'database' ? 'postgresql://synthetic@must-not-contact.invalid/test' : 'postgresql://synthetic@127.0.0.1:54322/test',
        SUPABASE_ANON_KEY: 'synthetic-only', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-only',
      },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /DISPOSABLE_LOOPBACK_REQUIRED/);
    assert.doesNotMatch(result.stderr, /fetch failed|FIXTURE_USER_CREATION_FAILED|AUTH_FIXTURE_FAILED/);
  });
}

for (const suffix of ['?host=remote.invalid', '?hostaddr=192.0.2.1', '?service=remote', '?options=-c%20role=postgres', '#ignored']) {
  test(`refuses libpq override ${suffix.split('=')[0]}`, () => {
    assert.throws(() => assertDisposableTargets('http://127.0.0.1:54321', `postgresql://fixture@localhost:54322/test${suffix}`), /DISPOSABLE_LOOPBACK_REQUIRED/);
  });
}
for (const endpoint of ['file:///tmp/socket', 'https://localhost/test', 'host=remote dbname=test']) {
  test('refuses unsupported database connection syntax', () => {
    assert.throws(() => assertDisposableTargets('http://127.0.0.1:54321', endpoint), /DISPOSABLE_LOOPBACK_REQUIRED/);
  });
}
test('accepts existing IPv4 and IPv6 loopback disposable URI shapes', () => {
  assertDisposableTargets('http://127.0.0.1:54321', 'postgresql://fixture:synthetic@127.0.0.1:54322/postgres');
  assertDisposableTargets('http://[::1]:54321', 'postgresql://fixture@[::1]:54322/postgres');
});

for (const name of ['PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE']) test(`refuses inherited libpq ${name}`, () => {
  assert.throws(() => assertDisposableTargets('http://localhost:54321', 'postgresql://fixture@localhost:54322/test', { [name]: 'override' }), /DISPOSABLE_LOOPBACK_REQUIRED/);
});
