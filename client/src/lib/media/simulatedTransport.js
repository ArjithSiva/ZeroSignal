import { createEmitter } from './emitter.js';

/** The labelled canvas simulation. Nothing real flows; the UI renders QualityPlayer for it. */
export function createSimulatedTransport() {
  const ev = createEmitter();
  let state = { status: 'live', provider: 'simulated', simulated: true, layer: null, bitrateKbps: 0, buffering: false, error: null };
  const set = (p) => { state = { ...state, ...p }; ev.emit('state', state); };
  return {
    provider: 'simulated',
    simulated: true,
    state: () => state,
    on: ev.on,
    async connect() { set({ status: 'live' }); },
    setLayer(layer) { set({ layer }); },
    getStats: () => null,
    destroy() { ev.clear(); },
  };
}
