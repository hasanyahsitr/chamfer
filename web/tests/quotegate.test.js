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

test('Red-Team P0: nested INSERT billion-laughs bomb is aborted early', () => {
  const blockChain = [];
  for (let i = 0; i <= 7; i++) {
    blockChain.push('0', 'BLOCK', '2', `B${i}`, '10', '0', '20', '0');
    if (i === 0) {
      for (let k = 0; k < 10; k++) {
        blockChain.push(
          '0',
          'LINE',
          '8',
          '0',
          '10',
          String(k * 10),
          '20',
          '0',
          '10',
          '0',
          '11',
          String(k * 10 + 5),
          '21',
          '5',
        );
      }
    } else {
      for (let k = 0; k < 10; k++) {
        blockChain.push('0', 'INSERT', '8', '0', '2', `B${i - 1}`, '10', String(k), '20', '0');
      }
    }
    blockChain.push('0', 'ENDBLK');
  }
  const bombDxf = [
    '0',
    'SECTION',
    '2',
    'BLOCKS',
    ...blockChain,
    '0',
    'ENDSEC',
    '0',
    'SECTION',
    '2',
    'ENTITIES',
    '0',
    'INSERT',
    '8',
    '0',
    '2',
    'B7',
    '10',
    '0',
    '20',
    '0',
    '0',
    'ENDSEC',
    '0',
    'EOF',
    '',
  ].join('\n');

  const t0 = Date.now();
  assert.throws(() => ingestIndustrialDxf(bombDxf, 'bomb.dxf'), /1200|INSERT|sınır/i);
  assert.ok(Date.now() - t0 < 500, 'DoS guard must abort immediately');
});

test('Red-Team P0: scaled and mirrored INSERT blocks scale ARC center & keep loop closure', () => {
  const scaledBlockDxf = [
    '0',
    'SECTION',
    '2',
    'HEADER',
    '9',
    '$INSUNITS',
    '70',
    '4',
    '0',
    'ENDSEC',
    '0',
    'SECTION',
    '2',
    'BLOCKS',
    '0',
    'BLOCK',
    '2',
    'SLOT_BLK',
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
    '10',
    '20',
    '0',
    '42',
    '0',
    '10',
    '40',
    '20',
    '0',
    '42',
    '1',
    '10',
    '40',
    '20',
    '20',
    '42',
    '0',
    '10',
    '10',
    '20',
    '20',
    '42',
    '1',
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
    '0',
    '2',
    'SLOT_BLK',
    '10',
    '100',
    '20',
    '50',
    '41',
    '2',
    '42',
    '2',
    '50',
    '0',
    '0',
    'ENDSEC',
    '0',
    'EOF',
    '',
  ].join('\n');

  const { drawing } = ingestIndustrialDxf(scaledBlockDxf, 'scaled-arc.dxf');
  const lint = lintDrawing(drawing, { manufacturing: true, thicknessMm: 2 });
  assert.equal(lint.valid, true);
  const arcs = drawing.entities.filter((e) => e.type === 'arc');
  assert.equal(arcs.length, 2);
  assert.ok(arcs.every((a) => Math.abs(a.radius - 20) < 1e-4));
  // Original right semicircle center [40, 10] -> scaled x2 + [100, 50] => [180, 70]
  assert.ok(
    arcs.some((a) => Math.abs(a.center[0] - 180) < 1e-4 && Math.abs(a.center[1] - 70) < 1e-4),
  );
});

test('Red-Team P0: open faulty bracket computes realistic plate mass and preserves all 3 parts on T-stub sheets', () => {
  const faulty = ingestIndustrialDxf(createDemoDxf('faulty_bracket'), 'faulty.dxf');
  const faultyParts = splitDrawingIntoParts(faulty.drawing);
  faultyParts[0].qty = 20;
  const openQuote = calculateSheetQuote(
    faultyParts,
    { materialId: 'stainless_304', thicknessMm: 10, currency: 'TRY', express: false },
    DEFAULT_TARIFF,
  );
  assert.equal(openQuote.summary.allPartsValid, false);
  assert.ok(
    openQuote.summary.totalMassKg > 10.5,
    `expected >10.5 kg, got ${openQuote.summary.totalMassKg}`,
  );
  assert.equal(openQuote.parts[0].massEstimated, true);

  // 3-part sheet where Part 3 is a 4-line closed box with an attached 10mm corner T-stub
  const tStubSheetDxf = [
    '0',
    'SECTION',
    '2',
    'HEADER',
    '9',
    '$INSUNITS',
    '70',
    '4',
    '0',
    'ENDSEC',
    '0',
    'SECTION',
    '2',
    'ENTITIES',
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
    '50',
    '20',
    '0',
    '10',
    '50',
    '20',
    '50',
    '10',
    '0',
    '20',
    '50',
    '0',
    'LWPOLYLINE',
    '8',
    '0',
    '90',
    '4',
    '70',
    '1',
    '10',
    '100',
    '20',
    '0',
    '10',
    '150',
    '20',
    '0',
    '10',
    '150',
    '20',
    '50',
    '10',
    '100',
    '20',
    '50',
    '0',
    'LINE',
    '8',
    '0',
    '10',
    '200',
    '20',
    '0',
    '11',
    '250',
    '21',
    '0',
    '0',
    'LINE',
    '8',
    '0',
    '10',
    '250',
    '20',
    '0',
    '11',
    '250',
    '21',
    '50',
    '0',
    'LINE',
    '8',
    '0',
    '10',
    '250',
    '20',
    '50',
    '11',
    '200',
    '21',
    '50',
    '0',
    'LINE',
    '8',
    '0',
    '10',
    '200',
    '20',
    '50',
    '11',
    '200',
    '21',
    '0',
    '0',
    'LINE',
    '8',
    '0',
    '10',
    '200',
    '20',
    '0',
    '11',
    '210',
    '21',
    '10',
    '0',
    'ENDSEC',
    '0',
    'EOF',
    '',
  ].join('\n');

  const sheet = ingestIndustrialDxf(tStubSheetDxf, '3parts-tstub.dxf');
  const split = splitDrawingIntoParts(sheet.drawing);
  assert.equal(split.length, 3);
  const q3 = calculateSheetQuote(
    split,
    { materialId: 'steel_s235', thicknessMm: 2 },
    DEFAULT_TARIFF,
  );
  assert.equal(q3.summary.allPartsValid, false);
});

test('Red-Team P1: shallow bulge closure, OCS (0,0,-1) mirror, case/frozen layers, unit/EOF/3D guards, and 0% VAT', () => {
  // Shallow bulge (R ≈ 100,000 mm) closes cleanly under 1e-4 mm CHAIN_TOL_MM
  const shallowBulgeDxf = [
    '0',
    'SECTION',
    '2',
    'HEADER',
    '9',
    '$INSUNITS',
    '70',
    '4',
    '0',
    'ENDSEC',
    '0',
    'SECTION',
    '2',
    'ENTITIES',
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
    '42',
    '0.0005',
    '10',
    '200',
    '20',
    '0',
    '42',
    '0',
    '10',
    '200',
    '20',
    '80',
    '42',
    '0',
    '10',
    '0',
    '20',
    '80',
    '42',
    '0',
    '0',
    'ENDSEC',
    '0',
    'EOF',
    '',
  ].join('\n');
  const shallow = ingestIndustrialDxf(shallowBulgeDxf, 'shallow.dxf');
  assert.equal(lintDrawing(shallow.drawing, { manufacturing: true }).valid, true);

  // Case-insensitive Cut/CUT + frozen OFF layer exclusion
  const layeredDxf = [
    '0',
    'SECTION',
    '2',
    'HEADER',
    '9',
    '$INSUNITS',
    '70',
    '4',
    '0',
    'ENDSEC',
    '0',
    'SECTION',
    '2',
    'TABLES',
    '0',
    'LAYER',
    '2',
    'Cut',
    '70',
    '0',
    '62',
    '7',
    '290',
    '1',
    '0',
    'LAYER',
    '2',
    'HIDDEN_REF',
    '70',
    '1',
    '62',
    '-5',
    '290',
    '1',
    '0',
    'ENDSEC',
    '0',
    'SECTION',
    '2',
    'ENTITIES',
    '0',
    'LINE',
    '8',
    'Cut',
    '10',
    '0',
    '20',
    '0',
    '11',
    '80',
    '21',
    '0',
    '0',
    'LINE',
    '8',
    'CUT',
    '10',
    '80',
    '20',
    '0',
    '11',
    '80',
    '21',
    '50',
    '0',
    'LINE',
    '8',
    'cut',
    '10',
    '80',
    '20',
    '50',
    '11',
    '0',
    '21',
    '50',
    '0',
    'LINE',
    '8',
    'Cut',
    '10',
    '0',
    '20',
    '50',
    '11',
    '0',
    '21',
    '0',
    '0',
    'CIRCLE',
    '8',
    'HIDDEN_REF',
    '10',
    '40',
    '20',
    '25',
    '40',
    '500',
    '0',
    'ENDSEC',
    '0',
    'EOF',
    '',
  ].join('\n');
  const layered = ingestIndustrialDxf(layeredDxf, 'layers.dxf');
  const layeredQuote = calculateSheetQuote(
    splitDrawingIntoParts(layered.drawing),
    {},
    { vatPct: 0 },
  );
  assert.equal(layeredQuote.summary.allPartsValid, true);
  assert.equal(layeredQuote.summary.vatPct, 0);
  assert.equal(layeredQuote.summary.vatAmount, 0);

  // OCS (0,0,-1) semicircle arc maps to WCS negative X without opening
  const ocsArcDxf = [
    '0',
    'SECTION',
    '2',
    'HEADER',
    '9',
    '$INSUNITS',
    '70',
    '4',
    '0',
    'ENDSEC',
    '0',
    'SECTION',
    '2',
    'ENTITIES',
    '0',
    'ARC',
    '8',
    '0',
    '10',
    '50',
    '20',
    '0',
    '40',
    '20',
    '50',
    '0',
    '51',
    '180',
    '210',
    '0',
    '220',
    '0',
    '230',
    '-1',
    '0',
    'LINE',
    '8',
    '0',
    '10',
    '-70',
    '20',
    '0',
    '11',
    '-30',
    '21',
    '0',
    '0',
    'ENDSEC',
    '0',
    'EOF',
    '',
  ].join('\n');
  const ocs = ingestIndustrialDxf(ocsArcDxf, 'ocs.dxf');
  assert.equal(lintDrawing(ocs.drawing, { manufacturing: true }).valid, true);

  // Reject unsupported $INSUNITS=99, missing EOF, and 3D Z coords
  assert.throws(
    () =>
      ingestIndustrialDxf(
        '0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n99\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nCIRCLE\n8\n0\n10\n0\n20\n0\n40\n5\n0\nENDSEC\n0\nEOF\n',
        'bad-unit.dxf',
      ),
    /INSUNITS/,
  );
  assert.throws(
    () =>
      ingestIndustrialDxf(
        '0\nSECTION\n2\nENTITIES\n0\nCIRCLE\n8\n0\n10\n0\n20\n0\n40\n5\n0\nENDSEC\n',
        'no-eof.dxf',
      ),
    /EOF/,
  );
  assert.throws(
    () =>
      ingestIndustrialDxf(
        '0\nSECTION\n2\nENTITIES\n0\nLINE\n8\n0\n10\n0\n20\n0\n30\n12\n11\n10\n21\n0\n0\nENDSEC\n0\nEOF\n',
        '3d.dxf',
      ),
    /3B Z/,
  );
});
