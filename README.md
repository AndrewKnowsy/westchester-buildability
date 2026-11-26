# Westchester Buildability

**Live demo:** <https://andrewknowsy.github.io/westchester-buildability/> (add `#<address>` to open a specific lot)

Type any Westchester County address and see what can be built on the lot:

- **Site plan** over the county's 2025 aerial: parcel, front/side/rear lot lines, the setback envelope, streams, ponds and wetlands with their regulated buffers, FEMA flood zones, steep slopes, 2-ft contours and neighbours.
- **Capacity**: floor area, building coverage and total coverage against the district's limits.
- **Test a project**: drop an addition, garage, accessory-apartment cottage, pool, shed, deck, patio or replacement house on the plan. It's checked live against setbacks, coverage, floor area, height, water buffers, flood zone, slopes, stormwater, NYC watershed and septic rules, and the page lists the approvals it would need.
- **Rule book**: the municipality's own rules (wetlands, slopes, trees, stormwater, accessory apartments) with links to the code.

Everything about the parcel is fetched live from Westchester County GIS in the browser. Zoning rules come from `rules/<MUN>.json`, one file per municipality, researched from each local code.

## Run it

Static files; serve over http so the page can load its JSON:

```bash
python3 -m http.server 8767 --bind 127.0.0.1
```

Open <http://localhost:8767>. Add `#<address>` to the URL to open a specific lot.

## How it works

| Step | Source |
| --- | --- |
| Address search | County locator (`geocoding/GeocodeServer`), preferring the tax-parcel match |
| Parcel, assessor fields | `DataHub_TaxParcels` |
| Zoning district | `DataHub_EnvironmentandPlanning` layer 207 (county code + district) |
| Constraints | Same service: steep slopes (152), NYS DEC wetlands (217), NWI wetlands (154), flood zones (157), drainage basins (148); planimetric streams, ponds, buildings, driveways, parking, streets; sewer mains |
| Aerial | `MappingWestchesterCounty_AerialPhoto2025` export |
| Geometry | JSTS (planar, in NY State Plane East feet, EPSG:2260) |

**Lot lines.** Parcel edges within 45 ft of a street centreline (with no neighbouring parcel touching) are the front; the line farthest from the front is the rear; the rest are sides. Clicking a FRONT/SIDE/REAR label on the plan cycles it; the choice is remembered per parcel on that device.

**Rules and provenance.** Every limit is tagged with where it came from: `code` (researched from the municipal code), `county` (the county zoning layer's summary attributes: minimum lot, height, coverage %, FAR), `you` (typed in on the Setbacks card) or `missing`. The county layer has no setbacks, so towns without a rules file need the setbacks typed in to draw the envelope.

**Water buffers** use the town's own wetlands/watercourse buffer from its rules file. Where none is loaded the page assumes 100 ft and says so. NYS DEC's 100 ft adjacent area is always added around state wetlands.

## Coverage (November 25, 2026)

- **All 43 zoning municipalities** in the county data have a rules file: 423 districts, 392 with full front/side/rear setbacks. The rest are planned-development, cluster or special districts where a board sets yards per project, or county district codes that no longer exist in the local code (e.g. Cortlandt R-160/PVD, Port Chester M1/RA2/VCRA, Ossining town R-80).
- **Confidence:** all 43 high. Every number cites the official code (eCode360, or the municipality's own published ordinance for White Plains and Eastchester). Six towns first drafted from third-party copies (Cortlandt, Mount Kisco, Port Chester, Rye Brook, Scarsdale, Yorktown) were re-verified against eCode360; that pass corrected Scarsdale's floor-area steps and Port Chester's corner setbacks and completed Port Chester's R2F district.
- **Tested:** one real one-family lot in every municipality resolves to a parcel and a zoning district, matches its rules file, and draws the plan. Build that list with `python3 tools/make_test_addresses.py` (it writes `research/test_addresses.json`, kept out of git because it holds homeowners' addresses).
- **Data mismatches** are flagged: when the tax roll's municipality differs from the zoning map's (e.g. lots on a village line), the page says so.

## Rules research

`research/` holds the pipeline:

- `BRIEF.md`: instructions and JSON schema used to research each municipality
- `county_districts.json`: every county zoning district with its attributes (the checklist)
- `validate.py`: schema check; `--list <MUN>` shows a town's districts
- `rules/<MUN>.json`: one file per municipality (research output)
- `raw/<MUN>/`: downloaded code attachments used as sources (kept locally, not in git)

After adding or fixing a rules file, publish it into the app:

```bash
python3 tools/sync_rules.py
```

It copies every file that passes validation into `rules/` and rebuilds `rules/index.json`.

## Putting it on the Knowsy site

It's a static page: three files (`index.html`, `app.js`, `style.css`) plus `rules/` and `data/`, with every fetch relative to the page, so it works under any path.

- **As its own page:** serve this folder as static files and link to it or embed it in an `<iframe>`. The Knowsy `vercel.json` currently sends every route to `api/index.py`; add a static route for this folder ahead of that catch-all, or serve the folder from the Flask app.
- **Inside the property report:** the reusable parts are `lookup()` (address → parcel, zoning and constraint layers), `classifyLotLines()`, `computeEnvelope()` and `resolveRules()` / `evalSpec()` in `app.js`, plus the `rules/*.json` files, which any backend can read.

### Check before it goes public

| Dependency | Key needed today | What to check |
| --- | --- | --- |
| Westchester County GIS (locator, parcels, zoning, environmental layers, 2025 aerial export) | No | Public ArcGIS services with no published SLA. Confirm the county is fine with a commercial site calling them, and with showing assessor fields. |
| JSTS 2.11.3 via jsDelivr | No | EPL/EDL licence. Consider self-hosting. |
| Google Fonts | No | Free to use; self-host if you prefer no third-party requests. |
| Municipal codes | — | Rules were read from eCode360 and municipal PDFs in Nov 2026. Re-read a town's code before relying on it, and keep the "not legal advice" notice next to results. |

## Limits

- County parcel lines, building outlines and driveways aren't survey grade; planimetrics date from 2000–2018 flyovers.
- Streams and wetlands are mapped lines, not field delineations. The county slope map is generalised.
- Codes change. Each rules file records the date it was read and any gaps the researcher couldn't fill.
- Not legal advice or a zoning determination. Confirm with the local building department.
