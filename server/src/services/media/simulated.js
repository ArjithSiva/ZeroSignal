/** The always-available last resort: the labelled canvas simulation (no real media moves). */
export function createSimulatedProvider() {
  return {
    id: 'simulated',
    label: 'Simulated feed',
    available: true,
    reason: null,
    layers: ['720p', '480p', '240p', 'AUDIO'],
    simulated: true,
    async publishCredentials() { return { mode: 'simulated' }; },
    async viewerCredentials() { return { mode: 'simulated' }; },
    health: () => ({ status: 'up', note: 'Labelled canvas simulation. No real video is streamed.' }),
  };
}
