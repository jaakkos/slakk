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
        with patch.dict('os.environ',{'STRAVA_ACCESS_TOKEN':'test-token','XDG_CONFIG_HOME':str(self.root)}), patch.object(cli,'download',return_value=json.dumps(streams).encode()) as call:
            cli.fetch_strava(args)
        q = cli.read_gpx(args.output)
        np.testing.assert_array_equal(q,[[19,69,100],[19.002,69.001,120]])
        self.assertEqual(call.call_args.args[1],'test-token')
        self.assertNotIn('test-token',call.call_args.args[0])

    def test_waypoint_forces_route_through_it(self):
        reference = np.array([[7.,20.],[32.,20.]])
        via = np.array([[20.,8.3]])
        q, info = cli.solve(self.terrain(),reference,self.args(),via)
        self.assertEqual(info['waypoints'],1)
        self.assertTrue((q == via[0]).all(axis=1).any(), 'exact waypoint missing from candidate')
        np.testing.assert_array_equal(q[[0,-1]],reference)

    def test_masked_waypoint_is_rejected_not_skipped(self):
        colors = np.zeros((40,40,4),np.uint8)
        colors[8,20] = [255,255,0,255]
        with self.assertRaisesRegex(cli.NoRoute,'Waypoint 1'):
            cli.solve(self.terrain(colors),np.array([[7.,20.],[32.,20.]]),self.args(),np.array([[8.,20.]]))

    def test_unreachable_waypoint_reports_which_leg(self):
        colors = np.zeros((40,40,4),np.uint8)
        colors[12,:] = [255,255,0,255]
        with self.assertRaisesRegex(cli.NoRoute,'waypoint 1'):
            cli.solve(self.terrain(colors),np.array([[20.,5.],[20.,35.]]),self.args(),np.array([[6.,20.]]))

    def test_coordinate_mode_without_gpx(self):
        terrain = self.terrain()
        (start,), (via,), (end,) = (terrain.lonlat(np.array([p])) for p in ([8.,8.],[20.,25.],[32.,10.]))
        fmt = lambda p: f'{p[1]:.9f},{p[0]:.9f}'
        out = self.root/'out'
        code = cli.main(['optimize','--start',fmt(start),'--end',fmt(end),'--via',fmt(via),
                         '--cache',str(self.root),'--out',str(out),'--offline','--corridor-m','500'])
        self.assertEqual(code,0)
        report = json.loads((out/'report.json').read_text())
        self.assertEqual((report['mode'],report['search']['waypoints']),('coordinates',1))
        self.assertTrue((out/'candidate-DRAFT.gpx').exists())
        self.assertFalse((out/'recorded-ascent.gpx').exists())
        q = cli.read_gpx(out/'candidate-DRAFT.gpx')
        np.testing.assert_allclose(q[[0,-1],:2],[start,end],atol=1e-7)

    def test_gpx_and_coordinates_cannot_be_mixed(self):
        path = self.root/'input.gpx'
        cli.write_gpx(path,self.terrain().lonlat(np.array([[7,20],[32,20]])),[100,100],'test','test')
        code = cli.main(['optimize',str(path),'--start','0.001,0.001','--end','0.002,0.002',
                         '--cache',str(self.root),'--out',str(self.root/'out'),'--offline'])
        self.assertEqual(code,2)

    def test_bad_coordinate_text_is_a_usage_error(self):
        with self.assertRaises(SystemExit):
            cli.parser().parse_args(['optimize','--start','61.2','--end','61,7','--out','o','--cache','c'])
    def write_area(self, terrain, corners, name='avoid.geojson'):
        ring = terrain.lonlat(np.array(corners,float)).tolist()
        path = self.root/name
        path.write_text(json.dumps({'type':'FeatureCollection','features':[
            {'type':'Feature','properties':{},'geometry':{'type':'Polygon','coordinates':[ring+[ring[0]]]}}]}))
        return path

    def test_avoid_area_is_never_entered(self):
        terrain = self.terrain()
        corners = [[14,10],[14,30],[26,30],[26,10]]
        rings = cli.read_areas(self.write_area(terrain,corners))
        mask = cli.area_mask(terrain,rings)
        q, _ = cli.solve(terrain,np.array([[20.,5.],[20.,35.]]),self.args(),(),mask)
        _, dense = cli.resample(q,.25,1)
        ij = np.rint(dense).astype(int)
        self.assertFalse(mask[ij[:,0],ij[:,1]].any())
        self.assertTrue(mask[20,20] and mask[14,10] and mask[26,30])

    def test_avoid_area_covering_goal_gives_no_route(self):
        terrain = self.terrain()
        path = self.write_area(terrain,[[15,30],[15,38],[25,38],[25,30]])
        gpx = self.root/'input.gpx'
        cli.write_gpx(gpx,terrain.lonlat(np.array([[20,5],[20,34]])),[100,100],'test','test')
        code = cli.main(['optimize',str(gpx),'--goal','last','--avoid',str(path),'--cache',str(self.root),
                         '--out',str(self.root/'out'),'--offline'])
        self.assertEqual(code,3)
        report = json.loads((self.root/'out'/'report.json').read_text())
        self.assertIn('avoid',report['reason'])
        self.assertEqual(list(report['avoid_sha256']),[str(path)])

    def test_non_polygon_area_is_rejected(self):
        path = self.root/'line.geojson'
        path.write_text(json.dumps({'type':'LineString','coordinates':[[0,0],[1,1]]}))
        with self.assertRaisesRegex(ValueError,'only Polygon'):
            cli.read_areas(path)
    def test_alternatives_are_distinct_and_valid(self):
        z = np.full((40,40),100,dtype=np.float32)
        found = cli.solve_many(self.terrain(z=z),np.array([[20.,5.],[20.,35.]]),self.args(),(),None,3)
        self.assertGreaterEqual(len(found),2)
        best, _ = found[0]
        np.testing.assert_array_equal(best, cli.solve(self.terrain(z=z),np.array([[20.,5.],[20.,35.]]),self.args())[0])
        for q, info in found[1:]:
            np.testing.assert_array_equal(q[[0,-1]],[[20,5],[20,35]])
            self.assertLessEqual(info['shared_with_earlier'],.9)

    def test_alternatives_command_writes_numbered_files(self):
        terrain = self.terrain()
        gpx = self.root/'input.gpx'
        cli.write_gpx(gpx,terrain.lonlat(np.array([[20,5],[20,34]])),[100,100],'test','test')
        out = self.root/'out'
        code = cli.main(['optimize',str(gpx),'--goal','last','--alternatives','3','--cache',str(self.root),
                         '--out',str(out),'--offline'])
        self.assertEqual(code,0)
        report = json.loads((out/'report.json').read_text())
        files = sorted(p.name for p in out.glob('candidate*.gpx'))
        self.assertEqual(files[0],'candidate-2-DRAFT.gpx')
        self.assertIn('candidate-DRAFT.gpx',files)
        self.assertEqual(len(files),1+len(report['alternatives']))
    def test_html_map_is_self_contained_and_flags_violations(self):
        z = np.full((40,40),100,dtype=np.float32)
        z[:,20:] += np.arange(20,dtype=np.float32)*3  # recorded line climbs ~17 degrees
        terrain = self.terrain(z=z)
        gpx = self.root/'input.gpx'
        cli.write_gpx(gpx,terrain.lonlat(np.array([[20,5],[20,35]])),[100,145],'test','test')
        out = self.root/'out'
        code = cli.main(['optimize',str(gpx),'--goal','last','--html','--cache',str(self.root),
                         '--out',str(out),'--offline','--max-terrain-deg','79','--corridor-m','500'])
        self.assertEqual(code,0)
        page = (out/'map.html').read_text()
        self.assertNotRegex(page,r'(src|href)="https?:')
        data = json.loads(page.split('const D = ',1)[1].split(';\n',1)[0])
        recorded, candidate = data['routes'][:2]
        self.assertTrue(any(recorded['over']))
        self.assertFalse(any(candidate['over']))
    def add_checksums(self):
        grid = json.loads((self.root/'manifest.json').read_text())
        grid['files'] = {n: {'sha256': __import__('hashlib').sha256((self.root/n).read_bytes()).hexdigest()}
                         for n in ('dem.tiff','hazards.png','topo.png')}
        (self.root/'manifest.json').write_text(json.dumps(grid))

    def offline_args(self):
        return cli.parser().parse_args(['optimize','x.gpx','--out',str(self.root/'out'),'--cache',str(self.root),'--offline'])

    def test_modified_cache_is_refused(self):
        self.terrain()
        self.add_checksums()
        terrain = cli.get_terrain(np.zeros((2,3)),self.offline_args())
        self.assertTrue(terrain.grid['verified'])
        Image.new('RGB',(40,40),'black').save(self.root/'topo.png')
        with self.assertRaisesRegex(ValueError,'checksum'):
            cli.get_terrain(np.zeros((2,3)),self.offline_args())

    def test_cache_without_checksums_is_flagged(self):
        self.terrain()
        self.assertFalse(cli.get_terrain(np.zeros((2,3)),self.offline_args()).grid['verified'])

    def test_steep_terrain_without_nve_marking_fails_closed(self):
        z = np.full((40,40),100,dtype=np.float32)
        z[:,20:] += np.arange(20,dtype=np.float32)*8  # ~39 degrees, but NVE layer is empty
        with self.assertRaisesRegex(ValueError,'missing or unmapped'):
            cli.hazard_coverage(self.terrain(z=z))
        colors = np.zeros((40,40,4),np.uint8)
        colors[:,20:] = [255,170,0,255]
        coverage = cli.hazard_coverage(self.terrain(colors,z))
        self.assertEqual(coverage['fraction_near_nve_steep'],1.0)
    def test_turn_cost_replaces_micro_zigzags_with_long_traverses(self):
        rows = np.arange(40,dtype=np.float32)[:,None]
        z = np.repeat(1000 - rows*10*np.tan(np.radians(25)),40,axis=1).astype(np.float32)
        terrain = self.terrain(z=z)
        reference = np.array([[36.,20.],[4.,20.]])
        plain, _ = cli.solve(terrain,reference,self.args('--max-terrain-deg','40'))
        turned, _ = cli.solve(terrain,reference,self.args('--max-terrain-deg','40','--turn-cost-m','120'))
        for q in (plain, turned):
            np.testing.assert_array_equal(q[[0,-1]],reference)
        dense = lambda q: cli.resample(q,5/10,1)[1]
        self.assertLess(cli.kick_turns(dense(turned),10),cli.kick_turns(dense(plain),10))
    def test_strava_login_saves_only_tokens_privately(self):
        import threading, time, urllib.request
        response = {'access_token':'a1','refresh_token':'r1','expires_at':2**40,'athlete':{'firstname':'Private'}}
        env = {'STRAVA_CLIENT_ID':'42','STRAVA_CLIENT_SECRET':'s3cret','XDG_CONFIG_HOME':str(self.root)}
        with patch.dict('os.environ',env), patch('secrets.token_urlsafe',return_value='fixed'), \
             patch.object(cli,'download',return_value=json.dumps(response).encode()) as call:
            worker = threading.Thread(target=cli.main,args=(['strava-login','--no-browser','--port','8791','--timeout','20'],))
            worker.start()
            for _ in range(100):
                try:
                    urllib.request.urlopen('http://127.0.0.1:8791/exchange?state=fixed&code=c0de&scope=read,activity:read_all').read()
                    break
                except OSError:
                    time.sleep(.05)
            worker.join(20)
            self.assertEqual(call.call_args.kwargs['form']['code'],'c0de')
            path = cli.token_file()
            self.assertEqual(json.loads(path.read_text()),{'access_token':'a1','refresh_token':'r1','expires_at':2**40})
            self.assertEqual(path.stat().st_mode & 0o777,0o600)
            self.assertEqual(cli.stored_access_token(),'a1')

    def test_expired_stored_token_is_refreshed(self):
        env = {'STRAVA_CLIENT_ID':'42','STRAVA_CLIENT_SECRET':'s3cret','XDG_CONFIG_HOME':str(self.root)}
        with patch.dict('os.environ',env):
            cli.save_tokens({'access_token':'old','refresh_token':'r1','expires_at':1})
            fresh = {'access_token':'new','refresh_token':'r2','expires_at':2**40}
            with patch.object(cli,'download',return_value=json.dumps(fresh).encode()) as call:
                self.assertEqual(cli.stored_access_token(),'new')
            self.assertEqual(call.call_args.kwargs['form']['grant_type'],'refresh_token')
            self.assertEqual(call.call_args.kwargs['form']['refresh_token'],'r1')
            self.assertEqual(json.loads(cli.token_file().read_text())['refresh_token'],'r2')

if __name__ == '__main__':
    unittest.main()
