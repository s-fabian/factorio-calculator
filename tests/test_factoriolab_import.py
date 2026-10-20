"""Offline importer regressions; uses the local source checkout without editing it."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT.parent / 'factoriolab'
MODULE_SPEC = importlib.util.spec_from_file_location('importer', ROOT / 'import_factoriolab.py')
importer = importlib.util.module_from_spec(MODULE_SPEC)
MODULE_SPEC.loader.exec_module(importer)


def tree_bytes(root):
    return {str(path.relative_to(root)): path.read_bytes()
            for path in sorted(root.rglob('*')) if path.is_file()}


class ImportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = json.loads((SOURCE / 'public/data/2x1/data.json').read_text())
        cls.version, cls.data, cls.report, cls.sprite, cls.license = importer.build(SOURCE, '2x1')

    def test_repeated_cli_import_is_identical_and_leaves_source_untouched(self):
        inputs = [SOURCE / 'public/data/2x1/data.json', SOURCE / 'public/data/2x1/icons.webp', SOURCE / 'LICENSE']
        before = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in inputs}
        with tempfile.TemporaryDirectory() as first, tempfile.TemporaryDirectory() as second:
            for output in (first, second):
                result = subprocess.run([sys.executable, str(ROOT / 'import_factoriolab.py'),
                    '--source', str(SOURCE), '--dataset', '2x1', '--output-dir', output,
                    '--source-commit', 'user-supplied-revision'], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(tree_bytes(Path(first)), tree_bytes(Path(second)))
            generated = json.loads((Path(first) / f'data/space-age-{self.version}.json').read_text())
            self.assertEqual(generated['source']['commit'], 'user-supplied-revision')
            self.assertEqual(generated['source']['files'], self.data['source']['files'])
        self.assertEqual(before, {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in inputs})

    def test_all_references_and_exact_route_exclusion(self):
        items = {x['id']: x for x in self.data['items']}
        locations = {x['id'] for x in self.data['locations']}
        self.assertEqual(len(locations), 6)
        source_technology = {x['id'] for x in self.source['recipes'] if 'technology' in x.get('flags', [])}
        actual = {x['id'] for x in self.data['recipes']}
        self.assertFalse(actual & source_technology)
        routes = [x for x in self.report['exclusions'] if x['kind'] == 'recipe' and 'asteroid distribution' in x['reason']]
        self.assertEqual(len(routes), 16)
        expected = {x['id'] for x in self.source['recipes']} - source_technology - {x['id'] for x in routes}
        self.assertEqual(actual, expected)
        for recipe in self.data['recipes']:
            for field in ('in', 'out', 'catalyst'):
                self.assertTrue(set(recipe.get(field, {})) <= items.keys(), recipe['id'])
            for machine in recipe.get('producers', []):
                self.assertIn('machine', items[machine])
            self.assertTrue(set(recipe.get('locations', [])) <= locations)
        self.assertEqual(len(self.data['externalResources']), 4)
        self.assertTrue(all(x['locations'] == ['space-platform'] for x in self.data['externalResources']))

    def test_units_quality_scope_and_temperature_aliases(self):
        items = {x['id']: x for x in self.data['items']}
        self.assertEqual(items['biochamber']['machine']['usage'], 500_000)
        self.assertEqual(items['uranium-fuel-cell']['fuel']['value'], 8_000_000_000)
        self.assertEqual(items['transport-belt']['belt']['speed'], 15)
        self.assertNotIn('module', items['quality-module-3'])
        self.assertIn('machine', items['biochamber'])
        self.assertNotIn('qualityRecord', json.dumps(self.data))
        self.assertNotEqual(items['steam']['id'], items['steam-165']['id'])
        self.assertEqual(items['steam-165']['iconText'], '165°')
        self.assertEqual(self.data['format'], 'factoriolab-production-v1')
        self.assertTrue(self.report['attribution'])
        self.assertTrue(self.license)

    def test_malformed_production_data_is_rejected_before_output_is_written(self):
        mutations = {
            'unknown item': lambda r: r['in'].__setitem__('nonexistent-item', 1),
            'unknown producer': lambda r: r.__setitem__('producers', ['nonexistent-machine']),
            'negative amount': lambda r: r['in'].__setitem__('iron-ore', -1),
            'nonfinite amount': lambda r: r['in'].__setitem__('iron-ore', float('nan')),
            'unsupported semantics': lambda r: r.__setitem__('unknownBehavior', 1),
        }
        for label, mutate in mutations.items():
            with self.subTest(label=label), tempfile.TemporaryDirectory() as temporary:
                path = Path(temporary)
                source = path / 'source'
                folder = source / 'public/data/2x1'
                folder.mkdir(parents=True)
                changed = copy.deepcopy(self.source)
                recipe = next(r for r in changed['recipes'] if r['id'] == 'iron-plate')
                mutate(recipe)
                (folder / 'data.json').write_text(json.dumps(changed))
                shutil.copy2(SOURCE / 'public/data/2x1/icons.webp', folder / 'icons.webp')
                shutil.copy2(SOURCE / 'LICENSE', source / 'LICENSE')
                output = path / 'output'
                result = subprocess.run([sys.executable, str(ROOT / 'import_factoriolab.py'),
                    '--source', str(source), '--output-dir', str(output)], capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertIn('Import failed:', result.stderr)
                self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
