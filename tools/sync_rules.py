"""Copy validated municipality rules into the app and rebuild the index.

  python3 tools/sync_rules.py

Reads research/rules/*.json, keeps the files that pass research/validate.py,
writes rules/<MUN>.json + rules/index.json, and a slim data/county_districts.json.
"""
import io
import json
import os
import sys
from contextlib import redirect_stdout

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'research'))
import validate  # noqa: E402

SRC = os.path.join(ROOT, 'research', 'rules')
DST = os.path.join(ROOT, 'rules')
os.makedirs(DST, exist_ok=True)
os.makedirs(os.path.join(ROOT, 'data'), exist_ok=True)

index, skipped = {}, []
for fn in sorted(os.listdir(SRC)):
    if not fn.endswith('.json'):
        continue
    path = os.path.join(SRC, fn)
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            ok = validate.validate(path)
    except Exception as e:  # unreadable JSON
        ok = False
        buf.write(str(e))
    if not ok:
        skipped.append((fn, buf.getvalue().strip().splitlines()[:3]))
        continue
    d = json.load(open(path))
    json.dump(d, open(os.path.join(DST, fn), 'w'), separators=(',', ':'))
    n_full = sum(1 for r in d['districts'].values() if all(r.get(k) is not None for k in ('front_ft', 'side_ft', 'rear_ft')))
    index[d['mun']] = {'name': d['name'], 'districts': len(d['districts']), 'with_setbacks': n_full,
                       'confidence': d.get('confidence'), 'retrieved': d.get('retrieved')}

json.dump(index, open(os.path.join(DST, 'index.json'), 'w'), indent=1)
keep = ('MUN', 'ZONING', 'ZONE_NAME', 'GENCODE', 'MIN_LOT', 'MAX_HGHT', 'STORIES', 'MAX_FAR', 'BLDG_COVER', 'TOT_COVERA')
county = json.load(open(os.path.join(ROOT, 'research', 'county_districts.json')))
json.dump([{k: c.get(k) for k in keep} for c in county], open(os.path.join(ROOT, 'data', 'county_districts.json'), 'w'), separators=(',', ':'))

print(f'{len(index)} municipalities synced: {", ".join(sorted(index))}')
for fn, why in skipped:
    print('SKIPPED', fn, why)
