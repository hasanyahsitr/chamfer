// Pure client-side ASCII R2010 (AC1024) millimeter DXF exporter and strict importer.
import { dimGeometry, distance, validateDrawing } from './model.js';

const MAX_DRAWING_BYTES = 1024 * 1024;
const SUPPORTED_DXF_ENTITIES = new Set([
  'LINE',
  'LWPOLYLINE',
  'CIRCLE',
  'ARC',
  'DIMENSION',
  'TEXT',
]);

const ACI_PALETTE = {
  1: '#ff0000',
  2: '#ffff00',
  3: '#00ff00',
  4: '#00ffff',
  5: '#0000ff',
  6: '#ff00ff',
  7: '#d4d8de',
  8: '#808080',
  9: '#c0c0c0',
};

function hexToRgbInt(hex) {
  return parseInt(hex.slice(1), 16);
}

function rgbIntToHex(rgbInt) {
  const n = Math.max(0, Math.min(0xffffff, Number(rgbInt) | 0));
  return '#' + n.toString(16).padStart(6, '0');
}

function aciToHex(aci) {
  const idx = Math.abs(Number(aci) || 7);
  return ACI_PALETTE[idx] || '#d4d8de';
}

function fmtNum(v) {
  const n = Number(v);
  if (Object.is(n, -0) || Math.abs(n) < 1e-12) return '0.0';
  const s = String(Math.round(n * 1e8) / 1e8);
  return s.includes('.') || s.includes('e') || s.includes('E') ? s : `${s}.0`;
}

function pushPairs(out, pairs) {
  for (const [code, val] of pairs) {
    out.push(String(code).padStart(3, ' '), String(val));
  }
}

export function exportDrawingToDxf(drawing, { cutOnly = false } = {}) {
  const validated = validateDrawing(drawing);
  const byteCheck = new TextEncoder().encode(JSON.stringify(validated)).length;
  if (byteCheck > MAX_DRAWING_BYTES) {
    throw new Error('Çizim boyutu 1 MiB sınırını aşıyor.');
  }

  let nextHandle = 0x100;
  const allocHandle = () => (nextHandle++).toString(16).toUpperCase();

  const cutLayerIds = new Set(
    validated.layers.filter((l) => l.visible !== false && !l.construction).map((l) => l.id),
  );
  const layerById = new Map();
  const dxfLayers = [];
  let hasLayer0 = false;
  for (const layer of validated.layers) {
    if (cutOnly && !cutLayerIds.has(layer.id)) continue;
    layerById.set(layer.id, layer.name);
    if (layer.name === '0') hasLayer0 = true;
    dxfLayers.push(layer);
  }
  if (!hasLayer0) {
    dxfLayers.unshift({ id: '__0__', name: '0', color: '#d4d8de', visible: true, locked: false });
  }

  const dimBlocks = [];
  const entityRecords = [];

  for (const entity of validated.entities) {
    if (
      cutOnly &&
      (!cutLayerIds.has(entity.layer) || entity.type === 'dim' || entity.type === 'text')
    ) {
      continue;
    }
    const layerName = layerById.get(entity.layer);
    const hEnt = allocHandle();

    if (entity.type === 'line') {
      const [[x1, y1], [x2, y2]] = entity.points;
      entityRecords.push([
        [0, 'LINE'],
        [5, hEnt],
        [330, '17'],
        [100, 'AcDbEntity'],
        [8, layerName],
        [100, 'AcDbLine'],
        [10, fmtNum(x1)],
        [20, fmtNum(y1)],
        [30, '0.0'],
        [11, fmtNum(x2)],
        [21, fmtNum(y2)],
        [31, '0.0'],
      ]);
    } else if (entity.type === 'polyline') {
      const rec = [
        [0, 'LWPOLYLINE'],
        [5, hEnt],
        [330, '17'],
        [100, 'AcDbEntity'],
        [8, layerName],
        [100, 'AcDbPolyline'],
        [90, entity.points.length],
        [70, entity.closed ? 1 : 0],
        [43, '0.0'],
      ];
      for (const [x, y] of entity.points) {
        rec.push([10, fmtNum(x)], [20, fmtNum(y)]);
      }
      entityRecords.push(rec);
    } else if (entity.type === 'circle') {
      const [cx, cy] = entity.center;
      entityRecords.push([
        [0, 'CIRCLE'],
        [5, hEnt],
        [330, '17'],
        [100, 'AcDbEntity'],
        [8, layerName],
        [100, 'AcDbCircle'],
        [10, fmtNum(cx)],
        [20, fmtNum(cy)],
        [30, '0.0'],
        [40, fmtNum(entity.radius)],
      ]);
    } else if (entity.type === 'arc') {
      const [cx, cy] = entity.center;
      const sa = ((entity.start_angle % 360) + 360) % 360;
      const ea = ((entity.end_angle % 360) + 360) % 360;
      entityRecords.push([
        [0, 'ARC'],
        [5, hEnt],
        [330, '17'],
        [100, 'AcDbEntity'],
        [8, layerName],
        [100, 'AcDbCircle'],
        [10, fmtNum(cx)],
        [20, fmtNum(cy)],
        [30, '0.0'],
        [40, fmtNum(entity.radius)],
        [100, 'AcDbArc'],
        [50, fmtNum(sa)],
        [51, fmtNum(ea)],
      ]);
    } else if (entity.type === 'dim') {
      const g = dimGeometry(entity);
      const blockName = `*D${dimBlocks.length + 1}`;
      const hBlkRec = allocHandle();
      const hBlk = allocHandle();
      const hEndBlk = allocHandle();
      const hExt1 = allocHandle();
      const hExt2 = allocHandle();
      const hDimLine = allocHandle();
      const hMtext = allocHandle();
      dimBlocks.push({
        name: blockName,
        hBlkRec,
        hBlk,
        hEndBlk,
        hExt1,
        hExt2,
        hDimLine,
        hMtext,
        g,
      });
      entityRecords.push([
        [0, 'DIMENSION'],
        [5, hEnt],
        [330, '17'],
        [100, 'AcDbEntity'],
        [8, layerName],
        [100, 'AcDbDimension'],
        [280, 0],
        [2, blockName],
        [3, 'Standard'],
        [10, fmtNum(g.d2[0])],
        [20, fmtNum(g.d2[1])],
        [30, '0.0'],
        [11, fmtNum(g.mid[0])],
        [21, fmtNum(g.mid[1])],
        [31, '0.0'],
        [70, 33],
        [71, 5],
        [42, fmtNum(g.span)],
        [1, '<>'],
        [100, 'AcDbAlignedDimension'],
        [13, fmtNum(g.p1[0])],
        [23, fmtNum(g.p1[1])],
        [33, '0.0'],
        [14, fmtNum(g.p2[0])],
        [24, fmtNum(g.p2[1])],
        [34, '0.0'],
      ]);
    } else if (entity.type === 'text') {
      const [tx, ty] = entity.position;
      const rot = (((entity.rotation || 0) % 360) + 360) % 360;
      entityRecords.push([
        [0, 'TEXT'],
        [5, hEnt],
        [330, '17'],
        [100, 'AcDbEntity'],
        [8, layerName],
        [100, 'AcDbText'],
        [10, fmtNum(tx)],
        [20, fmtNum(ty)],
        [30, '0.0'],
        [40, fmtNum(entity.height)],
        [1, entity.text],
        [50, fmtNum(rot)],
        [7, 'Standard'],
        [100, 'AcDbText'],
      ]);
    }
  }

  const layerRecords = dxfLayers.map((layer) => ({
    handle: allocHandle(),
    layer,
  }));

  const handSeed = (nextHandle + 16).toString(16).toUpperCase();
  const out = [];

  // HEADER
  pushPairs(out, [
    [0, 'SECTION'],
    [2, 'HEADER'],
    [9, '$ACADVER'],
    [1, 'AC1024'],
    [9, '$DWGCODEPAGE'],
    [3, 'ANSI_1252'],
    [9, '$INSUNITS'],
    [70, 4],
    [9, '$MEASUREMENT'],
    [70, 1],
    [9, '$HANDSEED'],
    [5, handSeed],
    [9, '$CLAYER'],
    [8, '0'],
    [9, '$CELTYPE'],
    [6, 'ByLayer'],
    [9, '$CECOLOR'],
    [62, 256],
    [9, '$TEXTSTYLE'],
    [7, 'Standard'],
    [9, '$DIMSTYLE'],
    [2, 'Standard'],
    [0, 'ENDSEC'],
  ]);

  // TABLES
  pushPairs(out, [
    [0, 'SECTION'],
    [2, 'TABLES'],
    [0, 'TABLE'],
    [2, 'VPORT'],
    [5, '8'],
    [330, '0'],
    [100, 'AcDbSymbolTable'],
    [70, 1],
    [0, 'VPORT'],
    [5, '23'],
    [330, '8'],
    [100, 'AcDbSymbolTableRecord'],
    [100, 'AcDbViewportTableRecord'],
    [2, '*Active'],
    [70, 0],
    [10, '0.0'],
    [20, '0.0'],
    [11, '1.0'],
    [21, '1.0'],
    [12, '0.0'],
    [22, '0.0'],
    [13, '0.0'],
    [23, '0.0'],
    [14, '0.5'],
    [24, '0.5'],
    [15, '0.5'],
    [25, '0.5'],
    [16, '0.0'],
    [26, '0.0'],
    [36, '1.0'],
    [17, '0.0'],
    [27, '0.0'],
    [37, '0.0'],
    [40, '1000.0'],
    [41, '1.34'],
    [42, '50.0'],
    [43, '0.0'],
    [44, '0.0'],
    [50, '0.0'],
    [51, '0.0'],
    [71, 0],
    [72, 1000],
    [73, 1],
    [74, 3],
    [75, 0],
    [76, 0],
    [77, 0],
    [78, 0],
    [0, 'ENDTAB'],
    [0, 'TABLE'],
    [2, 'LTYPE'],
    [5, '2'],
    [330, '0'],
    [100, 'AcDbSymbolTable'],
    [70, 3],
    [0, 'LTYPE'],
    [5, '24'],
    [330, '2'],
    [100, 'AcDbSymbolTableRecord'],
    [100, 'AcDbLinetypeTableRecord'],
    [2, 'ByBlock'],
    [70, 0],
    [3, ''],
    [72, 65],
    [73, 0],
    [40, '0.0'],
    [0, 'LTYPE'],
    [5, '25'],
    [330, '2'],
    [100, 'AcDbSymbolTableRecord'],
    [100, 'AcDbLinetypeTableRecord'],
    [2, 'ByLayer'],
    [70, 0],
    [3, ''],
    [72, 65],
    [73, 0],
    [40, '0.0'],
    [0, 'LTYPE'],
    [5, '26'],
    [330, '2'],
    [100, 'AcDbSymbolTableRecord'],
    [100, 'AcDbLinetypeTableRecord'],
    [2, 'Continuous'],
    [70, 0],
    [3, 'Solid line'],
    [72, 65],
    [73, 0],
    [40, '0.0'],
    [0, 'ENDTAB'],
    [0, 'TABLE'],
    [2, 'LAYER'],
    [5, '1'],
    [330, '0'],
    [100, 'AcDbSymbolTable'],
    [70, layerRecords.length],
  ]);

  for (const { handle, layer } of layerRecords) {
    pushPairs(out, [
      [0, 'LAYER'],
      [5, handle],
      [330, '1'],
      [100, 'AcDbSymbolTableRecord'],
      [100, 'AcDbLayerTableRecord'],
      [2, layer.name],
      [70, layer.locked ? 4 : 0],
      [62, layer.visible ? 7 : -7],
      [420, hexToRgbInt(layer.color)],
      [6, 'Continuous'],
      [290, layer.construction ? 0 : 1],
      [370, -3],
      [390, '13'],
    ]);
  }
  pushPairs(out, [[0, 'ENDTAB']]);

  pushPairs(out, [
    [0, 'TABLE'],
    [2, 'STYLE'],
    [5, '5'],
    [330, '0'],
    [100, 'AcDbSymbolTable'],
    [70, 1],
    [0, 'STYLE'],
    [5, '29'],
    [330, '5'],
    [100, 'AcDbSymbolTableRecord'],
    [100, 'AcDbTextStyleTableRecord'],
    [2, 'Standard'],
    [70, 0],
    [40, '0.0'],
    [41, '1.0'],
    [50, '0.0'],
    [71, 0],
    [42, '2.5'],
    [3, 'txt'],
    [4, ''],
    [0, 'ENDTAB'],
    [0, 'TABLE'],
    [2, 'VIEW'],
    [5, '7'],
    [330, '0'],
    [100, 'AcDbSymbolTable'],
    [70, 0],
    [0, 'ENDTAB'],
    [0, 'TABLE'],
    [2, 'UCS'],
    [5, '6'],
    [330, '0'],
    [100, 'AcDbSymbolTable'],
    [70, 0],
    [0, 'ENDTAB'],
    [0, 'TABLE'],
    [2, 'APPID'],
    [5, '3'],
    [330, '0'],
    [100, 'AcDbSymbolTable'],
    [70, 1],
    [0, 'APPID'],
    [5, '2A'],
    [330, '3'],
    [100, 'AcDbSymbolTableRecord'],
    [100, 'AcDbRegAppTableRecord'],
    [2, 'ACAD'],
    [70, 0],
    [0, 'ENDTAB'],
    [0, 'TABLE'],
    [2, 'DIMSTYLE'],
    [5, '4'],
    [330, '0'],
    [100, 'AcDbSymbolTable'],
    [70, 1],
    [100, 'AcDbDimStyleTable'],
    [0, 'DIMSTYLE'],
    [105, '2B'],
    [330, '4'],
    [100, 'AcDbSymbolTableRecord'],
    [100, 'AcDbDimStyleTableRecord'],
    [2, 'Standard'],
    [70, 0],
    [40, '1.0'],
    [41, '2.5'],
    [42, '0.625'],
    [43, '3.75'],
    [44, '1.25'],
    [140, '2.5'],
    [147, '0.625'],
    [77, 1],
    [271, 2],
    [340, '29'],
    [0, 'ENDTAB'],
    [0, 'TABLE'],
    [2, 'BLOCK_RECORD'],
    [5, '9'],
    [330, '0'],
    [100, 'AcDbSymbolTable'],
    [70, 2 + dimBlocks.length],
    [0, 'BLOCK_RECORD'],
    [5, '17'],
    [330, '9'],
    [100, 'AcDbSymbolTableRecord'],
    [100, 'AcDbBlockTableRecord'],
    [2, '*Model_Space'],
    [340, '1A'],
    [70, 0],
    [280, 1],
    [281, 0],
    [0, 'BLOCK_RECORD'],
    [5, '1B'],
    [330, '9'],
    [100, 'AcDbSymbolTableRecord'],
    [100, 'AcDbBlockTableRecord'],
    [2, '*Paper_Space'],
    [340, '1E'],
    [70, 0],
    [280, 1],
    [281, 0],
  ]);

  for (const db of dimBlocks) {
    pushPairs(out, [
      [0, 'BLOCK_RECORD'],
      [5, db.hBlkRec],
      [330, '9'],
      [100, 'AcDbSymbolTableRecord'],
      [100, 'AcDbBlockTableRecord'],
      [2, db.name],
      [340, '0'],
      [70, 1],
      [280, 1],
      [281, 0],
    ]);
  }
  pushPairs(out, [
    [0, 'ENDTAB'],
    [0, 'ENDSEC'],
  ]);

  // BLOCKS
  pushPairs(out, [
    [0, 'SECTION'],
    [2, 'BLOCKS'],
    [0, 'BLOCK'],
    [5, '18'],
    [330, '17'],
    [100, 'AcDbEntity'],
    [8, '0'],
    [100, 'AcDbBlockBegin'],
    [2, '*Model_Space'],
    [70, 0],
    [10, '0.0'],
    [20, '0.0'],
    [30, '0.0'],
    [3, '*Model_Space'],
    [1, ''],
    [0, 'ENDBLK'],
    [5, '19'],
    [330, '17'],
    [100, 'AcDbEntity'],
    [8, '0'],
    [100, 'AcDbBlockEnd'],
    [0, 'BLOCK'],
    [5, '1C'],
    [330, '1B'],
    [100, 'AcDbEntity'],
    [8, '0'],
    [100, 'AcDbBlockBegin'],
    [2, '*Paper_Space'],
    [70, 0],
    [10, '0.0'],
    [20, '0.0'],
    [30, '0.0'],
    [3, '*Paper_Space'],
    [1, ''],
    [0, 'ENDBLK'],
    [5, '1D'],
    [330, '1B'],
    [100, 'AcDbEntity'],
    [8, '0'],
    [100, 'AcDbBlockEnd'],
  ]);

  for (const db of dimBlocks) {
    const { g } = db;
    pushPairs(out, [
      [0, 'BLOCK'],
      [5, db.hBlk],
      [330, db.hBlkRec],
      [100, 'AcDbEntity'],
      [8, '0'],
      [100, 'AcDbBlockBegin'],
      [2, db.name],
      [70, 1],
      [10, '0.0'],
      [20, '0.0'],
      [30, '0.0'],
      [3, db.name],
      [1, ''],
      [0, 'LINE'],
      [5, db.hExt1],
      [330, db.hBlkRec],
      [100, 'AcDbEntity'],
      [8, '0'],
      [100, 'AcDbLine'],
      [10, fmtNum(g.p1[0])],
      [20, fmtNum(g.p1[1])],
      [30, '0.0'],
      [11, fmtNum(g.d1[0])],
      [21, fmtNum(g.d1[1])],
      [31, '0.0'],
      [0, 'LINE'],
      [5, db.hExt2],
      [330, db.hBlkRec],
      [100, 'AcDbEntity'],
      [8, '0'],
      [100, 'AcDbLine'],
      [10, fmtNum(g.p2[0])],
      [20, fmtNum(g.p2[1])],
      [30, '0.0'],
      [11, fmtNum(g.d2[0])],
      [21, fmtNum(g.d2[1])],
      [31, '0.0'],
      [0, 'LINE'],
      [5, db.hDimLine],
      [330, db.hBlkRec],
      [100, 'AcDbEntity'],
      [8, '0'],
      [100, 'AcDbLine'],
      [10, fmtNum(g.d1[0])],
      [20, fmtNum(g.d1[1])],
      [30, '0.0'],
      [11, fmtNum(g.d2[0])],
      [21, fmtNum(g.d2[1])],
      [31, '0.0'],
      [0, 'MTEXT'],
      [5, db.hMtext],
      [330, db.hBlkRec],
      [100, 'AcDbEntity'],
      [8, '0'],
      [100, 'AcDbMText'],
      [10, fmtNum(g.mid[0])],
      [20, fmtNum(g.mid[1])],
      [30, '0.0'],
      [40, '2.5'],
      [71, 5],
      [1, g.span.toFixed(2)],
      [0, 'ENDBLK'],
      [5, db.hEndBlk],
      [330, db.hBlkRec],
      [100, 'AcDbEntity'],
      [8, '0'],
      [100, 'AcDbBlockEnd'],
    ]);
  }
  pushPairs(out, [[0, 'ENDSEC']]);

  // ENTITIES
  pushPairs(out, [
    [0, 'SECTION'],
    [2, 'ENTITIES'],
  ]);
  for (const rec of entityRecords) {
    pushPairs(out, rec);
  }
  pushPairs(out, [[0, 'ENDSEC']]);

  // OBJECTS
  pushPairs(out, [
    [0, 'SECTION'],
    [2, 'OBJECTS'],
    [0, 'DICTIONARY'],
    [5, 'A'],
    [330, '0'],
    [100, 'AcDbDictionary'],
    [281, 1],
    [3, 'ACAD_GROUP'],
    [350, 'C'],
    [3, 'ACAD_LAYOUT'],
    [350, 'D'],
    [3, 'ACAD_PLOTSTYLENAME'],
    [350, '12'],
    [0, 'DICTIONARY'],
    [5, 'C'],
    [330, 'A'],
    [100, 'AcDbDictionary'],
    [281, 1],
    [0, 'DICTIONARY'],
    [5, 'D'],
    [330, 'A'],
    [100, 'AcDbDictionary'],
    [281, 1],
    [3, 'Model'],
    [350, '1A'],
    [3, 'Layout1'],
    [350, '1E'],
    [0, 'ACDBDICTIONARYWDFLT'],
    [5, '12'],
    [330, 'A'],
    [100, 'AcDbDictionary'],
    [281, 1],
    [3, 'Normal'],
    [350, '13'],
    [100, 'AcDbDictionaryWithDefault'],
    [340, '13'],
    [0, 'ACDBPLACEHOLDER'],
    [5, '13'],
    [330, '12'],
    [0, 'LAYOUT'],
    [5, '1A'],
    [330, 'D'],
    [100, 'AcDbPlotSettings'],
    [1, ''],
    [2, 'none_device'],
    [4, 'ISO_A3_(420.00_x_297.00_MM)'],
    [6, ''],
    [40, '7.5'],
    [41, '20.0'],
    [42, '7.5'],
    [43, '20.0'],
    [44, '420.0'],
    [45, '297.0'],
    [46, '0.0'],
    [47, '0.0'],
    [48, '0.0'],
    [49, '0.0'],
    [140, '0.0'],
    [141, '0.0'],
    [142, '1.0'],
    [143, '1.0'],
    [70, 1024],
    [72, 1],
    [73, 0],
    [74, 5],
    [7, ''],
    [75, 16],
    [147, '1.0'],
    [148, '0.0'],
    [149, '0.0'],
    [100, 'AcDbLayout'],
    [1, 'Model'],
    [70, 1],
    [71, 0],
    [10, '0.0'],
    [20, '0.0'],
    [11, '420.0'],
    [21, '297.0'],
    [12, '0.0'],
    [22, '0.0'],
    [32, '0.0'],
    [14, '0.0'],
    [24, '0.0'],
    [34, '0.0'],
    [15, '0.0'],
    [25, '0.0'],
    [35, '0.0'],
    [146, '0.0'],
    [13, '0.0'],
    [23, '0.0'],
    [33, '0.0'],
    [16, '1.0'],
    [26, '0.0'],
    [36, '0.0'],
    [17, '0.0'],
    [27, '1.0'],
    [37, '0.0'],
    [76, 1],
    [330, '17'],
    [0, 'LAYOUT'],
    [5, '1E'],
    [330, 'D'],
    [100, 'AcDbPlotSettings'],
    [1, ''],
    [2, 'none_device'],
    [4, 'ISO_A3_(420.00_x_297.00_MM)'],
    [6, ''],
    [40, '7.5'],
    [41, '20.0'],
    [42, '7.5'],
    [43, '20.0'],
    [44, '420.0'],
    [45, '297.0'],
    [46, '0.0'],
    [47, '0.0'],
    [48, '0.0'],
    [49, '0.0'],
    [140, '0.0'],
    [141, '0.0'],
    [142, '1.0'],
    [143, '1.0'],
    [70, 0],
    [72, 1],
    [73, 0],
    [74, 5],
    [7, ''],
    [75, 16],
    [147, '1.0'],
    [148, '0.0'],
    [149, '0.0'],
    [100, 'AcDbLayout'],
    [1, 'Layout1'],
    [70, 1],
    [71, 1],
    [10, '0.0'],
    [20, '0.0'],
    [11, '420.0'],
    [21, '297.0'],
    [12, '0.0'],
    [22, '0.0'],
    [32, '0.0'],
    [14, '0.0'],
    [24, '0.0'],
    [34, '0.0'],
    [15, '0.0'],
    [25, '0.0'],
    [35, '0.0'],
    [146, '0.0'],
    [13, '0.0'],
    [23, '0.0'],
    [33, '0.0'],
    [16, '1.0'],
    [26, '0.0'],
    [36, '0.0'],
    [17, '0.0'],
    [27, '1.0'],
    [37, '0.0'],
    [76, 1],
    [330, '1B'],
    [0, 'ENDSEC'],
    [0, 'EOF'],
  ]);

  return out.join('\n') + '\n';
}

function parseDxfPairs(content) {
  if (typeof content !== 'string') throw new Error('DXF içeriği metin olmalı.');
  if (new TextEncoder().encode(content).length > MAX_DRAWING_BYTES) {
    throw new Error('DXF input exceeds the 1 MiB limit.');
  }
  if (!content.trim()) throw new Error('DXF input is empty.');
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.length && lines.at(-1) === '') lines.pop();
  if (lines.length < 2) throw new Error('Invalid ASCII DXF input.');
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const codeStr = lines[i].trim();
    if (!/^-?\d+$/.test(codeStr)) throw new Error('Invalid ASCII DXF input.');
    const code = Number(codeStr);
    const value = lines[i + 1];
    pairs.push([code, value]);
    if (code === 0 && value.trim() === 'EOF') break;
  }
  if (!pairs.length || !(pairs.at(-1)[0] === 0 && pairs.at(-1)[1].trim() === 'EOF')) {
    throw new Error('Invalid ASCII DXF input.');
  }
  return pairs;
}

export function importDrawingFromDxf(content, name = 'DXF Drawing') {
  const pairs = parseDxfPairs(content);

  let insUnits = null;
  const layerTable = new Map();
  const rawEntities = [];

  let i = 0;
  while (i < pairs.length) {
    const [code, val] = pairs[i];
    if (code === 0 && val.trim() === 'SECTION' && i + 1 < pairs.length && pairs[i + 1][0] === 2) {
      const secName = pairs[i + 1][1].trim().toUpperCase();
      i += 2;
      if (secName === 'HEADER') {
        let currentVar = null;
        while (i < pairs.length && !(pairs[i][0] === 0 && pairs[i][1].trim() === 'ENDSEC')) {
          if (pairs[i][0] === 9) {
            currentVar = pairs[i][1].trim().toUpperCase();
          } else if (currentVar === '$INSUNITS' && pairs[i][0] === 70) {
            insUnits = Number(pairs[i][1].trim());
          }
          i++;
        }
      } else if (secName === 'TABLES') {
        while (i < pairs.length && !(pairs[i][0] === 0 && pairs[i][1].trim() === 'ENDSEC')) {
          if (pairs[i][0] === 0 && pairs[i][1].trim() === 'LAYER') {
            i++;
            const rec = {
              name: null,
              linetype: 'CONTINUOUS',
              aci: 7,
              flags: 0,
              trueColor: null,
              plot: 1,
            };
            while (i < pairs.length && pairs[i][0] !== 0) {
              const [c, v] = pairs[i];
              if (c === 2) rec.name = v.trim();
              else if (c === 6) rec.linetype = v.trim();
              else if (c === 62) rec.aci = Number(v.trim());
              else if (c === 70) rec.flags = Number(v.trim());
              else if (c === 290) rec.plot = Number(v.trim());
              else if (c === 420) rec.trueColor = Number(v.trim());
              i++;
            }
            if (rec.name) layerTable.set(rec.name, rec);
            continue;
          }
          i++;
        }
      } else if (secName === 'BLOCKS') {
        let inPaperBlock = false;
        while (i < pairs.length && !(pairs[i][0] === 0 && pairs[i][1].trim() === 'ENDSEC')) {
          if (pairs[i][0] === 0 && pairs[i][1].trim() === 'BLOCK') {
            i++;
            let blkName = '';
            while (i < pairs.length && pairs[i][0] !== 0) {
              if (pairs[i][0] === 2) blkName = pairs[i][1].trim();
              i++;
            }
            inPaperBlock = blkName.toUpperCase().startsWith('*PAPER_SPACE');
            continue;
          }
          if (pairs[i][0] === 0 && pairs[i][1].trim() === 'ENDBLK') {
            inPaperBlock = false;
            i++;
            continue;
          }
          if (inPaperBlock && pairs[i][0] === 0) {
            throw new Error(
              'Paper-space content is not supported; the original file was not changed.',
            );
          }
          i++;
        }
      } else if (secName === 'ENTITIES') {
        while (i < pairs.length && !(pairs[i][0] === 0 && pairs[i][1].trim() === 'ENDSEC')) {
          if (pairs[i][0] === 0) {
            const entType = pairs[i][1].trim().toUpperCase();
            i++;
            const tags = [];
            while (i < pairs.length && pairs[i][0] !== 0) {
              tags.push(pairs[i]);
              i++;
            }
            rawEntities.push({ type: entType, tags });
            continue;
          }
          i++;
        }
      } else {
        while (i < pairs.length && !(pairs[i][0] === 0 && pairs[i][1].trim() === 'ENDSEC')) i++;
      }
    }
    i++;
  }

  if (insUnits !== 4) {
    throw new Error('Only DXF files explicitly declaring millimeter units are supported.');
  }
  if (!layerTable.has('0')) {
    layerTable.set('0', {
      name: '0',
      linetype: 'CONTINUOUS',
      aci: 7,
      flags: 0,
      trueColor: null,
    });
  }
  if (rawEntities.length > 5000) {
    throw new Error('At most 5000 entities are supported.');
  }

  const unsupported = [
    ...new Set(rawEntities.map((e) => e.type).filter((t) => !SUPPORTED_DXF_ENTITIES.has(t))),
  ].sort();
  if (unsupported.length) {
    throw new Error('Unsupported DXF entities: ' + unsupported.join(', '));
  }

  const usedLayerNames = new Set(['0']);
  for (const ent of rawEntities) {
    const paperFlag = ent.tags.find(([c]) => c === 67);
    if (paperFlag && Number(paperFlag[1].trim()) === 1) {
      throw new Error('Paper-space content is not supported; the original file was not changed.');
    }
    const layerTag = ent.tags.find(([c]) => c === 8);
    usedLayerNames.add(layerTag ? layerTag[1].trim() : '0');
  }

  if (usedLayerNames.size > 100) {
    throw new Error('At most 100 used layers are supported.');
  }

  const sortedLayers = [...usedLayerNames].sort((a, b) => {
    if (a === '0' && b !== '0') return -1;
    if (b === '0' && a !== '0') return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const layers = [];
  for (const lname of sortedLayers) {
    const rec = layerTable.get(lname);
    if (!rec) throw new Error('An entity references a missing DXF layer.');
    if ((rec.linetype || 'CONTINUOUS').toUpperCase() !== 'CONTINUOUS') {
      throw new Error('Non-continuous layer linetypes are not supported.');
    }
    const color = rec.trueColor !== null ? rgbIntToHex(rec.trueColor) : aciToHex(rec.aci);
    const isOff = rec.aci < 0;
    const isFrozen = (rec.flags & 1) !== 0;
    const isLocked = (rec.flags & 4) !== 0;
    const layerEntry = {
      id: lname,
      name: lname,
      color,
      visible: !isOff && !isFrozen,
      locked: isLocked,
    };
    if (rec.plot === 0) layerEntry.construction = true;
    layers.push(layerEntry);
  }

  const entities = [];
  for (const raw of rawEntities) {
    let layer = '0';
    let colorAci = 256;
    let hasTrueColor = false;
    let linetype = 'BYLAYER';
    let lineweight = -1;
    let thickness = 0;
    let extX = 0,
      extY = 0,
      extZ = 1;

    for (const [c, v] of raw.tags) {
      const sv = v.trim();
      if (c === 8) layer = sv;
      else if (c === 62) colorAci = Number(sv);
      else if (c === 420) hasTrueColor = true;
      else if (c === 6) linetype = sv;
      else if (c === 370) lineweight = Number(sv);
      else if (c === 39 && raw.type !== 'DIMENSION') thickness = Number(sv);
      else if (c === 210) extX = Number(sv);
      else if (c === 220) extY = Number(sv);
      else if (c === 230) extZ = Number(sv);
    }

    if (
      colorAci !== 256 ||
      hasTrueColor ||
      linetype.toUpperCase() !== 'BYLAYER' ||
      lineweight !== -1 ||
      Math.abs(thickness) > 1e-9
    ) {
      throw new Error('Per-entity style overrides and extrusion thickness are not supported.');
    }
    if (Math.abs(extX) > 1e-9 || Math.abs(extY) > 1e-9 || Math.abs(extZ - 1) > 1e-9) {
      throw new Error('Only world-XY planar entities are supported.');
    }

    const common = { id: crypto.randomUUID(), layer };
    const getNum = (code, def = 0) => {
      const hit = raw.tags.find(([c]) => c === code);
      return hit ? Number(hit[1].trim()) : def;
    };
    const hasCode = (code) => raw.tags.some(([c]) => c === code);

    if (raw.type === 'LINE') {
      if (Math.abs(getNum(30, 0)) > 1e-9 || Math.abs(getNum(31, 0)) > 1e-9) {
        throw new Error('3D lines are not supported in the 2D importer.');
      }
      entities.push({
        ...common,
        type: 'line',
        points: [
          [getNum(10), getNum(20)],
          [getNum(11), getNum(21)],
        ],
      });
    } else if (raw.type === 'CIRCLE') {
      if (Math.abs(getNum(30, 0)) > 1e-9) {
        throw new Error('Only circles in the world-XY plane are supported.');
      }
      entities.push({
        ...common,
        type: 'circle',
        center: [getNum(10), getNum(20)],
        radius: getNum(40),
      });
    } else if (raw.type === 'ARC') {
      if (Math.abs(getNum(30, 0)) > 1e-9) {
        throw new Error('Only arcs in the world-XY plane are supported.');
      }
      entities.push({
        ...common,
        type: 'arc',
        center: [getNum(10), getNum(20)],
        radius: getNum(40),
        start_angle: ((getNum(50) % 360) + 360) % 360,
        end_angle: ((getNum(51) % 360) + 360) % 360,
      });
    } else if (raw.type === 'DIMENSION') {
      const dimType = getNum(70, 0);
      const dimSubtype = dimType & 0x07;
      if (dimSubtype !== 0 && dimSubtype !== 1) {
        throw new Error(
          'Only linear/aligned DXF dimensions (subtypes 0 and 1) are supported; angular, radial, and ordinate dimensions are rejected.',
        );
      }
      if (!hasCode(10) || !hasCode(13) || !hasCode(14)) {
        throw new Error('Unsupported DXF dimension subtype.');
      }
      if (
        Math.abs(getNum(30, 0)) > 1e-9 ||
        Math.abs(getNum(33, 0)) > 1e-9 ||
        Math.abs(getNum(34, 0)) > 1e-9
      ) {
        throw new Error('Only planar XY dimensions are supported.');
      }
      const dp = [getNum(10), getNum(20)];
      const p1 = [getNum(13), getNum(23)];
      const p2 = [getNum(14), getNum(24)];
      const alignedSpan = distance(p1, p2);
      if (hasCode(42)) {
        const meas = getNum(42);
        if (meas > 0 && Math.abs(meas - alignedSpan) > Math.max(1e-4, 1e-5 * alignedSpan)) {
          throw new Error('DXF dimension measurement does not match aligned span.');
        }
      }
      if (dimSubtype === 0) {
        const rotRad = (getNum(50, 0) * Math.PI) / 180;
        const projSpan = Math.abs(
          (p2[0] - p1[0]) * Math.cos(rotRad) + (p2[1] - p1[1]) * Math.sin(rotRad),
        );
        if (Math.abs(projSpan - alignedSpan) > Math.max(1e-4, 1e-5 * alignedSpan)) {
          throw new Error('DXF dimension measurement does not match aligned span.');
        }
      }
      entities.push({
        ...common,
        type: 'dim',
        p1,
        p2,
        dim_point: dp,
      });
    } else if (raw.type === 'TEXT') {
      if (Math.abs(getNum(30, 0)) > 1e-9) {
        throw new Error('Only planar XY text entities are supported.');
      }
      const txtTag = raw.tags.find(([c]) => c === 1);
      entities.push({
        ...common,
        type: 'text',
        position: [getNum(10), getNum(20)],
        height: getNum(40),
        rotation: ((getNum(50, 0) % 360) + 360) % 360,
        text: txtTag ? txtTag[1] : '',
      });
    } else if (raw.type === 'LWPOLYLINE') {
      const elevation = getNum(38, 0);
      const constWidth = getNum(43, 0);
      if (Math.abs(elevation) > 1e-9 || Math.abs(constWidth) > 1e-9) {
        throw new Error('Polyline arcs, widths and elevation are not supported.');
      }
      const closed = (getNum(70, 0) & 1) !== 0;
      const pts = [];
      let curPt = null;
      for (const [c, v] of raw.tags) {
        const num = Number(v.trim());
        if (c === 10) {
          if (curPt !== null) pts.push(curPt);
          curPt = [num, 0];
        } else if (c === 20 && curPt !== null) {
          curPt[1] = num;
        } else if ((c === 40 || c === 41 || c === 42) && Math.abs(num) > 1e-9) {
          throw new Error('Polyline arcs, widths and elevation are not supported.');
        }
      }
      if (curPt !== null) pts.push(curPt);
      entities.push({
        ...common,
        type: 'polyline',
        points: pts,
        closed,
      });
    }
  }

  const validated = validateDrawing({
    format: 'cad-lab.drawing',
    schema_version: 1,
    units: 'mm',
    name: (name || 'DXF Drawing').trim().slice(0, 80) || 'DXF Drawing',
    layers,
    entities,
  });
  return {
    drawing: validated,
    report: {
      layers: validated.layers.length,
      entities: validated.entities.length,
    },
  };
}
