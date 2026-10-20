# Factorio Calculator

This is the repository for the [Factorio Calculator](https://kirkmcdonald.github.io/calc.html), a tool for calculating resource requirements and production ratios in the game [Factorio](https://factorio.com/).

## Running locally

The calculator consists entirely of static files (HTML, JS, CSS), and may be run locally using any HTTP server. If you have Python 3 installed, you can start a simple development server on port 8000 with:

```text
$ python3 -m http.server 8000
```

An experimental standalone version of the calculator named `factoriocalc`, which will automatically obtain the game data from your locally installed mods, is also available from the [factorio-tools](https://github.com/KirkMcDonald/factorio-tools) repository. A Windows build is available from [the project's releases page](https://github.com/KirkMcDonald/factorio-tools/releases).

## Space Age 2.1 data

New calculations use **Space Age 2.1.20 — normal quality**, imported from
FactorioLab's `2x1` dataset. Existing dataset choices and explicit saved links
remain available. The calculator still runs as a static website; no importer,
FactorioLab checkout or Python installation is needed to use the generated data.

The import covers normal-quality production on Nauvis, Vulcanus, Gleba,
Fulgora, Aquilo and space platforms, including recycling, spoilage conversions,
probabilistic yields, catalyst exemptions, productivity and dedicated machine
fuels. Select multiple locations to calculate chains spanning those locations.
Asteroid chunks are external resources on space platforms. As in the existing
Space Age calculator, ordinary recycling recipes are disabled by default;
Fulgora retains recycling chains rooted in scrap. Individual recipes can be
re-enabled using the existing recipe controls. Belt rates use their normal
throughput; belt stacking has no separate control.

Quality tiers and quality module effects, research targets, asteroid route
simulations, transport logistics and freshness timing are deferred. Quality
modules remain craftable items. Spoilage recipes describe material conversion;
they do not predict when inventory spoils. Ordinary chemical fuel uses the
existing selector; biochambers, captive spawners and reactors use nutrients,
bioflux and uranium fuel cells respectively.

### Refreshing the import

Use Python 3.10+ with Pillow and a local FactorioLab checkout. From this directory:

```sh
python3 -m pip install Pillow
python3 import_factoriolab.py --source ../factoriolab --dataset 2x1
```

Both arguments above are defaults. To record a source revision you supply, add
`--source-commit YOUR_REVISION`. The importer runs no Git commands and does not
change the source checkout. To preview generated files elsewhere, add
`--output-dir /path/to/temporary-output`; this is the output calculator root,
with `data/`, `images/` and `docs/` subdirectories.

The command validates production semantics before writing a versioned JSON
file, PNG sprite sheet and import report. Outputs contain source file hashes,
versions, attribution and deliberate exclusions, with no timestamps or absolute
source paths. Repeated imports from identical inputs produce identical bytes.
See `docs/factoriolab-import-format.md` for the adapter contract and
`data/space-age-2.1.20.import-report.json` for this import's exclusions and image
fallbacks. FactorioLab's license is preserved in `docs/FACTORIOLAB-LICENSE.txt`;
Factorio game artwork remains attributed to Wube Software.

To adopt a newer game version, regenerate the files, update the registered
filename and label in `settings.js`, then run the checks below before selecting
it as the default. Old generated datasets can remain registered for saved links.

### Verification

Run the importer checks with Python/Pillow and the runtime checks with Node.js
22 or newer (no npm packages required):

```sh
python3 -m unittest discover -s tests -p 'test_*.py'
node --test tests/factoriolab.test.mjs
```

Importer tests require the sibling FactorioLab checkout. Runtime tests use the
checked-in generated files and exercise the actual calculator models, recursive
solver, matrix solver and all four legacy datasets. A minimal UI construction
stub keeps these numeric tests independent of a browser. For visual verification,
serve this directory and open `http://localhost:8000/calc.html`; check target
selection, icons, machine/module changes, location selection, tables, graphs and
saved-link reloads.

## Dumping new datasets

The utility for dumping datasets from the game, as well as assembling the sprite sheets, is called `factoriodump`, and may be found in the [factorio-tools](https://github.com/KirkMcDonald/factorio-tools) repository.

## Support the calculator

Please consider donating to [my Patreon campaign](https://www.patreon.com/kirkmcdonald). Any amount helps. And thank you!
