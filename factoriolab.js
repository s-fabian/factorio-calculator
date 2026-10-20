/* FactorioLab production-v1 adapter. Source conversion and attribution are
 * handled by import_factoriolab.py; the browser needs no FactorioLab code. */
import { Building } from "./building.js"
import { Belt } from "./belt.js"
import { spec } from "./factory.js"
import { Fuel } from "./fuel.js"
import { Icon } from "./icon.js"
import { Item } from "./item.js"
import { getModules } from "./module.js"
import { Rational, zero, one } from "./rational.js"
import { Ingredient, Recipe } from "./recipe.js"

// Retain decimal recipe times (including 1/64-second recycling), rather than
// rounding every value to five decimal places. Numeric JSON values use twelve
// significant digits to discard floating-point exporter noise such as
// 0.007000000000000001; explicit source fraction/decimal strings remain exact.
const R = value => {
    let text = typeof value === "number" ? value.toPrecision(12) : String(value || 0)
    if (text.includes("/")) { return Rational.from_string(text) }
    let match = text.match(/^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i)
    if (!match) { throw new Error(`Invalid production number: ${value}`) }
    let [, sign, whole, fraction = "", exponent = "0"] = match
    let numerator = bigInt((whole || "0") + fraction)
    let scale = fraction.length - Number(exponent)
    let denominator = bigInt(10).pow(Math.max(0, scale))
    if (scale < 0) { numerator = numerator.mul(bigInt(10).pow(-scale)) }
    if (sign === "-") { numerator = numerator.negate() }
    return new Rational(numerator, denominator)
}
const locations = x => x ? new Set(x) : null

export function locationAllows(recipe, building, location) {
    return (!recipe.locations || recipe.locations.has(location)) &&
        (!building || !building.locations || building.locations.has(location))
}

export class FactorioLabBuilding extends Building {
    constructor(d, categories, fuels) {
        let m = d.machine
        let fuelType = m.type === "burner" ? m.fuelTypes[0] : null
        super(d.id, d.name, d.icon_col, d.icon_row, categories, R(m.speed),
            R(m.baseEffect?.productivity), m.modules || 0, R(m.usage), fuelType)
        this.imported = true
        this.locations = locations(m.locations)
        this.disallowedEffects = new Set(m.disallowedEffects || [])
        this.baseEffects = m.baseEffect || {}
        this.energyType = m.type || (d.id === "heat-exchanger" ? "heat" : "none")
        this.drainPower = R(m.drain)
        this.fixedFuel = fuelType && fuelType !== "chemical"
            ? Array.from(fuels.values()).find(f => f.category === fuelType) : null
    }
    drain() { return this.drainPower }
    prodEffect(spec, recipe) {
        return this.prodBonus.add(recipe?.flags.has("mining") ? spec.miningProd : zero)
    }
}

export class FactorioLabRecipe extends Recipe {
    constructor(d, items, category, allFuels, machineData) {
        let inputs = d.in || {}
        let outputs = d.out || {}
        let time = R(d.time)
        let flags = new Set(d.flags || [])
        // FactorioLab leaves burn amounts zero until machine adjustment. Model
        // a complete fuel cycle, so all consumers and solvers see the byproduct.
        if (flags.has("burn")) {
            let fuelKey = Object.keys(inputs)[0]
            let fuel = allFuels.get(fuelKey)
            let machine = machineData.get(d.producers[0])
            if (!fuel || !fuel.result || !machine || !zero.less(R(machine.usage))) {
                throw new Error(`Unsupported burn recipe: ${d.id}`)
            }
            inputs = {[fuelKey]: 1}
            outputs = {[fuel.result]: 1}
            time = fuel.value.div(R(machine.usage)).mul(R(machine.speed))
        }
        let ingredients = Object.entries(inputs).filter(([, x]) => !R(x).isZero())
            .map(([key, x]) => new Ingredient(items.get(key), R(x)))
        let products = Object.entries(outputs).filter(([, x]) => !R(x).isZero())
            .map(([key, x]) => new Ingredient(items.get(key), R(x)))
        if (!products.length) { throw new Error(`Recipe has no output: ${d.id}`) }
        super(d.id, d.name, d.id, d.icon_col, d.icon_row,
            !(d.disallowedEffects || []).includes("productivity"), category,
            time, ingredients, products, [])
        this.imported = true
        this.sourceId = d.id
        this.flags = flags
        this.producers = new Set(d.producers || [])
        this.locations = locations(d.locations)
        this.disallowedEffects = new Set(d.disallowedEffects || [])
        this.catalysts = new Map(Object.entries(d.catalyst || {}).map(([k, v]) => [k, R(v)]))
        this.usage = d.usage === undefined ? null : R(d.usage)
        this.iconText = d.iconText
        if (flags.has("mining") || flags.has("plant") || (!ingredients.length && !flags.has("burn"))) {
            this.defaultPriority = flags.has("mining") || flags.has("plant") ? 1 : 0
            this.defaultWeight = R(d.cost || 100)
        }
    }
    isResource() { return this.defaultPriority !== undefined }
    canUseModule(module, beacon = false) {
        let building = spec.getBuilding(this)
        if (!building) { return false }
        for (let key of ["speed", "productivity", "consumption", "pollution", "quality"]) {
            if (!this.disallowedEffects.has(key) && !building.disallowedEffects.has(key)) { continue }
            let value = module.effects?.[key] || zero
            // A forbidden effect excludes its benefit, not incidental penalties.
            if (key === "consumption" || key === "pollution") {
                if (value.less(zero)) { return false }
            } else if (zero.less(value)) { return false }
        }
        return !beacon || module.canBeacon()
    }
    fuelIngredient() {
        if (this.flags.has("burn")) { return [] }
        let fuel = spec.getFuel(this)
        if (!fuel) { return [] }
        let rate = spec.getRecipeRate(this)
        if (!rate || rate.isZero()) { return [] }
        let power = spec.getPowerUsage(this, rate).power
        return [new Ingredient(fuel.item, power.div(rate).div(fuel.value))]
    }
    uses(item) {
        return this.getIngredients().filter(i => i.item === item).reduce((sum, i) => sum.add(i.amount), zero)
    }
    gives(item) {
        let product = this.products.find(p => p.item === item)
        if (!product) { throw new Error("recipe does not give item") }
        let exempt = this.catalysts.get(item.key) || zero
        let affected = product.amount.sub(exempt)
        if (affected.less(zero)) { affected = zero }
        return product.amount.add(affected.mul(spec.getProdEffect(this).sub(one)))
    }
}

class FactorioLabPlanet {
    constructor(d, recipes, buildings, i) {
        this.key = d.id
        this.name = d.name
        this.order = i
        this.icon_col = d.icon_col
        this.icon_row = d.icon_row
        this.icon = new Icon(this)
        this.disable = new Set()
        for (let recipe of recipes.values()) {
            let allowed = recipe.producers.size
                ? buildings.some(b => recipe.producers.has(b.key) && locationAllows(recipe, b, d.id))
                : locationAllows(recipe, null, d.id)
            if (!allowed || recipe.flags.has("recycling") || recipe.key.endsWith("-recycling")) {
                this.disable.add(recipe)
            }
        }
        // Keep the calculator's existing recycling preference: start with the
        // scrap chain on Fulgora. Other recycling remains explicitly selectable
        // without turning every ordinary production calculation into a cycle.
        let scrap = recipes.get("scrap")
        if (scrap && locationAllows(scrap, null, d.id)) {
            let seen = new Set()
            let visit = recipe => {
                for (let {item} of recipe.products) {
                    for (let next of item.uses) {
                        if ((next.flags.has("recycling") || next.key.endsWith("-recycling")) && !seen.has(next)) {
                            seen.add(next)
                            if (buildings.some(b => next.producers.has(b.key) && locationAllows(next, b, d.id))) {
                                this.disable.delete(next)
                                visit(next)
                            }
                        }
                    }
                }
            }
            visit(scrap)
        }
    }
}

export function getFactorioLabData(data) {
    if (data.format !== "factoriolab-production-v1") {
        throw new Error(`Unsupported production data format: ${data.format}`)
    }
    let items = new Map()
    let rowGroups = new Map()
    for (let d of data.items) {
        let item = new Item(d.id, d.name, d.icon_col, d.icon_row,
            d.types.includes("fluid") ? "fluid" : "solid", d.category, d.row || 0, d.id)
        item.sourceId = d.id
        item.iconText = d.iconText
        items.set(d.id, item)
        let group = rowGroups.get(d.category)
        if (!group) { group = new Map(); rowGroups.set(d.category, group) }
        let row = group.get(d.row || 0)
        if (!row) { row = []; group.set(d.row || 0, row) }
        row.push(item)
    }
    let allFuels = new Map()
    for (let d of data.items) {
        if (!d.fuel) { continue }
        for (let category of d.fuel.types) {
            let item = items.get(d.id)
            let f = new Fuel(d.id, d.name, d.icon_col, d.icon_row, item, category, R(d.fuel.value))
            f.result = d.fuel.result
            allFuels.set(d.id, f)
        }
    }
    let fuels = new Map(Array.from(allFuels).filter(([, f]) => f.category === "chemical")
        .sort((a, b) => a[1].value.toFloat() - b[1].value.toFloat()))
    let machineData = new Map(data.items.filter(d => d.machine).map(d => [d.id, d.machine]))
    let machineCategories = new Map(Array.from(machineData.keys(), key => [key, new Set()]))
    let recipes = new Map()
    for (let d of data.recipes) {
        let producers = Array.from(d.producers || []).sort()
        let category = producers.length ? `factoriolab:${producers.join("|")}` : null
        for (let key of producers) { machineCategories.get(key).add(category) }
        let recipe = new FactorioLabRecipe(d, items, category, allFuels, machineData)
        recipes.set(recipe.key, recipe)
    }
    for (let d of data.externalResources) {
        let recipe = new FactorioLabRecipe({...d, time: 1, out: {[d.item]: 1}}, items, null, allFuels, machineData)
        recipes.set(recipe.key, recipe)
    }
    let buildings = data.items.filter(d => d.machine && machineCategories.get(d.id).size)
        .map(d => new FactorioLabBuilding(d, machineCategories.get(d.id), allFuels))
    let modules = getModules({
        modules: data.items.filter(d => d.module).map(d => ({
            item_key: d.id, category: d.id.replace(/-\d+$/, ""), effect: d.module,
        })),
        beacon: (() => {
            let b = data.items.find(d => d.beacon)?.beacon
            return {distribution_effectivity: b?.effectivity || 0, profile: b?.profile || [1]}
        })(),
    }, items)
    for (let d of data.items) {
        if (d.module) {
            modules.get(d.id).effects = Object.fromEntries(Object.entries(d.module).map(([k, v]) => [k, R(v)]))
        }
    }
    let belts = new Map(data.items.filter(d => d.belt?.itemTypes.includes("item"))
        .sort((a, b) => Number(a.belt.speed) - Number(b.belt.speed))
        .map(d => [d.id, new Belt(d.id, d.name, d.icon_col, d.icon_row, R(d.belt.speed))]))
    let planets = new Map(data.locations.map((d, i) => [d.id, new FactorioLabPlanet(d, recipes, buildings, i)]))
    let itemGroups = data.categories.filter(d => rowGroups.has(d.id)).map(d =>
        Array.from(rowGroups.get(d.id)).sort((a, b) => a[0] - b[0]).map(([, row]) => row))
    return {items, recipes, planets, modules, buildings, belts, fuels, itemGroups}
}
