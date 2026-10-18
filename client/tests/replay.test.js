import { describe, expect, it } from 'vitest';
import { stateAt, timelineBounds } from '../src/lib/replay.js';

const tl = {
  sessions: [{ receiverId: 'A', name: 'Receiver A' }],
  metrics: [
    { receiverId: 'A', ts: 1000, tier: '720p', bandwidthKbps: 9000 },
    { receiverId: 'A', ts: 3000, tier: 'TEXT', bandwidthKbps: 80 },
  ],
  events: [{ at: 2500, from: '720p', to: 'TEXT' }],
  messages: [{ id: 'm', sentAt: 3500 }],
  acks: [{ at: 4000 }],
};

describe('replay', () => {
  it('finds the span of the timeline', () => {
    expect(timelineBounds(tl)).toEqual({ start: 1000, end: 4000 });
    expect(timelineBounds({})).toBeNull();
  });

  it('rebuilds receiver tier, events and alerts as of a moment', () => {
    const early = stateAt(tl, 2000);
    expect(early.receivers[0]).toMatchObject({ id: 'A', tier: '720p', name: 'Receiver A' });
    expect(early.events).toHaveLength(0);
    const late = stateAt(tl, 3600);
    expect(late.receivers[0].tier).toBe('TEXT');
    expect(late.events).toHaveLength(1);
    expect(late.messages).toHaveLength(1);
    expect(late.acks).toHaveLength(0);
  });
});
