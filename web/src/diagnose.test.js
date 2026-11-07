import { describe, expect, it } from 'vitest';
import { diagnoseClosedLeg, diagnosePoints } from './diagnose.js';

const bbox = [0, 0, 1000, 1000];
const width = 10;
const height = 10;
const n = width * height;

function gridElev(fill = 100) {
  return Float32Array.from({ length: n }, () => fill);
}

describe('diagnoseClosedLeg', () => {
  it('counts Block steep as Hard, ignores Off steep', () => {
    const steep = new Uint8Array(n);
    // Mid cells on the straight line get class 5.
    for (let i = 0; i < n; i++) steep[i] = 5;
    const from = { lat: 0.001, lon: 0.001 };
    const to = { lat: 0.008, lon: 0.008 };
    const blocked = diagnoseClosedLeg({
      from,
      to,
      bbox,
      width,
      height,
      elevations: gridElev(),
      steep,
      steepModes: {
        steep27: 'ignore',
        steep30: 'ignore',
        steep35: 'ignore',
        steep40: 'ignore',
        steep45: 'avoid',
      },
      slope: Float32Array.from({ length: n }, () => 10),
      maxTerrainDeg: 35,
      samples: 20,
    });
    expect(blocked.tallies.nve_steep).toBeGreaterThan(0);

    const off = diagnoseClosedLeg({
      from,
      to,
      bbox,
      width,
      height,
      elevations: gridElev(),
      steep,
      steepModes: {
        steep27: 'ignore',
        steep30: 'ignore',
        steep35: 'ignore',
        steep40: 'ignore',
        steep45: 'ignore',
      },
      slope: Float32Array.from({ length: n }, () => 10),
      maxTerrainDeg: 35,
      samples: 20,
    });
    expect(off.tallies.nve_steep).toBe(0);
  });

  it('counts fall-line above Ground slope max', () => {
    const slope = Float32Array.from({ length: n }, () => 50);
    const leg = diagnoseClosedLeg({
      from: { lat: 0.001, lon: 0.001 },
      to: { lat: 0.008, lon: 0.008 },
      bbox,
      width,
      height,
      elevations: gridElev(),
      steep: new Uint8Array(n),
      steepModes: {
        steep27: 'ignore',
        steep30: 'ignore',
        steep35: 'ignore',
        steep40: 'ignore',
        steep45: 'ignore',
      },
      slope,
      maxTerrainDeg: 35,
      samples: 20,
    });
    expect(leg.tallies.fall_line).toBeGreaterThan(0);
    expect(leg.reasons[0].id).toBe('fall_line');
  });
});

describe('diagnosePoints', () => {
  it('flags start on Block steep band', () => {
    const steep = new Uint8Array(n);
    // Place a point near grid centre; paint that cell.
    const reports = diagnosePoints({
      points: [{ lat: 0.004, lon: 0.004 }],
      bbox,
      width,
      height,
      elevations: gridElev(),
      steep,
      steepModes: {
        steep27: 'ignore',
        steep30: 'ignore',
        steep35: 'ignore',
        steep40: 'ignore',
        steep45: 'avoid',
      },
      runoutClass: new Uint8Array(n),
      corridorM: 10000,
      slope: Float32Array.from({ length: n }, () => 5),
    });
    // Paint after we know the cell — re-run with steep on that index.
    const cell = reports[0].cell;
    if (cell && !cell.outside) {
      steep[cell.i] = 5;
      const again = diagnosePoints({
        points: [{ lat: 0.004, lon: 0.004 }],
        bbox,
        width,
        height,
        elevations: gridElev(),
        steep,
        steepModes: {
          steep27: 'ignore',
          steep30: 'ignore',
          steep35: 'ignore',
          steep40: 'ignore',
          steep45: 'avoid',
        },
        runoutClass: new Uint8Array(n),
        corridorM: 10000,
        slope: Float32Array.from({ length: n }, () => 5),
      });
      expect(again[0].ok).toBe(false);
      expect(again[0].steep).toBe(true);
    }
  });
});
