/**
 * Chamfer QuoteGate — Analytical Industrial DXF Intake, Multi-Part Splitter & B2B Laser Quoting Engine.
 * Preserves exact analytical geometry (zero polygon chord approximations).
 */
import { arcSweepDeg, distance, validateDrawing } from '../drawing/model.js';
import {
  analyzeDrawingTopology,
  arcGeometry,
  computeCamMetrics,
  cuttingLayerIds,
  pointStrictlyInsideLoop,
} from '../drawing/ops.js';
import { lintDrawing, previewDrcFix } from '../drawing/linter.js';

const EPS = 1e-6;
const MAX_DXF_BYTES = 2 * 1024 * 1024;
const MAX_INSERT_DEPTH = 8;
const MAX_EXPANDED_INSERTS = 500;
export const MAX_SHEET_ENTITIES = 1200;
export const MAX_PART_ENTITIES = 300;
const IGNORED_ANNOTATIONS = new Set([
  'TEXT',
  'MTEXT',
  'DIMENSION',
  'LEADER',
  'MULTILEADER',
  'MLEADER',
  'HATCH',
  'POINT',
  'SOLID',
  'TRACE',
  'WIPEOUT',
  'RAY',
  'XLINE',
  'VIEWPORT',
  'ATTRIB',
  'ATTDEF',
]);
const REJECTED_CURVES = new Set(['SPLINE', 'ELLIPSE']);

const round4 = (n) => Math.round(n * 1e4) / 1e4;
const round6 = (n) => Math.round(n * 1e6) / 1e6;
const round9 = (n) => Math.round(n * 1e9) / 1e9;
const round2 = (n) => Math.round(n * 100) / 100;
const roundPt = (p) => [round6(p[0]), round6(p[1])];
const mod360 = (deg) => ((deg % 360) + 360) % 360;

export const MATERIALS = Object.freeze({
  steel_s235: {
    id: 'steel_s235',
    nameTr: 'DKP / S235 Karbon Çelik',
    nameEn: 'Mild Steel S235 / DKP',
    densityGCm3: 7.85,
    rateTryPerKg: 58,
    cutSpeedFactor: 1.0,
    pierceFactor: 1.0,
  },
  stainless_304: {
    id: 'stainless_304',
    nameTr: '304 Paslanmaz Çelik',
    nameEn: 'Stainless Steel 304',
    densityGCm3: 7.93,
    rateTryPerKg: 195,
    cutSpeedFactor: 1.35,
    pierceFactor: 1.4,
  },
  aluminum_6061: {
    id: 'aluminum_6061',
    nameTr: 'Alüminyum 5754 / 6061',
    nameEn: 'Aluminum 5754 / 6061',
    densityGCm3: 2.7,
    rateTryPerKg: 210,
    cutSpeedFactor: 1.15,
    pierceFactor: 1.25,
  },
  galvanized: {
    id: 'galvanized',
    nameTr: 'Galvanizli Sac',
    nameEn: 'Galvanized Steel Sheet',
    densityGCm3: 7.85,
    rateTryPerKg: 68,
    cutSpeedFactor: 1.05,
    pierceFactor: 1.05,
  },
});

export const DEFAULT_TARIFF = Object.freeze({
  shopName: 'Aeon Lazer & CNC Atölyesi',
  whatsappPhone: '',
  usdTry: 35.0,
  eurTry: 38.0,
  cutRateTryPerMeter: 18.0,
  pierceTry: 2.5,
  setupFeeTry: 95.0,
  minOrderTry: 250.0,
  scrapMarkupPct: 18,
  vatPct: 20,
  expressMultiplier: 1.35,
  materialRateOverrides: {
    steel_s235: 58,
    stainless_304: 195,
    aluminum_6061: 210,
    galvanized: 68,
  },
});

function clampFinite(val, fallback, min, max) {
  if (val === null || val === undefined || val === '' || typeof val === 'boolean') return fallback;
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * Normalizes workshop tariff parameters with finite bounds while preserving valid zeroes (e.g. 0% VAT).
 */
export function sanitizeTariff(rawTariff = {}) {
  const src = rawTariff && typeof rawTariff === 'object' ? rawTariff : {};
  const rawOverrides =
    src.materialRateOverrides && typeof src.materialRateOverrides === 'object'
      ? src.materialRateOverrides
      : {};
  const shopNameRaw =
    typeof src.shopName === 'string'
      ? src.shopName
          .replace(/[\x00-\x1f<>]/g, '')
          .trim()
          .slice(0, 80)
      : '';
  const phoneRaw =
    typeof src.whatsappPhone === 'string'
      ? src.whatsappPhone.replace(/[^\d]/g, '').slice(0, 20)
      : '';

  return {
    shopName: shopNameRaw || DEFAULT_TARIFF.shopName,
    whatsappPhone: phoneRaw,
    usdTry: clampFinite(src.usdTry, DEFAULT_TARIFF.usdTry, 1, 10000),
    eurTry: clampFinite(src.eurTry, DEFAULT_TARIFF.eurTry, 1, 10000),
    cutRateTryPerMeter: clampFinite(
      src.cutRateTryPerMeter,
      DEFAULT_TARIFF.cutRateTryPerMeter,
      0.1,
      100000,
    ),
    pierceTry: clampFinite(src.pierceTry, DEFAULT_TARIFF.pierceTry, 0, 50000),
    setupFeeTry: clampFinite(src.setupFeeTry, DEFAULT_TARIFF.setupFeeTry, 0, 500000),
    minOrderTry: clampFinite(src.minOrderTry, DEFAULT_TARIFF.minOrderTry, 0, 5000000),
    scrapMarkupPct: clampFinite(src.scrapMarkupPct, DEFAULT_TARIFF.scrapMarkupPct, 0, 300),
    vatPct: clampFinite(src.vatPct, DEFAULT_TARIFF.vatPct, 0, 100),
    expressMultiplier: clampFinite(src.expressMultiplier, DEFAULT_TARIFF.expressMultiplier, 1, 10),
    materialRateOverrides: {
      steel_s235: clampFinite(
        rawOverrides.steel_s235,
        MATERIALS.steel_s235.rateTryPerKg,
        1,
        500000,
      ),
      stainless_304: clampFinite(
        rawOverrides.stainless_304,
        MATERIALS.stainless_304.rateTryPerKg,
        1,
        500000,
      ),
      aluminum_6061: clampFinite(
        rawOverrides.aluminum_6061,
        MATERIALS.aluminum_6061.rateTryPerKg,
        1,
        500000,
      ),
      galvanized: clampFinite(
        rawOverrides.galvanized,
        MATERIALS.galvanized.rateTryPerKg,
        1,
        500000,
      ),
    },
  };
}

const INSUNITS_SCALE = new Map([
  [1, { scale: 25.4, label: 'inch' }],
  [2, { scale: 304.8, label: 'feet' }],
  [4, { scale: 1.0, label: 'mm' }],
  [5, { scale: 10.0, label: 'cm' }],
  [6, { scale: 1000.0, label: 'm' }],
  [8, { scale: 0.0000254, label: 'microinch' }],
  [9, { scale: 0.0254, label: 'mil' }],
  [10, { scale: 914.4, label: 'yard' }],
  [13, { scale: 0.001, label: 'micron' }],
  [14, { scale: 100.0, label: 'dm' }],
]);

function computeBulgeArcGeometry(p1, p2, bulge) {
  const chord = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
  if (chord <= EPS) return null;

  const b = Number(bulge || 0);
  const sagitta = (chord * Math.abs(b)) / 2;
  if (!Number.isFinite(b) || Math.abs(b) <= 1e-7) {
    return { kind: 'line', entity: { type: 'line', points: [roundPt(p1), roundPt(p2)] } };
  }

  const radius = (chord * (1 + b * b)) / (4 * Math.abs(b));
  if (Math.abs(b) < 1 && (sagitta <= 1e-4 || radius > 5e5)) {
    return { kind: 'line', entity: { type: 'line', points: [roundPt(p1), roundPt(p2)] } };
  }
  if (!Number.isFinite(radius) || radius > 5e5) {
    throw new Error('LWPOLYLINE yay yarıçapı izin verilen sınırı (500 m) aşıyor.');
  }

  const d = (chord * (1 - b * b)) / (4 * b);
  const mx = (p1[0] + p2[0]) / 2;
  const my = (p1[1] + p2[1]) / 2;
  const nx = -(p2[1] - p1[1]) / chord;
  const ny = (p2[0] - p1[0]) / chord;
  const cx = mx + d * nx;
  const cy = my + d * ny;

  const a1 = mod360((Math.atan2(p1[1] - cy, p1[0] - cx) * 180) / Math.PI);
  const a2 = mod360((Math.atan2(p2[1] - cy, p2[0] - cx) * 180) / Math.PI);
  const [startAngle, endAngle] = b > 0 ? [a1, a2] : [a2, a1];
  const sweep = arcSweepDeg(startAngle, endAngle);

  return {
    kind: 'arc',
    cx,
    cy,
    radius,
    startAngle,
    endAngle,
    sweep,
  };
}

/**
 * Analytically converts a DXF LWPOLYLINE bulge segment between p1 and p2 into a line or exact circular arc.
 */
export function bulgeSegmentToArc(p1, p2, bulge) {
  const geom = computeBulgeArcGeometry(p1, p2, bulge);
  if (!geom) return null;
  if (geom.kind === 'line') return geom.entity;
  if (geom.sweep <= 1e-4) {
    return { type: 'line', points: [roundPt(p1), roundPt(p2)] };
  }
  if (geom.sweep >= 360 - 1e-4) {
    throw new Error(
      'Tam 360° tek segment LWPOLYLINE bombesi tek yaya indirgenemez; iki yarım yay olarak bölün.',
    );
  }
  return {
    type: 'arc',
    center: [round9(geom.cx), round9(geom.cy)],
    radius: round9(geom.radius),
    start_angle: round9(geom.startAngle),
    end_angle: round9(geom.endAngle),
  };
}

function bulgeSegmentToPrimitives(p1, p2, bulge) {
  const geom = computeBulgeArcGeometry(p1, p2, bulge);
  if (!geom) return [];
  if (geom.kind === 'line') return [geom.entity];
  if (geom.sweep <= 1e-4) {
    return [{ type: 'line', points: [roundPt(p1), roundPt(p2)] }];
  }
  if (geom.sweep >= 360 - 1e-2) {
    const midAngle = mod360(geom.startAngle + geom.sweep / 2);
    return [
      {
        type: 'arc',
        center: [round9(geom.cx), round9(geom.cy)],
        radius: round9(geom.radius),
        start_angle: round9(geom.startAngle),
        end_angle: round9(midAngle),
      },
      {
        type: 'arc',
        center: [round9(geom.cx), round9(geom.cy)],
        radius: round9(geom.radius),
        start_angle: round9(midAngle),
        end_angle: round9(geom.endAngle),
      },
    ];
  }
  return [
    {
      type: 'arc',
      center: [round9(geom.cx), round9(geom.cy)],
      radius: round9(geom.radius),
      start_angle: round9(geom.startAngle),
      end_angle: round9(geom.endAngle),
    },
  ];
}

/**
 * Computes exact curve-aware [minX, minY, maxX, maxY] bounding box for a single 2D entity.
 */
export function entityBbox(entity) {
  if (entity.type === 'circle') {
    const [cx, cy] = entity.center;
    const r = entity.radius;
    return [cx - r, cy - r, cx + r, cy + r];
  }
  if (entity.type === 'arc') {
    const [cx, cy] = entity.center;
    const r = entity.radius;
    const { pStart, pMid, pEnd, sweep } = arcGeometry(entity);
    const xs = [pStart[0], pMid[0], pEnd[0]];
    const ys = [pStart[1], pMid[1], pEnd[1]];
    for (const q of [0, 90, 180, 270]) {
      if (mod360(q - entity.start_angle) <= sweep + 1e-5) {
        xs.push(cx + r * Math.cos((q * Math.PI) / 180));
        ys.push(cy + r * Math.sin((q * Math.PI) / 180));
      }
    }
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  if (entity.type === 'line' || entity.type === 'polyline') {
    const xs = entity.points.map((p) => p[0]);
    const ys = entity.points.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  if (entity.type === 'dim') {
    const xs = [entity.p1[0], entity.p2[0], entity.dim_point[0]];
    const ys = [entity.p1[1], entity.p2[1], entity.dim_point[1]];
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  const [px, py] = entity.position || [0, 0];
  return [px, py, px, py];
}

function tokenizeDxfPairs(dxfText) {
  if (typeof dxfText !== 'string' || !dxfText.trim()) {
    throw new Error('DXF dosyası boş.');
  }
  if (new TextEncoder().encode(dxfText).length > MAX_DXF_BYTES) {
    throw new Error('DXF dosyası 2 MiB sınırını aşıyor.');
  }
  const lines = dxfText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.length && lines.at(-1) === '') lines.pop();
  if (lines.length < 2) {
    throw new Error('Geçersiz ASCII DXF formatı.');
  }
  const pairs = [];
  let sawEof = false;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const codeStr = lines[i].trim();
    if (!/^-?\d+$/.test(codeStr)) {
      throw new Error(
        'Geçersiz DXF grup kodu (ikili/binary DXF desteklenmez, ASCII R2000–R2018 DXF yükleyin).',
      );
    }
    const code = Number(codeStr);
    const val = lines[i + 1];
    pairs.push([code, val]);
    if (code === 0 && val.trim().toUpperCase() === 'EOF') {
      sawEof = true;
      break;
    }
  }
  if (!sawEof) {
    throw new Error('DXF dosyası eksik veya bozuk (EOF sonlandırıcısı bulunamadı).');
  }
  return pairs;
}

function sanitizeLayerName(raw) {
  const cleaned = String(raw || '0')
    .replace(/[<>/\\":;?*|=\x00-\x1f]/g, '_')
    .trim()
    .slice(0, 80);
  return cleaned || '0';
}

function parseEntityRecord(pairs, startIdx) {
  const type = pairs[startIdx][1].trim().toUpperCase();
  let i = startIdx + 1;
  const tags = [];
  while (i < pairs.length && pairs[i][0] !== 0) {
    tags.push(pairs[i]);
    i++;
  }
  return { entity: { type, tags }, nextIdx: i };
}

function getTagNum(tags, code, def = 0) {
  const hit = tags.find(([c]) => c === code);
  if (!hit) return def;
  const n = Number(String(hit[1]).trim());
  return Number.isFinite(n) ? n : def;
}

function getTagStr(tags, code, def = '') {
  const hit = tags.find(([c]) => c === code);
  return hit ? String(hit[1]).trim() : def;
}

function consumeLegacyPolylines(rawStream) {
  const result = [];
  let i = 0;
  while (i < rawStream.length) {
    const cur = rawStream[i];
    if (cur.type === 'POLYLINE') {
      const layerTag = cur.tags.find(([c]) => c === 8);
      const polyFlags = getTagNum(cur.tags, 70, 0);
      if ((polyFlags & (8 | 16 | 64)) !== 0) {
        throw new Error(
          '3B POLYLINE veya çokgen/yüzey ağı (mesh) desteklenmez; yalnızca 2B düzlemsel çizim yükleyin.',
        );
      }
      const elevZ = getTagNum(cur.tags, 30, 0);
      if (Math.abs(elevZ) > 1e-3) {
        throw new Error('3B Z kotu (elevation) içeren POLYLINE desteklenmez.');
      }
      if (
        Math.abs(getTagNum(cur.tags, 40, 0)) > 1e-3 ||
        Math.abs(getTagNum(cur.tags, 41, 0)) > 1e-3
      ) {
        throw new Error(
          'Kalınlıklı (width) POLYLINE desteklenmez; sıfır çizgi kalınlığı kullanın.',
        );
      }
      const isClosed = (polyFlags & 1) !== 0;
      const syntheticTags = [];
      if (layerTag) syntheticTags.push([8, layerTag[1]]);
      syntheticTags.push([70, String(isClosed ? 1 : 0)]);
      for (const code of [67, 210, 220, 230]) {
        const tag = cur.tags.find(([c]) => c === code);
        if (tag) syntheticTags.push(tag);
      }
      const vertices = [];
      i++;
      while (i < rawStream.length && rawStream[i].type !== 'SEQEND') {
        if (rawStream[i].type === 'VERTEX') {
          const vFlags = getTagNum(rawStream[i].tags, 70, 0);
          if ((vFlags & (16 | 32 | 64)) !== 0) {
            throw new Error('3B veya spline kontrol noktası içeren POLYLINE/VERTEX desteklenmez.');
          }
          let vx = 0;
          let vy = 0;
          let vz = 0;
          let vb = 0;
          for (const [c, v] of rawStream[i].tags) {
            const num = Number(v.trim());
            if (!Number.isFinite(num)) continue;
            if (c === 10) vx = num;
            else if (c === 20) vy = num;
            else if (c === 30) vz = num;
            else if (c === 40 && Math.abs(num) > 1e-3) {
              throw new Error(
                'Değişken kalınlıklı (width) POLYLINE desteklenmez; sıfır kalınlık kullanın.',
              );
            } else if (c === 41 && Math.abs(num) > 1e-3) {
              throw new Error(
                'Değişken kalınlıklı (width) POLYLINE desteklenmez; sıfır kalınlık kullanın.',
              );
            } else if (c === 42) vb = num;
          }
          if (Math.abs(vz) > 1e-3) {
            throw new Error('3B Z koordinatı içeren POLYLINE desteklenmez.');
          }
          vertices.push({ x: vx, y: vy, bulge: vb });
        }
        i++;
      }
      if (i < rawStream.length && rawStream[i].type === 'SEQEND') i++;
      syntheticTags.push([90, String(vertices.length)]);
      for (const vt of vertices) {
        syntheticTags.push([10, String(vt.x)], [20, String(vt.y)], [42, String(vt.bulge)]);
      }
      result.push({ type: 'LWPOLYLINE', tags: syntheticTags });
      continue;
    }
    if (cur.type !== 'VERTEX' && cur.type !== 'SEQEND') {
      result.push(cur);
    }
    i++;
  }
  return result;
}

function resolveOcsNegZ(tags, entityType) {
  const nx = getTagNum(tags, 210, 0);
  const ny = getTagNum(tags, 220, 0);
  const nz = getTagNum(tags, 230, 1);
  if (Math.abs(nx) > 1e-4 || Math.abs(ny) > 1e-4 || Math.abs(Math.abs(nz) - 1) > 1e-4) {
    throw new Error(
      `Eğik 3B düzlem normali (210/220/230 = ${nx}, ${ny}, ${nz}) içeren "${entityType}" desteklenmez; yalnızca XY düzlemi desteklenir.`,
    );
  }
  return nz < 0;
}

function extractLwPolylineVertices(tags, scale, ocsNegZ = false) {
  if (Math.abs(getTagNum(tags, 38, 0)) > 1e-3) {
    throw new Error('3B Z kotu (38) içeren LWPOLYLINE desteklenmez.');
  }
  if (Math.abs(getTagNum(tags, 43, 0)) > 1e-3) {
    throw new Error(
      'Sabit kalınlıklı (43) LWPOLYLINE desteklenmez; sıfır çizgi kalınlığı kullanın.',
    );
  }
  const rawPts = [];
  let cur = null;
  for (const [c, v] of tags) {
    const num = Number(String(v).trim());
    if (!Number.isFinite(num)) continue;
    if (c === 10) {
      if (cur !== null) rawPts.push(cur);
      cur = { pt: [(ocsNegZ ? -num : num) * scale, 0], bulge: 0 };
    } else if (c === 20 && cur !== null) {
      cur.pt[1] = num * scale;
    } else if ((c === 40 || c === 41) && Math.abs(num) > 1e-3) {
      throw new Error(
        'Değişken kalınlıklı (40/41) LWPOLYLINE desteklenmez; sıfır çizgi kalınlığı kullanın.',
      );
    } else if (c === 42 && cur !== null) {
      cur.bulge = ocsNegZ ? -num : num;
    }
  }
  if (cur !== null) rawPts.push(cur);

  // Deduplicate adjacent identical vertices while preserving closing bulge semantics.
  const closed = (getTagNum(tags, 70, 0) & 1) !== 0;
  const deduped = [];
  for (const item of rawPts) {
    if (!deduped.length || distance(item.pt, deduped.at(-1).pt) > EPS) {
      deduped.push(item);
    } else {
      deduped.at(-1).bulge = item.bulge;
    }
  }
  if (closed && deduped.length > 1 && distance(deduped[0].pt, deduped.at(-1).pt) <= EPS) {
    deduped.pop();
  }
  return { vertices: deduped, closed };
}

/**
 * Strictly ingests real-world industrial ASCII DXF files for quoting:
 * expands INSERT blocks, converts LWPOLYLINE bulges into exact analytical ARCs,
 * normalizes units to millimeters, skips text/dimensions, and explicitly rejects SPLINE/ELLIPSE.
 */
export function ingestIndustrialDxf(dxfText, fileName = 'siparis.dxf') {
  const pairs = tokenizeDxfPairs(dxfText);

  let insUnits = null;
  let measurement = null;
  const layerMeta = new Map();
  const blocks = new Map();
  const rawModelEntities = [];
  let ignoredPaperSpace = 0;

  let i = 0;
  while (i < pairs.length) {
    const [code, val] = pairs[i];
    if (
      code === 0 &&
      val.trim().toUpperCase() === 'SECTION' &&
      i + 1 < pairs.length &&
      pairs[i + 1][0] === 2
    ) {
      const secName = pairs[i + 1][1].trim().toUpperCase();
      i += 2;

      if (secName === 'HEADER') {
        let varName = null;
        while (
          i < pairs.length &&
          !(pairs[i][0] === 0 && pairs[i][1].trim().toUpperCase() === 'ENDSEC')
        ) {
          if (pairs[i][0] === 9) {
            varName = pairs[i][1].trim().toUpperCase();
          } else if (varName === '$INSUNITS' && pairs[i][0] === 70) {
            insUnits = Number(pairs[i][1].trim());
          } else if (varName === '$MEASUREMENT' && pairs[i][0] === 70) {
            measurement = Number(pairs[i][1].trim());
          }
          i++;
        }
      } else if (secName === 'TABLES') {
        while (
          i < pairs.length &&
          !(pairs[i][0] === 0 && pairs[i][1].trim().toUpperCase() === 'ENDSEC')
        ) {
          if (pairs[i][0] === 0 && pairs[i][1].trim().toUpperCase() === 'LAYER') {
            i++;
            const rec = { name: '0', flags: 0, plot: 1, aci: 7 };
            while (i < pairs.length && pairs[i][0] !== 0) {
              const [c, v] = pairs[i];
              if (c === 2) rec.name = sanitizeLayerName(v);
              else if (c === 70) rec.flags = Number(v.trim()) || 0;
              else if (c === 62) rec.aci = Number(v.trim());
              else if (c === 290) rec.plot = Number(v.trim());
              i++;
            }
            layerMeta.set(rec.name.toLowerCase(), rec);
            continue;
          }
          i++;
        }
      } else if (secName === 'BLOCKS') {
        while (
          i < pairs.length &&
          !(pairs[i][0] === 0 && pairs[i][1].trim().toUpperCase() === 'ENDSEC')
        ) {
          if (pairs[i][0] === 0 && pairs[i][1].trim().toUpperCase() === 'BLOCK') {
            i++;
            let blkName = '';
            let baseX = 0;
            let baseY = 0;
            let baseZ = 0;
            while (i < pairs.length && pairs[i][0] !== 0) {
              const [c, v] = pairs[i];
              if (c === 2) blkName = v.trim();
              else if (c === 10) baseX = Number(v.trim()) || 0;
              else if (c === 20) baseY = Number(v.trim()) || 0;
              else if (c === 30) baseZ = Number(v.trim()) || 0;
              i++;
            }
            if (Math.abs(baseZ) > 1e-3) {
              throw new Error(
                `Blok "${blkName}" 3B Z taban kotu içeriyor; yalnızca 2B XY desteklenir.`,
              );
            }
            const stream = [];
            while (
              i < pairs.length &&
              !(pairs[i][0] === 0 && pairs[i][1].trim().toUpperCase() === 'ENDBLK') &&
              !(pairs[i][0] === 0 && pairs[i][1].trim().toUpperCase() === 'ENDSEC')
            ) {
              if (pairs[i][0] === 0) {
                const parsed = parseEntityRecord(pairs, i);
                stream.push(parsed.entity);
                i = parsed.nextIdx;
              } else {
                i++;
              }
            }
            if (
              i < pairs.length &&
              pairs[i][0] === 0 &&
              pairs[i][1].trim().toUpperCase() === 'ENDBLK'
            ) {
              i++;
              while (i < pairs.length && pairs[i][0] !== 0) i++;
            }
            if (
              blkName &&
              !blkName.toUpperCase().startsWith('*PAPER_SPACE') &&
              !blkName.toUpperCase().startsWith('*MODEL_SPACE')
            ) {
              blocks.set(blkName.toUpperCase(), {
                basePt: [baseX, baseY],
                entities: consumeLegacyPolylines(stream),
              });
            }
            continue;
          }
          i++;
        }
      } else if (secName === 'ENTITIES') {
        const stream = [];
        while (
          i < pairs.length &&
          !(pairs[i][0] === 0 && pairs[i][1].trim().toUpperCase() === 'ENDSEC')
        ) {
          if (pairs[i][0] === 0) {
            const parsed = parseEntityRecord(pairs, i);
            stream.push(parsed.entity);
            i = parsed.nextIdx;
          } else {
            i++;
          }
        }
        rawModelEntities.push(...consumeLegacyPolylines(stream));
      } else {
        while (
          i < pairs.length &&
          !(pairs[i][0] === 0 && pairs[i][1].trim().toUpperCase() === 'ENDSEC')
        ) {
          i++;
        }
      }
    }
    i++;
  }

  let scale = 1.0;
  let detectedUnits = 'unitless (mm varsayıldı)';
  let unitAssumedMm = false;
  if (insUnits === null || insUnits === 0) {
    if (measurement === 0) {
      throw new Error(
        'DXF dosyası emperyal ölçü sisteminde ($MEASUREMENT = 0) ve $INSUNITS = 0/eksik; birim belirsizliği nedeniyle reddedildi.',
      );
    }
    unitAssumedMm = true;
  } else if (INSUNITS_SCALE.has(insUnits)) {
    const unitEntry = INSUNITS_SCALE.get(insUnits);
    scale = unitEntry.scale;
    detectedUnits = unitEntry.label;
    unitAssumedMm = false;
  } else {
    throw new Error(
      `Desteklenmeyen DXF birimi ($INSUNITS = ${insUnits}); lütfen mm veya standart CAD birimlerinden birinde dışa aktarın.`,
    );
  }

  let convertedBulgeArcs = 0;
  let expandedInserts = 0;
  let ignoredAnnotations = 0;
  let emittedCount = 0;
  const entities = [];
  const usedLayers = new Map();
  const canonicalLayerByLower = new Map();
  const activeBlockStack = new Set();

  const resolveLayerId = (rawName) => {
    const clean = sanitizeLayerName(rawName);
    const key = clean.toLowerCase();
    if (!canonicalLayerByLower.has(key)) {
      const meta = layerMeta.get(key);
      canonicalLayerByLower.set(key, meta ? meta.name : clean);
    }
    return canonicalLayerByLower.get(key);
  };
  usedLayers.set('0', resolveLayerId('0'));

  const trackAndPush = (list, item) => {
    emittedCount += 1;
    if (emittedCount > MAX_SHEET_ENTITIES) {
      throw new Error(
        `DXF içindeki kesim öğesi sayısı ${MAX_SHEET_ENTITIES} sınırını aşıyor (parçaları bölerek yükleyin).`,
      );
    }
    list.push({ ...item, id: `qg-${emittedCount}` });
  };

  const translatePt = (p, dx, dy) => [p[0] + dx, p[1] + dy];

  function transformConvertedEntity(ent, tx, ty, sx, sy, rotDeg, blkBase) {
    const cur = structuredClone(ent);
    const bx = blkBase[0] * scale;
    const by = blkBase[1] * scale;

    const mapPoint = (p) => {
      let x = (p[0] - bx) * sx;
      let y = (p[1] - by) * sy;
      if (Math.abs(rotDeg) > 1e-6) {
        const rad = (rotDeg * Math.PI) / 180;
        const rx = x * Math.cos(rad) - y * Math.sin(rad);
        const ry = x * Math.sin(rad) + y * Math.cos(rad);
        x = rx;
        y = ry;
      }
      return roundPt([x + tx, y + ty]);
    };

    const uScale = Math.abs(sx);

    if (cur.type === 'line' || cur.type === 'polyline') {
      cur.points = cur.points.map(mapPoint);
      return cur;
    }
    if (cur.type === 'circle') {
      cur.center = mapPoint(cur.center);
      cur.radius = round6(cur.radius * uScale);
      return cur;
    }
    if (cur.type === 'arc') {
      cur.center = mapPoint(cur.center);
      cur.radius = round9(cur.radius * uScale);
      let sa = Number(cur.start_angle);
      let ea = Number(cur.end_angle);
      if (sx < 0) {
        [sa, ea] = [mod360(180 - ea), mod360(180 - sa)];
      }
      if (sy < 0) {
        [sa, ea] = [mod360(-ea), mod360(-sa)];
      }
      if (Math.abs(rotDeg) > 1e-6) {
        sa = mod360(sa + rotDeg);
        ea = mod360(ea + rotDeg);
      }
      cur.start_angle = round9(sa);
      cur.end_angle = round9(ea);
      return cur;
    }
    return cur;
  }

  function convertRaw(raw, layerOverride = null, depth = 0) {
    if (getTagNum(raw.tags, 67, 0) === 1) {
      ignoredPaperSpace += 1;
      return [];
    }
    if (IGNORED_ANNOTATIONS.has(raw.type)) {
      ignoredAnnotations += 1;
      return [];
    }
    if (REJECTED_CURVES.has(raw.type)) {
      throw new Error(
        `Dosyada desteklenmeyen "${raw.type}" eğrisi var. Analitik lazer kesim ve DRC doğruluğu için CAD programınızdan ARC / LINE / LWPOLYLINE formatında DXF dışa aktarın.`,
      );
    }

    const rawLayerStr = sanitizeLayerName(getTagStr(raw.tags, 8, '0'));
    const resolvedLayer = resolveLayerId(rawLayerStr);
    const layer = rawLayerStr === '0' && layerOverride ? layerOverride : resolvedLayer;
    usedLayers.set(layer.toLowerCase(), layer);

    if (raw.type === 'INSERT') {
      if (depth >= MAX_INSERT_DEPTH) {
        throw new Error(`İç içe INSERT blok derinliği ${MAX_INSERT_DEPTH} sınırını aştı.`);
      }
      const blkName = getTagStr(raw.tags, 2, '');
      const blkKey = blkName.toUpperCase();
      if (activeBlockStack.has(blkKey)) {
        throw new Error(`Blok "${blkName}" kendi kendine döngüsel referans (INSERT) içeriyor.`);
      }
      const blk = blocks.get(blkKey);
      if (!blk) {
        throw new Error(
          `Çizimde çözümlenemeyen dış/eksik "${blkName}" bloku (INSERT) bulundu; göndermeden önce blokları patlatın (EXPLODE).`,
        );
      }
      expandedInserts += 1;
      if (expandedInserts > MAX_EXPANDED_INSERTS) {
        throw new Error(`INSERT blok açılım sayısı ${MAX_EXPANDED_INSERTS} sınırını aştı.`);
      }

      const ocsNegZ = resolveOcsNegZ(raw.tags, 'INSERT');
      if (Math.abs(getTagNum(raw.tags, 30, 0)) > 1e-3) {
        throw new Error(`"${blkName}" INSERT bloğu 3B Z konumu içeriyor; yalnızca 2B desteklenir.`);
      }
      let tx = getTagNum(raw.tags, 10, 0) * scale;
      const ty = getTagNum(raw.tags, 20, 0) * scale;
      let sx = getTagNum(raw.tags, 41, 1);
      const sy = getTagNum(raw.tags, 42, 1);
      let rot = getTagNum(raw.tags, 50, 0);
      if (ocsNegZ) {
        tx = -tx;
        sx = -sx;
        rot = -rot;
      }
      if (Math.abs(sx) <= 1e-6 || Math.abs(sy) <= 1e-6) {
        throw new Error(`Blok "${blkName}" sıfır ölçek (sx=${sx}, sy=${sy}) içeriyor; reddedildi.`);
      }
      if (Math.abs(Math.abs(sx) - Math.abs(sy)) > 1e-4) {
        throw new Error(
          `Blok "${blkName}" tekdüze olmayan ölçek (${sx}, ${sy}) içeriyor; dairesel yaylar elipse döneceğinden reddedildi.`,
        );
      }
      activeBlockStack.add(blkKey);
      try {
        const out = [];
        for (const child of blk.entities) {
          for (const conv of convertRaw(child, layer, depth + 1)) {
            out.push(transformConvertedEntity(conv, tx, ty, sx, sy, rot, blk.basePt));
          }
        }
        return out;
      } finally {
        activeBlockStack.delete(blkKey);
      }
    }

    if (raw.type === 'LINE') {
      resolveOcsNegZ(raw.tags, 'LINE');
      if (
        Math.abs(getTagNum(raw.tags, 30, 0)) > 1e-3 ||
        Math.abs(getTagNum(raw.tags, 31, 0)) > 1e-3
      ) {
        throw new Error('3B Z koordinatı içeren LINE varlığı desteklenmez; 2B XY çizim yükleyin.');
      }
      const p1 = roundPt([getTagNum(raw.tags, 10) * scale, getTagNum(raw.tags, 20) * scale]);
      const p2 = roundPt([getTagNum(raw.tags, 11) * scale, getTagNum(raw.tags, 21) * scale]);
      if (distance(p1, p2) <= EPS) return [];
      const out = [];
      trackAndPush(out, { layer, type: 'line', points: [p1, p2] });
      return out;
    }

    if (raw.type === 'CIRCLE') {
      const ocsNegZ = resolveOcsNegZ(raw.tags, 'CIRCLE');
      if (Math.abs(getTagNum(raw.tags, 30, 0)) > 1e-3) {
        throw new Error('3B Z koordinatı içeren CIRCLE desteklenmez.');
      }
      const r = round6(getTagNum(raw.tags, 40) * scale);
      if (r <= EPS) return [];
      const cx = (ocsNegZ ? -getTagNum(raw.tags, 10) : getTagNum(raw.tags, 10)) * scale;
      const cy = getTagNum(raw.tags, 20) * scale;
      const out = [];
      trackAndPush(out, {
        layer,
        type: 'circle',
        center: roundPt([cx, cy]),
        radius: r,
      });
      return out;
    }

    if (raw.type === 'ARC') {
      const ocsNegZ = resolveOcsNegZ(raw.tags, 'ARC');
      if (Math.abs(getTagNum(raw.tags, 30, 0)) > 1e-3) {
        throw new Error('3B Z koordinatı içeren ARC desteklenmez.');
      }
      const r = round9(getTagNum(raw.tags, 40) * scale);
      if (r <= EPS) return [];
      let sa = mod360(getTagNum(raw.tags, 50));
      let ea = mod360(getTagNum(raw.tags, 51));
      if (ocsNegZ) {
        [sa, ea] = [mod360(180 - ea), mod360(180 - sa)];
      }
      const sw = arcSweepDeg(sa, ea);
      if (sw <= 1e-4 || sw >= 360 - 1e-4) return [];
      const cx = (ocsNegZ ? -getTagNum(raw.tags, 10) : getTagNum(raw.tags, 10)) * scale;
      const cy = getTagNum(raw.tags, 20) * scale;
      const out = [];
      trackAndPush(out, {
        layer,
        type: 'arc',
        center: roundPt([cx, cy]),
        radius: r,
        start_angle: round9(sa),
        end_angle: round9(ea),
      });
      return out;
    }

    if (raw.type === 'LWPOLYLINE') {
      const ocsNegZ = resolveOcsNegZ(raw.tags, 'LWPOLYLINE');
      const { vertices, closed } = extractLwPolylineVertices(raw.tags, scale, ocsNegZ);
      if (vertices.length < 2) return [];
      const hasBulge = vertices.some(
        (v, idx) => (idx < vertices.length - 1 || closed) && Math.abs(v.bulge) > 1e-7,
      );
      if (!hasBulge) {
        if (closed && vertices.length < 3) return [];
        const out = [];
        trackAndPush(out, {
          layer,
          type: 'polyline',
          points: vertices.map((v) => roundPt(v.pt)),
          closed,
        });
        return out;
      }

      const segCount = closed ? vertices.length : vertices.length - 1;
      const out = [];
      for (let k = 0; k < segCount; k++) {
        const cur = vertices[k];
        const next = vertices[(k + 1) % vertices.length];
        for (const prim of bulgeSegmentToPrimitives(cur.pt, next.pt, cur.bulge)) {
          if (prim.type === 'arc') convertedBulgeArcs += 1;
          trackAndPush(out, { layer, ...prim });
        }
      }
      return out;
    }

    throw new Error(
      `Dosyada desteklenmeyen "${raw.type}" varlığı var. Analitik lazer kesim için yalnızca 2B LINE, ARC, CIRCLE ve LWPOLYLINE kullanın.`,
    );
  }

  for (const raw of rawModelEntities) {
    for (const p of convertRaw(raw)) {
      entities.push(p);
    }
  }

  if (!entities.length) {
    throw new Error(
      'DXF dosyasında kesilebilir 2D geometri (LINE, ARC, CIRCLE, LWPOLYLINE) bulunamadı.',
    );
  }

  const layers = [];
  for (const [key, layerId] of usedLayers.entries()) {
    const meta = layerMeta.get(key);
    const isFrozen = Boolean(meta && (meta.flags & 1) !== 0);
    const isOff = Boolean(meta && Number.isFinite(meta.aci) && meta.aci < 0);
    const isConstruction =
      Boolean(meta && meta.plot === 0) || /^(construction|defpoints|ref)$/i.test(layerId);
    layers.push({
      id: layerId,
      name: layerId,
      color: isConstruction ? '#7c8594' : '#38bdf8',
      visible: !(isFrozen || isOff),
      locked: false,
      ...(isConstruction ? { construction: true } : {}),
    });
  }

  const cleanName =
    String(fileName || 'Sipariş DXF')
      .replace(/\.dxf$/i, '')
      .trim()
      .slice(0, 60) || 'Sipariş DXF';

  const drawing = validateDrawing({
    format: 'cad-lab.drawing',
    schema_version: 1,
    units: 'mm',
    name: cleanName,
    layers,
    entities,
  });

  const cutLayers = cuttingLayerIds(drawing);
  if (
    !drawing.entities.some((e) => cutLayers.has(e.layer) && e.type !== 'dim' && e.type !== 'text')
  ) {
    throw new Error(
      'Görünür kesim katmanlarında kesilebilir geometri yok (öğeler gizli/dondurulmuş veya yardımcı katmanda).',
    );
  }

  return {
    drawing,
    intakeReport: {
      detectedUnits,
      unitAssumedMm,
      scaleToMm: scale,
      entityCount: drawing.entities.length,
      convertedBulgeArcs,
      expandedInserts,
      ignoredAnnotations,
      ignoredPaperSpace,
    },
  };
}

function mergeBbox(a, b) {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

function bboxesNear(a, b, pad = 1.5) {
  return a[0] <= b[2] + pad && a[2] >= b[0] - pad && a[1] <= b[3] + pad && a[3] >= b[1] - pad;
}

function bboxArea(bb) {
  return Math.max(0, bb[2] - bb[0]) * Math.max(0, bb[3] - bb[1]);
}

function bboxCenterDist(bb, pt) {
  const dx = pt[0] < bb[0] ? bb[0] - pt[0] : pt[0] > bb[2] ? pt[0] - bb[2] : 0;
  const dy = pt[1] < bb[1] ? bb[1] - pt[1] : pt[1] > bb[3] ? pt[1] - bb[3] : 0;
  return Math.hypot(dx, dy);
}

function entitySamplePoints(ent) {
  if (ent.type === 'line' || ent.type === 'polyline') {
    const pts = [];
    const n = ent.points.length;
    for (let i = 0; i < n; i++) {
      pts.push(ent.points[i]);
      if (i + 1 < n || ent.closed) {
        const nxt = ent.points[(i + 1) % n];
        pts.push([(ent.points[i][0] + nxt[0]) / 2, (ent.points[i][1] + nxt[1]) / 2]);
      }
    }
    return pts;
  }
  if (ent.type === 'circle') {
    const [cx, cy] = ent.center;
    const r = ent.radius;
    return [
      [cx, cy],
      [cx + r, cy],
      [cx - r, cy],
      [cx, cy + r],
      [cx, cy - r],
    ];
  }
  if (ent.type === 'arc') {
    const { pStart, pMid, pEnd } = arcGeometry(ent);
    return [pStart, pMid, pEnd];
  }
  return [];
}

function pointToSegDist2D(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  if (l2 <= EPS) return distance(p, a);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function pointsNearRootLoop(pts, loop, tol = 1.5) {
  if (!loop) return false;
  if (loop.source === 'circle') {
    return pts.some((p) => Math.abs(distance(p, loop.center) - loop.radius) <= tol);
  }
  return pts.some((p) =>
    loop.edges.some((edge) => {
      if (edge.kind === 'line') return pointToSegDist2D(p, edge.start, edge.end) <= tol;
      if (edge.kind === 'arc') {
        const [cx, cy] = edge.entity.center;
        return Math.abs(Math.hypot(p[0] - cx, p[1] - cy) - edge.entity.radius) <= tol;
      }
      return false;
    }),
  );
}

/**
 * Splits a multi-part DXF drawing into independent validated single-part drawings
 * using Chamfer's analytical loop containment hierarchy without ever dropping cutting entities.
 */
export function splitDrawingIntoParts(drawing) {
  const validated = validateDrawing(drawing);
  const cutLayers = cuttingLayerIds(validated);
  const topo = analyzeDrawingTopology(validated);
  const byId = new Map(validated.entities.map((e) => [e.id, e]));

  const loopToRoot = new Map();
  for (let idx = 0; idx < topo.loops.length; idx++) {
    let curIdx = idx;
    const guard = new Set();
    while (
      topo.loops[curIdx].depth > 0 &&
      topo.loops[curIdx].parent_idx !== null &&
      !guard.has(curIdx)
    ) {
      guard.add(curIdx);
      curIdx = topo.loops[curIdx].parent_idx;
    }
    loopToRoot.set(idx, curIdx);
  }

  const rootClustersByIdx = new Map();
  for (const lp of topo.outer_loops) {
    const origIdx = topo.loops.indexOf(lp);
    rootClustersByIdx.set(origIdx, {
      rootIdx: origIdx,
      rootLoop: lp,
      entityIds: new Set(),
      bbox: [...lp.bbox],
    });
  }
  topo.loops.forEach((lp, idx) => {
    const cluster = rootClustersByIdx.get(loopToRoot.get(idx));
    if (!cluster) return;
    for (const eid of lp.entity_ids) cluster.entityIds.add(eid);
  });

  const activeClusters = [...rootClustersByIdx.values()];
  const rawBadComps = [...topo.open_components, ...topo.branched_components].map((comp) => {
    const ents = comp.entity_ids.map((eid) => byId.get(eid)).filter(Boolean);
    let bb = null;
    const pts = [];
    for (const ent of ents) {
      const eb = entityBbox(ent);
      bb = bb ? mergeBbox(bb, eb) : eb;
      pts.push(...entitySamplePoints(ent));
    }
    return {
      entityIds: new Set(comp.entity_ids),
      bbox: bb || [0, 0, 0, 0],
      pts,
    };
  });

  // 1) Merge any enclosed or overlapping rootLoop (e.g. inner or edge-colliding holes inside an unclosed outer bracket) into the open/branched component.
  const openClusters = [];
  for (const comp of rawBadComps) {
    const compArea = bboxArea(comp.bbox);
    const mergedIndices = [];
    for (let idx = activeClusters.length - 1; idx >= 0; idx--) {
      const rc = activeClusters[idx];
      if (!rc.rootLoop) continue;
      const lp = rc.rootLoop;
      const overlapsOrInside = bboxesNear(lp.bbox, comp.bbox, 0.5);
      const compInsideLoop = comp.pts.every((pt) => pointStrictlyInsideLoop(pt, lp, 1e-4));
      if (overlapsOrInside && compArea > lp.area && !compInsideLoop) {
        mergedIndices.push(idx);
      }
    }
    if (mergedIndices.length > 0) {
      for (const idx of mergedIndices) {
        const [removed] = activeClusters.splice(idx, 1);
        for (const eid of removed.entityIds) comp.entityIds.add(eid);
        comp.bbox = mergeBbox(comp.bbox, removed.bbox);
      }
      openClusters.push({ entityIds: comp.entityIds, rootLoop: null, bbox: comp.bbox });
      continue;
    }

    // 2) Otherwise attach interior/adjacent open geometry to its enclosing rootLoop if inside/touching it.
    let targetCluster = null;
    let bestArea = Infinity;
    for (const rc of activeClusters) {
      if (!rc.rootLoop) continue;
      const inside = comp.pts.some((pt) => pointStrictlyInsideLoop(pt, rc.rootLoop, 1e-4));
      const nearBoundary =
        bboxesNear(comp.bbox, rc.bbox, 1.5) && pointsNearRootLoop(comp.pts, rc.rootLoop, 1.5);
      if ((inside || nearBoundary) && rc.rootLoop.area < bestArea) {
        bestArea = rc.rootLoop.area;
        targetCluster = rc;
      }
    }
    if (targetCluster) {
      for (const eid of comp.entityIds) targetCluster.entityIds.add(eid);
      targetCluster.bbox = mergeBbox(targetCluster.bbox, comp.bbox);
    } else {
      openClusters.push({ entityIds: comp.entityIds, rootLoop: null, bbox: comp.bbox });
    }
  }

  // Merge overlapping open clusters (e.g. a single broken boundary split by 2 corner gaps).
  for (let i = 0; i < openClusters.length; i++) {
    for (let j = i + 1; j < openClusters.length; j++) {
      if (bboxesNear(openClusters[i].bbox, openClusters[j].bbox, 1.5)) {
        for (const eid of openClusters[j].entityIds) openClusters[i].entityIds.add(eid);
        openClusters[i].bbox = mergeBbox(openClusters[i].bbox, openClusters[j].bbox);
        openClusters.splice(j, 1);
        j--;
      }
    }
  }

  const allClusters = [...activeClusters, ...openClusters];
  const assigned = new Set();
  for (const c of allClusters) {
    for (const eid of c.entityIds) assigned.add(eid);
  }

  // Guarantee zero cutting entities can ever be dropped.
  for (const ent of validated.entities) {
    if (assigned.has(ent.id)) continue;
    const isCut = cutLayers.has(ent.layer) && ent.type !== 'dim' && ent.type !== 'text';
    const eb = entityBbox(ent);
    const pt = [(eb[0] + eb[2]) / 2, (eb[1] + eb[3]) / 2];

    let bestCluster = null;
    let bestDist = Infinity;
    for (const c of allClusters) {
      const d = bboxCenterDist(c.bbox, pt);
      if (d < bestDist) {
        bestDist = d;
        bestCluster = c;
      }
    }
    if (bestCluster && (!isCut || bestDist <= 25)) {
      bestCluster.entityIds.add(ent.id);
      if (isCut) bestCluster.bbox = mergeBbox(bestCluster.bbox, eb);
      assigned.add(ent.id);
    } else if (isCut) {
      allClusters.push({ entityIds: new Set([ent.id]), rootLoop: null, bbox: eb });
      assigned.add(ent.id);
    }
  }

  const ordered = allClusters
    .filter((c) => c.entityIds.size > 0)
    .sort((a, b) => a.bbox[0] - b.bbox[0] || bboxArea(b.bbox) - bboxArea(a.bbox));

  if (ordered.length <= 1) {
    return [
      {
        partIndex: 1,
        partId: 'part-1',
        name: validated.name || 'Parça 1',
        drawing: validated,
      },
    ];
  }

  return ordered.map((entry, idx) => {
    const partEntities = [];
    const usedLayerIds = new Set();
    for (const eid of entry.entityIds) {
      const ent = byId.get(eid);
      if (ent) {
        partEntities.push(structuredClone(ent));
        usedLayerIds.add(ent.layer);
      }
    }
    const partLayers = validated.layers
      .filter((l) => usedLayerIds.has(l.id))
      .map((l) => structuredClone(l));
    if (!partLayers.length) {
      partLayers.push(structuredClone(validated.layers[0]));
    }
    const partNum = idx + 1;
    const partDoc = validateDrawing({
      format: 'cad-lab.drawing',
      schema_version: 1,
      units: 'mm',
      name: `${validated.name} #${partNum}`.slice(0, 80),
      layers: partLayers,
      entities: partEntities,
    });
    return {
      partIndex: partNum,
      partId: `part-${partNum}`,
      name: `Parça #${partNum}`,
      drawing: partDoc,
    };
  });
}

function countCuttingSegments(drawing) {
  const cutLayers = cuttingLayerIds(drawing);
  let count = 0;
  for (const ent of drawing.entities || []) {
    if (!cutLayers.has(ent.layer) || ent.type === 'dim' || ent.type === 'text') continue;
    if (ent.type === 'polyline') {
      count += ent.closed ? ent.points.length : Math.max(0, ent.points.length - 1);
    } else {
      count += 1;
    }
  }
  return count;
}

/**
 * Runs iterative deterministic analytical DRC repairs (open gaps, duplicates, thin webs)
 * up to 12 passes on a single part drawing.
 */
export function autoRepairPartDrawing(drawing, thicknessMm = 3.0) {
  let doc = validateDrawing(drawing);
  const appliedFixes = [];

  for (let pass = 0; pass < 12; pass++) {
    const lint = lintDrawing(doc, { manufacturing: true, thicknessMm });
    if (lint.valid && lint.summary.warnings === 0) {
      return { drawing: doc, appliedFixes, lintReport: lint };
    }
    let fixedOne = false;
    for (const issue of lint.issues) {
      const fix = previewDrcFix(doc, issue, { thicknessMm });
      if (fix && fix.nextDoc) {
        doc = fix.nextDoc;
        appliedFixes.push({
          code: issue.code,
          summary: fix.diffSummary,
          shiftMm: fix.shiftMm,
        });
        fixedOne = true;
        break;
      }
    }
    if (!fixedOne) {
      return { drawing: doc, appliedFixes, lintReport: lint };
    }
  }

  return {
    drawing: doc,
    appliedFixes,
    lintReport: lintDrawing(doc, { manufacturing: true, thicknessMm }),
  };
}

/**
 * Evaluates each part's analytical DRC status & CAM metrics and calculates an itemized B2B laser quote.
 */
export function calculateSheetQuote(parts, params = {}, rawTariff = DEFAULT_TARIFF) {
  const tariff = sanitizeTariff(rawTariff);
  const materialId = Object.hasOwn(MATERIALS, params.materialId) ? params.materialId : 'steel_s235';
  const mat = MATERIALS[materialId];
  const thicknessMm = clampFinite(params.thicknessMm, 2.0, 0.5, 50);
  const currency = ['TRY', 'USD', 'EUR'].includes(params.currency) ? params.currency : 'TRY';
  const express = Boolean(params.express);

  const rateTryPerKg = tariff.materialRateOverrides[materialId] ?? mat.rateTryPerKg;
  const speedFactor = mat.cutSpeedFactor * (1 + Math.max(0, thicknessMm - 1.5) * 0.14);
  const pierceMult = mat.pierceFactor * (1 + Math.max(0, thicknessMm - 2.0) * 0.08);
  const scrapFactor = 1 + tariff.scrapMarkupPct / 100;

  let totalQty = 0;
  let totalMassKg = 0;
  let totalCutMeters = 0;
  let totalPierces = 0;
  let materialCostTry = 0;
  let cuttingCostTry = 0;
  let pierceCostTry = 0;
  let allPartsValid = true;
  let warningCount = 0;
  let errorCount = 0;

  const evaluatedParts = parts.map((part) => {
    const qty = Math.max(1, Math.min(10000, Math.round(Number(part.qty) || 1)));
    const segCount = countCuttingSegments(part.drawing);
    if (segCount > MAX_PART_ENTITIES) {
      throw new Error(
        `Parça "${part.name || 'Parça'}" çok karmaşık (${segCount} kesim segmenti > ${MAX_PART_ENTITIES} sınırı); lütfen parçayı sadeleştirin.`,
      );
    }

    const lint = lintDrawing(part.drawing, { manufacturing: true, thicknessMm });
    const cam = computeCamMetrics(part.drawing, thicknessMm);
    const partTopo = analyzeDrawingTopology(part.drawing);

    // Fallback to bbox envelope minus closed internal holes when an outer contour is open/broken so unclosed parts cannot bill ~0 plate mass.
    const envelopeAreaMm2 = cam.bbox_mm[0] * cam.bbox_mm[1];
    let effectiveAreaMm2 = cam.net_area_mm2;
    let massEstimated = false;
    if (
      partTopo.open_components.length > 0 ||
      partTopo.branched_components.length > 0 ||
      partTopo.outer_loops.length === 0
    ) {
      const hasLargeOuterLoop = partTopo.outer_loops.some((o) => o.area > envelopeAreaMm2 * 0.75);
      const holeAreas = partTopo.loops
        .filter((lp) =>
          hasLargeOuterLoop ? lp.depth === 1 : lp.depth === 0 && lp.area < envelopeAreaMm2 * 0.75,
        )
        .reduce((acc, lp) => acc + lp.area, 0);
      const fallbackArea = Math.max(0, envelopeAreaMm2 - holeAreas);
      if (fallbackArea > cam.net_area_mm2 + 1e-3) {
        effectiveAreaMm2 = fallbackArea;
        massEstimated = true;
      }
    }

    const netVolumeCm3 = (effectiveAreaMm2 * thicknessMm) / 1000;
    const unitMassKg = (netVolumeCm3 * mat.densityGCm3) / 1000;
    const unitCutMeters = cam.cut_length_mm / 1000;

    const unitMatTry = unitMassKg * scrapFactor * rateTryPerKg;
    const unitCutTry = unitCutMeters * tariff.cutRateTryPerMeter * speedFactor;
    const unitPierceTry = cam.pierce_count * tariff.pierceTry * pierceMult;
    const unitTotalTry = unitMatTry + unitCutTry + unitPierceTry;

    if (!lint.valid) allPartsValid = false;
    errorCount += lint.summary.errors;
    warningCount += lint.summary.warnings;

    totalQty += qty;
    totalMassKg += unitMassKg * qty;
    totalCutMeters += unitCutMeters * qty;
    totalPierces += cam.pierce_count * qty;
    materialCostTry += unitMatTry * qty;
    cuttingCostTry += unitCutTry * qty;
    pierceCostTry += unitPierceTry * qty;

    return {
      ...part,
      qty,
      lint,
      cam,
      massEstimated,
      unitMassKg: round4(unitMassKg),
      unitCutMeters: round4(unitCutMeters),
      unitPriceTry: round2(unitTotalTry),
      lineTotalTry: round2(unitTotalTry * qty),
    };
  });

  const setupFeeTry = evaluatedParts.length > 0 ? tariff.setupFeeTry : 0;
  const rawProdTry = materialCostTry + cuttingCostTry + pierceCostTry;

  let discountPct = 0;
  if (totalQty >= 100) discountPct = 15;
  else if (totalQty >= 25) discountPct = 10;
  else if (totalQty >= 10) discountPct = 5;

  const discountTry = rawProdTry * (discountPct / 100);
  const afterDiscountTry = rawProdTry - discountTry + setupFeeTry;
  const minFloorApplied = evaluatedParts.length > 0 && afterDiscountTry < tariff.minOrderTry;
  const baseTry = evaluatedParts.length > 0 ? Math.max(tariff.minOrderTry, afterDiscountTry) : 0;
  const expressSurchargeTry = express ? baseTry * (tariff.expressMultiplier - 1) : 0;
  const subtotalTry = baseTry + expressSurchargeTry;
  const vatTry = subtotalTry * (tariff.vatPct / 100);
  const grandTotalTry = subtotalTry + vatTry;

  const fxDiv = currency === 'USD' ? tariff.usdTry : currency === 'EUR' ? tariff.eurTry : 1;

  const conv = (v) => round2(v / fxDiv);

  return {
    currency,
    currencySymbol: currency === 'USD' ? '$' : currency === 'EUR' ? '€' : '₺',
    material: mat,
    thicknessMm,
    express,
    parts: evaluatedParts.map((p) => ({
      ...p,
      unitPriceDisplay: conv(p.unitPriceTry),
      lineTotalDisplay: conv(p.lineTotalTry),
    })),
    summary: {
      partCount: evaluatedParts.length,
      totalQty,
      totalMassKg: round4(totalMassKg),
      totalCutMeters: round4(totalCutMeters),
      totalPierces,
      allPartsValid,
      errorCount,
      warningCount,
      discountPct,
      minFloorApplied,
      materialCost: conv(materialCostTry),
      cuttingCost: conv(cuttingCostTry),
      pierceCost: conv(pierceCostTry),
      setupFee: conv(setupFeeTry),
      discountAmount: conv(discountTry),
      expressSurcharge: conv(expressSurchargeTry),
      subtotal: conv(subtotalTry),
      vatAmount: conv(vatTry),
      grandTotal: conv(grandTotalTry),
      vatPct: tariff.vatPct,
    },
  };
}

function wrapR2010Dxf(entityLines) {
  return [
    '0',
    'SECTION',
    '2',
    'HEADER',
    '9',
    '$ACADVER',
    '1',
    'AC1024',
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
    ...entityLines,
    '0',
    'ENDSEC',
    '0',
    'EOF',
    '',
  ].join('\n');
}

export const DEMO_DXF_PRESETS = Object.freeze({
  multi_part_bulge: {
    id: 'multi_part_bulge',
    labelTr: 'Çoklu Parça + Kavisli Flanş (Bulge DXF)',
    labelEn: 'Multi-Part Sheet + Curved Slot Flange',
    fileName: 'fason-coklu-sac-paket.dxf',
  },
  faulty_bracket: {
    id: 'faulty_bracket',
    labelTr: 'Hatalı Müşteri Çizimi (Otomatik Tamir)',
    labelEn: 'Defective Customer DXF (Auto-Repair)',
    fileName: 'arizali-lazer-braket.dxf',
  },
  nema17_plate: {
    id: 'nema17_plate',
    labelTr: 'NEMA-17 Step Motor Montaj Sacı',
    labelEn: 'NEMA-17 Stepper Mount Plate',
    fileName: 'nema17-motor-flansi.dxf',
  },
});

/**
 * Generates clean realistic ASCII R2010 millimeter DXF payloads for live demos and tests.
 */
export function createDemoDxf(presetId = 'multi_part_bulge') {
  if (presetId === 'faulty_bracket') {
    return wrapR2010Dxf([
      '0',
      'LWPOLYLINE',
      '8',
      '0',
      '90',
      '5',
      '70',
      '0',
      '10',
      '0',
      '20',
      '0',
      '10',
      '110',
      '20',
      '0',
      '10',
      '110',
      '20',
      '65',
      '10',
      '0',
      '20',
      '65',
      '10',
      '0',
      '20',
      '0.7',
      '0',
      'CIRCLE',
      '8',
      '0',
      '10',
      '18',
      '20',
      '32',
      '40',
      '4',
      '0',
      'CIRCLE',
      '8',
      '0',
      '10',
      '108.5',
      '20',
      '32',
      '40',
      '3.5',
    ]);
  }

  if (presetId === 'nema17_plate') {
    const holeCoords = [
      [5.65, 5.65],
      [36.65, 5.65],
      [36.65, 36.65],
      [5.65, 36.65],
    ];
    const holeLines = holeCoords.flatMap(([cx, cy]) => [
      '0',
      'CIRCLE',
      '8',
      '0',
      '10',
      String(cx),
      '20',
      String(cy),
      '40',
      '1.7',
    ]);
    return wrapR2010Dxf([
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
      '42.3',
      '20',
      '0',
      '10',
      '42.3',
      '20',
      '42.3',
      '10',
      '0',
      '20',
      '42.3',
      '0',
      'CIRCLE',
      '8',
      '0',
      '10',
      '21.15',
      '20',
      '21.15',
      '40',
      '11.2',
      ...holeLines,
    ]);
  }

  // multi_part_bulge: Part 1 is an obround stadium flange via exact LWPOLYLINE bulge=1 arcs + 2 M6 bores;
  // Part 2 is a 100x70 rectangular gusset with center Ø24 bore and 4 M5 corner holes.
  return wrapR2010Dxf([
    '0',
    'LWPOLYLINE',
    '8',
    '0',
    '90',
    '4',
    '70',
    '1',
    '10',
    '25',
    '20',
    '0',
    '42',
    '0',
    '10',
    '95',
    '20',
    '0',
    '42',
    '1',
    '10',
    '95',
    '20',
    '50',
    '42',
    '0',
    '10',
    '25',
    '20',
    '50',
    '42',
    '1',
    '0',
    'CIRCLE',
    '8',
    '0',
    '10',
    '25',
    '20',
    '25',
    '40',
    '6',
    '0',
    'CIRCLE',
    '8',
    '0',
    '10',
    '95',
    '20',
    '25',
    '40',
    '6',
    '0',
    'LWPOLYLINE',
    '8',
    '0',
    '90',
    '4',
    '70',
    '1',
    '10',
    '150',
    '20',
    '0',
    '10',
    '250',
    '20',
    '0',
    '10',
    '250',
    '20',
    '70',
    '10',
    '150',
    '20',
    '70',
    '0',
    'CIRCLE',
    '8',
    '0',
    '10',
    '200',
    '20',
    '35',
    '40',
    '12',
    '0',
    'CIRCLE',
    '8',
    '0',
    '10',
    '162',
    '20',
    '12',
    '40',
    '2.6',
    '0',
    'CIRCLE',
    '8',
    '0',
    '10',
    '238',
    '20',
    '12',
    '40',
    '2.6',
    '0',
    'CIRCLE',
    '8',
    '0',
    '10',
    '238',
    '20',
    '58',
    '40',
    '2.6',
    '0',
    'CIRCLE',
    '8',
    '0',
    '10',
    '162',
    '20',
    '58',
    '40',
    '2.6',
  ]);
}
