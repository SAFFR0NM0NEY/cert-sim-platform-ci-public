// A desired view is different from the attempt ID returned by Start. Every
// originating operation has its own generation, including A -> B -> A views.
export function createRunnerInitializationScope() {
  let viewKey = '', viewGeneration = 0, generation = 0, current = null, view = null;
  const isCurrent = (context) => Boolean(context && current === context &&
    context.viewKey === viewKey && context.viewGeneration === viewGeneration && !context.signal.aborted);
  return Object.freeze({
    update: (key) => {
      if (key === viewKey) return view;
      current?.controller.abort();
      current = null;
      viewKey = key;
      viewGeneration += 1;
      view = Object.freeze({ key: viewKey, generation: viewGeneration });
      return view;
    },
    begin: ({ view: expectedView, accountId, attemptId = '', signal }) => {
      if (expectedView !== view || signal.aborted) return null;
      current?.controller.abort();
      const controller = new AbortController();
      current = { viewKey, viewGeneration, generation: ++generation, accountId, attemptId, controller,
        signal: AbortSignal.any([signal, controller.signal]) };
      return current;
    },
    isCurrent,
    matchesView: (context) => Boolean(context && context.viewKey === viewKey && context.viewGeneration === viewGeneration),
    bindAttempt: (context, attemptId) => {
      if (!isCurrent(context)) return false;
      if (!attemptId || (context.attemptId && context.attemptId !== attemptId)) {
        throw Object.assign(new Error('Protected attempt binding could not be verified.'), { code: 'binding_mismatch' });
      }
      context.attemptId = attemptId;
      return true;
    },
    cancel: (context) => { context?.controller.abort(); if (current === context) current = null; },
    dispose: () => { current?.controller.abort(); current = null; viewGeneration += 1; },
  });
}
