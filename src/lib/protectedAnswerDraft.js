// Ordinary answer drafts are local intent, not persistence acknowledgments.
export function createProtectedAnswerDraft(owner = null) {
  return { owner, answers: {}, revisions: {}, dirtyIds: new Set(), edits: {} };
}
export function ownsProtectedAnswerDraft(draft, owner) {
  return Boolean(owner?.accountId && owner?.attemptId && draft.owner?.accountId === owner.accountId && draft.owner?.attemptId === owner.attemptId);
}
export function reconcileProtectedAnswerDraft(draft, owner, incoming, { replace = false } = {}) {
  const matching = ownsProtectedAnswerDraft(draft, owner);
  if (!matching && draft.dirtyIds.size) throw Object.assign(new Error('Unsaved answers belong to the original attempt.'), { code: 'unsaved_attempt' });
  const base = matching ? draft : createProtectedAnswerDraft(owner);
  const answers = replace ? {} : { ...base.answers };
  const revisions = replace ? {} : { ...base.revisions };
  for (const item of incoming) {
    if (base.dirtyIds.has(item.itemId)) continue;
    if (item.answer === undefined) delete answers[item.itemId];
    else answers[item.itemId] = item.answer;
    revisions[item.itemId] = item.revision;
  }
  // Keep every owned dirty item, including those outside a resumed prefix.
  for (const itemId of base.dirtyIds) {
    if (!Object.hasOwn(base.answers, itemId)) throw Object.assign(new Error('The local answer draft is unavailable.'), { code: 'draft_unavailable' });
    answers[itemId] = base.answers[itemId];
    revisions[itemId] = base.revisions[itemId];
  }
  return { ...base, owner, answers, revisions };
}
export function editProtectedAnswerDraft(draft, owner, itemId, value) {
  if (!ownsProtectedAnswerDraft(draft, owner)) throw Object.assign(new Error('The answer belongs to another attempt.'), { code: 'binding_mismatch' });
  return { ...draft, answers: { ...draft.answers, [itemId]: value }, dirtyIds: new Set(draft.dirtyIds).add(itemId),
    edits: { ...draft.edits, [itemId]: (draft.edits[itemId] ?? 0) + 1 } };
}
export function acknowledgeProtectedAnswerDraft(draft, owner, itemId, sent, saved) {
  if (!ownsProtectedAnswerDraft(draft, owner)) return draft;
  if (saved?.itemId !== itemId || saved.revision !== sent.revision + 1) {
    throw Object.assign(new Error('The saved answer acknowledgment did not match this item and revision.'), { code: 'binding_mismatch' });
  }
  if (!draft.dirtyIds.has(itemId) || draft.revisions[itemId] !== sent.revision) return draft;
  const dirtyIds = new Set(draft.dirtyIds);
  if (draft.edits[itemId] === sent.edit) dirtyIds.delete(itemId);
  // An acknowledgment of our own save can advance its base, but cannot clean
  // a later edit. Reads never advance a dirty draft's expected revision.
  return { ...draft, revisions: { ...draft.revisions, [itemId]: saved.revision }, dirtyIds };
}
