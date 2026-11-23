// Fail before synthetic fixture creation. In particular libpq's ?host= and
// ?hostaddr= override the URI host, so checking hostname alone is insufficient.
export function assertDisposableTargets(apiValue, databaseValue, environment = process.env) {
  const refuse = () => { throw new Error('DISPOSABLE_LOOPBACK_REQUIRED'); };
  if (['PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE'].some(name => environment[name])) refuse();
  for (const [value, protocols] of [[apiValue, ['http:', 'https:']], [databaseValue, ['postgres:', 'postgresql:']]]) {
    let target;
    try { target = new URL(value); } catch { refuse(); }
    if (!protocols.includes(target.protocol)
      || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
      || target.search || target.hash) refuse();
  }
}
