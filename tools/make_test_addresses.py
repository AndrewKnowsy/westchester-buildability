"""Build a regression list: one one-family (class 210) parcel address per municipality.

  python3 tools/make_test_addresses.py           # writes research/test_addresses.json

The list holds real homeowners' addresses from the public tax roll, so it is
generated locally and kept out of git (see .gitignore).
"""
import json
import os
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PARCELS = 'https://giswww.westchestergov.com/arcgis/rest/services/DataHub_TaxParcels/MapServer/0/query'


def get(params):
    with urllib.request.urlopen(PARCELS + '?' + urllib.parse.urlencode(params), timeout=60) as r:
        return json.load(r)


swis = get(dict(where="PROP_CLASS='210'", outFields='SWIS,MUNI_NAME', returnDistinctValues='true',
                returnGeometry='false', f='json'))
pairs = sorted({(f['attributes']['SWIS'], f['attributes']['MUNI_NAME']) for f in swis['features']})
out = []
for code, name in pairs:
    r = get(dict(where=f"SWIS='{code}' AND PROP_CLASS='210' AND ACRES>0.12", outFields='PARCEL_ADDR,MUNI_NAME',
                 returnGeometry='false', resultRecordCount=1, resultOffset=31, f='json'))
    if r.get('features'):
        a = r['features'][0]['attributes']
        out.append(f"{a['PARCEL_ADDR']}, {a['MUNI_NAME']}, NY")
json.dump(out, open(os.path.join(ROOT, 'research', 'test_addresses.json'), 'w'), indent=0)
print(f'{len(out)} test addresses from {len(pairs)} tax districts -> research/test_addresses.json')
