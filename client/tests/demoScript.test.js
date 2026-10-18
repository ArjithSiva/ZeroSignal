import { describe, expect, it } from 'vitest';
import { SCENARIOS } from '@zerosignal/shared';
import { AUTOPILOT, AUTOPILOT_SECONDS, RECEIVER_IDS, SPEC_CONDITIONS } from '../src/lib/demoScript.js';
import { findPresetKeys } from './helpers.js';

describe('auto-pilot script', () => {
  it('is ordered, runs about 3.5 minutes, and ends on the closing line', () => {
    const times = AUTOPILOT.map((s) => s.at);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(AUTOPILOT_SECONDS).toBeGreaterThan(190);
    expect(AUTOPILOT_SECONDS).toBeLessThan(240);
    expect(AUTOPILOT.at(-1).caption).toMatch(/When networks fail, information shouldn’t/);
  });

  it('only references presets and scenarios that exist', () => {
    const keys = findPresetKeys();
    for (const a of AUTOPILOT.flatMap((s) => s.actions ?? [])) {
      if (a.preset) expect(keys).toContain(a.preset);
      if (a.scenario) expect(SCENARIOS[a.scenario]).toBeTruthy();
      if (a.id) expect(RECEIVER_IDS).toContain(a.id);
    }
  });

  it('has a scenario curve for every demo receiver', () => {
    for (const id of RECEIVER_IDS) expect(SCENARIOS.cyclone.curves[id]).toBeTruthy();
    expect(Object.keys(SPEC_CONDITIONS)).toEqual(RECEIVER_IDS);
  });
});
