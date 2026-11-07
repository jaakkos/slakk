import { describe, expect, it } from 'vitest';
import {
  splitRunoutClass,
  planRunoutStrategy,
  formatRunoutModes,
} from './runoutZones.js';

describe('splitRunoutClass', () => {
  it('splits Block / Prefer around / Off', () => {
    const raw = new Uint8Array([0, 1, 2, 3, 2]);
    const modes = { short: 'avoid', medium: 'penalize', long: 'ignore' };
    const split = splitRunoutClass(raw, modes);
    expect([...split.avoidMask]).toEqual([0, 1, 0, 0, 0]);
    expect([...split.costClass]).toEqual([0, 0, 2, 0, 2]);
    expect([...split.activeClass]).toEqual([0, 1, 2, 0, 2]);
    expect(split.hasAvoid).toBe(true);
    expect(split.hasPenalize).toBe(true);
  });
});

describe('planRunoutStrategy', () => {
  it('uses avoid when only Block zones', () => {
    expect(
      planRunoutStrategy({ short: 'avoid', medium: 'ignore', long: 'ignore' }),
    ).toMatchObject({ runout: 'avoid', mergeAvoidIntoSteep: false });
  });

  it('merges avoid into steep when mixed with Prefer around', () => {
    expect(
      planRunoutStrategy({ short: 'avoid', medium: 'penalize', long: 'ignore' }),
    ).toMatchObject({
      runout: 'penalize',
      mergeAvoidIntoSteep: true,
      classSource: 'cost',
    });
  });

  it('uses penalize when only Prefer around', () => {
    expect(
      planRunoutStrategy({ short: 'penalize', medium: 'penalize', long: 'penalize' }),
    ).toMatchObject({ runout: 'penalize', mergeAvoidIntoSteep: false });
  });
});

describe('formatRunoutModes', () => {
  it('uses block/prefer/off labels', () => {
    expect(
      formatRunoutModes({ short: 'avoid', medium: 'penalize', long: 'ignore' }),
    ).toBe('S:block M:prefer L:off');
  });
});
