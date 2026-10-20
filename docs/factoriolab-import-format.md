# FactorioLab production import v1

Contract between the offline importer and browser adapter. No Git commands are
needed by either the importer or the implementation workflow.

- `format`: `factoriolab-production-v1`.
- `source`: dataset ID, `versions`, optional user-supplied `commit`, and source
  file SHA-256 hashes. The separate report contains full attribution/exclusions.
- `categories`: source category records in their source order.
- `items`: physical source item records, retaining `id`, `name`, `types`,
  `category`, `row`, `iconText`, and relevant machine/module/beacon/belt/fuel data.
  Every item has numeric `icon_col` and `icon_row`. Nested `qualityRecord` fields
  are removed. Machine `usage` and `drain` are watts, fuel `value` is joules;
  belt speed stays items/second. Module/beacon effects remain dimensionless.
  Quality modules remain items/recipes but their `module` field is removed.
- `recipes`: non-technology source recipes except the no-input/no-producer
  asteroid distributions. Preserve source IDs, time (seconds), `in`, `out`,
  `catalyst`, `producers`, `locations`, `flags`, `disallowedEffects`, and `cost`.
  Recipe `usage` (when present) is watts. Every recipe has `icon_col`/`icon_row`.
  `locked` is technology-unlock metadata, not a runtime restriction.
- `externalResources`: records `{id, name, item, locations, icon_col, icon_row}`
  for the four asteroid chunks; IDs are `external-<item>`, locations contains
  only `space-platform`. The adapter creates ordinary resource-priority sources.
- `locations`: all six source location records, with `icon_col`/`icon_row`.
- `sprites`: native `{hash, width, height, extra}` metadata for a generated
  32px-cell PNG named `images/sprite-sheet-<hash>.png`. `extra` supplies native
  `clock` and `slot_icon_module` sprites. Source `icon` aliases are resolved
  offline; source `iconText` must remain available for temperature labels.

Default output: `data/space-age-<space-age version>.json` and a sibling
`space-age-<version>.import-report.json`. Output contains no absolute paths or
timestamps. The importer validates all production references before writing.
The adapter bypasses legacy synthetic items, recipes, and special building
loaders, returning the same model collections consumed by `spec.setData`.
The adapter preserves explicit fraction/decimal strings exactly. Numeric JSON
values are normalized to twelve significant digits to remove floating-point
exporter noise while retaining short recycling times such as 0.015625 seconds.

Imported recipes must apply explicit catalyst exemptions in `gives()` and the
solver matrix. Recipe and machine locations must intersect on at least one
selected location; selecting multiple locations permits their union, not a
recipe/machine pair that has no common location. No locations selected means
all locations. Legacy dataset behavior remains unchanged.

Physical recipe eligibility is separate from default recipe preferences. As in
the existing Space Age dataset, ordinary recycling starts disabled; scrap-root
recycling chains start enabled on Fulgora. Users can override these defaults
through the existing recipe controls and saved links.
