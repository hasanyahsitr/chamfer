import test from 'node:test';
import assert from 'node:assert/strict';
import { DrawingStore, computeCamMetrics, snapPointDetailed } from '../src/drawing/model.js';
import { CommandEngine } from '../src/drawing/commands.js';
import { lintDrawing } from '../src/drawing/linter.js';
import { PRESET_BUILDERS } from '../src/drawing/presets.js';
import { entitiesInBox } from '../src/drawing/selection.js';

const setup = () => {
  const store = new DrawingStore();
  const log = [];
  return {
    store,
    log,
    engine: new CommandEngine(
      store,
      () => {},
      (text) => log.push(text),
      () => {},
    ),
  };
};

test('CHAMFER, FILLET, TRIM, ROTATE, MIRROR, ARRAY, and TEXT execute deterministically', () => {
  const { store, engine } = setup();
  engine.execute('REC 0,0 100,60');
  const rectId = store.document.entities[0].id;
  engine.execute(`CHA ${rectId} 5`);
  assert.equal(store.document.entities[0].points.length, 8);

  engine.execute('C 20,20 4');
  const holeId = store.document.entities[1].id;
  engine.execute(`AR RECT ${holeId} 2 2 60 20`);
  assert.equal(store.document.entities.filter((e) => e.type === 'circle').length, 4);

  engine.execute('L 0,30 100,30');
  engine.execute('');
  engine.execute('L 50,10 50,50');
  engine.execute('');
  const horizId = store.document.entities.at(-2).id;
  engine.execute(`TR ${horizId} 20,30`);
  const trimmed = store.document.entities.find((e) => e.id === horizId);
  assert.deepEqual(trimmed.points, [
    [50, 30],
    [100, 30],
  ]);

  store.select(trimmed.id);
  engine.execute('RO 50,30 90');
  const rotated = store.document.entities.find((e) => e.id === horizId);
  assert.deepEqual(rotated.points, [
    [50, 30],
    [50, 80],
  ]);

  store.select(rotated.id);
  engine.execute('MI 50,0 50,100');
  assert.equal(store.document.entities.filter((e) => e.type === 'line').length, 3);

  engine.execute('TEXT 10,-8 3.5 ISO 2768-mK');
  const note = store.document.entities.at(-1);
  assert.equal(note.type, 'text');
  assert.equal(note.text, 'ISO 2768-mK');
  assert.ok(entitiesInBox(store.document, [0, -15], [60, 5]).includes(note.id));

  engine.execute('REC 200,0 260,40');
  const r2 = store.document.entities.at(-1).id;
  engine.execute(`F ${r2} 6`);
  assert.equal(store.document.entities.filter((e) => e.type === 'arc').length, 4);
});

test('analytical INT and PER snaps resolve line-line, line-circle, and perpendicular feet', () => {
  const { store, engine } = setup();
  engine.execute('L 0,0 100,100');
  engine.execute('');
  engine.execute('L 0,80 80,0');
  engine.execute('');
  const intSnap = snapPointDetailed([40.3, 39.8], store.document, 2.0);
  assert.equal(intSnap.kind, 'INT');
  assert.deepEqual(intSnap.point, [40, 40]);

  engine.execute('L 0,20 100,20');
  engine.execute('');
  const perSnap = snapPointDetailed([34.6, 20.3], store.document, 2.0, [35, 60]);
  assert.equal(perSnap.kind, 'PER');
  assert.deepEqual(perSnap.point, [35, 20]);
});

test('all industrial standard presets pass DRC with 0 errors and report positive CAM metrics', () => {
  for (const key of ['nema17', 'dn50', 'rack1u', 'slotted']) {
    const doc = PRESET_BUILDERS[key]();
    const report = lintDrawing(doc);
    assert.equal(report.summary.errors, 0, `Preset ${key} had DRC errors`);
    assert.equal(report.summary.warnings, 0, `Preset ${key} had DRC warnings`);
    const cam = computeCamMetrics(doc, 4.0);
    assert.ok(cam.cut_length_mm > 100);
    assert.ok(cam.pierce_count >= 5);
    assert.ok(cam.net_area_mm2 > 500);
    assert.ok(cam.mass_al6061_g > 5);
  }
});
