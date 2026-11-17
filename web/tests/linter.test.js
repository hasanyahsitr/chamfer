import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DrawingStore } from '../src/drawing/model.js';
import { CommandEngine } from '../src/drawing/commands.js';
import { lintDrawing, previewDrcFix, flawedCncBracketExample } from '../src/drawing/linter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('clean mounting plate passes linter with zero errors and warnings', () => {
  const store = new DrawingStore();
  const engine = new CommandEngine(
    store,
    () => {},
    () => {},
    () => {},
  );
  engine.execute('REC 0,0 80,50');
  engine.execute('C 10,10 2.5');
  engine.execute('C 70,40 2.5');
  const report = lintDrawing(store.document);
  assert.equal(report.valid, true);
  assert.equal(report.status, 'passed');
  assert.equal(report.issues.length, 0);
});

test('flawed CNC bracket example catches open contour, edge collision, and thin web', () => {
  const report = lintDrawing(flawedCncBracketExample());
  assert.equal(report.valid, false);
  assert.equal(report.status, 'failed');
  const codes = new Set(report.issues.map((i) => i.code));
  assert.ok(codes.has('OPEN_CONTOUR_GAP'));
  assert.ok(codes.has('CIRCLE_COLLISION'));
  assert.ok(codes.has('MIN_CLEARANCE'));
});

test('LINT command executes via CommandEngine and invokes callback', () => {
  const store = new DrawingStore(flawedCncBracketExample());
  const logs = [];
  let captured = null;
  const engine = new CommandEngine(
    store,
    () => {},
    (msg) => logs.push(msg),
    () => {},
    (report) => {
      captured = report;
    },
  );
  engine.execute('LINT');
  assert.ok(captured);
  assert.equal(captured.valid, false);
  assert.ok(logs.some((line) => line.startsWith('LINT ·')));
});

test('office layout example passes JS linter with zero false-positive errors', () => {
  const officePath = path.resolve(__dirname, '../../examples/office-layout.cadlab.json');
  const office = JSON.parse(fs.readFileSync(officePath, 'utf8'));
  const report = lintDrawing(office);
  assert.equal(report.valid, true);
  assert.equal(report.summary.errors, 0);
});

test('thicknessMm scales default min_clearance_mm to 1x sheet thickness while honoring 1.5 mm floor and explicit override', () => {
  const plateWith2mmWeb = {
    format: 'cad-lab.drawing',
    schema_version: 1,
    units: 'mm',
    name: 'WebTest',
    layers: [{ id: '0', name: '0', color: '#d5dee7', visible: true, locked: false }],
    entities: [
      {
        id: 'outer',
        layer: '0',
        type: 'polyline',
        points: [
          [0, 0],
          [80, 0],
          [80, 50],
          [0, 50],
        ],
        closed: true,
      },
      { id: 'h1', layer: '0', type: 'circle', center: [15, 25], radius: 3 },
      { id: 'h2', layer: '0', type: 'circle', center: [23, 25], radius: 3 },
    ],
  };

  const defaultRep = lintDrawing(plateWith2mmWeb);
  assert.equal(defaultRep.min_clearance_mm, 1.5);
  assert.equal(defaultRep.summary.warnings, 0);

  const thickRep = lintDrawing(plateWith2mmWeb, { thicknessMm: 6.0 });
  assert.equal(thickRep.min_clearance_mm, 6);
  assert.equal(thickRep.summary.warnings, 1);
  assert.equal(thickRep.issues[0].code, 'MIN_CLEARANCE');
  assert.match(thickRep.issues[0].message, /< 6\.000 mm/);

  const thinRep = lintDrawing(plateWith2mmWeb, { thicknessMm: 0.8 });
  assert.equal(thinRep.min_clearance_mm, 1.5);
  assert.equal(thinRep.summary.warnings, 0);

  const overrideRep = lintDrawing(plateWith2mmWeb, { thicknessMm: 6.0, minClearanceMm: 1.2 });
  assert.equal(overrideRep.min_clearance_mm, 1.2);
  assert.equal(overrideRep.summary.warnings, 0);
});

test('previewDrcFix reports exact Euclidean shiftMm and scales target clearance with thicknessMm', () => {
  const flawed = flawedCncBracketExample();
  const reportDefault = lintDrawing(flawed);
  const crashIssue = reportDefault.issues.find(
    (i) => i.code === 'CIRCLE_COLLISION' && i.entities.includes('hole-edge-crash'),
  );
  assert.ok(crashIssue);

  const fixDefault = previewDrcFix(flawed, crashIssue);
  assert.equal(fixDefault.shiftMm, 3.5);
  assert.match(fixDefault.diffSummary, /Δ3\.5 mm/);

  const fix6mm = previewDrcFix(flawed, crashIssue, { thicknessMm: 6.0 });
  assert.equal(fix6mm.shiftMm, 8);
  assert.match(fix6mm.diffSummary, /Δ8 mm/);
  const movedHole = fix6mm.nextDoc.entities.find((e) => e.id === 'hole-edge-crash');
  assert.deepEqual(movedHole.center, [70.5, 25]);
});
