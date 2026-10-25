"""Offline checks for route continuity, masks, constraints and Strava conversion."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image
import route_cli as cli


class RouteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def terrain(self, rgba=None, z=None):
        if z is None:
            z = np.full((40,40),100,dtype=np.float32)
        if rgba is None:
            rgba = np.zeros((40,40,4),dtype=np.uint8)
        Image.fromarray(z).save(self.root/'dem.tiff')
        Image.fromarray(rgba).save(self.root/'hazards.png')
        Image.new('RGB',(40,40),'white').save(self.root/'topo.png')
        grid = dict(provider='kartverket-nve-v1',bbox=[0,0,400,400],resolution=10,
                    ground_resolution=10,width=40,height=40,scale=1)
        (self.root/'manifest.json').write_text(json.dumps(grid))
        return cli.Terrain(self.root,grid)

    def args(self,*extra):
        return cli.parser().parse_args(['optimize','unused.gpx','--out',str(self.root/'out'),
            '--cache',str(self.root),'--corridor-m','500','--steep-buffer-m','0',
            '--runout-buffer-m','0',*extra])

    def test_flat_route_retains_exact_endpoints(self):
        reference = np.array([[7.3,20.1],[20,20],[31.2,20.4]])
        q, info = cli.solve(self.terrain(),reference,self.args())
        np.testing.assert_array_equal(q[0],reference[0])
        np.testing.assert_array_equal(q[-1],reference[-1])
        self.assertLess(info['max_sampled_uphill_deg'],.01)

    def test_impenetrable_steep_wall_returns_no_route(self):
        colors = np.zeros((40,40,4),np.uint8)
        colors[20,:] = [255,255,0,255]
        with self.assertRaises(cli.NoRoute):
            cli.solve(self.terrain(colors),np.array([[7,20],[32,20]]),self.args())

    def test_steep_elevation_step_cannot_be_jumped(self):
        z = np.full((40,40),100,dtype=np.float32)
        z[20:] = 160
        with self.assertRaises(cli.NoRoute):
            cli.solve(self.terrain(z=z),np.array([[7,20],[32,20]]),self.args('--max-terrain-deg','79'))

    def test_preserved_approach_cannot_bypass_hazard_validation(self):
        colors = np.zeros((40,40,4),np.uint8)
        colors[10,20] = [0,77,168,255]
        reference = np.array([[7,20],[17,20],[32,20]])
        with self.assertRaisesRegex(cli.NoRoute,'preserved approach'):
            cli.solve(self.terrain(colors),reference,self.args('--keep-first-m','100'))

    def test_unknown_nve_palette_is_rejected(self):
        colors = np.zeros((40,40,4),np.uint8)
        colors[20,20] = [1,2,3,255]
        with self.assertRaisesRegex(ValueError,'unknown colours'):
            self.terrain(colors)

    def test_no_route_command_emits_report_but_no_gpx(self):
        colors = np.zeros((40,40,4),np.uint8)
        colors[20,:] = [255,255,0,255]
        terrain = self.terrain(colors)
        path = self.root/'input.gpx'
        reference = np.array([[7,20],[32,20]])
        cli.write_gpx(path,terrain.lonlat(reference),[100,100],'test','test')
        code = cli.main(['optimize',str(path),'--goal','last','--cache',str(self.root),
                         '--out',str(self.root/'out'),'--offline'])
        self.assertEqual(code,3)
        report = json.loads((self.root/'out'/'report.json').read_text())
        self.assertEqual(report['status'],'no_feasible_route')
        self.assertEqual(list((self.root/'out').glob('*.gpx')),[])

    def test_disconnected_gpx_is_rejected(self):
        p = self.root/'broken.gpx'
        p.write_text('<gpx><trk><trkseg><trkpt lat="69" lon="19"/></trkseg>'
                     '<trkseg><trkpt lat="70" lon="20"/></trkseg></trk></gpx>')
        with self.assertRaisesRegex(ValueError,'continuous'):
            cli.read_gpx(p)

    def test_strava_latlon_order_and_elevations(self):
        streams = {'latlng':{'data':[[69,19],[69.001,19.002]]},'altitude':{'data':[100,120]}}
        args = cli.parser().parse_args(['fetch-strava','123','-o',str(self.root/'activity.gpx')])
        with patch.dict('os.environ',{'STRAVA_ACCESS_TOKEN':'test-token'}), patch.object(cli,'download',return_value=json.dumps(streams).encode()) as call:
            cli.fetch_strava(args)
        q = cli.read_gpx(args.output)
        np.testing.assert_array_equal(q,[[19,69,100],[19.002,69.001,120]])
        self.assertEqual(call.call_args.args[1],'test-token')
        self.assertNotIn('test-token',call.call_args.args[0])


if __name__ == '__main__':
    unittest.main()
