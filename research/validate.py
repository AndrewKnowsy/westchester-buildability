"""Validate a municipality rules file, or list the county's districts for a municipality.

  python3 research/validate.py research/rules/BED.json     # check a rules file
  python3 research/validate.py --list BED                  # county zoning districts for BED
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
COUNTY = json.load(open(os.path.join(HERE, 'county_districts.json')))
RES_GEN = {'1', '2', '3', '4', '5'}
NUM_KEYS = ['min_lot_sf', 'min_frontage_ft', 'min_lot_width_ft', 'min_lot_depth_ft', 'front_ft', 'side_ft',
            'side_total_ft', 'rear_ft', 'corner_side_ft', 'max_height_ft', 'max_stories']
SPEC_KEYS = ['max_building_coverage', 'max_impervious_coverage', 'max_floor_area']


def county_for(mun):
    return [d for d in COUNTY if d['MUN'] == mun]


def check_spec(name, spec, errs, where):
    if spec is None:
        return
    if not isinstance(spec, dict):
        errs.append(f'{where}.{name}: must be an object or null'); return
    keys = set(spec) - {'note'}
    if keys == {'pct'} or keys == {'sf'} or keys == {'far'} or keys == {'text'}:
        v = next(spec[k] for k in keys)
        if keys != {'text'} and not isinstance(v, (int, float)):
            errs.append(f'{where}.{name}: {keys} value must be a number')
        return
    if 'bands' in keys:
        for i, b in enumerate(spec['bands']):
            if 'min' not in b:
                errs.append(f'{where}.{name}.bands[{i}]: needs min (sf)')
            if not any(k in b for k in ('sf', 'pct', 'far', 'base', 'pct_over')):
                errs.append(f'{where}.{name}.bands[{i}]: needs sf, pct, far, or base/pct_over/over')
        return
    errs.append(f'{where}.{name}: unknown shape {sorted(keys)}; use pct | sf | far | bands | text')


def validate(path):
    d = json.load(open(path))
    errs, warns = [], []
    for k in ('mun', 'name', 'code_url', 'districts', 'general', 'confidence'):
        if k not in d:
            errs.append(f'missing top-level key {k}')
    mun = d.get('mun')
    expected = {c['ZONING'] for c in county_for(mun) if str(c['GENCODE']).strip() in RES_GEN and '*' not in (c['ZONING'] or '')}
    got = set(d.get('districts', {}))
    for z in sorted(expected - got):
        warns.append(f'county residential district not covered: {z}')
    for z, r in d.get('districts', {}).items():
        w = f'districts[{z}]'
        for k in NUM_KEYS:
            if k in r and r[k] is not None and not isinstance(r[k], (int, float)):
                errs.append(f'{w}.{k}: must be a number or null (got {r[k]!r})')
        for k in SPEC_KEYS:
            check_spec(k, r.get(k), errs, w)
        if any(r.get(k) is not None for k in ('front_ft', 'side_ft', 'rear_ft')) and not r.get('source'):
            errs.append(f'{w}: has yard numbers but no source')
        if r.get('front_ft') is None:
            warns.append(f'{w}: no front yard recorded')
    g = d.get('general', {})
    for k in ('wetland_buffer_ft', 'watercourse_buffer_ft'):
        if k in g and g[k] is not None and not isinstance(g[k], (int, float)):
            errs.append(f'general.{k}: number or null')
    n_full = sum(1 for r in d.get('districts', {}).values() if all(r.get(k) is not None for k in ('front_ft', 'side_ft', 'rear_ft')))
    print(f'{os.path.basename(path)}: {len(got)} districts, {n_full} with front/side/rear; '
          f'{len(expected & got)}/{len(expected)} county residential districts covered')
    for e in errs:
        print('  ERROR', e)
    for w_ in warns:
        print('  warn ', w_)
    return not errs


if __name__ == '__main__':
    if sys.argv[1] == '--list':
        for c in county_for(sys.argv[2]):
            res = 'RES' if str(c['GENCODE']).strip() in RES_GEN else '   '
            print(res, json.dumps({k: c[k] for k in ('ZONING', 'ZONE_NAME', 'MIN_LOT', 'MAX_HGHT', 'STORIES', 'BLDG_COVER', 'TOT_COVERA', 'MAX_FAR')}))
    else:
        ok = all([validate(p) for p in sys.argv[1:]])
        sys.exit(0 if ok else 1)
