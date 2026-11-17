/**
 * Chamfer QuoteGate — Analytical Industrial DXF Intake, Multi-Part Splitter & B2B Laser Quoting Engine.
 * Preserves exact analytical geometry (zero polygon chord approximations).
 */
import { arcSweepDeg, distance, validateDrawing } from '../drawing/model.js';
import {
  analyzeDrawingTopology,
  arcGeometry,
  computeCamMetrics,
  mirrorEntity,
  rotateEntity,
} from '../drawing/ops.js';
import { lintDrawing, previewDrcFix } from '../drawing/linter.js';

const EPS = 1e-6;
const MAX_DXF_BYTES = 2 * 1024 * 1024;
const MAX_INSERT_DEPTH = 8;
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
]);
const REJECTED_CURVES = new Set(['SPLINE', 'ELLIPSE']);

const round4 = (n) => Math.round(n * 1e4) / 1e4;
const round6 = (n) => Math.round(n * 1e6) / 1e6;
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

const INSUNITS_SCALE = new Map([
  [1, { scale: 25.4, label: 'inch' }],
  [2, { scale: 304.8, label: 'feet' }],
  [4, { scale: 1.0, label: 'mm' }],
  [5, { scale: 10.0, label: 'cm' }],
  [6, { scale: 1000.0, label: 'm' }],
]);

/**
 * Analytically converts a DXF LWPOLYLINE bulge segment between p1 and p2 into a line or exact circular arc.
 */
export function bulgeSegmentToArc(p1, p2, bulge) {
  const chord = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
  if (chord <= EPS) return null;

  const b = Number(bulge || 0);
  if (!Number.isFinite(b) || Math.abs(b) <= 1e-7) {
    return { type: 'line', points: [roundPt(p1), roundPt(p2)] };
  }

  const radius = (chord * (1 + b * b)) / (4 * Math.abs(b));
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
  if (sweep <= 1e-4 || sweep >= 360 - 1e-4) {
    return { type: 'line', points: [roundPt(p1), roundPt(p2)] };
  }

  return {
    type: 'arc',
    center: roundPt([cx, cy]),
    radius: round6(radius),
    start_angle: round6(startAngle),
    end_angle: round6(endAngle),
  };
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
    if (code === 0 && val.trim().toUpperCase() === 'EOF') break;
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

function consumeLegacyPolylines(rawStream) {
  const result = [];
  let i = 0;
  while (i < rawStream.length) {
    const cur = rawStream[i];
    if (cur.type === 'POLYLINE') {
      const layerTag = cur.tags.find(([c]) => c === 8);
      const flagsTag = cur.tags.find(([c]) => c === 70);
      const polyFlags = flagsTag ? Number(flagsTag[1].trim()) : 0;
      const isClosed = (polyFlags & 1) !== 0;
      const syntheticTags = [];
      if (layerTag) syntheticTags.push([8, layerTag[1]]);
      syntheticTags.push([70, String(isClosed ? 1 : 0)]);
      const vertices = [];
      i++;
      while (i < rawStream.length && rawStream[i].type !== 'SEQEND') {
        if (rawStream[i].type === 'VERTEX') {
          let vx = 0;
          let vy = 0;
          let vb = 0;
          for (const [c, v] of rawStream[i].tags) {
            const num = Number(v.trim());
            if (c === 10) vx = num;
            else if (c === 20) vy = num;
            else if (c === 42) vb = num;
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

function extractLwPolylineVertices(tags, scale) {
  const rawPts = [];
  let cur = null;
  for (const [c, v] of tags) {
    const num = Number(String(v).trim());
    if (!Number.isFinite(num)) continue;
    if (c === 10) {
      if (cur !== null) rawPts.push(cur);
      cur = { pt: [num * scale, 0], bulge: 0 };
    } else if (c === 20 && cur !== null) {
      cur.pt[1] = num * scale;
    } else if (c === 42 && cur !== null) {
      cur.bulge = num;
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
            const rec = { name: '0', plot: 1, aci: 7 };
            while (i < pairs.length && pairs[i][0] !== 0) {
              const [c, v] = pairs[i];
              if (c === 2) rec.name = sanitizeLayerName(v);
              else if (c === 62) rec.aci = Number(v.trim());
              else if (c === 290) rec.plot = Number(v.trim());
              i++;
            }
            layerMeta.set(rec.name, rec);
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
            while (i < pairs.length && pairs[i][0] !== 0) {
              const [c, v] = pairs[i];
              if (c === 2) blkName = v.trim();
              else if (c === 10) baseX = Number(v.trim()) || 0;
              else if (c === 20) baseY = Number(v.trim()) || 0;
              i++;
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
              blocks.set(blkName, {
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

  const unitEntry = INSUNITS_SCALE.get(insUnits);
  const scale = unitEntry ? unitEntry.scale : 1.0;
  const detectedUnits = unitEntry ? unitEntry.label : 'unitless (mm varsayıldı)';
  const unitAssumedMm = insUnits !== 4;

  let convertedBulgeArcs = 0;
  let expandedInserts = 0;
  let ignoredAnnotations = 0;
  const entities = [];
  const usedLayers = new Set(['0']);

  const translatePt = (p, dx, dy) => [p[0] + dx, p[1] + dy];

  function transformConvertedEntity(ent, tx, ty, sx, sy, rotDeg, blkBase) {
    let cur = structuredClone(ent);
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
    const mirrored = sx * sy < 0;

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
      cur.center = roundPt(translatePt(cur.center, -bx, -by));
      cur.radius = round6(cur.radius * uScale);
      if (sx < 0) cur = mirrorEntity(cur, [0, 0], [0, 1]);
      if (sy < 0) cur = mirrorEntity(cur, [0, 0], [1, 0]);
      if (Math.abs(rotDeg) > 1e-6) cur = rotateEntity(cur, [0, 0], rotDeg);
      cur.center = roundPt(translatePt(cur.center, tx, ty));
      if (mirrored && Math.abs(sx) !== 1) {
        // radius already scaled; keep invariant
      }
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

    const rawLayer = sanitizeLayerName(getTagStr(raw.tags, 8, '0'));
    const layer = rawLayer === '0' && layerOverride ? layerOverride : rawLayer;
    usedLayers.add(layer);

    if (raw.type === 'INSERT') {
      if (depth >= MAX_INSERT_DEPTH) {
        throw new Error(`İç içe INSERT blok derinliği ${MAX_INSERT_DEPTH} sınırını aştı.`);
      }
      const blkName = getTagStr(raw.tags, 2, '');
      const blk = blocks.get(blkName);
      if (!blk) return [];
      const tx = getTagNum(raw.tags, 10, 0) * scale;
      const ty = getTagNum(raw.tags, 20, 0) * scale;
      const sx = getTagNum(raw.tags, 41, 1);
      const sy = getTagNum(raw.tags, 42, 1);
      const rot = getTagNum(raw.tags, 50, 0);
      if (Math.abs(Math.abs(sx) - Math.abs(sy)) > 1e-4) {
        throw new Error(
          `Blok "${blkName}" tekdüze olmayan ölçek (${sx}, ${sy}) içeriyor; dairesel yaylar elipse döneceğinden reddedildi.`,
        );
      }
      expandedInserts += 1;
      const out = [];
      for (const child of blk.entities) {
        for (const conv of convertRaw(child, layer, depth + 1)) {
          out.push({
            ...transformConvertedEntity(conv, tx, ty, sx, sy, rot, blk.basePt),
            id: `qg-${entities.length + out.length + 1}`,
          });
        }
      }
      return out;
    }

    const baseId = `qg-${entities.length + 1}`;
    if (raw.type === 'LINE') {
      const p1 = roundPt([getTagNum(raw.tags, 10) * scale, getTagNum(raw.tags, 20) * scale]);
      const p2 = roundPt([getTagNum(raw.tags, 11) * scale, getTagNum(raw.tags, 21) * scale]);
      if (distance(p1, p2) <= EPS) return [];
      return [{ id: baseId, layer, type: 'line', points: [p1, p2] }];
    }

    if (raw.type === 'CIRCLE') {
      const r = round6(getTagNum(raw.tags, 40) * scale);
      if (r <= EPS) return [];
      return [
        {
          id: baseId,
          layer,
          type: 'circle',
          center: roundPt([getTagNum(raw.tags, 10) * scale, getTagNum(raw.tags, 20) * scale]),
          radius: r,
        },
      ];
    }

    if (raw.type === 'ARC') {
      const r = round6(getTagNum(raw.tags, 40) * scale);
      if (r <= EPS) return [];
      const sa = mod360(getTagNum(raw.tags, 50));
      const ea = mod360(getTagNum(raw.tags, 51));
      const sw = arcSweepDeg(sa, ea);
      if (sw <= 1e-4 || sw >= 360 - 1e-4) return [];
      return [
        {
          id: baseId,
          layer,
          type: 'arc',
          center: roundPt([getTagNum(raw.tags, 10) * scale, getTagNum(raw.tags, 20) * scale]),
          radius: r,
          start_angle: round6(sa),
          end_angle: round6(ea),
        },
      ];
    }

    if (raw.type === 'LWPOLYLINE') {
      const { vertices, closed } = extractLwPolylineVertices(raw.tags, scale);
      if (vertices.length < 2) return [];
      const hasBulge = vertices.some(
        (v, idx) => (idx < vertices.length - 1 || closed) && Math.abs(v.bulge) > 1e-7,
      );
      if (!hasBulge) {
        if (closed && vertices.length < 3) return [];
        return [
          {
            id: baseId,
            layer,
            type: 'polyline',
            points: vertices.map((v) => roundPt(v.pt)),
            closed,
          },
        ];
      }

      const segCount = closed ? vertices.length : vertices.length - 1;
      const converted = [];
      for (let k = 0; k < segCount; k++) {
        const cur = vertices[k];
        const next = vertices[(k + 1) % vertices.length];
        const prim = bulgeSegmentToArc(cur.pt, next.pt, cur.bulge);
        if (!prim) continue;
        if (prim.type === 'arc') convertedBulgeArcs += 1;
        converted.push({
          id: `${baseId}-s${k + 1}`,
          layer,
          ...prim,
        });
      }
      return converted;
    }

    return [];
  }

  for (const raw of rawModelEntities) {
    const pieces = convertRaw(raw);
    for (const p of pieces) {
      if (entities.length >= 4990) {
        throw new Error('DXF içindeki kesim öğesi sayısı 4990 sınırını aşıyor.');
      }
      entities.push({ ...p, id: `qg-${entities.length + 1}` });
    }
  }

  if (!entities.length) {
    throw new Error(
      'DXF dosyasında kesilebilir 2D geometri (LINE, ARC, CIRCLE, LWPOLYLINE) bulunamadı.',
    );
  }

  const seenLayerLower = new Set();
  const layers = [];
  for (const lname of [...usedLayers]) {
    const clean = sanitizeLayerName(lname);
    const key = clean.toLowerCase();
    if (seenLayerLower.has(key)) continue;
    seenLayerLower.add(key);
    const meta = layerMeta.get(clean);
    const isConstruction =
      Boolean(meta && meta.plot === 0) || /^(construction|defpoints|ref)$/i.test(clean);
    layers.push({
      id: clean,
      name: clean,
      color: isConstruction ? '#7c8594' : '#38bdf8',
      visible: true,
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

/**
 * Splits a multi-part DXF drawing into independent validated single-part drawings
 * using Chamfer's analytical loop containment hierarchy.
 */
export function splitDrawingIntoParts(drawing) {
  const validated = validateDrawing(drawing);
  const topo = analyzeDrawingTopology(validated);
  const byId = new Map(validated.entities.map((e) => [e.id, e]));
  const rootLoops = topo.outer_loops;

  const hasOpenOuterBoundary = topo.open_components.some((comp) =>
    comp.entity_ids.some((eid) => {
      const ent = byId.get(eid);
      if (!ent) return false;
      const [ex0, ey0, ex1, ey1] = entityBbox(ent);
      return !rootLoops.some((lp) => {
        const [bx0, by0, bx1, by1] = lp.bbox;
        return ex0 >= bx0 - 1 && ey0 >= by0 - 1 && ex1 <= bx1 + 1 && ey1 <= by1 + 1;
      });
    }),
  );

  if (rootLoops.length <= 1 || hasOpenOuterBoundary) {
    return [
      {
        partIndex: 1,
        partId: 'part-1',
        name: validated.name || 'Parça 1',
        drawing: validated,
      },
    ];
  }

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

  const buckets = new Map();
  rootLoops.forEach((lp) => {
    const origIdx = topo.loops.indexOf(lp);
    buckets.set(origIdx, new Set());
  });

  topo.loops.forEach((lp, idx) => {
    const rootIdx = loopToRoot.get(idx);
    const set = buckets.get(rootIdx);
    if (!set) return;
    for (const eid of lp.entity_ids) set.add(eid);
  });

  const assigned = new Set();
  for (const s of buckets.values()) {
    for (const eid of s) assigned.add(eid);
  }

  // Assign any unassigned open entities inside the padded bbox of their enclosing outer profile.
  for (const ent of validated.entities) {
    if (assigned.has(ent.id) || ent.type === 'dim' || ent.type === 'text') continue;
    const [ex0, ey0, ex1, ey1] = entityBbox(ent);
    const cx = (ex0 + ex1) / 2;
    const cy = (ey0 + ey1) / 2;
    let bestRootIdx = null;
    let bestArea = Infinity;
    for (const [rootIdx, set] of buckets.entries()) {
      const lp = topo.loops[rootIdx];
      const [bx0, by0, bx1, by1] = lp.bbox;
      if (cx >= bx0 - 2 && cx <= bx1 + 2 && cy >= by0 - 2 && cy <= by1 + 2 && lp.area < bestArea) {
        bestArea = lp.area;
        bestRootIdx = rootIdx;
      }
      if (set && bestRootIdx === null && rootIdx >= 0) {
        // fallback tracked below
      }
    }
    if (bestRootIdx !== null) {
      buckets.get(bestRootIdx).add(ent.id);
      assigned.add(ent.id);
    }
  }

  const orderedRoots = [...buckets.entries()]
    .map(([rootIdx, entIds]) => ({
      rootIdx,
      loop: topo.loops[rootIdx],
      entIds,
    }))
    .sort((a, b) => a.loop.bbox[0] - b.loop.bbox[0] || b.loop.area - a.loop.area);

  return orderedRoots.map((entry, idx) => {
    const partEntities = [];
    const usedLayerIds = new Set();
    for (const eid of entry.entIds) {
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
  const tariff = { ...DEFAULT_TARIFF, ...(rawTariff || {}) };
  const materialId = Object.hasOwn(MATERIALS, params.materialId) ? params.materialId : 'steel_s235';
  const mat = MATERIALS[materialId];
  const thicknessMm = Math.max(0.5, Math.min(50, Number(params.thicknessMm) || 2.0));
  const currency = ['TRY', 'USD', 'EUR'].includes(params.currency) ? params.currency : 'TRY';
  const express = Boolean(params.express);

  const overrideRate = Number(tariff.materialRateOverrides?.[materialId]);
  const rateTryPerKg =
    Number.isFinite(overrideRate) && overrideRate > 0 ? overrideRate : mat.rateTryPerKg;
  const speedFactor = mat.cutSpeedFactor * (1 + Math.max(0, thicknessMm - 1.5) * 0.14);
  const pierceMult = mat.pierceFactor * (1 + Math.max(0, thicknessMm - 2.0) * 0.08);
  const scrapFactor = 1 + Math.max(0, Number(tariff.scrapMarkupPct ?? 18)) / 100;

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
    const lint = lintDrawing(part.drawing, { manufacturing: true, thicknessMm });
    const cam = computeCamMetrics(part.drawing, thicknessMm);

    const netVolumeCm3 = (cam.net_area_mm2 * thicknessMm) / 1000;
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
      unitMassKg: round4(unitMassKg),
      unitCutMeters: round4(unitCutMeters),
      unitPriceTry: round2(unitTotalTry),
      lineTotalTry: round2(unitTotalTry * qty),
    };
  });

  const setupFeeTry = evaluatedParts.length > 0 ? Number(tariff.setupFeeTry) || 0 : 0;
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
  const vatTry = subtotalTry * ((Number(tariff.vatPct) || 20) / 100);
  const grandTotalTry = subtotalTry + vatTry;

  const fxDiv =
    currency === 'USD'
      ? Math.max(1, Number(tariff.usdTry) || 35)
      : currency === 'EUR'
        ? Math.max(1, Number(tariff.eurTry) || 38)
        : 1;

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
      vatPct: Number(tariff.vatPct) || 20,
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
