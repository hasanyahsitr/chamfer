import assert from 'node:assert/strict';
import test from 'node:test';
import { lintDrawing } from '../src/drawing/linter.js';
import {
  DEFAULT_TARIFF,
  DEMO_DXF_PRESETS,
  autoRepairPartDrawing,
  bulgeSegmentToArc,
  calculateSheetQuote,
  createDemoDxf,
  ingestIndustrialDxf,
  splitDrawingIntoParts,
} from '../src/quotegate/engine.js';

test('bulgeSegmentToArc analytically converts CCW and CW semicircle bulges', () => {
  const ccw = bulgeSegmentToArc([100, 0], [100, 50], 1);
  assert.equal(ccw.type, 'arc');
  assert.ok(Math.abs(ccw.center[0] - 100) < 1e-4);
  assert.ok(Math.abs(ccw.center[1] - 25) < 1e-4);
  assert.ok(Math.abs(ccw.radius - 25) < 1e-4);
  assert.ok(Math.abs(ccw.start_angle - 270) < 1e-4);
  assert.ok(Math.abs(ccw.end_angle - 90) < 1e-4);

  const cw = bulgeSegmentToArc([100, 50], [100, 0], -1);
  assert.equal(cw.type, 'arc');
  assert.ok(Math.abs(cw.center[0] - 100) < 1e-4);
  assert.ok(Math.abs(cw.center[1] - 25) < 1e-4);
  assert.ok(Math.abs(cw.radius - 25) < 1e-4);
  assert.ok(Math.abs(cw.start_angle - 270) < 1e-4);
  assert.ok(Math.abs(cw.end_angle - 90) < 1e-4);
});

test('ingestIndustrialDxf expands INSERT blocks, scales INSUNITS=1 inches to mm, skips TEXT/DIMENSION, and rejects SPLINE', () => {
  const inchWithBlockDxf = [
    '0',
    'SECTION',
    '2',
    'HEADER',
    '9',
    '$INSUNITS',
    '70',
    '1',
    '0',
    'ENDSEC',
    '0',
    'SECTION',
    '2',
    'BLOCKS',
    '0',
    'BLOCK',
    '2',
    'FLANGE_BLK',
    '10',
    '0',
    '20',
    '0',
    '0',
    'LWPOLYLINE',
    '8',
    '0',
    '90',
    '4',
    '70',
    '1',
    '10',
    '0',
    '20',
    '0',
    '10',
    '4',
    '20',
    '0',
    '10',
    '4',
    '20',
    '2',
    '10',
    '0',
    '20',
    '2',
    '0',
    'CIRCLE',
    '8',
    '0',
    '10',
    '2',
    '20',
    '1',
    '40',
    '0.25',
    '0',
    'ENDBLK',
    '0',
    'ENDSEC',
    '0',
    'SECTION',
    '2',
    'ENTITIES',
    '0',
    'INSERT',
    '8',
    'CUT',
    '2',
    'FLANGE_BLK',
    '10',
    '1',
    '20',
    '1',
    '41',
    '1',
    '42',
    '1',
    '50',
    '0',
    '0',
    'TEXT',
    '8',
    '0',
    '10',
    '0',
    '20',
    '0',
    '40',
    '1',
    '1',
    'NOTES',
    '0',
    'ENDSEC',
    '0',
    'EOF',
    '',
  ].join('\n');

  const { drawing, intakeReport } = ingestIndustrialDxf(inchWithBlockDxf, 'inch-block.dxf');
  assert.equal(intakeReport.detectedUnits, 'inch');
  assert.equal(intakeReport.scaleToMm, 25.4);
  assert.equal(intakeReport.expandedInserts, 1);
  assert.equal(intakeReport.ignoredAnnotations, 1);
  const poly = drawing.entities.find((e) => e.type === 'polyline');
  const hole = drawing.entities.find((e) => e.type === 'circle');
  assert.ok(Math.abs(poly.points[0][0] - 25.4) < 1e-3);
  assert.ok(Math.abs(hole.radius - 6.35) < 1e-3);
  assert.equal(lintDrawing(drawing, { manufacturing: true }).valid, true);

  const splineDxf = [
    '0',
    'SECTION',
    '2',
    'ENTITIES',
    '0',
    'SPLINE',
    '8',
    '0',
    '0',
    'ENDSEC',
    '0',
    'EOF',
    '',
  ].join('\n');
  assert.throws(() => ingestIndustrialDxf(splineDxf, 'bad.dxf'), /SPLINE/);
});

test('splitDrawingIntoParts splits multi-part bulge sheet into valid independent parts and calculates quote', () => {
  const dxf = createDemoDxf('multi_part_bulge');
  const { drawing, intakeReport } = ingestIndustrialDxf(
    dxf,
    DEMO_DXF_PRESETS.multi_part_bulge.fileName,
  );
  assert.equal(intakeReport.convertedBulgeArcs, 2);

  const parts = splitDrawingIntoParts(drawing);
  assert.equal(parts.length, 2);
  for (const part of parts) {
    const lint = lintDrawing(part.drawing, { manufacturing: true, thicknessMm: 2 });
    assert.equal(lint.valid, true);
  }

  parts[0].qty = 10;
  parts[1].qty = 5;
  const quote = calculateSheetQuote(
    parts,
    { materialId: 'steel_s235', thicknessMm: 2.0, currency: 'TRY', express: false },
    DEFAULT_TARIFF,
  );
  assert.equal(quote.summary.allPartsValid, true);
  assert.equal(quote.summary.totalQty, 15);
  assert.equal(quote.summary.discountPct, 5);
  assert.ok(quote.summary.grandTotal > 250);
  assert.ok(quote.summary.totalCutMeters > 3.5);
});

test('autoRepairPartDrawing heals faulty customer bracket to manufacturing DRC PASS', () => {
  const dxf = createDemoDxf('faulty_bracket');
  const { drawing } = ingestIndustrialDxf(dxf, 'faulty.dxf');
  const parts = splitDrawingIntoParts(drawing);
  assert.equal(parts.length, 1);

  const before = lintDrawing(parts[0].drawing, { manufacturing: true, thicknessMm: 2 });
  assert.equal(before.valid, false);

  const repaired = autoRepairPartDrawing(parts[0].drawing, 2);
  assert.equal(repaired.lintReport.valid, true);
  assert.ok(repaired.appliedFixes.length >= 2);
});
