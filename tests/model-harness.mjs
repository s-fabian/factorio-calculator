// Only UI construction is stubbed. All calculator models and solving are real.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

export const root = fileURLToPath(new URL('../', import.meta.url))
vm.runInThisContext(readFileSync(root + 'third_party/BigInteger.min.js', 'utf8'))
function node() {
    return { lastChild: null, insertBefore() {}, appendChild() {}, addEventListener() {} }
}
function selection() {
    const element = node()
    let chain
    chain = new Proxy({}, {
        get(_, name) {
            if (name === 'node') return () => element
            return () => chain
        },
    })
    return chain
}
globalThis.window = { location: { hash: '' } }
globalThis.d3 = { local: () => new WeakMap(), create: selection, select: selection }

export const { Rational, zero, one } = await import('../rational.js')
export const factory = await import('../factory.js')
export const { solve } = await import('../solve.js')
export const { getItems } = await import('../item.js')
export const { getRecipes } = await import('../recipe.js')
export const { getBuildings } = await import('../building.js')
export const { getPlanets } = await import('../planet.js')
export const { getModules } = await import('../module.js')
export const { getBelts } = await import('../belt.js')
export const { getFuel } = await import('../fuel.js')
export const { getItemGroups } = await import('../group.js')
export const { getSprites } = await import('../icon.js')
const { init } = await import('../init.js')
const { MODIFICATIONS } = await import('../settings.js')

export const readData = filename => JSON.parse(readFileSync(root + 'data/' + filename, 'utf8'))
export function setData(data, models) {
    factory.resetSpec()
    getSprites(data)
    factory.spec.setData(models.items, models.recipes, models.planets, models.modules,
        models.buildings, models.belts, models.fuels, models.itemGroups)
    factory.spec.setDefaultPriority()
    return factory.spec
}
export function loadLegacy(filename) {
    // Select through the real initialization path to set its legacy flag.
    // Stop before fetching/rendering; the model loader below remains real.
    const entry = [...MODIFICATIONS].find(([, mod]) => mod.filename === filename)
    const selector = { value: entry[0], appendChild() {} }
    globalThis.document = { getElementById: () => selector, createElement: node }
    window.location.hash = '#data=' + entry[0]
    d3.json = () => ({ then() {} })
    init()
    const data = readData(filename)
    const items = getItems(data)
    const recipes = getRecipes(data, items)
    return setData(data, {
        items, recipes, planets: getPlanets(data, recipes), modules: getModules(data, items),
        buildings: getBuildings(data, items), belts: getBelts(data), fuels: getFuel(data, items),
        itemGroups: getItemGroups(items, data),
    })
}
export const rational = value => Rational.from_string(String(value))
