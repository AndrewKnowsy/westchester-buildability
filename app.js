/* Westchester Buildability — live parcel lookup + zoning rules + constraint screen.
   All geometry is NY State Plane East (EPSG:2260, US feet), requested straight from county GIS.
   Local drawing coordinates: x = east - x0, y = y1 - north (feet, y down). */
(() => {
'use strict';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const G = 'https://giswww.westchestergov.com/arcgis/rest/services';
const GEOCODER = `${G}/geocoding/GeocodeServer`;
const LAYERS = {
  parcels: 'DataHub_TaxParcels/MapServer/0',
  zoning: 'DataHub_EnvironmentandPlanning/MapServer/207',
  slopes: 'DataHub_EnvironmentandPlanning/MapServer/152',
  nysWet: 'DataHub_EnvironmentandPlanning/MapServer/217',
  nwi: 'DataHub_EnvironmentandPlanning/MapServer/154',
  flood: 'DataHub_EnvironmentandPlanning/MapServer/157',
  shed: 'DataHub_EnvironmentandPlanning/MapServer/148',
  bldg: 'DataHub_BasemapPlanimetrics/MapServer/5',
  drive: 'DataHub_BasemapPlanimetrics/MapServer/10',
  parking: 'DataHub_BasemapPlanimetrics/MapServer/9',
  streams: 'DataHub_BasemapPlanimetrics/MapServer/0',
  lakes: 'DataHub_BasemapPlanimetrics/MapServer/11',
  streets: 'DataHub_BasemapPlanimetrics/MapServer/13',
  walls: 'DataHub_BasemapPlanimetrics/MapServer/4',
  sewer: 'DataHub_Infrastructure/MapServer/152',
  contours: '2FtContours_WGS84/MapServer/0',
};
const AERIAL = `${G}/MappingWestchesterCounty_AerialPhoto2025/MapServer/export`;
const PARCEL_FIELDS = 'PRINT_KEY,SWIS,SBL,MUNI_NAME,CITYTOWN_NAME,PARCEL_ADDR,LOC_ZIP,PROP_CLASS,ACRES,YR_BLT,SQFT_LIVING,NBR_BEDROOMS,NBR_FULL_BATHS,SEWER_DESC,WATER_DESC,BLDG_STYLE_DESC,ROLL_YR';
const RES_GEN = new Set(['1', '2', '3', '4', '5']);
const DEFAULT_ADDRESS = '400 Jay St, Katonah, NY, 10536';  // John Jay Homestead, a public state historic site
const DEFAULT_BUFFER = 100;     // used only where we have no local rule
const DEC_ADJACENT = 100;       // NYS DEC freshwater wetland adjacent area
const KENSICO_MUNS = new Set(['NOC', 'HAR', 'MTP']);
const TEXT_SCALE = 0.8;         // plan labels about 10 px on screen; plain white, no outline
const LINKS = {
  irsp: 'https://www.nyc.gov/assets/dep/downloads/pdf/watershed-protection/regulations/applicants-guide-to-irsp.pdf',
  dos: 'https://dos.ny.gov/notice-adoption',
  aeba: 'https://spectrumlocalnews.com/nys/central-ny/politics/2025/11/12/new-york-agrees-to-delay-all-electric-buildings-mandate',
  dec: 'https://dec.ny.gov/nature/waterbodies/wetlands/freshwater-wetlands-program',
  fema: 'https://msc.fema.gov/portal/search',
  gis: 'https://giswww.westchestergov.com/arcgis/rest/services',
  spdes: 'https://dec.ny.gov/environmental-protection/water/water-quality/stormwater/construction-stormwater',
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const $ = s => document.querySelector(s);
const fmt = n => (n == null || !isFinite(n)) ? '–' : Math.round(n).toLocaleString('en-US');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = u => (typeof u === 'string' && /^https:\/\//.test(u)) ? u : null;
const link = (u, t) => safeUrl(u) ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)}</a>` : esc(t);
const title = s => String(s || '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
function store(k, v) { try { localStorage.setItem('wbuild:' + k, JSON.stringify(v)); } catch (e) {} }
function recall(k) { try { const v = localStorage.getItem('wbuild:' + k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }

async function getJson(url, params) {
  const u = new URL(url);
  if (params) u.search = new URLSearchParams(params);
  const res = await fetch(u);
  if (!res.ok) throw new Error(`Request failed (HTTP ${res.status})`);
  const json = await res.json();
  if (json && json.error) throw new Error(json.error.message || 'Request failed');
  return json;
}

// ---------------------------------------------------------------------------
// Planar geometry in local drawing coordinates
// ---------------------------------------------------------------------------
function inRing(p, r) { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const a = r[i], b = r[j]; if (((a[1] > p[1]) !== (b[1] > p[1])) && (p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0])) c = !c; } return c; }
function inPoly(p, poly) { let c = false; for (const r of poly) if (inRing(p, r)) c = !c; return c; }
function inAny(p, polys) { return !!polys && polys.some(poly => inPoly(p, poly)); }
function segDist(p, a, b) { const dx = b[0] - a[0], dy = b[1] - a[1]; const L2 = dx * dx + dy * dy; let t = L2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]); }
function cross(a, b, c) { return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); }
function segsIntersect(a, b, c, d) { const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d); return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0)); }
function segSeg(a, b, c, d) { if (segsIntersect(a, b, c, d)) return 0; return Math.min(segDist(a, c, d), segDist(b, c, d), segDist(c, a, b), segDist(d, a, b)); }
function distRectToLines(rect, lines) { let m = Infinity; for (let k = 0; k < rect.length; k++) { const a = rect[k], b = rect[(k + 1) % rect.length]; for (const ln of lines) for (let i = 0; i < ln.length - 1; i++) m = Math.min(m, segSeg(a, b, ln[i], ln[i + 1])); } return m; }
function distPtToLines(p, lines) { let m = Infinity; for (const ln of lines) for (let i = 0; i < ln.length - 1; i++) m = Math.min(m, segDist(p, ln[i], ln[i + 1])); return m; }
function polysToLines(polys) { return (polys || []).flat(); }
function rectCorners(p) { const t = p.rot * Math.PI / 180, c = Math.cos(t), s = Math.sin(t), hw = p.w / 2, hd = p.d / 2; return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([x, y]) => [p.cx + x * c - y * s, p.cy + x * s + y * c]); }
function rectSamples(p) { const t = p.rot * Math.PI / 180, c = Math.cos(t), s = Math.sin(t); const nx = Math.max(4, Math.min(28, Math.round(p.w / 1.5))), ny = Math.max(4, Math.min(28, Math.round(p.d / 1.5))); const pts = []; for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) { const x = -p.w / 2 + (i + .5) * p.w / nx, y = -p.d / 2 + (j + .5) * p.d / ny; pts.push([p.cx + x * c - y * s, p.cy + x * s + y * c]); } return pts; }
function ringPath(r) { return r.length ? 'M' + r.map(q => q[0].toFixed(1) + ' ' + q[1].toFixed(1)).join('L') + 'Z' : ''; }
function polysPath(polys) { return (polys || []).map(poly => poly.map(ringPath).join('')).join(''); }
function linesPath(lines) { return (lines || []).filter(l => l.length > 1).map(l => 'M' + l.map(q => q[0].toFixed(1) + ' ' + q[1].toFixed(1)).join('L')).join(''); }
function centroid(r) { let x = 0, y = 0; for (const q of r) { x += q[0]; y += q[1]; } return [x / r.length, y / r.length]; }

// ---------------------------------------------------------------------------
// JSTS bridge (feet)
// ---------------------------------------------------------------------------
const reader = new jsts.io.GeoJSONReader();
const factory = new jsts.geom.GeometryFactory();
function jread(geojsonGeom) { try { const g = reader.read(geojsonGeom); return g.isValid() ? g : g.buffer(0); } catch (e) { return null; } }
function junion(geoms) {
  const gs = geoms.filter(g => g && !g.isEmpty());
  if (!gs.length) return factory.createGeometryCollection([]);
  try { return jsts.operation.union.UnaryUnionOp.union(factory.createGeometryCollection(gs)); }
  catch (e) { return gs.reduce((a, b) => { try { return a.union(b); } catch (_) { return a; } }); }
}
function jpoint(x, y) { return factory.createPoint(new jsts.geom.Coordinate(x, y)); }
function jline(coords) { return factory.createLineString(coords.map(([x, y]) => new jsts.geom.Coordinate(x, y))); }
function parts(g) { const out = []; if (!g || g.isEmpty()) return out; const n = g.getNumGeometries(); for (let i = 0; i < n; i++) { const p = g.getGeometryN(i); if (p.getNumGeometries && p.getNumGeometries() > 1 && p !== g) out.push(...parts(p)); else out.push(p); } return out; }
function safeOp(fn, fallback) { try { return fn(); } catch (e) { console.warn(e); return fallback; } }

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------
let RULES_INDEX = {}, COUNTY = new Map();
const RULE_CACHE = {};
async function loadRuleData() {
  const [idx, county] = await Promise.all([
    fetch('rules/index.json', { cache: 'no-cache' }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
    fetch('data/county_districts.json').then(r => r.ok ? r.json() : []).catch(() => []),
  ]);
  RULES_INDEX = idx || {};
  for (const d of county) COUNTY.set(`${d.MUN}|${d.ZONING}`, d);
}
async function rulesFile(mun) {
  if (!mun || !/^[A-Z]{3}$/.test(mun)) return null;
  if (!(mun in RULE_CACHE)) RULE_CACHE[mun] = await fetch(`rules/${mun}.json`, { cache: 'no-cache' }).then(r => r.ok ? r.json() : null).catch(() => null);
  return RULE_CACHE[mun];
}
const norm = s => String(s || '').toUpperCase().replace(/[\s\-_.]/g, '');
function findDistrict(file, zoning) {
  if (!file || !file.districts) return null;
  if (file.districts[zoning]) return { key: zoning, r: file.districts[zoning] };
  const want = norm(zoning);
  for (const [k, r] of Object.entries(file.districts)) if (norm(k) === want) return { key: k, r };
  if (zoning && zoning.includes('*')) { const first = zoning.split('*')[0]; return findDistrict(file, first); }
  return null;
}
function evalSpec(spec, A) {
  if (!spec) return null;
  const bandValue = b => b.sf != null ? b.sf : b.pct != null ? b.pct / 100 * A : b.far != null ? b.far * A : (b.base || 0) + (b.pct_over || 0) / 100 * (A - (b.over || 0));
  if (spec.pct != null) return { v: spec.pct / 100 * A, how: `${spec.pct}% of lot area` };
  if (spec.far != null) return { v: spec.far * A, how: `FAR ${spec.far}` };
  if (spec.sf != null) return { v: spec.sf, how: `${fmt(spec.sf)} sf` };
  if (spec.bands) {
    const b = spec.bands.find(b => A >= (b.min || 0) && (b.max == null || A < b.max));
    if (!b) return { v: null, how: 'no band in the code covers this lot size' };
    const how = b.sf != null ? `${fmt(b.sf)} sf for lots of ${fmt(b.min)}${b.max ? '–' + fmt(b.max) : '+'} sf`
      : b.pct != null ? `${b.pct}% of lot area` : b.far != null ? `FAR ${b.far}`
      : `${fmt(b.base || 0)} sf + ${b.pct_over}% of lot area over ${fmt(b.over || 0)} sf`;
    return { v: bandValue(b), how };
  }
  if (spec.text) return { v: null, how: spec.text };
  return null;
}
function num(v) { const n = typeof v === 'string' ? parseFloat(v) : v; return (n == null || !isFinite(n) || n <= 0) ? null : n; }

// Resolve the rules for a municipality + district with provenance for every field.
async function resolveRules(mun, zoning) {
  const file = await rulesFile(mun);
  const hit = findDistrict(file, zoning);
  const r = hit ? hit.r : null;
  const cd = COUNTY.get(`${mun}|${zoning}`) || (zoning && zoning.includes('*') ? COUNTY.get(`${mun}|${zoning.split('*')[0]}`) : null);
  const manual = recall(`manual:${mun}|${zoning}`) || {};
  const out = { mun, zoning, file, district: r, districtKey: hit ? hit.key : null, county: cd, prov: {} };
  const pick = (key, codeVal, countyVal) => {
    if (manual[key] != null) { out.prov[key] = 'manual'; return manual[key]; }
    if (codeVal != null) { out.prov[key] = 'code'; return codeVal; }
    if (countyVal != null) { out.prov[key] = 'county'; return countyVal; }
    out.prov[key] = 'none'; return null;
  };
  out.front = pick('front', r && r.front_ft, null);
  out.side = pick('side', r && r.side_ft, null);
  out.side_total = r ? r.side_total_ft ?? null : null;
  out.rear = pick('rear', r && r.rear_ft, null);
  out.corner_side = r ? r.corner_side_ft ?? null : null;
  out.min_lot = pick('min_lot', r && r.min_lot_sf, cd && num(cd.MIN_LOT));
  out.frontage = r ? (r.min_frontage_ft ?? r.min_lot_width_ft ?? null) : null;
  out.depth = r ? r.min_lot_depth_ft ?? null : null;
  out.height = pick('height', r && r.max_height_ft, cd && num(cd.MAX_HGHT));
  out.stories = pick('stories', r && r.max_stories, cd && num(cd.STORIES));
  out.bc = pick('bc', r && r.max_building_coverage, cd && num(cd.BLDG_COVER) ? { pct: num(cd.BLDG_COVER) } : null);
  out.dc = pick('dc', r && r.max_impervious_coverage, cd && num(cd.TOT_COVERA) ? { pct: num(cd.TOT_COVERA) } : null);
  out.fa = pick('fa', r && r.max_floor_area, cd && num(cd.MAX_FAR) ? { far: num(cd.MAX_FAR) } : null);
  out.accessory = r && r.accessory ? r.accessory : null;
  out.general = (file && file.general) || null;
  out.name = (r && r.name) || (cd && cd.ZONE_NAME) || '';
  out.residential = cd ? RES_GEN.has(String(cd.GENCODE).trim()) : !!r;
  return out;
}

// ---------------------------------------------------------------------------
// Lookup pipeline
// ---------------------------------------------------------------------------
const LOCATOR_RANK = { TaxParcel: 0, AddressPoints: 1, Street: 2 };
async function geocode(text, magicKey) {
  const params = { SingleLine: text, outSR: 2260, maxLocations: 6, outFields: 'Loc_name,Addr_type', f: 'json' };
  if (magicKey) params.magicKey = magicKey;
  const json = await getJson(`${GEOCODER}/findAddressCandidates`, params);
  const c = (json.candidates || []).filter(c => c.score >= 80)
    .sort((a, b) => ((LOCATOR_RANK[a.attributes.Loc_name] ?? 9) - (LOCATOR_RANK[b.attributes.Loc_name] ?? 9)) || (b.score - a.score));
  return c[0] ? { x: c[0].location.x, y: c[0].location.y, label: c[0].address } : null;
}
async function suggestAddresses(text) {
  const json = await getJson(`${GEOCODER}/suggest`, { text, maxSuggestions: 6, f: 'json' });
  return json.suggestions || [];
}
function queryLayer(key, params) {
  return getJson(`${G}/${LAYERS[key]}/query`, Object.assign({ spatialRel: 'esriSpatialRelIntersects', inSR: 2260, outSR: 2260, outFields: '*', returnGeometry: true, f: 'geojson' }, params))
    .then(j => (j.features || []).filter(f => f.geometry));
}
function queryEnv(key, b, extra) {
  return queryLayer(key, Object.assign({ geometry: `${b[0]},${b[1]},${b[2]},${b[3]}`, geometryType: 'esriGeometryEnvelope' }, extra || {}));
}

async function findParcel(pt) {
  let feats = await queryLayer('parcels', { geometry: `${pt.x},${pt.y}`, geometryType: 'esriGeometryPoint', outFields: PARCEL_FIELDS });
  if (!feats.length) feats = await queryLayer('parcels', { geometry: `${pt.x},${pt.y}`, geometryType: 'esriGeometryPoint', distance: 120, units: 'esriSRUnit_Foot', outFields: PARCEL_FIELDS });
  if (!feats.length) return null;
  const P = jpoint(pt.x, pt.y);
  const scored = feats.map(f => ({ f, g: jread(f.geometry) })).filter(o => o.g).map(o => ({ ...o, d: o.g.distance(P) })).sort((a, b) => a.d - b.d);
  const best = scored[0];
  // A property is often several tax parcels sharing one address (a house lot plus side lots).
  // Gather every touching parcel with the same address in the same tax district and treat them as one lot.
  const group = [{ f: best.f, g: best.g }];
  const addr = (best.f.properties.PARCEL_ADDR || '').trim(), swis = best.f.properties.SWIS;
  if (addr && swis) {
    const sib = await queryLayer('parcels', { where: `PARCEL_ADDR='${addr.replace(/'/g, "''")}' AND SWIS='${String(swis).replace(/'/g, "''")}'`, outFields: PARCEL_FIELDS }).catch(() => []);
    const cands = sib.map(f => ({ f, g: jread(f.geometry) })).filter(o => o.g && o.f.properties.PRINT_KEY !== best.f.properties.PRINT_KEY);
    for (let grown = true; grown;) {
      grown = false;
      const U = junion(group.map(o => o.g));
      for (let i = cands.length - 1; i >= 0; i--) if (cands[i].g.distance(U) < 3) { group.push(cands[i]); cands.splice(i, 1); grown = true; }
    }
  }
  // close hairline gaps between the pieces
  let g = group.length > 1 ? safeOp(() => junion(group.map(o => o.g)).buffer(2, 8).buffer(-2, 8), best.g) : best.g;
  const multipart = g.getNumGeometries() > 1;
  if (multipart) g = parts(g).sort((a, b) => a.distance(P) - b.distance(P) || b.getArea() - a.getArea())[0];
  // assessor fields from the parcel that carries the house
  const isRes = o => /^2/.test(String(o.f.properties.PROP_CLASS || ''));
  const primary = group.slice().sort((a, b) => (isRes(b) - isRes(a)) || ((b.f.properties.SQFT_LIVING || 0) - (a.f.properties.SQFT_LIVING || 0)) || (b.g.getArea() - a.g.getArea()))[0];
  return {
    attrs: primary.f.properties, geom: g, multipart,
    fullArea: group.reduce((s, o) => s + o.g.getArea(), 0),
    group: group.map(o => ({ key: `${o.f.properties.SWIS}|${o.f.properties.PRINT_KEY}`, printKey: o.f.properties.PRINT_KEY, acres: o.f.properties.ACRES, cls: o.f.properties.PROP_CLASS })),
  };
}

async function lookup(text, magicKey) {
  const loc = await geocode(text, magicKey);
  if (!loc) throw new Error(`The county address search couldn't find "${text}". Try the street number and name with the town.`);
  const parcel = await findParcel(loc);
  if (!parcel) throw new Error('No tax parcel found at that address.');
  const env = parcel.geom.getEnvelopeInternal();
  const w = env.getWidth(), h = env.getHeight(), maxDim = Math.max(w, h);
  const m = Math.max(90, Math.min(350, maxDim * 0.2));
  let x0 = env.getMinX() - m, y0 = env.getMinY() - m, x1 = env.getMaxX() + m, y1 = env.getMaxY() + m;
  // keep a pleasant aspect (between 1.2 and 1.8 wide)
  const fw = x1 - x0, fh = y1 - y0;
  if (fw / fh < 1.25) { const add = (fh * 1.25 - fw) / 2; x0 -= add; x1 += add; }
  if (fw / fh > 1.9) { const add = (fw / 1.9 - fh) / 2; y0 -= add; y1 += add; }
  const bbox = [x0, y0, x1, y1];
  const big = Math.max(x1 - x0, y1 - y0) > 2400;
  const settled = await Promise.allSettled([
    queryEnv('zoning', bbox, { outFields: 'MUN,ZONING,ZONE_NAME,GENCODE,OVERLAY' }),
    queryEnv('slopes', bbox, { outFields: 'SLOPE,GRID_CODE' }),
    queryEnv('nysWet', bbox),
    queryEnv('nwi', bbox, { outFields: 'WETLAND_TYPE,ATTRIBUTE,ACRES' }),
    queryEnv('flood', bbox),
    queryEnv('shed', bbox, { outFields: 'MAJNAME' }),
    queryEnv('bldg', bbox, { outFields: 'ACTUAL_HEIGHT,BASE_ELEVATION,APPROX_ROOF_ELEVATION,PHOTO_DATE' }),
    queryEnv('drive', bbox, { outFields: 'OBJECTID' }),
    queryEnv('parking', bbox, { outFields: 'OBJECTID' }),
    queryEnv('streams', bbox, { outFields: 'NAME' }),
    queryEnv('lakes', bbox, { outFields: 'NAME' }),
    queryEnv('streets', bbox, { outFields: 'NAME' }),
    queryEnv('parcels', bbox, { outFields: 'SWIS,PRINT_KEY,PARCEL_ADDR,ACRES' }),
    queryEnv('sewer', [x0 - 200, y0 - 200, x1 + 200, y1 + 200], { outFields: 'OBJECTID' }),
    big ? Promise.resolve([]) : queryEnv('contours', bbox, { outFields: 'ELEV', maxAllowableOffset: 1 }),
  ]);
  const K = ['zoning', 'slopes', 'nysWet', 'nwi', 'flood', 'shed', 'bldg', 'drive', 'parking', 'streams', 'lakes', 'streets', 'parcels', 'sewer', 'contours'];
  const L = {}, failed = [];
  settled.forEach((s, i) => { L[K[i]] = s.status === 'fulfilled' ? s.value : []; if (s.status !== 'fulfilled') failed.push(K[i]); });
  return buildSite(loc, parcel, bbox, L, failed);
}

function buildSite(loc, parcel, bbox, L, failed) {
  const [x0, y0, x1, y1] = bbox;
  const W = x1 - x0, H = y1 - y0;
  const xy = (x, y) => [x - x0, y1 - y];
  const toPolys = g => { const out = []; for (const p of parts(g)) { if (p.getGeometryType() !== 'Polygon' || p.isEmpty()) continue; const rings = [p.getExteriorRing()]; for (let i = 0; i < p.getNumInteriorRing(); i++) rings.push(p.getInteriorRingN(i)); out.push(rings.map(r => r.getCoordinates().map(c => xy(c.x, c.y)))); } return out; };
  const toLines = g => parts(g).filter(p => /LineString|LinearRing/.test(p.getGeometryType())).map(p => p.getCoordinates().map(c => xy(c.x, c.y)));
  const frameG = jread({ type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] });
  const clip = g => safeOp(() => g.intersection(frameG), g);
  const readAll = fs => fs.map(f => ({ p: f.properties || {}, g: jread(f.geometry) })).filter(o => o.g && !o.g.isEmpty());

  const pg = parcel.geom;
  const P = pg.getInteriorPoint();
  // zoning shares
  const zf = readAll(L.zoning).map(o => ({ ...o, share: safeOp(() => o.g.intersection(pg).getArea(), 0) })).filter(o => o.share > 1).sort((a, b) => b.share - a.share);
  const zones = zf.map(o => ({ mun: o.p.MUN, zoning: o.p.ZONING, name: o.p.ZONE_NAME, gencode: String(o.p.GENCODE || '').trim(), overlay: (o.p.OVERLAY || '').trim(), share: o.share / pg.getArea() }));
  // buildings in the lot
  const bl = readAll(L.bldg).map(o => ({ ...o, inLot: safeOp(() => o.g.intersection(pg).getArea(), 0) }));
  const mine = bl.filter(o => o.inLot > 20).sort((a, b) => b.inLot - a.inLot);
  const house = mine[0] || null;
  const driveG = junion(readAll(L.drive).concat(readAll(L.parking)).map(o => o.g));
  const driveIn = safeOp(() => driveG.intersection(pg), null);
  // neighbours
  const selfKeys = new Set(parcel.group.map(x => x.key));
  // "huge" = a road right-of-way artifact: an outline far bigger than the parcel's assessed acreage
  // (a genuine 100-acre estate next door stays a neighbour)
  const rowLike = o => { const a = o.g.getArea(), ac = +o.p.ACRES || 0; return ac > 0 ? a > 20 * 43560 && a > 5 * ac * 43560 : a > 50 * 43560; };
  const nbrs = readAll(L.parcels).filter(o => !selfKeys.has(`${o.p.SWIS}|${o.p.PRINT_KEY}`)).map(o => ({ ...o, huge: rowLike(o) }));
  // streets
  const streets = readAll(L.streets);
  const streetsG = junion(streets.map(o => o.g));
  // water + constraints
  const streamsG = junion(readAll(L.streams).map(o => o.g));
  const lakesG = junion(readAll(L.lakes).map(o => o.g));
  const nysG = junion(readAll(L.nysWet).map(o => o.g));
  const nwiG = junion(readAll(L.nwi).map(o => o.g));
  const floodG = junion(readAll(L.flood).map(o => o.g));
  const sl = readAll(L.slopes);
  const s1525G = junion(sl.filter(o => +o.p.GRID_CODE === 2).map(o => o.g));
  const s25G = junion(sl.filter(o => +o.p.GRID_CODE === 3).map(o => o.g));
  const sheds = readAll(L.shed).filter(o => o.g.distance(P) < 1).map(o => o.p.MAJNAME);
  const sewerD = L.sewer.length ? Math.min(...readAll(L.sewer).map(o => o.g.distance(pg))) : Infinity;

  const site = {
    loc, bbox, W, H, xy, toPolys, toLines, failed,
    attrs: parcel.attrs, multipart: parcel.multipart, group: parcel.group,
    pg, area: pg.getArea(), fullArea: parcel.fullArea,
    ring: toPolys(pg)[0][0],
    zones,
    house: house ? { ring: toPolys(house.g)[0] ? toPolys(house.g)[0][0] : [], g: house.g, area: house.g.getArea(), p: house.p } : null,
    bldgInLot: mine.reduce((s, o) => s + o.inLot, 0),
    others: bl.filter(o => o !== house).map(o => toPolys(o.g)).flat(),
    drivePolys: driveIn ? toPolys(driveIn) : [], driveArea: driveIn ? driveIn.getArea() : 0,
    nbrs, streets, streetsG,
    streamsG, lakesG, nysG, nwiG, floodG, s1525G, s25G,
    stream: toLines(clip(streamsG)), ponds: toPolys(clip(lakesG)),
    nys: toPolys(clip(nysG)), nwi: toPolys(clip(nwiG)), flood: toPolys(clip(floodG)),
    s1525: toPolys(clip(s1525G)), s25: toPolys(clip(s25G)),
    sheds, sewerD,
    walls: [],
    contours: L.contours.map(f => ({ elev: f.properties.ELEV, g: jread(f.geometry) })).filter(o => o.g).map(o => ({ elev: o.elev, lines: toLines(o.g) })),
    neighborsDraw: nbrs.filter(o => !o.huge).map(o => ({ rings: toPolys(clip(o.g)).map(p => p[0]), area: o.g.getArea(), label: (() => { const c = safeOp(() => clip(o.g).getInteriorPoint(), null); return c && !c.isEmpty() ? xy(c.getX(), c.getY()) : null; })(), address: title(o.p.PARCEL_ADDR || '') })),
    aerial: `${AERIAL}?` + new URLSearchParams({ bbox: bbox.join(','), bboxSR: 2260, imageSR: 2260, size: `${Math.round(Math.min(1800, W * Math.min(2, 1800 / W)))},${Math.round(Math.min(1800, W * Math.min(2, 1800 / W)) * H / W)}`, format: 'jpg', transparent: false, f: 'image' }),
  };
  site.lotlines = classifyLotLines(site);
  return site;
}

// Split the parcel boundary into front / side / rear lot lines.
function classifyLotLines(site) {
  const pg = site.pg;
  const coords = pg.getExteriorRing().getCoordinates().map(c => [c.x, c.y]);
  const n = coords.length - 1;
  const nearestStreet = pt => { let best = null; for (const s of site.streets) { const d = s.g.distance(pt); if (!best || d < best.d) best = { d, name: (s.p.NAME || '').trim() }; } return best || { d: Infinity, name: '' }; };
  const edges = [];
  for (let i = 0; i < n; i++) {
    const a = coords[i], b = coords[i + 1];
    const mid = jpoint((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
    const st = nearestStreet(mid);
    const nb = site.nbrs.find(o => !o.huge && o.g.distance(mid) < 3);
    // an edge no neighbouring parcel touches is street right-of-way; up to 90 ft from a named street
    // reaches round cul-de-sac bulbs (unnamed centrelines are often private drives, so keep those at 45 ft)
    const front = !nb && (st.d <= 45 || (st.d <= 90 && !!st.name));
    edges.push({ a, b, front, key: front ? 'F' : nb ? 'N:' + nb.p.PRINT_KEY : 'X', street: st.name, abut: front ? (st.name ? title(st.name) : 'street') : nb ? (title(nb.p.PARCEL_ADDR) || nb.p.PRINT_KEY) : 'no mapped parcel', dStreet: st.d });
  }
  // rotate so we start at a boundary between groups
  let start = edges.findIndex((e, i) => e.key !== edges[(i - 1 + n) % n].key);
  if (start < 0) start = 0;
  const ordered = edges.slice(start).concat(edges.slice(0, start));
  const groups = [];
  for (const e of ordered) {
    const g = groups[groups.length - 1];
    if (g && g.key === e.key) g.edges.push(e); else groups.push({ key: e.key, front: e.front, abut: e.abut, edges: [e] });
  }
  if (groups.length > 1 && groups[0].key === groups[groups.length - 1].key) { const last = groups.pop(); groups[0].edges = last.edges.concat(groups[0].edges); }
  for (const g of groups) {
    const pts = [g.edges[0].a, ...g.edges.map(e => e.b)];
    g.coords = pts; g.geom = jline(pts); g.length = g.geom.getLength();
    g.minStreet = Math.min(...g.edges.map(e => e.dStreet));
  }
  let fronts = groups.filter(g => g.front);
  let inferred = false;
  if (!fronts.length && groups.length) { const g = groups.slice().sort((a, b) => a.minStreet - b.minStreet)[0]; g.front = true; fronts = [g]; inferred = true; }
  const frontsG = junion(fronts.map(g => g.geom));
  const rest = groups.filter(g => !g.front);
  rest.forEach(g => g.df = g.geom.getCentroid().distance(frontsG));
  const rear = rest.length > 1 ? rest.slice().sort((a, b) => b.df - a.df)[0] : null;
  groups.forEach(g => g.kind = g.front ? 'front' : g === rear ? 'rear' : 'side');
  // a second, shorter street line on a corner lot is the "corner side" if the code sets one
  if (fronts.length > 1) fronts.slice().sort((a, b) => b.length - a.length).slice(1).forEach(g => g.secondaryFront = true);
  groups.inferred = inferred;
  groups.forEach((g, i) => { g.id = i; g.lines = [g.coords.map(([x, y]) => site.xy(x, y))]; });
  return groups;
}

// Setback envelope + constraint layers that depend on the rules in force.
function computeEnvelope(site, R) {
  const L = site.lotlines;
  const sbFor = g => g.kind === 'front' ? (g.secondaryFront && R.corner_side != null ? R.corner_side : R.front) : g.kind === 'rear' ? R.rear : R.side;
  const missing = L.some(g => sbFor(g) == null);
  let env = null;
  if (!missing) env = safeOp(() => site.pg.difference(junion(L.map(g => g.geom.buffer(sbFor(g), 8)))), null);
  const gen = R.general || {};
  const hasFile = !!R.file;
  const wcBuf = hasFile ? num(gen.watercourse_buffer_ft) : DEFAULT_BUFFER;
  const wlBuf = hasFile ? num(gen.wetland_buffer_ft) : DEFAULT_BUFFER;
  const waterParts = [];
  if (wcBuf) waterParts.push(safeOp(() => junion([site.streamsG, site.lakesG]).buffer(wcBuf, 8), null));
  if (wlBuf) waterParts.push(safeOp(() => junion([site.nwiG, site.nysG]).buffer(wlBuf, 8), null));
  waterParts.push(safeOp(() => site.nysG.buffer(DEC_ADJACENT, 8), null));
  waterParts.push(site.lakesG, site.nysG, site.nwiG);
  const waterG = junion(waterParts.filter(Boolean));
  const frameG = jread({ type: 'Polygon', coordinates: [[[site.bbox[0], site.bbox[1]], [site.bbox[2], site.bbox[1]], [site.bbox[2], site.bbox[3]], [site.bbox[0], site.bbox[3]], [site.bbox[0], site.bbox[1]]]] });
  const consG = junion([waterG, site.floodG, site.s1525G, site.s25G]);
  const clear = env ? safeOp(() => env.difference(consG), env) : null;
  return {
    sbFor, missing, wcBuf, wlBuf, assumedBuffer: !hasFile,
    envelope: env ? site.toPolys(env) : [], envArea: env ? env.getArea() : null,
    clear: clear ? site.toPolys(clear) : [], clearArea: clear ? clear.getArea() : null,
    water: site.toPolys(safeOp(() => waterG.intersection(frameG), waterG)),
    waterInLot: safeOp(() => waterG.intersection(site.pg).getArea(), 0),
    floodInLot: safeOp(() => site.floodG.intersection(site.pg).getArea(), 0),
    s1525InLot: safeOp(() => site.s1525G.intersection(site.pg).getArea(), 0),
    s25InLot: safeOp(() => site.s25G.intersection(site.pg).getArea(), 0),
    streamInLot: safeOp(() => site.streamsG.intersection(site.pg).getLength(), 0),
    nysNear: !site.nysG.isEmpty() && site.nysG.distance(site.pg) < DEC_ADJACENT,
    houseDist: site.house ? Object.fromEntries(['front', 'side', 'rear'].map(k => [k, Math.min(...L.filter(g => g.kind === k).map(g => site.house.g.distance(g.geom)), Infinity)])) : null,
    waterLines: site.stream.concat(polysToLines(site.ponds), polysToLines(site.nwi), polysToLines(site.nys)),
  };
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------
const TYPES = {
  addition: { label: 'Addition to the house', w: 22, d: 26, stories: 2, height: 26, bc: 1, dc: 1, fa: 1, kind: 'principal' },
  garage:   { label: 'Detached garage', w: 24, d: 24, stories: 1, height: 12, bc: 1, dc: 1, fa: .5, kind: 'accessory' },
  adu:      { label: 'Accessory apartment cottage', w: 24, d: 30, stories: 1, height: 12, bc: 1, dc: 1, fa: 1, kind: 'accessory', adu: true },
  pool:     { label: 'Pool and terrace', w: 24, d: 44, stories: 0, height: 0, bc: 0, dc: 1, fa: 0, kind: 'pool' },
  shed:     { label: 'Shed', w: 10, d: 12, stories: 1, height: 11, bc: 1, dc: 1, fa: 0, kind: 'accessory' },
  deck:     { label: 'Deck', w: 16, d: 20, stories: 0, height: 0, bc: 1, dc: 1, fa: 0, kind: 'deck' },
  terrace:  { label: 'Patio or terrace', w: 20, d: 24, stories: 0, height: 0, bc: 0, dc: 1, fa: 0, kind: 'terrace' },
  house:    { label: 'New or replacement house', w: 56, d: 42, stories: 2, height: 30, bc: 1, dc: 1, fa: 1, kind: 'principal', newHouse: true },
};
let SITE = null, R = null, ENV = null, state = null, view = null, svg, projG, layers = {}, DEF = null;
const LAYER_DEFS = [
  { id: 'aerial', label: 'Aerial 2025', sw: 'linear-gradient(135deg,#6b5a3e,#4f6b3a)', on: true },
  { id: 'contours', label: '2-ft contours', sw: 'repeating-linear-gradient(0deg,#9aa 0 1px,transparent 1px 4px)', on: true },
  { id: 'env', label: 'Setback envelope', sw: 'linear-gradient(#ff4f8b,#ff4f8b) center/100% 2px no-repeat, rgba(64,214,128,.45)', on: true },
  { id: 'water', label: 'Water + buffers', sw: 'rgba(80,180,255,.55)', on: true },
  { id: 'flood', label: 'FEMA flood zone', sw: 'repeating-linear-gradient(0deg,#3d7bd9 0 2px,transparent 2px 5px)', on: true },
  { id: 'slopes', label: 'Steep slopes', sw: 'repeating-linear-gradient(45deg,#f2b134 0 2px,transparent 2px 5px)', on: true },
  { id: 'context', label: 'Neighbours', sw: 'repeating-linear-gradient(90deg,#999 0 4px,transparent 4px 7px)', on: true },
];
const NS = 'http://www.w3.org/2000/svg';
function el(tag, attrs, parent) { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; }

// ---------------------------------------------------------------------------
// Plan drawing
// ---------------------------------------------------------------------------
function drawPlan() {
  const S = SITE, W = S.W, H = S.H;
  svg = $('#plan'); svg.innerHTML = ''; svg._z = null;
  layers = {};
  const defs = el('defs', {}, svg);
  // Size text and hatching to the screen, not to the lot, so a small lot reads like a big one
  // (~12 px labels at "fit"). Line widths are screen pixels via vector-effect in the CSS.
  const px = $('#planbox').clientWidth || 900;
  const k = Math.max(0.15, Math.min(4, W / px * 1.1));
  const kt = k * TEXT_SCALE;   // text size factor
  S.k = k; S.kt = kt;
  const hatch = (id, size, rot, fill, stroke, sw, horizontal) => {
    const s = size * k, p = el('pattern', { id, width: s, height: s, patternUnits: 'userSpaceOnUse', patternTransform: rot ? `rotate(${rot})` : '' }, defs);
    el('rect', { width: s, height: s, fill }, p);
    el('line', horizontal ? { x1: 0, y1: s / 2, x2: s, y2: s / 2, stroke, 'stroke-width': sw * k } : { x1: 0, y1: 0, x2: 0, y2: s, stroke, 'stroke-width': sw * k }, p);
  };
  hatch('hatch1525', 7, 45, 'rgba(242,177,52,.10)', '#f2b134', 1.6);
  hatch('hatch25', 5, -45, 'rgba(255,106,61,.16)', '#ff6a3d', 1.7);
  hatch('hatchflood', 6, 0, 'rgba(61,123,217,.18)', '#3d7bd9', 1.4, true);
  const g = id => (layers[id] = el('g', { 'data-layer': id }, svg));

  g('aerial'); el('image', { href: S.aerial, x: 0, y: 0, width: W, height: H, preserveAspectRatio: 'none' }, layers.aerial);
  g('contours');
  for (const c of S.contours) el('path', { d: linesPath(c.lines), class: 'p-contour' + (Math.round(c.elev) % 10 === 0 ? ' ix' : '') }, layers.contours);
  const placed = [];
  for (const c of S.contours) {
    if (Math.round(c.elev) % 10 !== 0) continue;
    for (const ln of c.lines) {
      if (ln.length < 6) continue;
      const p = ln[Math.floor(ln.length / 2)];
      if (p[0] < 20 * k || p[1] < 20 * k || p[0] > W - 20 * k || p[1] > H - 20 * k || placed.some(q => Math.hypot(q[0] - p[0], q[1] - p[1]) < 90 * k)) continue;
      placed.push(p);
      el('text', { x: p[0], y: p[1], class: 'p-clab', 'text-anchor': 'middle', 'dominant-baseline': 'middle', 'font-size': 7 * kt }, layers.contours).textContent = Math.round(c.elev);
    }
  }
  g('context');
  for (const n of S.neighborsDraw) el('path', { d: n.rings.map(ringPath).join(''), class: 'p-nbr' }, layers.context);
  for (const p of S.others) el('path', { d: polysPath([p]), class: 'p-bldg' }, layers.context);
  // one label per address (a neighbour can own several tax parcels), on its largest piece
  const labelled = new Set();
  for (const n of S.neighborsDraw.slice().sort((a, b) => b.area - a.area)) {
    if (!n.address || !n.label || labelled.has(n.address)) continue;
    labelled.add(n.address);
    const [x, y] = n.label;
    if (x < 30 * k || y < 16 * k || x > W - 30 * k || y > H - 10 * k || inRing(n.label, S.ring)) continue;
    el('text', { x, y, class: 'p-nlab', 'text-anchor': 'middle', 'font-size': 11 * kt }, layers.context).textContent = n.address;
  }
  const named = {};
  for (const s of S.streets) { const nm = (s.p.NAME || '').trim(); if (!nm) continue; const ls = S.toLines(s.g); for (const l of ls) if (!named[nm] || l.length > named[nm].length) named[nm] = l; }
  for (const [nm, ln] of Object.entries(named)) {
    if (ln.length < 3) continue;
    const i = Math.floor(ln.length * .5), a = ln[Math.max(0, i - 2)], b = ln[Math.min(ln.length - 1, i + 2)], p = ln[i];
    if (p[0] < 0 || p[1] < 0 || p[0] > W || p[1] > H) continue;
    let ang = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI; if (ang > 90) ang -= 180; if (ang < -90) ang += 180;
    el('text', { x: p[0], y: p[1], class: 'p-street', 'text-anchor': 'middle', 'dominant-baseline': 'middle', 'font-size': 12 * kt, transform: `rotate(${ang.toFixed(1)} ${p[0]} ${p[1]})` }, layers.context).textContent = nm;
  }
  g('slopes');
  el('path', { d: polysPath(S.s1525), class: 'p-s1525', 'fill-rule': 'evenodd' }, layers.slopes);
  el('path', { d: polysPath(S.s25), class: 'p-s25', 'fill-rule': 'evenodd' }, layers.slopes);
  g('flood');
  el('path', { d: polysPath(S.flood), fill: 'url(#hatchflood)', stroke: '#3d7bd9', 'stroke-width': 1.2, 'fill-rule': 'evenodd' }, layers.flood);
  g('water');
  el('path', { d: polysPath(ENV.water), class: 'p-buf', 'fill-rule': 'evenodd' }, layers.water);
  el('path', { d: polysPath(S.nys), fill: 'rgba(40,140,210,.45)', stroke: '#2c8fd6', 'stroke-width': 1.2, 'fill-rule': 'evenodd' }, layers.water);
  el('path', { d: polysPath(S.nwi), fill: 'rgba(80,180,255,.35)', stroke: '#59b8ff', 'stroke-width': 1, 'fill-rule': 'evenodd' }, layers.water);
  el('path', { d: polysPath(S.ponds), class: 'p-pond', 'fill-rule': 'evenodd' }, layers.water);
  el('path', { d: linesPath(S.stream), class: 'p-stream' }, layers.water);
  g('env');
  el('path', { d: polysPath(ENV.clear), class: 'p-clear', 'fill-rule': 'evenodd' }, layers.env);
  el('path', { d: polysPath(ENV.envelope), class: 'p-env', 'fill-rule': 'evenodd' }, layers.env);

  const base = el('g', {}, svg);
  el('path', { d: polysPath(S.drivePolys), class: 'p-drive', 'fill-rule': 'evenodd' }, base);
  el('path', { d: ringPath(S.ring), class: 'p-parcel' }, base);
  if (S.house && S.house.ring.length) {
    el('path', { d: ringPath(S.house.ring), class: 'p-house' }, base);
    const hc = centroid(S.house.ring);
    el('text', { x: hc[0], y: hc[1] + 4, class: 'p-hlab', 'text-anchor': 'middle', 'font-size': 11 * kt }, base).textContent = 'HOUSE';
  }
  // lot line labels (click to change type)
  const pc = centroid(S.ring);
  const NAMES = { front: 'FRONT', side: 'SIDE', rear: 'REAR' };
  const RANK = { front: 0, rear: 1, side: 2 };
  const fs = 11 * kt, charW = fs * 0.56, placedLL = [];
  // fronts first, then rear, then the longest sides; each label shortens to fit its line or is skipped
  for (const ll of S.lotlines.slice().sort((a, b) => (RANK[a.kind] - RANK[b.kind]) || (b.length - a.length))) {
    // measure along the whole lot line (curved frontages are many short segments), centre the label on it
    const ln = ll.lines.slice().sort((a, b) => b.length - a.length)[0] || [];
    const cum = [0];
    for (let i = 1; i < ln.length; i++) cum.push(cum[i - 1] + Math.hypot(ln[i][0] - ln[i - 1][0], ln[i][1] - ln[i - 1][1]));
    const bestLen = cum[cum.length - 1] || 0;
    if (ln.length < 2 || !bestLen) continue;
    const at = d => { let i = 1; while (i < cum.length - 1 && cum[i] < d) i++; const t = (d - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1); return [ln[i - 1][0] + t * (ln[i][0] - ln[i - 1][0]), ln[i - 1][1] + t * (ln[i][1] - ln[i - 1][1])]; };
    const span = Math.min(bestLen / 4, 40);
    const best = [at(bestLen / 2 - span), at(bestLen / 2 + span)];
    const sb = ENV.sbFor(ll), n = sb != null ? sb : '?';
    const variants = [`${NAMES[ll.kind]} · ${n} FT`, `${NAMES[ll.kind]} ${n}′`, `${NAMES[ll.kind][0]} ${n}′`];
    const label = variants.find(v => v.length * charW <= bestLen * 0.85);
    if (!label) continue;
    const m = at(bestLen / 2);
    const vx = pc[0] - m[0], vy = pc[1] - m[1], vl = Math.hypot(vx, vy) || 1;
    const off = fs * 1.1;
    let ang = Math.atan2(best[1][1] - best[0][1], best[1][0] - best[0][0]) * 180 / Math.PI; if (ang > 90) ang -= 180; if (ang < -90) ang += 180;
    const x = m[0] + vx / vl * off, y = m[1] + vy / vl * off;
    const ux = Math.cos(ang * Math.PI / 180), uy = Math.sin(ang * Math.PI / 180), half = label.length * charW / 2;
    const seg = [[x - ux * half, y - uy * half], [x + ux * half, y + uy * half]];
    if (placedLL.some(q => segSeg(seg[0], seg[1], q[0], q[1]) < fs * 1.2)) continue;
    placedLL.push(seg);
    const t = el('text', { x, y, class: 'p-ll ' + ll.kind, 'text-anchor': 'middle', 'dominant-baseline': 'middle', 'font-size': fs, transform: `rotate(${ang.toFixed(1)} ${x} ${y})`, tabindex: 0, role: 'button', 'aria-label': `${NAMES[ll.kind]} lot line along ${ll.abut}, ${n} ft setback; click to change`,
      // anchor data so zooming can keep the label beside its line
      'data-mx': m[0], 'data-my': m[1], 'data-vx': vx / vl, 'data-vy': vy / vl, 'data-off': off, 'data-ang': ang.toFixed(1), 'data-len': bestLen, 'data-cw': charW, 'data-variants': variants.join('|') }, base);
    t.textContent = label;
    const cycle = e => { e.stopPropagation(); e.preventDefault(); cycleLotLine(ll.id); };
    t.addEventListener('pointerdown', e => e.stopPropagation());
    t.addEventListener('click', cycle);
    t.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') cycle(e); });
  }
  const sbar = Math.pow(10, Math.floor(Math.log10(W / 6))) * (W / 6 / Math.pow(10, Math.floor(Math.log10(W / 6))) >= 5 ? 5 : W / 6 / Math.pow(10, Math.floor(Math.log10(W / 6))) >= 2 ? 2 : 1);
  const sb = el('g', { transform: `translate(${18 * k} ${H - 22 * k})` }, svg);
  for (let i = 0; i < 4; i++) el('rect', { x: i * sbar / 4, y: 0, width: sbar / 4, height: 5 * k, class: 'p-scale', 'fill-opacity': i % 2 ? .25 : 1 }, sb);
  [0, sbar / 2, sbar].forEach(v => el('text', { x: v, y: -4 * k, class: 'p-scaletxt', 'text-anchor': 'middle', 'font-size': 10 * kt }, sb).textContent = v === sbar ? `${sbar} ft` : v);
  const na = el('g', { transform: `translate(${W - 70 * k} ${34 * k}) scale(${k})` }, svg);
  el('path', { d: 'M0 -16 L7 8 L0 3 L-7 8 Z', class: 'p-scale' }, na);
  el('text', { x: 0, y: 22, class: 'p-scaletxt', 'text-anchor': 'middle' }, na).textContent = 'N';
  projG = el('g', {}, svg);
  setView(view || { x: 0, y: 0, w: W, h: H });
  applyLayerVisibility();
}
function applyLayerVisibility() {
  for (const d of LAYER_DEFS) if (layers[d.id]) layers[d.id].style.display = state.layers[d.id] ? '' : 'none';
  $('#planbox').classList.toggle('noaerial', !state.layers.aerial);
}
function buildLegend() {
  const Lg = $('#legend'); Lg.innerHTML = '';
  for (const d of LAYER_DEFS) {
    const lab = document.createElement('label'); lab.className = 'chip'; lab.htmlFor = 'lyr-' + d.id;
    lab.innerHTML = `<input type="checkbox" id="lyr-${d.id}" ${state.layers[d.id] ? 'checked' : ''}><span class="sw" style="background:${d.sw}"></span>${d.label}`;
    lab.querySelector('input').addEventListener('change', e => { state.layers[d.id] = e.target.checked; store('layers', state.layers); applyLayerVisibility(); });
    Lg.appendChild(lab);
  }
}
function setView(v) {
  const W = SITE.W, H = SITE.H, minW = 80;
  v.w = Math.max(minW, Math.min(W, v.w)); v.h = v.w * H / W;
  v.x = Math.max(0, Math.min(W - v.w, v.x)); v.y = Math.max(0, Math.min(H - v.h, v.y));
  view = v; svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
  const z = W / v.w;
  if (svg._z !== z) { svg._z = z; scaleText(svg); }
}
// Keep labels the same size on screen at any zoom (the photo and lines zoom; text doesn't)
function scaleText(root) {
  if (!root || !SITE || !view) return;
  const z = SITE.W / view.w;
  for (const t of root.querySelectorAll('text')) {
    if (t.dataset.fs === undefined) t.dataset.fs = t.getAttribute('font-size') || '';
    if (!t.dataset.fs) continue;
    t.setAttribute('font-size', (+t.dataset.fs / z).toFixed(3));
    if (t.dataset.mx !== undefined) {
      const off = +t.dataset.off / z, x = +t.dataset.mx + +t.dataset.vx * off, y = +t.dataset.my + +t.dataset.vy * off;
      t.setAttribute('x', x); t.setAttribute('y', y); t.setAttribute('transform', `rotate(${t.dataset.ang} ${x} ${y})`);
      // zoomed in there's room for the longer wording
      const fit = (t.dataset.variants || '').split('|').find(v => v && v.length * +t.dataset.cw / z <= +t.dataset.len * 0.85);
      if (fit) t.textContent = fit;
    }
  }
}
function zoom(f, cx, cy) {
  if (!SITE) return;
  if (cx == null) { cx = view.x + view.w / 2; cy = view.y + view.h / 2; }
  const w = view.w * f, h = w * SITE.H / SITE.W;
  setView({ x: cx - (cx - view.x) * (w / view.w), y: cy - (cy - view.y) * (h / view.h), w, h });
}
function svgPoint(evt) { const pt = svg.createSVGPoint(); pt.x = evt.clientX; pt.y = evt.clientY; const m = svg.getScreenCTM(); return m ? pt.matrixTransform(m.inverse()) : { x: 0, y: 0 }; }

function cycleLotLine(id) {
  const order = { front: 'side', side: 'rear', rear: 'front' };
  const ll = SITE.lotlines.find(l => l.id === id);
  ll.kind = order[ll.kind];
  const ov = recall('lotlines:' + SITE.attrs.SWIS + SITE.attrs.PRINT_KEY) || {};
  ov[id] = ll.kind; store('lotlines:' + SITE.attrs.SWIS + SITE.attrs.PRINT_KEY, ov);
  refreshRules();
}

// ---------------------------------------------------------------------------
// Analysis of the test project
// ---------------------------------------------------------------------------
function existingTotals() {
  const e = { ...state.existing };
  if (state.proj.type === 'house' && state.proj.replaces && SITE.house) {
    e.fa = Math.max(0, e.fa - DEF.fa); e.bc = Math.max(0, e.bc - SITE.house.area); e.dc = Math.max(0, e.dc - SITE.house.area);
  }
  return e;
}
function capsFor(A) { return { fa: evalSpec(R.fa, A), bc: evalSpec(R.bc, A), dc: evalSpec(R.dc, A) }; }

function analyse() {
  const p = state.proj, T = TYPES[p.type], S = SITE, gen = R.general || {};
  const A = state.existing.area;
  const rect = rectCorners(p), samples = rectSamples(p);
  const foot = p.w * p.d;
  const frac = f => samples.filter(f).length / samples.length;
  const inLot = frac(q => inRing(q, S.ring));
  const inWater = frac(q => inAny(q, ENV.water));
  const inFlood = frac(q => inAny(q, S.flood));
  const on1525 = frac(q => inAny(q, S.s1525)), on25 = frac(q => inAny(q, S.s25));
  const dWater = distRectToLines(rect, ENV.waterLines);
  const acc = T.kind !== 'principal' && R.accessory ? R.accessory : null;
  const need = { front: acc && acc.front_ft != null ? acc.front_ft : R.front, side: acc && acc.side_ft != null ? acc.side_ft : R.side, rear: acc && acc.rear_ft != null ? acc.rear_ft : R.rear };
  const dist = {}, sideBy = [];
  for (const k of ['front', 'side', 'rear']) {
    const gs = S.lotlines.filter(l => l.kind === k);
    dist[k] = gs.length ? Math.min(...gs.map(g => distRectToLines(rect, g.lines))) : null;
    if (k === 'side') for (const g of gs) sideBy.push(distRectToLines(rect, g.lines));
  }
  const ex = existingTotals();
  const stories = T.stories ? p.stories : 0;
  const addFA = T.fa ? foot * stories * T.fa + (p.basement && T.fa ? foot * .5 : 0) : 0;
  const addBC = T.bc ? foot : 0, addDC = T.dc ? foot : 0;
  const caps = capsFor(A);
  const tot = { fa: ex.fa + addFA, bc: ex.bc + addBC, dc: ex.dc + addDC };
  const checks = [], approvals = [];
  const needA = (name, who) => { if (!approvals.some(a => a.name === name)) approvals.push({ name, who }); };
  const muni = (R.file && R.file.name) || title(S.attrs.MUNI_NAME);
  let variance = false;

  if (inLot < 0.999) { checks.push({ s: 'bad', t: 'On the lot', d: inLot > 0 ? 'Part of the project falls outside the property line.' : 'The project is off the property.', c: 'Parcel' }); variance = true; }

  // setbacks
  const known = ['front', 'side', 'rear'].filter(k => need[k] != null && dist[k] != null);
  const fails = known.filter(k => dist[k] < need[k] - 0.05);
  const txt = ['front', 'side', 'rear'].filter(k => dist[k] != null).map(k => `${k} ${fmt(dist[k])} ft${need[k] != null ? ` (needs ${need[k]})` : ' (rule unknown)'}`).join(' · ');
  const cite = R.district ? (R.district.source || 'local code') : 'local code';
  if (!known.length) checks.push({ s: 'info', t: 'Setbacks', d: `${txt}. Setbacks for this district aren't loaded; enter them under Setbacks to check.`, c: cite });
  else if (fails.length) { checks.push({ s: 'bad', t: 'Setbacks', d: `Too close: ${txt}. Move it inside the dashed pink line or plan on a variance.`, c: cite }); variance = true; }
  else checks.push({ s: known.length < 3 ? 'info' : 'ok', t: 'Setbacks', d: txt + '.' + (acc ? ' Accessory-structure setbacks used.' : ''), c: cite });
  if (R.side_total != null && sideBy.length >= 2) {
    const two = sideBy.slice().sort((a, b) => a - b).slice(0, 2).reduce((a, b) => a + b, 0);
    if (two < R.side_total) { checks.push({ s: 'bad', t: 'Both side yards', d: `The two side yards add up to ${fmt(two)} ft; the code requires ${R.side_total} ft combined.`, c: cite }); variance = true; }
  }

  // front-yard placement for accessory structures and pools
  if (T.kind !== 'principal' && S.house && ENV.houseDist && dist.front != null && dist.front < ENV.houseDist.front - 2) {
    const why = T.kind === 'pool' ? (gen.pools || '') : (gen.accessory_structures || '');
    checks.push({ s: 'permit', t: 'Front yard', d: `It sits in front of the house. Most Westchester codes keep accessory buildings and pools out of the front yard.${why ? ' Local rule: ' + why : ''}`, c: 'Accessory structure rules' });
  }

  // water
  if (inWater > 0 || dWater < (ENV.wcBuf || DEFAULT_BUFFER)) {
    const local = gen.wetlands && gen.wetlands.summary ? gen.wetlands.summary : (ENV.assumedBuffer ? 'This town\'s wetlands law isn\'t loaded yet; most Westchester towns regulate a 100 ft buffer around streams and wetlands.' : 'Check the local wetlands law.');
    checks.push({ s: 'permit', t: 'Water buffer', d: `${fmt(dWater)} ft from a mapped stream, pond or wetland; ${Math.round(inWater * 100)}% of it inside a regulated buffer. ${local} A wetland scientist flags the real edge first.`, c: gen.wetlands ? 'Local wetlands law' : 'Local wetlands law (not loaded)' });
    needA('Wetlands / watercourse permit', `${muni}${gen.wetlands ? '' : ' (check which board)'}`);
    if (ENV.nysNear) needA('Freshwater wetlands permit (if inside the 100 ft adjacent area)', 'NYS DEC');
  } else checks.push({ s: 'ok', t: 'Water buffer', d: `${isFinite(dWater) ? fmt(dWater) + ' ft from the nearest mapped stream, pond or wetland' : 'No mapped streams, ponds or wetlands nearby'}; outside the buffers.`, c: 'County hydrography, NWI, NYS DEC' });

  if (inFlood > 0) {
    checks.push({ s: 'permit', t: 'Flood zone', d: `${Math.round(inFlood * 100)}% of it is in a mapped FEMA flood zone. Expect a floodplain development permit and elevation requirements.`, c: 'Local flood damage prevention law' });
    needA('Floodplain development permit', `${muni} floodplain administrator`);
  }

  // slopes
  const slopeLaw = gen.steep_slopes;
  if (on25 > .02 || on1525 > .02) {
    const pct = on25 > .02 ? `${Math.round(on25 * 100)}% of it on 25%+ slopes` : `${Math.round(on1525 * 100)}% of it on 15–25% slopes`;
    checks.push({ s: slopeLaw ? 'permit' : 'info', t: 'Steep slopes', d: `About ${pct}. ${slopeLaw ? slopeLaw.summary : 'No local steep-slope law is loaded for this town; check the code.'}`, c: slopeLaw ? 'Local steep slope law' : 'County slope map' });
    if (slopeLaw) needA('Steep slope permit', muni);
  } else checks.push({ s: 'ok', t: 'Steep slopes', d: 'Not on a mapped 15%+ slope.', c: 'County slope map' });

  // coverage + floor area
  const cov = (key, label, ttype) => {
    if (!ttype) return;
    const c = caps[key];
    if (!c || c.v == null) { checks.push({ s: 'info', t: label, d: c && c.how ? `Rule: ${c.how}` : 'No limit found for this district.', c: provLabel(R.prov[key]) }); return; }
    const left = c.v - tot[key];
    checks.push(left >= 0
      ? { s: 'ok', t: label, d: `${fmt(tot[key])} of ${fmt(c.v)} sf; ${fmt(left)} sf left after this project.`, c: `${c.how} · ${provLabel(R.prov[key])}` }
      : { s: 'bad', t: label, d: `${fmt(tot[key])} sf would exceed the ${fmt(c.v)} sf limit by ${fmt(-left)} sf.`, c: `${c.how} · ${provLabel(R.prov[key])}` });
    if (left < 0) variance = true;
  };
  cov('fa', 'Floor area', T.fa); cov('bc', 'Building coverage', T.bc); cov('dc', 'Total coverage', T.dc);

  if (T.stories) {
    const hMax = acc && acc.max_height_ft != null ? acc.max_height_ft : R.height;
    const sMax = T.kind === 'principal' ? R.stories : null;
    const bad = (hMax != null && p.height > hMax) || (sMax != null && p.stories > sMax);
    checks.push({ s: bad ? 'bad' : hMax == null ? 'info' : 'ok', t: 'Height', d: `${p.stories} ${p.stories === 1 ? 'story' : 'stories'}, ${p.height} ft; limit ${sMax != null ? sMax + ' stories, ' : ''}${hMax != null ? hMax + ' ft' : 'unknown'}. Towns measure height differently (to the midpoint of the roof or the ridge); check the definition.`, c: provLabel(R.prov.height) });
    if (bad) variance = true;
  }
  if (T.adu) {
    checks.push({ s: 'permit', t: 'Accessory apartment', d: gen.adu ? gen.adu.summary : 'Accessory apartment rules for this town aren\'t loaded; most Westchester towns allow them only by special permit with owner occupancy.', c: 'Local ADU rule' });
    needA('Accessory apartment approval', muni);
  }

  // stormwater
  const newImp = T.dc ? foot : 0, disturb = (p.w + 20) * (p.d + 20);
  if (disturb >= 43560) needA('NYS construction stormwater permit (SPDES GP)', 'NYS DEC');
  if (newImp > 1000 || disturb >= 5000) {
    checks.push({ s: 'permit', t: 'Stormwater', d: `About ${fmt(newImp)} sf new hard surface and ${fmt(disturb)} sf disturbed. ${gen.stormwater ? gen.stormwater.summary : 'Many Westchester towns require a stormwater plan around this size.'}`, c: 'Local stormwater law' });
    needA('Stormwater plan (SWPPP) / stormwater permit', `${muni} engineer`);
  } else checks.push({ s: 'ok', t: 'Stormwater', d: `About ${fmt(newImp)} sf new impervious, ~${fmt(disturb)} sf disturbed; small enough that most towns don't require a stormwater plan.`, c: gen.stormwater ? 'Local stormwater law' : 'Typical thresholds' });

  // NYC watershed
  const croton = S.sheds.some(s => /CROTON/.test(s));
  const kensico = !croton && KENSICO_MUNS.has(S.zones[0] && S.zones[0].mun) && S.sheds.some(s => /BRONX/.test(s));
  if (croton || kensico) {
    if (T.newHouse && dWater < 100) { checks.push({ s: 'permit', t: 'NYC watershed', d: 'A new house within 100 ft of a perennial stream or DEC wetland needs NYC DEP\'s Individual Residential Stormwater Permit. Additions are exempt.', c: '15 RCNY § 18-39' }); needA('Individual Residential Stormwater Permit (if the stream is perennial)', 'NYC DEP'); }
    else checks.push({ s: 'ok', t: 'NYC watershed', d: `${croton ? 'In the Croton watershed' : 'Possibly in the Kensico watershed'}. ${T.newHouse ? 'More than 100 ft from water, so DEP\'s house permit isn\'t triggered.' : 'Additions and accessory improvements to an existing home have no DEP distance limits.'}`, c: 'NYC DEP watershed rules' });
  }
  const septic = !isFinite(S.sewerD) || S.sewerD > 250;
  if (p.bedrooms > 0 || T.adu || T.newHouse) {
    checks.push({ s: septic ? 'permit' : 'info', t: septic ? 'Septic and well' : 'Sewer', d: septic ? 'No public sewer main is mapped near the lot, so it likely has a septic system. New bedrooms or a dwelling need Westchester County Health Department approval.' : `A public sewer main is mapped ${fmt(S.sewerD)} ft away; new connections go through the sewer authority.`, c: 'Westchester County Health Department' });
    if (septic) needA('Septic / water approval', 'Westchester County Department of Health');
  }
  if (gen.trees) { checks.push({ s: 'info', t: 'Trees', d: gen.trees.summary, c: 'Local tree law' }); needA('Tree removal permit (for trees removed)', muni); }
  needA('Building permit', `${muni} Building Department; 2025 NYS Residential Code`);
  if (variance) needA('Area variance', `${muni} Zoning Board of Appeals`);
  const order = ['Area variance', 'Wetlands / watercourse permit', 'Freshwater wetlands permit (if inside the 100 ft adjacent area)', 'Floodplain development permit', 'Steep slope permit', 'Accessory apartment approval', 'Individual Residential Stormwater Permit (if the stream is perennial)', 'Stormwater plan (SWPPP) / stormwater permit', 'NYS construction stormwater permit (SPDES GP)', 'Septic / water approval', 'Tree removal permit (for trees removed)', 'Building permit'];
  approvals.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  const worst = checks.some(c => c.s === 'bad') ? 'bad' : checks.some(c => c.s === 'permit') ? 'permit' : 'ok';
  return { checks, approvals, worst, dist, rect, foot, addFA, addBC, addDC, caps, tot, ex };
}
const provLabel = p => ({ code: 'local code', county: 'county GIS', manual: 'entered by you', none: 'not found' }[p] || '');
const provTag = p => `<span class="prov ${p}">${({ code: 'code', county: 'county', manual: 'you', none: 'missing' })[p] || ''}</span>`;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderProject(Rz) {
  projG.innerHTML = '';
  const p = state.proj, k = SITE.kt || SITE.k || 1;
  const poly = el('polygon', { points: Rz.rect.map(q => q.join(',')).join(' '), class: 'p-proj ' + Rz.worst, tabindex: 0, 'aria-label': 'Test project, drag to move' }, projG);
  poly.addEventListener('pointerdown', startDrag);
  el('text', { x: p.cx, y: p.cy + 4, class: 'p-plab', 'text-anchor': 'middle', 'font-size': 11 * k }, projG).textContent = `${p.w}×${p.d}`;
  for (const kind of ['front', 'side', 'rear']) {
    const lines = SITE.lotlines.filter(l => l.kind === kind).flatMap(l => l.lines);
    let best = { d: Infinity };
    for (const q of Rz.rect) for (const ln of lines) for (let i = 0; i < ln.length - 1; i++) {
      const a = ln[i], b = ln[i + 1], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
      let t = L2 ? ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
      const f = [a[0] + t * dx, a[1] + t * dy], d = Math.hypot(f[0] - q[0], f[1] - q[1]);
      if (d < best.d) best = { d, q, f };
    }
    if (!isFinite(best.d) || best.d > Math.max(260, SITE.W / 3)) continue;
    el('line', { x1: best.q[0], y1: best.q[1], x2: best.f[0], y2: best.f[1], class: 'p-dim' }, projG);
    el('text', { x: (best.q[0] + best.f[0]) / 2, y: (best.q[1] + best.f[1]) / 2 - 3, class: 'p-dimtxt', 'text-anchor': 'middle', 'font-size': 10 * k }, projG).textContent = `${Math.round(best.d)}′`;
  }
  scaleText(projG);
}
const STATUS = { ok: 'Meets', permit: 'Permit', bad: 'Fails', info: 'Note' };
function renderPanel(Rz) {
  const p = state.proj, T = TYPES[p.type];
  const nBad = Rz.checks.filter(c => c.s === 'bad').length;
  const nPermit = Rz.approvals.filter(a => !/^(Building permit|Tree removal|Area variance)/.test(a.name)).length;
  const head = Rz.worst === 'bad' ? `<span class="pill bad">Doesn't fit as drawn</span> ${nBad} rule${nBad === 1 ? '' : 's'} failed. Change the size or move it, or plan on a variance.`
    : Rz.worst === 'permit' ? (nPermit ? `<span class="pill permit">Fits with permits</span> Zoning allows it here, but it triggers ${nPermit} extra review${nPermit === 1 ? '' : 's'} beyond a building permit.` : `<span class="pill permit">Check</span> Zoning allows it, but one rule needs a closer look below.`)
    : `<span class="pill ok">Fits</span> The rules we have allow it here with a building permit.`;
  $('#p-summary').innerHTML = `<strong>${esc(T.label)}</strong> · ${fmt(Rz.foot)} sf footprint${Rz.addFA ? ` · ${fmt(Rz.addFA)} sf counted floor area` : ''}<br>${head}`;
  $('#checks').innerHTML = Rz.checks.map(c => `<li><span><span class="pill ${c.s}">${STATUS[c.s]}</span></span><div><div class="t">${esc(c.t)}</div><div class="d">${esc(c.d)}</div><div class="c">${esc(c.c)}</div></div></li>`).join('');
  $('#approvals').innerHTML = Rz.approvals.map(a => `<li><strong>${esc(a.name)}</strong> <span class="who">— ${esc(a.who)}</span></li>`).join('');
  const m = [['fa', 'Floor area', Rz.addFA], ['bc', 'Building coverage', Rz.addBC], ['dc', 'Total coverage', Rz.addDC]];
  $('#meters').innerHTML = m.map(([key, label, add]) => {
    const c = Rz.caps[key], ex = Rz.ex[key], tot = ex + add;
    if (!c || c.v == null) return `<div class="meter"><div class="row"><strong>${label}</strong>${provTag(R.prov[key])}</div><div class="foot">${c && c.how ? esc(c.how) : 'No limit found for this district.'} Existing ${fmt(ex)} sf${add ? ` + project ${fmt(add)}` : ''}.</div></div>`;
    const cap = c.v, pe = Math.min(100, ex / cap * 100), pp = Math.max(0, Math.min(100 - pe, add / cap * 100)), over = tot > cap;
    return `<div class="meter"><div class="row"><strong>${label} ${provTag(R.prov[key])}</strong><span class="num">${fmt(tot)} / ${fmt(cap)} sf</span></div>
      <div class="bar" role="img" aria-label="${label}: ${fmt(ex)} existing plus ${fmt(add)} proposed of ${fmt(cap)} allowed"><i class="ex" style="width:${pe}%"></i><i class="${over ? 'over' : 'pr'}" style="left:${pe}%;width:${over ? 100 - pe : pp}%"></i></div>
      <div class="row foot"><span>Existing ${fmt(ex)}${add ? ` + project ${fmt(add)}` : ''}</span><span class="num" style="color:${over ? 'var(--bad)' : 'inherit'}">${over ? 'over by ' + fmt(tot - cap) : fmt(cap - tot) + ' left'}</span></div>
      <div class="foot">${esc(c.how)}${R.district && R.district[key === 'fa' ? 'max_floor_area' : key === 'bc' ? 'max_building_coverage' : 'max_impervious_coverage'] && R.district[key === 'fa' ? 'max_floor_area' : key === 'bc' ? 'max_building_coverage' : 'max_impervious_coverage'].note ? ' · ' + esc(R.district[key === 'fa' ? 'max_floor_area' : key === 'bc' ? 'max_building_coverage' : 'max_impervious_coverage'].note) : ''}</div></div>`;
  }).join('') + `<div class="meter"><div class="row"><strong>Height ${provTag(R.prov.height)}</strong><span class="num">${R.stories != null ? R.stories + ' stories · ' : ''}${R.height != null ? R.height + ' ft max' : 'unknown'}</span></div>${SITE.house && SITE.house.p.ACTUAL_HEIGHT ? `<div class="foot">The county's building survey puts the existing roof about ${SITE.house.p.ACTUAL_HEIGHT} ft above its base.</div>` : ''}</div>`;
  const capsNow = capsFor(state.existing.area);
  const tile = (valSel, labSel, cap, used, what) => {
    const v = $(valSel), l = $(labSel);
    if (!cap || cap.v == null) { v.textContent = '–'; l.textContent = `no ${what} cap found for this district`; return; }
    const left = cap.v - used;
    v.textContent = left >= 0 ? fmt(left) : 'Over';
    l.textContent = left >= 0 ? `sq ft of ${what} left under the cap` : `existing ${what} is ${fmt(-left)} sq ft over the cap (check the county figures)`;
  };
  tile('#v-fa', '#v-fa-l', capsNow.fa, state.existing.fa, 'floor area');
  tile('#v-bc', '#v-bc-l', capsNow.bc, state.existing.bc, 'building footprint');
}

function renderYards() {
  const rows = [['front', 'Front'], ['side', 'Side'], ['rear', 'Rear']];
  const hd = ENV.houseDist;
  $('#yards').innerHTML = `<thead><tr><th>Yard</th><th class="num">Required</th><th class="num">House today</th><th></th></tr></thead><tbody>` + rows.map(([k, l]) => {
    const req = R[k], d = hd ? hd[k] : null;
    // county lines are good to a few feet, so within 2 ft of the rule is too close to call
    const status = req == null || d == null || !isFinite(d) ? '' : Math.abs(d - req) < 2 ? '<span class="pill permit">Close</span>' : `<span class="pill ${d >= req ? 'ok' : 'bad'}">${d >= req ? 'Meets' : 'Short'}</span>`;
    return `<tr><td>${l} ${provTag(R.prov[k])}</td><td class="num"><input type="number" min="0" step="1" data-yard="${k}" value="${req ?? ''}" aria-label="${l} setback in feet"> ft</td><td class="num mono">${d != null && isFinite(d) ? fmt(d) + ' ft' : '–'}</td><td>${status}</td></tr>`;
  }).join('') + `</tbody>`;
  const extra = [];
  if (R.side_total != null) extra.push(`Both side yards together: ${R.side_total} ft.`);
  if (R.corner_side != null) extra.push(`Street side of a corner lot: ${R.corner_side} ft.`);
  if (R.accessory) extra.push(`Accessory buildings: ${['front', 'side', 'rear'].map(k => R.accessory[k + '_ft'] != null ? `${k} ${R.accessory[k + '_ft']} ft` : null).filter(Boolean).join(', ') || 'see code'}${R.accessory.notes ? ` (${R.accessory.notes})` : ''}.`);
  extra.push('Type over any number to try your own; it\'s remembered for this district on this device.');
  $('#yards-note').textContent = extra.join(' ');
  $('#yards-src').textContent = R.district ? (R.district.source || '') : 'no local rules loaded';
  for (const inp of document.querySelectorAll('#yards input')) inp.addEventListener('change', e => {
    const key = `manual:${R.mun}|${R.zoning}`, man = recall(key) || {};
    const v = parseFloat(e.target.value);
    if (isFinite(v) && v >= 0) man[e.target.dataset.yard] = v; else delete man[e.target.dataset.yard];
    store(key, man); refreshRules();
  });
}

function renderNotices() {
  const out = [];
  const S = SITE;
  if (S.group && S.group.length > 1) out.push(['info', `This property is ${S.group.length} tax parcels with the same address (${S.group.map(x => esc(x.printKey)).join(', ')}), analysed together as one ${(S.area / 43560).toFixed(2)}-acre lot. If they're legally separate lots, the setbacks apply to each one.`]);
  if (/^2/.test(String(S.attrs.PROP_CLASS || '')) && !num(S.attrs.SQFT_LIVING)) out.push(['', 'The tax roll has no living-area figure for this house, so existing floor area starts at 0 and the room left is overstated. Enter it under Capacity → Adjust what\'s already on the lot.']);
  const roll = (S.attrs.MUNI_NAME || '').replace(/,\s*(village|town|city)$/i, '');
  if (R.file && roll && !norm(R.file.name).includes(norm(roll))) out.push(['', `The tax roll puts this parcel in ${esc(title(roll))}, but the county zoning map shows ${esc(R.file.name)}'s ${esc(R.zoning)} district. Check which municipality's zoning applies before relying on these numbers.`]);
  if (S.zones.length > 1 && S.zones[1].share > .05) out.push(['info', `This lot is split between zoning districts: ${S.zones.map(z => `${esc(z.zoning)} (${Math.round(z.share * 100)}%)`).join(', ')}. The plan uses ${esc(S.zones[0].zoning)}.`]);
  if (!R.residential) out.push(['bad', `${esc(R.zoning)} isn't a residential district in the county's data, so one-family rules may not apply.`]);
  if (!R.file) out.push(['bad', `This municipality's zoning rules aren't loaded yet. Limits shown come from county GIS; type the setbacks from the code below to draw the envelope.`]);
  else if (!R.district) out.push(['bad', `${esc(R.zoning)} isn't in our ${esc(R.file.name)} rules. Limits shown come from county GIS; type the setbacks from the ${link(R.file.code_url, 'zoning code')} to draw the envelope.`]);
  if (ENV.missing) out.push(['', 'Some setbacks are unknown, so the buildable envelope isn\'t drawn yet. Enter them under Setbacks.']);
  if (S.lotlines.inferred) out.push(['', 'No street frontage was detected (a flag lot or private road?). The line nearest a street is treated as the front; click the labels on the plan to change it.']);
  if (S.multipart) out.push(['info', 'The tax parcel has more than one piece; only the piece at this address is analysed.']);
  if (S.failed.length) out.push(['', `Some county layers didn't load (${S.failed.join(', ')}). Reload to try again.`]);
  if (ENV.assumedBuffer) out.push(['info', 'Water buffers are drawn at a typical 100 ft because this town\'s wetlands law isn\'t loaded.']);
  $('#notices').innerHTML = out.map(([c, t]) => `<div class="notice ${c}">${t}</div>`).join('');
}

function renderBook() {
  const S = SITE, A = state.existing.area, gen = R.general || {};
  const muniName = (R.file && R.file.name) || title(S.attrs.MUNI_NAME);
  const caps = capsFor(A);
  const row = (label, req, prov, here) => `<tr><td>${label} ${prov ? provTag(prov) : ''}</td><td class="num">${req}</td><td class="num">${here}</td></tr>`;
  const ft = v => v == null ? '–' : `${fmt(v)} ft`;
  const front = S.lotlines.filter(l => l.kind === 'front').reduce((s, l) => s + l.length, 0);
  const cards = [];
  cards.push({ h: `Lot and bulk rules · ${esc(R.zoning)}${R.name ? ' ' + esc(R.name) : ''}`, src: R.district ? link(R.district.source_url, R.district.source || 'local code') : 'County GIS zoning layer',
    body: `<div class="tablewrap"><table class="sched"><thead><tr><th>Rule</th><th class="num">Required</th><th class="num">This lot</th></tr></thead><tbody>
      ${row('Minimum lot area', R.min_lot != null ? `${fmt(R.min_lot)} sf` : '–', R.prov.min_lot, `${fmt(A)} sf`)}
      ${row('Frontage / lot width', ft(R.frontage), R.frontage != null ? 'code' : null, front ? `≈${fmt(front)} ft frontage` : '–')}
      ${row('Front / side / rear yard', `${R.front ?? '?'} / ${R.side ?? '?'} / ${R.rear ?? '?'} ft`, null, ENV.houseDist ? ['front', 'side', 'rear'].map(k => isFinite(ENV.houseDist[k]) ? fmt(ENV.houseDist[k]) : '–').join(' / ') + ' ft' : '–')}
      ${row('Height', `${R.stories != null ? R.stories + ' st, ' : ''}${R.height != null ? R.height + ' ft' : '–'}`, R.prov.height, S.house && S.house.p.ACTUAL_HEIGHT ? `~${S.house.p.ACTUAL_HEIGHT} ft` : '–')}
      ${row('Max floor area', caps.fa && caps.fa.v != null ? `${fmt(caps.fa.v)} sf` : '–', R.prov.fa, `${fmt(state.existing.fa)} sf`)}
      ${row('Max building coverage', caps.bc && caps.bc.v != null ? `${fmt(caps.bc.v)} sf` : '–', R.prov.bc, `${fmt(state.existing.bc)} sf`)}
      ${row('Max total coverage', caps.dc && caps.dc.v != null ? `${fmt(caps.dc.v)} sf` : '–', R.prov.dc, `${fmt(state.existing.dc)} sf`)}
      </tbody></table></div>
      ${R.min_lot != null && A < R.min_lot ? `<p class="small" style="color:var(--warn)">The lot is smaller than today's minimum, so it's likely a pre-existing nonconforming lot. Check the code's rules for undersized lots.</p>` : ''}
      ${R.district && R.district.notes ? `<p class="small muted">${esc(R.district.notes)}</p>` : ''}` });
  const localItems = [['Wetlands and watercourses', gen.wetlands], ['Steep slopes', gen.steep_slopes], ['Trees', gen.trees], ['Stormwater', gen.stormwater], ['Accessory apartments', gen.adu]].filter(([, v]) => v);
  const localText = [['Accessory structures', gen.accessory_structures], ['Pools', gen.pools], ['Also', gen.notes]].filter(([, v]) => v);
  cards.push({ h: `Local rules in ${esc(muniName)}`, src: R.file ? link(R.file.code_url, 'Zoning code') + (R.file.retrieved ? ` · read ${esc(R.file.retrieved)}` : '') : 'Not loaded',
    body: R.file ? `<ul>${localItems.map(([h, v]) => `<li><strong>${h}</strong>: ${esc(v.summary)} ${safeUrl(v.url) ? link(v.url, 'Code') : ''}</li>`).join('')}${localText.map(([h, v]) => `<li><strong>${h}</strong>: ${esc(v)}</li>`).join('')}</ul>${R.file.gaps && R.file.gaps.length ? `<p class="small muted">Research gaps: ${esc(R.file.gaps.join('; '))}</p>` : ''}`
      : `<p>We haven't loaded ${esc(muniName)}'s code yet. Search eCode360 for "${esc(muniName)} zoning" to find the schedule of dimensional regulations.</p>` });
  const croton = S.sheds.some(s => /CROTON/.test(s));
  cards.push({ h: 'Water, flood and watershed', src: `${link(LINKS.dec, 'NYS DEC wetlands')} · ${link(LINKS.fema, 'FEMA flood maps')} · ${link(LINKS.irsp, 'NYC DEP')}`,
    body: `<ul>
      <li>Mapped streams on the lot: ${ENV.streamInLot > 1 ? `about ${fmt(ENV.streamInLot)} ft` : 'none'}. Regulated water buffers cover about ${fmt(ENV.waterInLot)} sf (${Math.round(ENV.waterInLot / S.area * 100)}%) of the lot${ENV.assumedBuffer ? ' at an assumed 100 ft' : ''}.</li>
      <li>NYS DEC wetlands: ${ENV.nysNear ? '<strong>a state wetland or its 100 ft adjacent area reaches the lot</strong>; work there needs a DEC permit' : 'none within 100 ft'}. DEC also regulates unmapped wetlands of 12.4+ acres.</li>
      <li>FEMA flood zone: ${ENV.floodInLot > 1 ? `about ${fmt(ENV.floodInLot)} sf of the lot` : 'none mapped on the lot'}.</li>
      <li>Steep slopes (county map): ${fmt(ENV.s1525InLot)} sf at 15–25%, ${fmt(ENV.s25InLot)} sf at 25%+.</li>
      <li>Drainage basin: ${esc(S.sheds.map(title).join(', ') || 'unknown')}. ${croton ? 'This is NYC\'s Croton water supply: a new house within 100 ft of a perennial stream or DEC wetland needs a DEP permit; additions don\'t.' : KENSICO_MUNS.has(R.mun) ? 'Parts of this town drain to NYC\'s Kensico Reservoir, where DEP rules also apply; check DEP\'s watershed map.' : 'Outside NYC\'s Croton watershed.'}</li>
      <li>Sewer: ${isFinite(S.sewerD) && S.sewerD < 250 ? `a public sewer main is mapped about ${fmt(S.sewerD)} ft away` : 'no public sewer main mapped nearby, so likely septic'}. Water: ${esc(title(S.attrs.WATER_DESC) || 'unknown')} (assessor).</li>
    </ul>` });
  cards.push({ h: 'Building code', src: `${link(LINKS.dos, 'NYS DOS: 2025 Uniform Code')} · ${link(LINKS.aeba, 'All-electric rule delay')}`,
    body: `<ul>
      <li>Building permits filed on or after December 31, 2025 follow the 2025 Residential Code of New York State and 2025 NYS Energy Code. Some towns (New Castle among them) add a stricter local energy code.</li>
      <li>New York's all-electric rule for new buildings was put on hold in November 2025 pending a court appeal. Check its status before designing a new house or cottage.</li>
      <li>Disturbing an acre or more needs coverage under DEC's construction stormwater permit, on top of any local stormwater rules.</li>
      ${S.attrs.YR_BLT ? `<li>The assessor dates the house to ${esc(S.attrs.YR_BLT)}${+S.attrs.YR_BLT < 1940 ? '. Older houses may also fall under local historic review; check whether it is a designated landmark or in a historic district' : ''}.</li>` : ''}
    </ul>` });
  $('#book').innerHTML = cards.map(c => `<article class="rule"><h3>${c.h}</h3>${c.body}<div class="src">${c.src}</div></article>`).join('');
  $('#book-h').textContent = `What applies at ${title(S.attrs.PARCEL_ADDR) || 'this lot'}`;
  $('#sources').innerHTML = [
    `Parcel, assessor data, zoning district, slopes, streams, wetlands, flood zones, buildings, driveways, contours and the 2025 aerial come live from ${link(LINKS.gis, 'Westchester County GIS')}. Positions are accurate to a few feet, not survey grade; building outlines and driveways date from county flyovers (2000–2018) and may miss newer work.`,
    `Zoning rules come from each municipality's own code, read in November 2026 and tagged <span class="prov code">code</span>. Where we couldn't find a rule, the county's zoning attributes are used and tagged <span class="prov county">county</span>; those are summaries and may be out of date.`,
    `Lot lines are classified automatically: lines along a street are fronts, the line farthest from the street is the rear, the rest are sides. Corner lots, flag lots and odd shapes often need a correction (click the labels).`,
    `Stream, pond and wetland lines are county and federal maps, not field delineations. Buffers are measured from those lines; the real buffer is measured from the flagged edge.`,
  ].map(s => `<li>${s}</li>`).join('');
}

function renderHeader() {
  const S = SITE, a = S.attrs;
  $('#h-addr').textContent = title(a.PARCEL_ADDR) || S.loc.label;
  $('#h-muni').textContent = `${(R.file && R.file.name) || title(a.MUNI_NAME)} · ${S.loc.label}`;
  $('#tb-pk').textContent = (a.PRINT_KEY || '–') + (S.group && S.group.length > 1 ? ` +${S.group.length - 1}` : '');
  $('#tb-zone').textContent = R.zoning || '–';
  $('#tb-area').textContent = (state.existing.area / 43560).toFixed(2) + ' ac';
  $('#v-env').textContent = ENV.envArea != null ? fmt(ENV.envArea) : '–';
  $('#v-clear').textContent = ENV.clearArea != null ? fmt(ENV.clearArea) : '–';
  const limiting = [];
  if (ENV.waterInLot / S.area > .1) limiting.push('water buffers');
  if ((ENV.s1525InLot + ENV.s25InLot) / S.area > .15) limiting.push('steep slopes');
  if (ENV.floodInLot / S.area > .05) limiting.push('the flood zone');
  const roomFA = capsFor(state.existing.area).fa;
  const room = roomFA && roomFA.v != null ? (roomFA.v - state.existing.fa > 1500 ? 'Zoning leaves room to grow.' : 'Zoning leaves little room to grow.') : 'No floor-area cap found.';
  $('#v-lead').innerHTML = `<strong>${esc(room)} ${limiting.length ? `${esc(limiting.join(' and ').replace(/^./, c => c.toUpperCase()))} limit where you can build.` : 'No major mapped constraints on the lot.'}</strong>`;
}

let raf = 0;
function update() {
  if (raf || !SITE) return;
  const go = () => {
    if (!raf) return;
    cancelAnimationFrame(raf); clearTimeout(timer); raf = 0;
    const Rz = analyse();
    renderProject(Rz); renderPanel(Rz); syncFields();
    store('proj', state.proj);
  };
  // animation frames pause in background tabs; the timer keeps a hidden page current
  raf = requestAnimationFrame(go);
  const timer = setTimeout(go, 120);
}
async function refreshRules() {
  const z = SITE.zones[0] || { mun: null, zoning: null };
  R = await resolveRules(z.mun, z.zoning);
  ENV = computeEnvelope(SITE, R);
  drawPlan(); renderYards(); renderNotices(); renderBook(); renderHeader();
  update();
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
function syncFields() {
  const p = state.proj, T = TYPES[p.type];
  const set = (id, v) => { const e = $(id); if (document.activeElement !== e) e.value = v; };
  set('#f-w', p.w); set('#f-d', p.d); set('#f-r', p.rot); set('#f-s', p.stories); set('#f-h', p.height); set('#f-b', p.bedrooms);
  $('#f-bsmt').checked = !!p.basement; $('#f-repl').checked = !!p.replaces;
  $('#f-s').disabled = $('#f-h').disabled = !T.stories; $('#f-bsmt').disabled = !T.fa;
  $('#repl-wrap').hidden = !T.newHouse;
  for (const b of document.querySelectorAll('#types button')) b.setAttribute('aria-pressed', b.dataset.t === p.type ? 'true' : 'false');
  const e = state.existing;
  const sete = (id, v) => { const x = $(id); if (document.activeElement !== x) x.value = Math.round(v); };
  sete('#e-area', e.area); sete('#e-fa', e.fa); sete('#e-bc', e.bc); sete('#e-dc', e.dc);
  $('#tb-area').textContent = (e.area / 43560).toFixed(2) + ' ac';
}
function buildTypes() {
  $('#types').innerHTML = Object.entries(TYPES).map(([k, t]) => `<button type="button" data-t="${k}" aria-pressed="false">${t.label}</button>`).join('');
  $('#types').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || !SITE) return;
    const t = TYPES[b.dataset.t];
    Object.assign(state.proj, { type: b.dataset.t, w: t.w, d: t.d, stories: t.stories || 1, height: t.height, basement: false, replaces: !!t.newHouse, bedrooms: t.adu ? 1 : 0 });
    if (t.newHouse && SITE.house) { const hc = centroid(SITE.house.ring); state.proj.cx = hc[0]; state.proj.cy = hc[1]; } else nudgeIntoClear();
    update();
  });
}
function bindFields() {
  const numIn = (id, key, lo, hi) => $(id).addEventListener('input', e => { const v = parseFloat(e.target.value); if (isFinite(v)) { state.proj[key] = Math.max(lo, Math.min(hi, v)); update(); } });
  numIn('#f-w', 'w', 4, 300); numIn('#f-d', 'd', 4, 300); numIn('#f-r', 'rot', -360, 360); numIn('#f-h', 'height', 0, 80); numIn('#f-b', 'bedrooms', 0, 8);
  $('#f-s').addEventListener('change', e => { state.proj.stories = +e.target.value; update(); });
  $('#f-bsmt').addEventListener('change', e => { state.proj.basement = e.target.checked; update(); });
  $('#f-repl').addEventListener('change', e => { state.proj.replaces = e.target.checked; update(); });
  const ex = (id, key) => $(id).addEventListener('input', e => { const v = parseFloat(e.target.value); if (isFinite(v) && v >= 0) { state.existing[key] = v; update(); renderBook(); } });
  ex('#e-area', 'area'); ex('#e-fa', 'fa'); ex('#e-bc', 'bc'); ex('#e-dc', 'dc');
  $('#e-reset').addEventListener('click', () => { state.existing = { ...DEF }; update(); renderBook(); });
  $('#zin').addEventListener('click', () => zoom(1 / 1.5));
  $('#zout').addEventListener('click', () => zoom(1.5));
  $('#zfit').addEventListener('click', () => SITE && setView({ x: 0, y: 0, w: SITE.W, h: SITE.H }));
}
let drag = null;
function startDrag(e) {
  e.stopPropagation(); e.preventDefault();
  const pt = svgPoint(e);
  drag = { mode: 'move', dx: state.proj.cx - pt.x, dy: state.proj.cy - pt.y, id: e.pointerId };
  svg.setPointerCapture(e.pointerId);
}
function bindPlanPointer() {
  const plan = $('#plan');
  plan.addEventListener('pointerdown', e => {
    if (drag || !SITE) return;
    const pt = svgPoint(e);
    drag = { mode: 'maybe', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, px: pt.x, py: pt.y, id: e.pointerId };
    plan.setPointerCapture(e.pointerId);
  });
  plan.addEventListener('pointermove', e => {
    if (!SITE) return;
    const pt = svgPoint(e);
    if (!drag) { hover(pt); return; }
    if (drag.mode === 'move') { state.proj.cx = pt.x + drag.dx; state.proj.cy = pt.y + drag.dy; update(); return; }
    if (drag.mode === 'maybe' && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 5) drag.mode = 'pan';
    if (drag.mode === 'pan') { const r = plan.getBoundingClientRect(), k = view.w / r.width; setView({ x: drag.vx - (e.clientX - drag.sx) * k, y: drag.vy - (e.clientY - drag.sy) * k, w: view.w, h: view.h }); }
  });
  const end = () => {
    if (!drag) return;
    if (drag.mode === 'maybe') { state.proj.cx = drag.px; state.proj.cy = drag.py; update(); }
    try { plan.releasePointerCapture(drag.id); } catch (_) {}
    drag = null;
  };
  plan.addEventListener('pointerup', end); plan.addEventListener('pointercancel', end);
  plan.addEventListener('pointerleave', () => { if (!drag) $('#readout').hidden = true; });
  plan.addEventListener('wheel', e => { if (!SITE || (!e.ctrlKey && !e.metaKey && !e.altKey)) return; e.preventDefault(); const pt = svgPoint(e); zoom(e.deltaY > 0 ? 1.2 : 1 / 1.2, pt.x, pt.y); }, { passive: false });
  plan.addEventListener('keydown', e => {
    const step = e.shiftKey ? 10 : 2, k = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (k && e.target.classList.contains('p-proj')) { e.preventDefault(); state.proj.cx += k[0]; state.proj.cy += k[1]; update(); }
  });
}
function hover(pt) {
  const p = [pt.x, pt.y], ro = $('#readout');
  if (!inRing(p, SITE.ring)) { ro.hidden = true; return; }
  const bits = [];
  if (!ENV.missing) bits.push(inAny(p, ENV.envelope) ? '<b>Inside the setbacks</b>' : '<b>In a required yard</b>');
  if (inAny(p, ENV.water)) bits.push(`In a regulated water buffer (${fmt(distPtToLines(p, ENV.waterLines))} ft from water)`);
  if (inAny(p, SITE.flood)) bits.push('FEMA flood zone');
  if (inAny(p, SITE.s25)) bits.push('Slope 25%+');
  else if (inAny(p, SITE.s1525)) bits.push('Slope 15–25%');
  if (!bits.length) bits.push('No mapped constraint here');
  ro.innerHTML = bits.join('<br>'); ro.hidden = false;
}
function nudgeIntoClear() {
  const p = state.proj, S = SITE;
  // try the constraint-free area first, then the whole setback envelope
  // accessory setbacks first; if the lot can't meet them, place it anyway and let the checks say so
  for (const useAcc of [true, false]) for (const target of [ENV.clear, ENV.envelope, [[S.ring]]]) if (target.length && placeIn(target, useAcc)) return;
  const ip = S.pg.getInteriorPoint(), c = S.xy(ip.getX(), ip.getY()); p.cx = c[0]; p.cy = c[1];
}
function placeIn(target, useAcc) {
  const p = state.proj, S = SITE;
  const hc = S.house && S.house.ring.length ? centroid(S.house.ring) : centroid(S.ring);
  const step = Math.max(5, Math.max(S.W, S.H) / 140);
  // accessory structures go beside or behind the house when there's room
  const T = TYPES[p.type];
  const frontLines = S.lotlines.filter(l => l.kind === 'front').flatMap(l => l.lines);
  const houseFront = ENV.houseDist && isFinite(ENV.houseDist.front) ? ENV.houseDist.front : null;
  const wantBehind = T.kind !== 'principal' && houseFront != null && frontLines.length;
  // accessory structures can have their own (often larger front, smaller side/rear) setbacks
  const acc = useAcc && T.kind !== 'principal' && R.accessory ? R.accessory : null;
  const accNeed = acc ? ['front', 'side', 'rear'].map(kind => [S.lotlines.filter(l => l.kind === kind).flatMap(l => l.lines), acc[kind + '_ft']]).filter(([ls, v]) => ls.length && v != null && v > 0) : [];
  let best = null, bestAny = null;
  for (let x = 0; x < S.W; x += step) for (let y = 0; y < S.H; y += step) {
    const cand = { ...p, cx: x, cy: y };
    const rc = rectCorners(cand);
    if (!rc.concat([[x, y]]).every(q => inAny(q, target))) continue;
    if (S.house && (rc.some(q => inRing(q, S.house.ring)) || S.house.ring.some(q => inRing(q, rc.concat([rc[0]]))))) continue;
    const d = Math.hypot(x - hc[0], y - hc[1]);
    if (S.house && d < Math.max(p.w, p.d) / 2 + 25) continue;
    if (accNeed.some(([ls, v]) => distRectToLines(rc, ls) < v)) continue;
    if (!bestAny || d < bestAny.d) bestAny = { d, x, y };
    if (wantBehind && distRectToLines(rc, frontLines) < houseFront) continue;
    if (!best || d < best.d) best = { d, x, y };
  }
  best = best || bestAny;
  if (!best) return false;
  p.cx = best.x; p.cy = best.y;
  return true;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
const input = $('#address'), list = $('#suggestions');
let suggestions = [], highlighted = -1, suggestTimer = null, suggestRun = 0;
function renderSuggestions() {
  list.innerHTML = suggestions.map((s, i) => `<li role="option" data-index="${i}" aria-selected="${i === highlighted}">${esc(s.text)}</li>`).join('');
  list.hidden = !suggestions.length; input.setAttribute('aria-expanded', String(!list.hidden));
}
function closeSuggestions() { suggestions = []; highlighted = -1; renderSuggestions(); }
input.addEventListener('input', () => {
  clearTimeout(suggestTimer);
  const text = input.value.trim();
  if (text.length < 3) { closeSuggestions(); return; }
  const run = ++suggestRun;
  suggestTimer = setTimeout(async () => { try { const s = await suggestAddresses(text); if (run === suggestRun) { suggestions = s; highlighted = -1; renderSuggestions(); } } catch (_) {} }, 220);
});
input.addEventListener('keydown', e => {
  if (list.hidden) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); highlighted = Math.min(suggestions.length - 1, highlighted + 1); renderSuggestions(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); highlighted = Math.max(-1, highlighted - 1); renderSuggestions(); }
  else if (e.key === 'Escape') closeSuggestions();
  else if (e.key === 'Enter' && highlighted >= 0) { e.preventDefault(); pick(suggestions[highlighted]); }
});
list.addEventListener('mousedown', e => { const li = e.target.closest('li'); if (li) { e.preventDefault(); pick(suggestions[+li.dataset.index]); } });
input.addEventListener('blur', () => setTimeout(closeSuggestions, 150));
function pick(s) { input.value = s.text; closeSuggestions(); run(s.text, s.magicKey); }
$('#search').addEventListener('submit', e => { e.preventDefault(); const t = input.value.trim(); if (t) run(t); });

let runId = 0;
async function run(text, magicKey) {
  const id = ++runId;
  const status = $('#status');
  status.className = 'status'; status.textContent = `Looking up ${text}…`;
  document.body.classList.add('loading');
  try {
    const site = await lookup(text, magicKey);
    if (id !== runId) return;
    SITE = site; view = null;
    const ov = recall('lotlines:' + site.attrs.SWIS + site.attrs.PRINT_KEY) || {};
    for (const l of site.lotlines) if (ov[l.id]) l.kind = ov[l.id];
    const fa = num(site.attrs.SQFT_LIVING) || 0;
    DEF = { area: Math.round(site.area), fa, bc: Math.round(site.bldgInLot), dc: Math.round(site.bldgInLot + site.driveArea) };
    state.existing = { ...DEF };
    state.proj = Object.assign({ type: 'garage', rot: 0, stories: 1, height: 18, basement: false, replaces: false, bedrooms: 0 }, { type: state.proj.type || 'garage' });
    const T = TYPES[state.proj.type] || TYPES.garage;
    Object.assign(state.proj, { w: T.w, d: T.d, stories: T.stories || 1, height: T.height, replaces: !!T.newHouse });
    if (site.house) { const r = site.house.ring; let best = 0, ang = 0; for (let i = 0; i < r.length - 1; i++) { const Lr = Math.hypot(r[i + 1][0] - r[i][0], r[i + 1][1] - r[i][1]); if (Lr > best) { best = Lr; ang = Math.atan2(r[i + 1][1] - r[i][1], r[i + 1][0] - r[i][0]) * 180 / Math.PI; } } state.proj.rot = Math.round(((ang % 90) + 90) % 90 / 5) * 5; }
    store('last', text);
    try { history.replaceState(null, '', '#' + encodeURIComponent(text)); } catch (_) {}
    const z = SITE.zones[0] || {};
    R = await resolveRules(z.mun, z.zoning);
    ENV = computeEnvelope(SITE, R);
    if (T.newHouse && site.house) { const hc = centroid(site.house.ring); state.proj.cx = hc[0]; state.proj.cy = hc[1]; } else nudgeIntoClear();
    drawPlan(); renderYards(); renderNotices(); renderBook(); renderHeader();
    update();
    status.textContent = '';
    input.value = site.loc.label;
  } catch (e) {
    if (id !== runId) return;
    console.error(e);
    status.className = 'status err'; status.textContent = e.message || 'Something went wrong looking that up. Try again.';
  } finally { if (id === runId) document.body.classList.remove('loading'); }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  state = { layers: Object.assign(Object.fromEntries(LAYER_DEFS.map(d => [d.id, d.on])), recall('layers') || {}), existing: {}, proj: { type: 'garage' } };
  buildLegend(); buildTypes(); bindFields(); bindPlanPointer();
  await loadRuleData();
  const fromHash = decodeURIComponent((location.hash || '').slice(1));
  const start = fromHash || recall('last') || DEFAULT_ADDRESS;
  input.value = start;
  run(start);
}
window.addEventListener('hashchange', () => { const t = decodeURIComponent(location.hash.slice(1)); if (t && SITE && t !== SITE.loc.label && t !== input.value) { input.value = t; run(t); } });
boot();
})();
