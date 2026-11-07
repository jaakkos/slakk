import { describe, expect, it } from 'vitest';
import {
  migrate,
  sanitizeSettingsMap,
  sanitizeValue,
  SETTINGS_SCHEMA,
  SETTINGS_VERSION,
} from './settingsStore.js';

describe('sanitizeValue', () => {
  it('clamps numbers to schema range', () => {
    expect(sanitizeValue(SETTINGS_SCHEMA.hazardBuf, 999)).toBe(200);
    expect(sanitizeValue(SETTINGS_SCHEMA.maxUp, 0)).toBe(1);
  });

  it('rejects unknown enums', () => {
    expect(sanitizeValue(SETTINGS_SCHEMA.steep27, 'nope')).toBeNull();
    expect(sanitizeValue(SETTINGS_SCHEMA.steep27, 'penalize')).toBe('penalize');
  });
});

describe('sanitizeSettingsMap', () => {
  it('keeps known keys only', () => {
    const out = sanitizeSettingsMap({
      maxUp: 20,
      mystery: 1,
      steep27: 'avoid',
    });
    expect(out).toEqual({ maxUp: 20, steep27: 'avoid' });
  });
});

describe('migrate', () => {
  it('upgrades plain v1 map through to v4 steep bands', () => {
    const out = migrate({
      maxUp: 15,
      runout: 'avoid',
      runoutShort: true,
      steepBuf: 6,
      runoutBuf: 10,
    });
    expect(out.v).toBe(SETTINGS_VERSION);
    expect(out.settings.runoutShort).toBe('avoid');
    expect(out.settings.hazardBuf).toBe(10);
    expect(out.settings.steep27).toBe('ignore');
    expect(out.settings.steepMode).toBeUndefined();
  });

  it('maps legacy steepMode avoid onto all five bands', () => {
    const out = migrate({
      v: 3,
      settings: { steepMode: 'avoid', hazardBuf: 12 },
    });
    expect(out.v).toBe(4);
    expect(out.settings.steep27).toBe('avoid');
    expect(out.settings.steep45).toBe('avoid');
    expect(out.settings.steepMode).toBeUndefined();
    expect(out.settings.hazardBuf).toBe(12);
  });

  it('preserves explicit per-band modes when migrating from v3', () => {
    const out = migrate({
      v: 3,
      settings: {
        steepMode: 'ignore',
        steep40: 'penalize',
        steep45: 'avoid',
      },
    });
    expect(out.settings.steep40).toBe('penalize');
    expect(out.settings.steep45).toBe('avoid');
    expect(out.settings.steep27).toBe('ignore');
  });
});
