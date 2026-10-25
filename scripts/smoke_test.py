"""Run a slakk command end to end on a synthetic offline terrain cache.

Usage: python scripts/smoke_test.py [COMMAND...]
COMMAND defaults to `python slakk.py`; the release workflow passes a built binary.
Needs NumPy and Pillow to write the cache. Makes no network requests.
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import slakk  # noqa: E402


def main():
    command = sys.argv[1:] or [sys.executable, str(ROOT / 'slakk.py')]
    with tempfile.TemporaryDirectory() as temp:
        cache, out = Path(temp) / 'cache', Path(temp) / 'out'
        cache.mkdir()
        y, x = np.mgrid[0:60, 0:60]
        Image.fromarray((100 + 2.0 * x + 8 * np.sin(y / 6)).astype(np.float32)).save(cache / 'dem.tiff')
        Image.fromarray(np.zeros((60, 60, 4), np.uint8)).save(cache / 'hazards.png')
        Image.new('RGB', (60, 60), 'white').save(cache / 'topo.png')
        grid = dict(provider='kartverket-nve-v1', bbox=[2100000, 10900000, 2100600, 10900600],
                    resolution=10, ground_resolution=10, width=60, height=60, scale=1)
        (cache / 'manifest.json').write_text(json.dumps(grid))
        terrain = slakk.Terrain(cache, grid)
        start, end = (terrain.lonlat(np.array([p]))[0] for p in ([30., 5.], [30., 55.]))
        subprocess.run([*command, '--version'], check=True)
        subprocess.run([*command, 'optimize', '--start', f'{start[1]:.7f},{start[0]:.7f}',
                        '--end', f'{end[1]:.7f},{end[0]:.7f}', '--cache', str(cache), '--out', str(out),
                        '--offline', '--html'], check=True, stdout=subprocess.DEVNULL)
        report = json.loads((out / 'report.json').read_text())
        missing = [n for n in ('candidate-DRAFT.gpx', 'comparison.png', 'map.html') if not (out / n).exists()]
        if report.get('status') != 'unverified_candidate' or missing:
            sys.exit(f'Smoke test failed: status {report.get("status")!r}, missing {missing}')
    print('Smoke test passed.')


if __name__ == '__main__':
    main()
