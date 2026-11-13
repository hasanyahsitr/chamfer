import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DrawingStore } from '../src/drawing/model.js';
import { CommandEngine } from '../src/drawing/commands.js';
import { lintDrawing, flawedCncBracketExample } from '../src/drawing/linter.js';

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
