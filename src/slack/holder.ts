// A shared mutable slot with owner-scoped clearing: installing overwrites unconditionally, but clearing is a
// no-op unless the caller still owns the slot. Used for the Slack bridge/thread-reader/reporter holders in the
// daemon composition root — a late-stopping superseded connection must not null the holders a newer connection
// has re-installed (that silently auto-allowed every approval while slack.status showed 'up').
export interface Holder<T> {
  set(v: T): void;
  clearIf(v: T): void;
  get(): T | null;
}

export function makeHolder<T>(): Holder<T> {
  let cur: T | null = null;
  return {
    set: (v) => { cur = v; },
    clearIf: (v) => { if (cur === v) cur = null; },
    get: () => cur,
  };
}
