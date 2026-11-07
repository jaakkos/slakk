import { describe, expect, it } from 'vitest';
import {
  buildSavedEntry,
  defaultSavedName,
  deleteSavedRoute,
  getSavedRoute,
  listSavedRoutes,
  MAX_SAVED_ROUTES,
  savedEntryAsShareBlob,
  SAVED_ROUTES_KEY,
  upsertSavedRoute,
} from './savedRoutes.js';

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      map.set(k, String(v));
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

describe('buildSavedEntry', () => {
  it('requires two waypoints', () => {
    expect(() => buildSavedEntry({ points: [[1, 2]], settings: {} })).toThrow(/two waypoints/i);
  });

  it('stores waypoints and optional smoothed route', () => {
    const entry = buildSavedEntry({
      name: 'Test ridge',
      points: [
        [61.5, 8.5],
        [61.51, 8.51],
      ],
      settings: { maxUp: 22, mystery: 1 },
      pathLatLon: [
        [61.5, 8.5],
        [61.505, 8.505],
        [61.51, 8.51],
      ],
      elevationsM: [100, 110, 120],
      aspectsDeg: [180, 185, 190],
      smoothM: 0,
      summary: { distance_m: 1234.5, ascent_m: 20.2 },
    });
    expect(entry.name).toBe('Test ridge');
    expect(entry.pts).toHaveLength(2);
    expect(entry.set).toEqual({ maxUp: 22 });
    expect(entry.route.path).toHaveLength(3);
    expect(entry.route.asp).toEqual([180, 185, 190]);
    expect(entry.summary).toEqual({ distance_m: 1235, ascent_m: 20 });
  });
});

describe('savedRoutes store', () => {
  it('upserts, lists newest first, loads, and deletes', () => {
    const storage = memoryStorage();
    const a = buildSavedEntry({
      id: 'a',
      name: 'A',
      points: [
        [61, 8],
        [61.1, 8.1],
      ],
      settings: {},
      savedAt: '2026-01-01T00:00:00.000Z',
    });
    const b = buildSavedEntry({
      id: 'b',
      name: 'B',
      points: [
        [62, 9],
        [62.1, 9.1],
      ],
      settings: {},
      savedAt: '2026-02-01T00:00:00.000Z',
    });
    upsertSavedRoute(a, storage);
    upsertSavedRoute(b, storage);
    const list = listSavedRoutes(storage);
    expect(list.map((e) => e.id)).toEqual(['b', 'a']);
    expect(getSavedRoute('a', storage)?.name).toBe('A');
    expect(deleteSavedRoute('a', storage)).toBe(true);
    expect(getSavedRoute('a', storage)).toBeNull();
    expect(listSavedRoutes(storage)).toHaveLength(1);
  });

  it('caps at MAX_SAVED_ROUTES', () => {
    const storage = memoryStorage();
    for (let i = 0; i < MAX_SAVED_ROUTES + 3; i++) {
      upsertSavedRoute(
        buildSavedEntry({
          id: `id-${i}`,
          name: `R${i}`,
          points: [
            [60 + i * 0.01, 8],
            [60.1 + i * 0.01, 8.1],
          ],
          settings: {},
          savedAt: new Date(2026, 0, 1 + i).toISOString(),
        }),
        storage,
      );
    }
    expect(listSavedRoutes(storage)).toHaveLength(MAX_SAVED_ROUTES);
  });

  it('survives corrupt storage', () => {
    const storage = memoryStorage({ [SAVED_ROUTES_KEY]: '{not-json' });
    expect(listSavedRoutes(storage)).toEqual([]);
  });
});

describe('savedEntryAsShareBlob', () => {
  it('matches share restore shape', () => {
    const entry = buildSavedEntry({
      name: 'X',
      points: [
        [61.5, 8.5],
        [61.6, 8.6],
      ],
      settings: { corridor: 500 },
      pathLatLon: [
        [61.5, 8.5],
        [61.6, 8.6],
      ],
      elevationsM: [10, 20],
      smoothM: 0,
    });
    const blob = savedEntryAsShareBlob(entry);
    expect(blob.pts).toHaveLength(2);
    expect(blob.set.corridor).toBe(500);
    expect(blob.route.path).toHaveLength(2);
  });
});

describe('defaultSavedName', () => {
  it('prefers place name', () => {
    expect(defaultSavedName([[1, 2], [3, 4]], '  Spanstinden  ')).toBe('Spanstinden');
  });
});
