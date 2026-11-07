import { describe, expect, it } from 'vitest';
import {
  splitSteepClass,
  steepModesList,
  modeForSteepClass,
  anySteepActive,
  STEEP_FORCE_HARD,
} from './steepZones.js';

const allOff = {
  steep27: 'ignore',
  steep30: 'ignore',
  steep35: 'ignore',
  steep40: 'ignore',
  steep45: 'ignore',
};

describe('steepModesList', () => {
  it('orders classes 1..5', () => {
    expect(
      steepModesList({
        ...allOff,
        steep27: 'avoid',
        steep45: 'penalize',
      }),
    ).toEqual(['avoid', 'ignore', 'ignore', 'ignore', 'penalize']);
  });
});

describe('splitSteepClass', () => {
  it('splits avoid / prefer / off', () => {
    const raw = new Uint8Array([0, 1, 2, 5, 3]);
    const modes = {
      steep27: 'avoid',
      steep30: 'penalize',
      steep35: 'ignore',
      steep40: 'ignore',
      steep45: 'avoid',
    };
    const split = splitSteepClass(raw, modes);
    expect([...split.avoidMask]).toEqual([0, 1, 0, 1, 0]);
    expect([...split.costClass]).toEqual([0, 0, 2, 0, 0]);
    expect([...split.activeClass]).toEqual([0, 1, 2, 5, 0]);
    expect(split.hasAvoid).toBe(true);
    expect(split.hasPenalize).toBe(true);
  });

  it('treats all-off as inactive', () => {
    const raw = new Uint8Array([1, 2, 3, 4, 5]);
    const split = splitSteepClass(raw, allOff);
    expect(split.hasAvoid).toBe(false);
    expect(split.hasPenalize).toBe(false);
    expect(split.activeClass.every((v) => v === 0)).toBe(true);
  });
});

describe('modeForSteepClass', () => {
  it('force-hard sentinel is always avoid', () => {
    expect(modeForSteepClass(allOff, STEEP_FORCE_HARD)).toBe('avoid');
  });
});

describe('anySteepActive', () => {
  it('is false when all Off', () => {
    expect(anySteepActive(allOff)).toBe(false);
  });
  it('is true when any Band is not Off', () => {
    expect(anySteepActive({ ...allOff, steep40: 'penalize' })).toBe(true);
  });
});
