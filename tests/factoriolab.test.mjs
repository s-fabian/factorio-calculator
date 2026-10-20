import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readdirSync } from 'node:fs'
import {
    root, readData, setData, loadLegacy, rational, solve, zero, one,
} from './model-harness.mjs'

const { getFactorioLabData } = await import('../factoriolab.js')
const data = readData('space-age-2.1.20.json')
function load() { return setData(data, getFactorioLabData(data)) }
function near(actual, expected, label = '') {
    const value = typeof actual === 'number' ? actual : actual.toFloat()
    assert.ok(Math.abs(value - expected) < 1e-9, `${label}: ${value} != ${expected}`)
}
function restrict(spec, enabled) {
    const keep = new Set(enabled)
    spec.disable = new Set([...spec.recipes.values()].filter(r => !keep.has(r.key)))
    spec.setDefaultPriority()
}
function target(spec, item, recipe = null, amount = 1) {
    return solve(spec, [{item: spec.items.get(item), rate: rational(amount),
        recipe: recipe === null ? null : spec.recipes.get(recipe)}])
}
function amount(ingredients, key) {
    return ingredients.filter(x => x.item.key === key).reduce((sum, x) => sum.add(x.amount), zero)
}
function select(spec, ...keys) {
    spec.selectedPlanets = new Set(keys.map(key => spec.planets.get(key)))
}

for (const [planet, item, rate, required] of [
    ['nauvis', 'advanced-circuit', 5, ['iron-ore-mining', 'copper-ore-mining']],
    ['vulcanus', 'tungsten-ore', 1, ['tungsten-ore']],
    ['gleba', 'bioflux', 1, ['bioflux']],
    ['fulgora', 'holmium-ore', 1, ['scrap-recycling']],
    ['aquilo', 'lithium-brine', 1, ['lithium-brine']],
    ['space-platform', 'iron-ore', 20, ['metallic-asteroid-crushing']],
]) {
    test(`unrestricted ${planet} production uses real resources for ${item}`, () => {
        const spec = load()
        spec.selectOnePlanet(spec.planets.get(planet))
        const totals = target(spec, item, null, rate)
        for (const key of required) {
            const recipe = spec.recipes.get(key)
            assert.ok(recipe, `missing source recipe ${key}`)
            assert.ok(zero.less(totals.rates.get(recipe) || zero), `${key} must be used`)
        }
        const artificial = [...totals.rates].filter(([recipe, value]) =>
            zero.less(value) && recipe.isDisable?.())
        assert.deepEqual(artificial.map(([recipe]) => recipe.key), [], 'unexpected free material import')
        for (const recipe of totals.extra.values()) {
            assert.ok(!zero.less(totals.rates.get(recipe) || zero), 'unexpected positive solver fallback resource')
        }
        if (item === 'advanced-circuit') {
            near(totals.surplus.get(spec.items.get(item)) || zero, 0, 'target surplus')
        }
    })
}

test('normal-quality recycling defaults avoid ordinary loops and preserve Fulgora scrap chains', () => {
    const spec = load()
    spec.selectOnePlanet(spec.planets.get('nauvis'))
    const recycling = spec.recipes.get('iron-plate-recycling')
    assert.ok(spec.disable.has(recycling))
    spec.setEnable(recycling)
    assert.ok(!spec.disable.has(recycling))
    spec.selectOnePlanet(spec.planets.get('fulgora'))
    assert.ok(!spec.disable.has(spec.recipes.get('scrap-recycling')))
})

test('exact fractional recycling durations survive number conversion', () => {
    const spec = load()
    assert.equal(spec.recipes.get('iron-stick-recycling').time.toString(), '1/64')
})

test('nutrient breakdown combines recipe ingredient and machine fuel for one consumer', () => {
    const spec = load()
    select(spec, 'gleba')
    const recipe = spec.recipes.get('pentapod-egg')
    restrict(spec, [recipe.key])
    // One craft: 30 recipe nutrients + 500kW * (15s / speed2) / 2MJ.
    const totals = target(spec, 'pentapod-egg', null, '1.5')
    near(totals.rates.get(recipe), 1)
    const nutrient = spec.items.get('nutrients')
    near(totals.items.get(nutrient), 31.875)
    near(totals.consumers.get(nutrient).get(recipe), 31.875)
})

test('beacon effect profile follows source aggregation and rounding', () => {
    const spec = load()
    spec.setMinimumBuilding(spec.buildingKeys.get('assembling-machine-3'))
    const modules = spec.getModuleSpec(spec.recipes.get('electronic-circuit'))
    modules.setBeaconModule(spec.modules.get('speed-module-3'), 0)
    modules.setBeaconModule(spec.modules.get('speed-module-3'), 1)
    modules.setBeaconCount(rational(3))
    near(modules.speedEffect(), 3.5979)
    near(modules.powerEffect(spec), 4.637)
})

test('normal-quality production models retain IDs, temperatures and all six locations', () => {
    const spec = load()
    assert.equal(spec.planets.size, 6)
    for (const key of ['nauvis', 'gleba', 'vulcanus', 'fulgora', 'aquilo', 'space-platform']) {
        assert.ok(spec.planets.has(key))
    }
    assert.notEqual(spec.items.get('steam'), spec.items.get('steam-165'))
    assert.ok(spec.items.has('quality-module-3'))
    assert.ok(!spec.modules.has('quality-module-3'))
    assert.ok(spec.recipes.has('quality-module-3'))
    for (const id of ['metallic', 'carbonic', 'oxide', 'promethium']) {
        const recipe = spec.recipes.get(`external-${id}-asteroid-chunk`)
        assert.ok(recipe.isResource())
        select(spec, 'space-platform')
        assert.ok(spec.getRecipes(spec.items.get(`${id}-asteroid-chunk`)).includes(recipe))
        select(spec, 'nauvis')
        assert.ok(!spec.getRecipes(spec.items.get(`${id}-asteroid-chunk`)).includes(recipe))
    }
})

test('existing machine defaults, zero modules and mining productivity are retained', () => {
    const spec = load()
    const iron = spec.recipes.get('iron-plate')
    const mining = spec.recipes.get('iron-ore-mining')
    assert.equal(spec.getBuilding(iron).key, 'electric-furnace')
    assert.equal(spec.getBuilding(mining).key, 'electric-mining-drill')
    assert.equal(spec.getBuilding(spec.recipes.get('iron-gear-wheel')).key, 'assembling-machine-1')
    assert.ok(spec.getModuleSpec(iron).modules.every(module => module === null))
    assert.equal(spec.defaultBeaconCount.toString(), '0')
    spec.miningProd = rational('0.25')
    near(mining.gives(spec.items.get('iron-ore')), 1.25)
    restrict(spec, [mining.key])
    const totals = target(spec, 'iron-ore', null, 5)
    near(totals.rates.get(mining), 4)
})

test('dedicated fuel usage follows speed and consumption modules after changes', () => {
    const spec = load()
    const recipe = spec.recipes.get('iron-bacteria-cultivation')
    select(spec, 'gleba')
    const modules = spec.getModuleSpec(recipe)
    near(amount(recipe.getIngredients(), 'nutrients'), 0.5)
    modules.setModule(0, spec.modules.get('speed-module-3'))
    near(amount(recipe.getIngredients(), 'nutrients'), 0.5 * 1.7 / 1.5)
    modules.setModule(0, spec.modules.get('efficiency-module-3'))
    near(amount(recipe.getIngredients(), 'nutrients'), 0.25)
    spec.fuel = spec.fuels.get('wood')
    near(amount(recipe.getIngredients(), 'nutrients'), 0.25)
    near(amount(recipe.getIngredients(), 'wood'), 0)
})

test('recipe eligibility preserves exact producers and common selected locations', () => {
    const spec = load()
    const iron = spec.recipes.get('iron-plate')
    assert.deepEqual(new Set(iron.producers), new Set(['stone-furnace', 'steel-furnace', 'electric-furnace']))
    assert.ok(iron.producers.has(spec.getBuilding(iron).key))
    const bacteria = spec.recipes.get('iron-bacteria-cultivation')
    select(spec, 'nauvis')
    assert.equal(spec.getBuilding(bacteria), null)
    select(spec, 'nauvis', 'gleba')
    assert.equal(spec.getBuilding(bacteria).key, 'biochamber')
    const eggs = spec.recipes.get('biter-egg')
    select(spec, 'gleba')
    assert.equal(spec.getBuilding(eggs), null)
    select(spec, 'nauvis')
    assert.equal(spec.getBuilding(eggs).key, 'captive-biter-spawner')
    // A union of surfaces must not join a machine on one to a recipe on another.
    const machine = spec.buildingKeys.get('biochamber')
    machine.locations = new Set(['nauvis'])
    select(spec, 'nauvis', 'gleba')
    assert.equal(spec.getBuilding(bacteria), null)
})

test('recursive smelting consumes one ore and source-based chemical fuel per plate', () => {
    const spec = load()
    spec.setMinimumBuilding(spec.buildingKeys.get('stone-furnace'))
    const recipe = spec.recipes.get('iron-plate')
    restrict(spec, ['iron-plate'])
    near(recipe.gives(spec.items.get('iron-plate')), 1)
    near(amount(recipe.getIngredients(), 'iron-ore'), 1)
    // 90 kW * 3.2 seconds / 4 MJ = 0.072 coal.
    near(amount(recipe.getIngredients(), 'coal'), 0.072)
    // Electric furnaces avoid a fuel edge and exercise the recursive path.
    spec.setMinimumBuilding(spec.buildingKeys.get('electric-furnace'))
    const totals = target(spec, 'iron-plate')
    near(totals.rates.get(recipe), 1)
    assert.equal(spec.lastTableau, null)
    near(totals.items.get(spec.items.get('iron-ore')), 1)
})

test('uranium processing retains probabilistic yields and matrix balance', () => {
    const spec = load()
    const recipe = spec.recipes.get('uranium-processing')
    restrict(spec, ['uranium-processing'])
    near(recipe.gives(spec.items.get('uranium-235')), 0.007)
    near(recipe.gives(spec.items.get('uranium-238')), 0.993)
    const totals = target(spec, 'uranium-235')
    assert.ok(spec.lastTableau)
    near(totals.rates.get(recipe), 1 / 0.007)
    near(totals.items.get(spec.items.get('uranium-ore')), 10 / 0.007)
})

test('Kovarex catalyst exemption is identical in gives and cyclic matrix solving', () => {
    const spec = load()
    const recipe = spec.recipes.get('kovarex-enrichment-process')
    const modules = spec.getModuleSpec(recipe)
    modules.setModule(0, spec.modules.get('productivity-module-3'))
    modules.setModule(1, spec.modules.get('productivity-module-3'))
    restrict(spec, [recipe.key])
    near(recipe.gives(spec.items.get('uranium-235')), 41.2)
    near(recipe.gives(spec.items.get('uranium-238')), 2)
    const totals = target(spec, 'uranium-235')
    assert.ok(spec.lastTableau)
    near(totals.rates.get(recipe), 1 / 1.2)
    near(totals.items.get(spec.items.get('uranium-238')), 5 / 1.2)
})

test('bacteria productivity applies to full output and nutrients enter matrix ingredients', () => {
    const spec = load()
    select(spec, 'gleba')
    const recipe = spec.recipes.get('iron-bacteria-cultivation')
    restrict(spec, [recipe.key])
    near(recipe.gives(spec.items.get('iron-bacteria')), 6)
    near(amount(recipe.getIngredients(), 'nutrients'), 0.5)
    const totals = target(spec, 'iron-bacteria', null, 5)
    assert.ok(spec.lastTableau)
    near(totals.rates.get(recipe), 1)
    near(totals.items.get(spec.items.get('bioflux')), 1)
    near(totals.items.get(spec.items.get('nutrients')), 0.5)
})

test('captive spawner consumes bioflux; reactor produces spent fuel without chemical fuel substitution', () => {
    const spec = load()
    const eggs = spec.recipes.get('biter-egg')
    near(amount(eggs.getIngredients(), 'bioflux'), 1 / 6)
    near(amount(eggs.getIngredients(), 'coal'), 0)
    const reactor = [...spec.recipes.values()].find(recipe =>
        recipe.producers?.has('nuclear-reactor'))
    assert.ok(reactor, 'reactor production recipe must be imported')
    const fuel = amount(reactor.getIngredients(), 'uranium-fuel-cell')
    assert.ok(zero.less(fuel))
    near(reactor.gives(spec.items.get('depleted-uranium-fuel-cell')), fuel.toFloat())
})

test('steam temperatures and boiler/heat-exchanger speed use the source values', () => {
    const spec = load()
    const boiler = spec.recipes.get('steam')
    const exchanger = spec.recipes.get('heat-exchanger-steam-boil')
    assert.equal(boiler.products[0].item.key, 'steam-165')
    assert.equal(exchanger.products[0].item.key, 'steam')
    near(spec.getRecipeRate(boiler), 6)
    near(spec.getRecipeRate(exchanger), 10000 / 970)
    near(spec.getPowerUsage(boiler, one).power, 1800000 / 6)
})

test('scrap recycling and asteroid crushing preserve expected yield and returned chunks', () => {
    const spec = load()
    const scrap = spec.recipes.get('scrap-recycling')
    near(scrap.gives(spec.items.get('holmium-ore')), 0.01)
    restrict(spec, [scrap.key])
    let totals = target(spec, 'holmium-ore')
    near(totals.rates.get(scrap), 100)
    near(totals.items.get(spec.items.get('scrap')), 100)
    const asteroid = spec.recipes.get('metallic-asteroid-crushing')
    select(spec, 'space-platform')
    restrict(spec, [asteroid.key, 'external-metallic-asteroid-chunk'])
    totals = target(spec, 'iron-ore', null, 20)
    near(totals.rates.get(asteroid), 1)
    near(totals.rates.get(spec.recipes.get('external-metallic-asteroid-chunk')), 0.7)
})

test('zero beacons with configured modules stay finite and module restrictions are honored', () => {
    const spec = load()
    const recipe = spec.recipes.get('electronic-circuit')
    const modules = spec.getModuleSpec(recipe)
    modules.setBeaconModule(spec.modules.get('speed-module-3'), 0)
    modules.setBeaconCount(zero)
    near(modules.speedEffect(), 1)
    near(modules.powerEffect(spec), 1)
    assert.ok(!spec.modules.get('productivity-module-3').canUse(spec.recipes.get('scrap-recycling')))
})

for (const filename of readdirSync(root + 'data').filter(x => /^(vanilla-|space-age-2\.0).*\.json$/.test(x))) {
    test(`legacy dataset loads and solves unchanged: ${filename}`, () => {
        // Older loaders deliberately log items without resource recipes.
        const log = console.log
        let spec
        try { console.log = () => {}; spec = loadLegacy(filename) } finally { console.log = log }
        const totals = target(spec, 'iron-plate')
        assert.ok(totals.rates.size >= 2)
        near(totals.items.get(spec.items.get('iron-ore')), 1)
        assert.ok(spec.belt)
        assert.ok(spec.fuel)
    })
}
