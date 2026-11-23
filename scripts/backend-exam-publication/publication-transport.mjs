export async function publishProtectedPackage({ client, request }) {
  if (!client?.auth?.getUser || !client?.rpc) throw new Error('PUBLICATION_CLIENT_INVALID');
  const { data: userData, error: userError } = await client.auth.getUser();
  if (userError || !userData?.user?.id) throw new Error('PUBLICATION_USER_NOT_VERIFIED');
  if (Object.hasOwn(request ?? {}, 'actorUserId') || Object.hasOwn(request ?? {}, 'actorId')) {
    throw new Error('PUBLICATION_ACTOR_FIELD_FORBIDDEN');
  }
  const { data, error } = await client.rpc('certsim_protected_publish_package', {
    p_request: request,
  });
  if (error) throw new Error(`PUBLICATION_RPC_FAILED:${safeCode(error.code)}`);
  return sanitizeResult(data);
}

function sanitizeResult(value) {
  const allowed = ['ok','classification','replayed','examKey','packageVersion','profileCount','questionCount','packageHash','validationHash'];
  return Object.fromEntries(allowed.filter((key) => Object.hasOwn(value ?? {}, key)).map((key) => [key, value[key]]));
}
function safeCode(value) {
  return typeof value === 'string' && /^[A-Z0-9_]{1,64}$/i.test(value) ? value : 'UNKNOWN';
}
