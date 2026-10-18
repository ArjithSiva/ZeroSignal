/** Minimal typed-ish event emitter shared by the transports. */
export function createEmitter() {
  const handlers = new Map();
  return {
    on(event, cb) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(cb);
      return () => handlers.get(event)?.delete(cb);
    },
    emit(event, payload) {
      for (const cb of handlers.get(event) ?? []) {
        try { cb(payload); } catch { /* a listener must never break the transport */ }
      }
    },
    clear: () => handlers.clear(),
  };
}
