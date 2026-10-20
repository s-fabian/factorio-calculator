#!/usr/bin/env python3
"""Import a local FactorioLab production dataset; ordinary calculator use stays static.

Requires Pillow. No network access, Factorio installation, or Git commands are used.
--output-dir is a calculator root containing generated data/ and images/ folders.
"""
from __future__ import annotations

import argparse
import copy
from fractions import Fraction
import hashlib
from io import BytesIO
import json
import math
from pathlib import Path
import re
import sys

try:
    from PIL import Image
except ImportError:
    raise SystemExit("Pillow is required: python3 -m pip install Pillow")

ROOT = Path(__file__).resolve().parent
FORMAT = "factoriolab-production-v1"
ASTEROIDS = ("metallic-asteroid-chunk", "carbonic-asteroid-chunk",
             "oxide-asteroid-chunk", "promethium-asteroid-chunk")
RECIPE_FIELDS = {"id", "name", "category", "row", "time", "in", "out",
                 "producers", "locations", "flags", "disallowedEffects", "cost",
                 "catalyst", "icon", "iconText", "usage"}
ITEM_FIELDS = {"id", "name", "category", "row", "types", "stack", "rocketCapacity",
               "icon", "iconText", "machine", "belt", "module", "beacon", "fuel",
               "inserter", "wagon"}
MACHINE_FIELDS = {"speed", "type", "fuelTypes", "usage", "drain", "pollution", "size",
                  "locations", "modules", "disallowedEffects", "qualityRecord",
                  "baseEffect", "ingredientUsage", "silo"}
FLAGS = {"locked", "mining", "recycling", "showCount", "plant", "infinite", "burn"}
EFFECTS = {"speed", "consumption", "productivity", "pollution", "quality"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def number(value, label, minimum=None, positive=False):
    require(not isinstance(value, bool) and isinstance(value, (int, float, str)),
            f"{label}: expected a number, got {value!r}")
    try:
        result = Fraction(str(value))
    except (ValueError, ZeroDivisionError, OverflowError):
        raise ValueError(f"{label}: invalid finite number {value!r}") from None
    require(math.isfinite(float(result)), f"{label}: non-finite number")
    require(minimum is None or result >= minimum, f"{label}: must be >= {minimum}")
    require(not positive or result > 0, f"{label}: must be positive")
    return result


def scale(value, factor, label):
    result = number(value, label, minimum=0) * factor
    if result.denominator == 1:
        return result.numerator
    if isinstance(value, str):
        return str(result)
    return float(result)


def unique(records, label):
    require(isinstance(records, list), f"{label}: expected records")
    result = {}
    for record in records:
        require(isinstance(record, dict) and isinstance(record.get("id"), str)
                and record["id"], f"{label}: missing identifier")
        require(record["id"] not in result, f"{label}: duplicate {record['id']}")
        result[record["id"]] = record
    return result


def known_fields(record, allowed, label):
    require(not set(record) - allowed,
            f"{label}: unsupported fields {sorted(set(record) - allowed)}")


def remove_quality(value, path, exclusions):
    if isinstance(value, dict):
        result = {}
        for key, entry in value.items():
            if key == "qualityRecord":
                exclusions.append({"kind": "qualityRecord", "id": path + ".qualityRecord",
                                   "reason": "Only normal quality is imported."})
            else:
                result[key] = remove_quality(entry, path + "." + key, exclusions)
        return result
    if isinstance(value, list):
        return [remove_quality(v, f"{path}[{i}]", exclusions) for i, v in enumerate(value)]
    return value


def validate_locations(record, location_ids, label):
    if "locations" in record:
        require(isinstance(record["locations"], list) and record["locations"],
                f"{label}: locations must be a nonempty list")
        for location in record["locations"]:
            require(location in location_ids, f"{label}: unknown location {location}")


def validate_effects(record, label):
    if "disallowedEffects" in record:
        require(isinstance(record["disallowedEffects"], list), f"{label}: invalid effect list")
        require(set(record["disallowedEffects"]) <= EFFECTS, f"{label}: unsupported effects")


def validate_finite(value, label):
    if isinstance(value, float):
        require(math.isfinite(value), f"{label}: non-finite number")
    elif isinstance(value, dict):
        for key, entry in value.items():
            if key != "qualityRecord":
                validate_finite(entry, label + "." + key)
    elif isinstance(value, list):
        for index, entry in enumerate(value):
            validate_finite(entry, f"{label}[{index}]")


def validate(items, recipes, locations, categories):
    validate_finite([items, recipes, locations, categories], "production data")
    item_map = unique(items, "items")
    recipe_map = unique(recipes, "recipes")
    location_ids = unique(locations, "locations")
    category_ids = unique(categories, "categories")
    for item in items:
        label = "item " + item["id"]
        known_fields(item, ITEM_FIELDS, label)
        require(item.get("types") and set(item["types"]) <= {"item", "fluid"},
                f"{label}: unsupported physical type")
        require(item.get("category") in category_ids, f"{label}: unknown category")
        number(item.get("row"), f"{label}.row", minimum=0)
        for field in ("stack", "rocketCapacity"):
            if field in item:
                number(item[field], f"{label}.{field}", minimum=0, positive=field == "stack")
        for nested in ("machine", "beacon", "belt", "module", "fuel"):
            if nested not in item:
                continue
            record = item[nested]
            require(isinstance(record, dict), f"{label}.{nested}: expected object")
            allowed = {
                "machine": MACHINE_FIELDS,
                "beacon": {"effectivity", "modules", "range", "type", "usage", "disallowedEffects", "size", "profile", "qualityRecord"},
                "belt": {"itemTypes", "speed", "qualityRecord"},
                "module": EFFECTS | {"qualityRecord"},
                "fuel": {"types", "value", "result"},
            }[nested]
            known_fields(record, allowed, f"{label}.{nested}")
            validate_locations(record, location_ids, label)
            validate_effects(record, label)
            for field in ("speed", "usage", "drain", "modules", "ingredientUsage", "effectivity", "range", "value"):
                if field in record:
                    number(record[field], f"{label}.{nested}.{field}", minimum=None if nested == "module" else 0,
                           positive=field in {"value", "ingredientUsage"})
            if "speed" in record and nested == "machine":
                number(record["speed"], label + ".machine.speed", positive=True)
            if "type" in record:
                require(record["type"] in {"electric", "burner"}, f"{label}: unsupported energy type")
            if "baseEffect" in record:
                known_fields(record["baseEffect"], {"speed", "consumption", "productivity"}, label + ".baseEffect")
                for key, value in record["baseEffect"].items():
                    number(value, label + ".baseEffect." + key)
            if nested == "machine" and "fuelTypes" in record:
                require(isinstance(record["fuelTypes"], list) and record["fuelTypes"]
                        and set(record["fuelTypes"]) <= {"chemical", "nuclear", "nutrients", "food"},
                        f"{label}: unsupported machine fuel types")
            if "modules" in record:
                require(number(record["modules"], label + ".modules").denominator == 1,
                        f"{label}: module slot count must be integral")
            if "size" in record:
                require(isinstance(record["size"], list) and len(record["size"]) == 2,
                        f"{label}: expected two machine dimensions")
                for dimension in record["size"]:
                    number(dimension, label + ".size", positive=True)
            if "result" in record:
                require(record["result"] in item_map, f"{label}: unknown burnt fuel result")
            if nested == "module":
                for key, value in record.items():
                    if key != "qualityRecord":
                        number(value, label + ".module." + key)
            if "profile" in record:
                require(isinstance(record["profile"], list) and record["profile"], f"{label}: empty beacon profile")
                for v in record["profile"]:
                    number(v, label + ".profile", minimum=0)
    for recipe in recipe_map.values():
        label = "recipe " + recipe["id"]
        known_fields(recipe, RECIPE_FIELDS, label)
        require(recipe.get("category") in category_ids, f"{label}: unknown category")
        number(recipe.get("time"), label + ".time", positive=True)
        number(recipe.get("row"), label + ".row", minimum=0)
        require(set(recipe.get("flags", [])) <= FLAGS, f"{label}: unsupported production flags")
        validate_effects(recipe, label)
        validate_locations(recipe, location_ids, label)
        for field in ("in", "out", "catalyst"):
            quantities = recipe.get(field, {})
            require(isinstance(quantities, dict), f"{label}.{field}: expected quantity map")
            if field == "out":
                require(quantities, f"{label}: output required")
            for item, amount in quantities.items():
                require(item in item_map, f"{label}.{field}: unknown item {item}")
                number(amount, f"{label}.{field}.{item}", minimum=0)
                if field == "catalyst":
                    require(item in recipe["out"] and number(amount, label) <= number(recipe["out"][item], label),
                            f"{label}: catalyst exceeds output")
        for field in ("usage", "cost"):
            if field in recipe:
                number(recipe[field], label + "." + field, minimum=0)
        producers = recipe.get("producers", [])
        require(isinstance(producers, list) and all(isinstance(p, str) for p in producers),
                f"{label}: producers must be an array of identifiers")
        flags = recipe.get("flags", [])
        if "burn" in flags:
            require(len(producers) == 1 and len(recipe["in"]) == 1 and len(recipe["out"]) == 1,
                    f"{label}: unsupported burn recipe shape")
            fuel_id, fuel_amount = next(iter(recipe["in"].items()))
            result_id, result_amount = next(iter(recipe["out"].items()))
            fuel = item_map[fuel_id].get("fuel", {})
            require(fuel.get("result") == result_id and number(fuel_amount, label) == 0
                    and number(result_amount, label) == 0,
                    f"{label}: burn recipe must reference a burnt-result fuel with zero placeholders")
            machine = item_map.get(producers[0], {}).get("machine", {})
            require(machine.get("type") == "burner"
                    and set(machine.get("fuelTypes", [])) & set(fuel.get("types", [])),
                    f"{label}: incompatible burn recipe producer")
        else:
            require(any(number(v, label) > 0 for v in recipe["out"].values()),
                    f"{label}: output must contain a positive quantity")
        for producer in producers:
            require(producer in item_map and "machine" in item_map[producer],
                    f"{label}: unknown production machine {producer}")
            machine = item_map[producer]["machine"]
            require(number(machine.get("ingredientUsage", 1), label) == 1,
                    f"{label}: production ingredientUsage modifiers are unsupported")
        if not recipe.get("producers"):
            require(recipe.get("in"), f"{label}: unsupported source without a producer")
    return item_map


def build(source, dataset, source_commit=None):
    require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", dataset), "Invalid dataset identifier")
    folder = source / "public" / "data" / dataset
    source_data = json.loads((folder / "data.json").read_text())
    known_fields(source_data, {"version", "categories", "icons", "items", "recipes", "flags", "qualities", "locations", "defaults"}, "dataset")
    unique(source_data["items"], "source items")
    unique(source_data["recipes"], "source recipes")
    exclusions = []
    items = []
    for item in source_data["items"]:
        if "technology" in item:
            exclusions.append({"kind": "item", "id": item["id"], "reason": "Research/technology target."})
        else:
            items.append(copy.deepcopy(item))
    recipes = []
    for recipe in source_data["recipes"]:
        if "technology" in recipe.get("flags", []):
            exclusions.append({"kind": "recipe", "id": recipe["id"], "reason": "Research/technology target."})
        elif not recipe.get("in") and not recipe.get("producers"):
            require(recipe.get("category") == "space" and set(recipe["out"]) <= set(ASTEROIDS),
                    f"Unsupported source recipe {recipe['id']}")
            exclusions.append({"kind": "recipe", "id": recipe["id"], "reason": "Space-route/orbital asteroid distribution; chunks are external resources."})
        else:
            recipes.append(copy.deepcopy(recipe))
    locations = copy.deepcopy(source_data["locations"])
    categories = copy.deepcopy(source_data["categories"])
    item_map = validate(items, recipes, locations, categories)
    for item in items:
        if number(item.get("module", {}).get("quality", 0), item["id"]) > 0:
            item.pop("module")
            exclusions.append({"kind": "module", "id": item["id"], "reason": "Quality modules remain craftable, but cannot be installed in normal-quality calculations."})
    items = [remove_quality(item, "items." + item["id"], exclusions) for item in items]
    for item in items:
        for nested in ("machine", "beacon"):
            for field in ("usage", "drain"):
                if field in item.get(nested, {}):
                    item[nested][field] = scale(item[nested][field], 1000, item["id"] + "." + field)
        if "fuel" in item:
            item["fuel"]["value"] = scale(item["fuel"]["value"], 1000000, item["id"] + ".fuel.value")
        if "quality" in item.get("module", {}):
            item["module"].pop("quality")
            exclusions.append({"kind": "effect", "id": item["id"] + ".module.quality", "reason": "Quality effects are deferred; other module effects are retained."})
    for recipe in recipes:
        if "usage" in recipe:
            recipe["usage"] = scale(recipe["usage"], 1000, recipe["id"] + ".usage")
    for key in ("qualities", "flags", "defaults"):
        exclusions.append({"kind": "metadata", "id": key, "reason": {
            "qualities": "Normal quality only; no quality-tier expansion.",
            "flags": "FactorioLab user-interface capability flags are not calculator data.",
            "defaults": "Calculator retains its existing preferences and zero installed modules.",
        }[key]})
    icons = unique(source_data["icons"], "icons")
    source_atlas = Image.open(folder / "icons.webp").convert("RGBA")
    icon_ids = []
    fallbacks = []
    def resolve(record, kind):
        icon_id = record.get("icon", record["id"])
        if icon_id not in icons:
            candidates = list(record.get("out", {}))
            resolved = next((item_map[k].get("icon", k) for k in candidates
                             if item_map[k].get("icon", k) in icons), None)
            require(resolved is not None, f"{kind} {record['id']}: no resolvable icon")
            fallbacks.append({"kind": kind, "id": record["id"], "requested": icon_id, "resolved": resolved})
            icon_id = resolved
        if icon_id not in icon_ids:
            icon_ids.append(icon_id)
        index = icon_ids.index(icon_id)
        record["icon_col"], record["icon_row"] = index % 32, index // 32
    for kind, records in (("item", items), ("recipe", recipes), ("location", locations)):
        for record in records:
            resolve(record, kind)
    external = []
    for identifier in ASTEROIDS:
        require(identifier in item_map, f"Missing asteroid chunk {identifier}")
        record = {"id": "external-" + identifier, "name": item_map[identifier]["name"],
                  "item": identifier, "locations": ["space-platform"], "icon": item_map[identifier].get("icon", identifier)}
        resolve(record, "externalResource")
        record.pop("icon")
        external.append(record)
    legacy_file = ROOT / "data" / "space-age-2.0.55.json"
    legacy = json.loads(legacy_file.read_text())["sprites"]
    legacy_atlas_file = ROOT / "images" / f"sprite-sheet-{legacy['hash']}.png"
    legacy_atlas = Image.open(legacy_atlas_file).convert("RGBA")
    atlas = Image.new("RGBA", (32 * 32, math.ceil((len(icon_ids) + 2) / 32) * 32))
    for index, identifier in enumerate(icon_ids):
        icon = icons[identifier]
        x, y = icon["x"], icon["y"]
        require(isinstance(x, int) and isinstance(y, int) and 0 <= x <= source_atlas.width - 64
                and 0 <= y <= source_atlas.height - 64, f"Icon {identifier}: invalid atlas coordinates")
        tile = source_atlas.crop((x, y, x + 64, y + 64)).resize((32, 32), Image.Resampling.LANCZOS)
        atlas.paste(tile, (index % 32 * 32, index // 32 * 32))
    extra = {}
    for offset, identifier in enumerate(("clock", "slot_icon_module")):
        index = len(icon_ids) + offset
        record = legacy["extra"][identifier]
        x, y = record["icon_col"] * 32, record["icon_row"] * 32
        atlas.paste(legacy_atlas.crop((x, y, x + 32, y + 32)), (index % 32 * 32, index // 32 * 32))
        extra[identifier] = {"icon_col": index % 32, "icon_row": index // 32, "name": record["name"]}
    buffer = BytesIO()
    atlas.save(buffer, format="PNG", compress_level=9)
    sprite_bytes = buffer.getvalue()
    sprite_hash = hashlib.sha256(sprite_bytes).hexdigest()[:32]
    hashes = {f"public/data/{dataset}/{name}": hashlib.sha256((folder / name).read_bytes()).hexdigest()
              for name in ("data.json", "icons.webp")}
    license_bytes = (source / "LICENSE").read_bytes()
    require(b"MIT License" in license_bytes and b"Permission is hereby granted" in license_bytes,
            "Expected FactorioLab MIT LICENSE; review source license before importing")
    hashes["LICENSE"] = hashlib.sha256(license_bytes).hexdigest()
    source_info = {"dataset": dataset, "versions": source_data["version"], "files": hashes}
    if source_commit:
        source_info["commit"] = source_commit
    version = source_data["version"].get("space-age")
    require(isinstance(version, str) and re.fullmatch(r"[0-9]+(?:\.[0-9]+)+", version), "Missing safe Space Age version")
    data = {"format": FORMAT, "source": source_info, "categories": categories, "items": items,
            "recipes": recipes, "externalResources": external, "locations": locations,
            "sprites": {"hash": sprite_hash, "width": atlas.width, "height": atlas.height, "extra": extra}}
    report = {"format": FORMAT, "source": source_info,
              "counts": {"sourceItems": len(source_data["items"]), "items": len(items),
                         "sourceRecipes": len(source_data["recipes"]), "recipes": len(recipes),
                         "externalResources": len(external), "locations": len(locations)},
              "attribution": {"project": "FactorioLab", "url": "https://github.com/factoriolab/factoriolab",
                              "license": "MIT", "licenseFile": "docs/FACTORIOLAB-LICENSE.txt",
                              "gameAssets": "Factorio names and artwork belong to Wube Software. FactorioLab's MIT license does not relicense game assets."},
              "utilitySpriteSources": {"dataset": "data/space-age-2.0.55.json",
                                       "datasetSha256": hashlib.sha256(legacy_file.read_bytes()).hexdigest(),
                                       "sprite": f"images/{legacy_atlas_file.name}",
                                       "spriteSha256": hashlib.sha256(legacy_atlas_file.read_bytes()).hexdigest()},
              "exclusions": exclusions, "iconFallbacks": fallbacks,
              "deferred": ["Research targets", "Non-normal quality tiers", "Space-route/orbital asteroid simulations", "Freshness and transport-time simulation"],
              "notes": ["Source output amounts already represent expected probabilistic yields.",
                        "Distinct temperature-specific item identifiers and iconText labels are retained.",
                        "Source locked flags describe technology unlocks, not production restrictions.",
                        "Spoilage recipes remain material conversions; their source time is not a freshness model.",
                        "Burn recipes intentionally retain zero placeholder amounts; the adapter derives fuel consumption and depleted-cell output from machine power and fuel energy.",
                        "Nested source qualityRecord variants are discarded; retained values are normal quality."]}
    return version, data, report, sprite_bytes, license_bytes


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT.parent / "factoriolab", help="FactorioLab checkout (default: ../factoriolab beside this script)")
    parser.add_argument("--dataset", default="2x1")
    parser.add_argument("--output-dir", type=Path, default=ROOT, help="Calculator output root (writes data/, images/, docs/)")
    parser.add_argument("--source-commit", help="Optional source commit recorded verbatim; never inspected with Git")
    args = parser.parse_args(argv)
    try:
        version, data, report, sprite_bytes, license_bytes = build(args.source, args.dataset, args.source_commit)
        outputs = {
            f"data/space-age-{version}.json": (json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode(),
            f"data/space-age-{version}.import-report.json": (json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode(),
            f"images/sprite-sheet-{data['sprites']['hash']}.png": sprite_bytes,
            "docs/FACTORIOLAB-LICENSE.txt": license_bytes,
        }
        # Validate and render everything before touching any output file.
        for relative, content in outputs.items():
            path = args.output_dir / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
        print(f"Imported {args.dataset}: {len(data['items'])} items, {len(data['recipes'])} recipes, {len(data['locations'])} locations")
        print(f"Dataset: {args.output_dir / f'data/space-age-{version}.json'}")
        return 0
    except (ValueError, KeyError, TypeError, OSError) as error:
        print(f"Import failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
