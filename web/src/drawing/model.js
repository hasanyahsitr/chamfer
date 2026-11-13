// 2D millimeter CAD geometry model. Coordinates live in a planar Y-up world.
import {
  analyzeDrawingTopology,
  arrayPolarEntities,
  arrayRectEntities,
  chamferPolyline,
  chamferTwoLines,
  computeCamMetrics,
  filletPolylineToPrimitives,
  filletTwoLines,
  findAnalyticalSnaps,
  mirrorEntity,
  rotateEntity,
  trimLineEntity,
} from './ops.js';

export { analyzeDrawingTopology, computeCamMetrics, mirrorEntity, rotateEntity };

const LIMIT = 1e6;
const EPS = 1e-6;
const MAX_TOTAL_SEGMENTS = 10000;
const TYPES = new Set(['line', 'polyline', 'circle', 'arc', 'dim', 'text']);
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const clone = (value) => structuredClone(value);
const finite = (value) =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= LIMIT;
export const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const mod360 = (deg) => ((deg % 360) + 360) % 360;

export function arcSweepDeg(startAngle, endAngle) {
  return mod360(endAngle - startAngle);
}

export function arcPointAt(entity, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  return [
    entity.center[0] + entity.radius * Math.cos(rad),
    entity.center[1] + entity.radius * Math.sin(rad),
  ];
}

export function arcFromThreePoints(p1, p2, p3) {
  const [x1, y1] = p1,
    [x2, y2] = p2,
    [x3, y3] = p3;
  const denom = 2 * ((x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3));
  if (Math.abs(denom) <= EPS) throw new Error('Yay noktaları doğrusal (kolineer) olamaz.');
  const s1 = x1 * x1 + y1 * y1 - x3 * x3 - y3 * y3;
  const s2 = x2 * x2 + y2 * y2 - x3 * x3 - y3 * y3;
  const cx = (s1 * (y2 - y3) - s2 * (y1 - y3)) / denom;
  const cy = (s2 * (x1 - x3) - s1 * (x2 - x3)) / denom;
  const radius = Math.hypot(x1 - cx, y1 - cy);
  if (!finite(cx) || !finite(cy) || !finite(radius) || radius <= EPS)
    throw new Error('Hesaplanan yay koordinat sınırlarını aşıyor.');
  const angleAt = (pt) => mod360((Math.atan2(pt[1] - cy, pt[0] - cx) * 180) / Math.PI);
  const a1 = angleAt(p1),
    a2 = angleAt(p2),
    a3 = angleAt(p3);
  const ccw12 = mod360(a2 - a1),
    ccw13 = mod360(a3 - a1);
  const [start_angle, end_angle] = ccw12 < ccw13 ? [a1, a3] : [a3, a1];
  return { center: [cx, cy], radius, start_angle, end_angle };
}

export function dimGeometry(entity) {
  const { p1, p2, dim_point: dp } = entity;
  const span = distance(p1, p2);
  const ux = (p2[0] - p1[0]) / span,
    uy = (p2[1] - p1[1]) / span;
  const nx = -uy,
    ny = ux;
  const signedOffset = (dp[0] - p1[0]) * nx + (dp[1] - p1[1]) * ny;
  const d1 = [p1[0] + signedOffset * nx, p1[1] + signedOffset * ny];
  const d2 = [p2[0] + signedOffset * nx, p2[1] + signedOffset * ny];
  const mid = [(d1[0] + d2[0]) / 2, (d1[1] + d2[1]) / 2];
  let angleDeg = (Math.atan2(uy, ux) * 180) / Math.PI;
  if (angleDeg > 90 || angleDeg <= -90) angleDeg += 180;
  return { p1, p2, d1, d2, mid, span, signedOffset, ux, uy, nx, ny, angleDeg };
}

function signedPolygonArea(pts) {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i],
      [x2, y2] = pts[(i + 1) % pts.length];
    area += x1 * y2 - x2 * y1;
  }
  return area * 0.5;
}

function pointInPolygon(pt, pts) {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i],
      [x2, y2] = pts[(i + 1) % pts.length];
    if (y1 > y !== y2 > y && x < ((x2 - x1) * (y - y1)) / (y2 - y1 || 1e-12) + x1) {
      inside = !inside;
    }
  }
  return inside;
}

function lineIntersection(p1, d1, p2, d2, fallback, maxMiter) {
  const cross = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(cross) <= EPS) return fallback;
  const qpx = p2[0] - p1[0],
    qpy = p2[1] - p1[1];
  const t = (qpx * d2[1] - qpy * d2[0]) / cross;
  const hit = [p1[0] + t * d1[0], p1[1] + t * d1[1]];
  return distance(hit, fallback) > maxMiter ? fallback : hit;
}

export function offsetEntityGeometry(entity, distMm, sidePt) {
  if (!finite(distMm) || distMm <= EPS) throw new Error('Ofset mesafesi pozitif bir sayı olmalı.');
  const next = clone(entity);
  if (entity.type === 'line') {
    const [a, b] = entity.points;
    const len = distance(a, b);
    const ux = (b[0] - a[0]) / len,
      uy = (b[1] - a[1]) / len;
    const nx = -uy,
      ny = ux;
    const side = (sidePt[0] - a[0]) * nx + (sidePt[1] - a[1]) * ny;
    const sign = side < -1e-9 ? -1 : 1;
    next.points = [
      [a[0] + sign * distMm * nx, a[1] + sign * distMm * ny],
      [b[0] + sign * distMm * nx, b[1] + sign * distMm * ny],
    ];
    if (!next.points.every((p) => p.every(finite))) throw new Error('Koordinat sınırı aşıldı.');
    return next;
  }
  if (entity.type === 'circle' || entity.type === 'arc') {
    const radial = distance(sidePt, entity.center);
    const nextR = radial >= entity.radius ? entity.radius + distMm : entity.radius - distMm;
    if (!finite(nextR) || nextR <= EPS)
      throw new Error('Ofset mesafesi iç yarıçaptan büyük olamaz.');
    next.radius = nextR;
    return next;
  }
  if (entity.type === 'polyline') {
    const pts = entity.points;
    const closed = entity.closed;
    const segCount = closed ? pts.length : pts.length - 1;
    const dirs = [],
      normals = [];
    for (let i = 0; i < segCount; i++) {
      const a = pts[i],
        b = pts[(i + 1) % pts.length];
      const len = distance(a, b);
      const ux = (b[0] - a[0]) / len,
        uy = (b[1] - a[1]) / len;
      dirs.push([ux, uy]);
      normals.push([-uy, ux]);
    }
    let sign;
    if (closed) {
      const inside = pointInPolygon(sidePt, pts);
      const ccw = signedPolygonArea(pts) >= 0;
      sign = inside ? (ccw ? 1 : -1) : ccw ? -1 : 1;
    } else {
      let bestIdx = 0,
        bestD = Infinity;
      for (let i = 0; i < segCount; i++) {
        const a = pts[i],
          b = pts[i + 1];
        const dx = b[0] - a[0],
          dy = b[1] - a[1],
          lsq = dx * dx + dy * dy;
        const t = Math.max(
          0,
          Math.min(1, ((sidePt[0] - a[0]) * dx + (sidePt[1] - a[1]) * dy) / lsq),
        );
        const d = distance(sidePt, [a[0] + t * dx, a[1] + t * dy]);
        if (d < bestD) {
          bestD = d;
          bestIdx = i;
        }
      }
      const [nx, ny] = normals[bestIdx],
        a = pts[bestIdx];
      sign = (sidePt[0] - a[0]) * nx + (sidePt[1] - a[1]) * ny < -1e-9 ? -1 : 1;
    }
    const shifted = Array.from({ length: segCount }, (_, i) => [
      pts[i][0] + sign * distMm * normals[i][0],
      pts[i][1] + sign * distMm * normals[i][1],
    ]);
    const maxMiter = 4 * distMm;
    const newPts = [];
    if (closed) {
      for (let i = 0; i < pts.length; i++) {
        const prev = (i - 1 + pts.length) % pts.length;
        newPts.push(
          lineIntersection(shifted[prev], dirs[prev], shifted[i], dirs[i], shifted[i], maxMiter),
        );
      }
    } else {
      newPts.push(shifted[0]);
      for (let i = 1; i < pts.length - 1; i++) {
        newPts.push(
          lineIntersection(shifted[i - 1], dirs[i - 1], shifted[i], dirs[i], shifted[i], maxMiter),
        );
      }
      const last = segCount - 1;
      newPts.push([
        pts.at(-1)[0] + sign * distMm * normals[last][0],
        pts.at(-1)[1] + sign * distMm * normals[last][1],
      ]);
    }
    if (
      !newPts.every((p) => p.every(finite)) ||
      newPts.some((p, i) => i && distance(p, newPts[i - 1]) <= EPS) ||
      (closed && distance(newPts[0], newPts.at(-1)) <= EPS)
    )
      throw new Error('Ofset mesafesi bu çoklu çizgiyi daraltıp çökertiyor.');
    next.points = newPts;
    return next;
  }
  throw new Error('Seçili nesne türü OFFSET desteklemiyor.');
}

export function parseScalar(text) {
  if (!NUMBER.test(text)) throw new Error('Sayıyı ondalık noktayla girin; örnek: 12.5.');
  const value = Number(text);
  if (!finite(value)) throw new Error('Sayı sonlu ve desteklenen aralıkta olmalı.');
  return value;
}

export function parseIntScalar(text) {
  const value = parseScalar(text);
  if (!Number.isInteger(value)) throw new Error('Tam sayı girin; ondalık değer desteklenmiyor.');
  return value;
}

export function emptyDrawing() {
  return {
    format: 'cad-lab.drawing',
    schema_version: 1,
    units: 'mm',
    name: 'Untitled',
    layers: [{ id: '0', name: '0', color: '#d4d8de', visible: true, locked: false }],
    entities: [],
  };
}

export function validateDrawing(input) {
  if (
    !input ||
    input.format !== 'cad-lab.drawing' ||
    input.schema_version !== 1 ||
    input.units !== 'mm'
  )
    throw new Error('Desteklenmeyen çizim dosyası veya birimi.');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80)
    throw new Error('Çizim adı 1–80 karakter olmalı.');
  if (!Array.isArray(input.layers) || !input.layers.length || input.layers.length > 100)
    throw new Error('1–100 katman gerekli.');
  if (!Array.isArray(input.entities) || input.entities.length > 5000)
    throw new Error('En fazla 5000 nesne destekleniyor.');
  const layerIds = new Set();
  const layerNames = new Set();
  for (const layer of input.layers) {
    if (
      typeof layer.id !== 'string' ||
      !layer.id ||
      layerIds.has(layer.id) ||
      typeof layer.name !== 'string' ||
      !layer.name.trim() ||
      layer.name.length > 80 ||
      layerNames.has(layer.name.toLowerCase()) ||
      /[<>/\\":;?*|=\x00-\x1f]/.test(layer.name)
    )
      throw new Error('Katman adları ve kimlikleri geçerli ve benzersiz olmalı.');
    if (
      !/^#[0-9a-f]{6}$/i.test(layer.color) ||
      typeof layer.visible !== 'boolean' ||
      typeof layer.locked !== 'boolean' ||
      (layer.construction !== undefined && typeof layer.construction !== 'boolean')
    )
      throw new Error('Geçersiz katman özellikleri.');
    layerIds.add(layer.id);
    layerNames.add(layer.name.toLowerCase());
  }
  const ids = new Set();
  const point = (p) => Array.isArray(p) && p.length === 2 && p.every(finite);
  let totalSegments = 0;
  for (const entity of input.entities) {
    if (
      typeof entity.id !== 'string' ||
      !entity.id ||
      ids.has(entity.id) ||
      !layerIds.has(entity.layer) ||
      !TYPES.has(entity.type)
    )
      throw new Error('Geçersiz nesne, katman veya nesne kimliği.');
    ids.add(entity.id);
    if (entity.type === 'circle') {
      if (!point(entity.center) || !finite(entity.radius) || entity.radius <= EPS)
        throw new Error('Çember merkezi ve yarıçapı geçersiz.');
    } else if (entity.type === 'arc') {
      if (
        !point(entity.center) ||
        !finite(entity.radius) ||
        entity.radius <= EPS ||
        !finite(entity.start_angle) ||
        !finite(entity.end_angle)
      )
        throw new Error('Yay parametreleri geçersiz.');
      const sweep = arcSweepDeg(entity.start_angle, entity.end_angle);
      if (sweep <= 1e-4 || sweep >= 360 - 1e-4)
        throw new Error('Yay açısı 0° ile 360° arasında olmalı.');
    } else if (entity.type === 'dim') {
      if (
        !point(entity.p1) ||
        !point(entity.p2) ||
        !point(entity.dim_point) ||
        distance(entity.p1, entity.p2) <= EPS
      )
        throw new Error('Ölçü noktaları geçersiz.');
    } else if (entity.type === 'text') {
      if (
        !point(entity.position) ||
        !finite(entity.height) ||
        entity.height < 0.2 ||
        entity.height > 1e4 ||
        (entity.rotation !== undefined && !finite(entity.rotation)) ||
        typeof entity.text !== 'string' ||
        !entity.text.trim() ||
        entity.text.length > 200 ||
        /[\x00-\x1f]/.test(entity.text)
      )
        throw new Error('Metin konumu, yüksekliği veya içeriği geçersiz.');
    } else {
      if (
        !Array.isArray(entity.points) ||
        entity.points.length < 2 ||
        entity.points.length > 1000 ||
        !entity.points.every(point)
      )
        throw new Error('Nesne noktaları geçersiz.');
      if (entity.type === 'line') {
        if (entity.points.length !== 2 || distance(...entity.points) < EPS)
          throw new Error('Çizgi iki farklı nokta gerektirir.');
        totalSegments += 1;
      }
      if (entity.type === 'polyline') {
        if (
          typeof entity.closed !== 'boolean' ||
          (entity.closed && entity.points.length < 3) ||
          entity.points.some((p, i) => i && distance(p, entity.points[i - 1]) < EPS) ||
          (entity.closed && distance(entity.points[0], entity.points.at(-1)) < EPS)
        )
          throw new Error(
            'Çoklu çizgi noktaları farklı olmalı; kapalı çizgi en az üç nokta gerektirir.',
          );
        totalSegments += entity.closed ? entity.points.length : entity.points.length - 1;
      }
      if (totalSegments > MAX_TOTAL_SEGMENTS)
        throw new Error(`En fazla ${MAX_TOTAL_SEGMENTS} toplam çizgi parçası destekleniyor.`);
    }
  }
  const out = clone(input);
  for (const ent of out.entities) {
    if (ent.type === 'text' && ent.rotation === undefined) ent.rotation = 0;
  }
  return out;
}

export function parsePoint(text, base = null) {
  const source = text.trim();
  const relative = source.startsWith('@');
  if (relative && !base)
    throw new Error('Göreli koordinat için önce bir başlangıç noktası belirtin.');
  const value = relative ? source.slice(1) : source;
  let values;
  if (value.includes('<')) {
    const pair = value.split('<');
    if (pair.length !== 2 || !pair.every((part) => NUMBER.test(part)))
      throw new Error('Kutupsal koordinat: @uzunluk<açı. Örnek: @50<90.');
    const [length, angle] = pair.map(Number);
    if (!finite(length) || length < 0 || !finite(angle))
      throw new Error('Kutupsal mesafe ve açı geçersiz.');
    const radians = (angle * Math.PI) / 180;
    values = [length * Math.cos(radians), length * Math.sin(radians)];
  } else {
    const pair = value.split(',').map((part) => part.trim());
    if (pair.length !== 2 || !pair.every((part) => NUMBER.test(part)))
      throw new Error(
        'Koordinatı x,y biçiminde girin; ondalık ayıracı noktadır. Örnek: 100,50 veya @20,0.',
      );
    values = pair.map(Number);
  }
  if (!values.every(finite)) throw new Error('Koordinatlar sonlu sayılar olmalı.');
  const result = values.map((v, i) => v + (relative ? base[i] : 0));
  if (!result.every(finite)) throw new Error('Koordinat sınırı aşıldı.');
  return result;
}

export function translated(entity, delta) {
  const next = clone(entity);
  const shift = (p) => p.map((v, i) => v + delta[i]);
  if (next.type === 'circle' || next.type === 'arc') next.center = shift(next.center);
  else if (next.type === 'dim') {
    next.p1 = shift(next.p1);
    next.p2 = shift(next.p2);
    next.dim_point = shift(next.dim_point);
  } else if (next.type === 'text') {
    next.position = shift(next.position);
  } else next.points = next.points.map(shift);
  return next;
}

export function textBoundsPoints(entity) {
  const [x, y] = entity.position;
  const h = entity.height;
  const w = Math.max(h, entity.text.length * h * 0.6);
  const rad = ((entity.rotation || 0) * Math.PI) / 180;
  const ux = Math.cos(rad),
    uy = Math.sin(rad);
  const nx = -uy,
    ny = ux;
  return [
    [x, y],
    [x + w * ux, y + w * uy],
    [x + w * ux + h * nx, y + w * uy + h * ny],
    [x + h * nx, y + h * ny],
  ];
}

export function entityPoints(entity) {
  if (entity.type === 'circle')
    return [
      entity.center,
      ...[
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ].map((v) => v.map((c, i) => entity.center[i] + c * entity.radius)),
    ];
  if (entity.type === 'arc') {
    const sweep = arcSweepDeg(entity.start_angle, entity.end_angle);
    const pts = [
      entity.center,
      arcPointAt(entity, entity.start_angle),
      arcPointAt(entity, entity.start_angle + sweep / 2),
      arcPointAt(entity, entity.end_angle),
    ];
    for (const cardinal of [0, 90, 180, 270]) {
      if (mod360(cardinal - entity.start_angle) <= sweep + 1e-6) {
        pts.push(arcPointAt(entity, cardinal));
      }
    }
    return pts;
  }
  if (entity.type === 'dim') {
    const g = dimGeometry(entity);
    return [g.p1, g.p2, g.d1, g.d2, g.mid];
  }
  if (entity.type === 'text') {
    return [entity.position];
  }
  const result = [...entity.points];
  const pairs = entity.points.slice(1).map((p, i) => [entity.points[i], p]);
  if (entity.closed) pairs.push([entity.points.at(-1), entity.points[0]]);
  for (const [a, b] of pairs) result.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
  return result;
}

function entitySnapCandidates(entity) {
  if (entity.type === 'circle') {
    return [
      { point: entity.center, kind: 'CEN' },
      ...[
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ].map((v) => ({
        point: v.map((c, i) => entity.center[i] + c * entity.radius),
        kind: 'QUAD',
      })),
    ];
  }
  if (entity.type === 'arc') {
    const sweep = arcSweepDeg(entity.start_angle, entity.end_angle);
    const out = [
      { point: entity.center, kind: 'CEN' },
      { point: arcPointAt(entity, entity.start_angle), kind: 'END' },
      { point: arcPointAt(entity, entity.start_angle + sweep / 2), kind: 'MID' },
      { point: arcPointAt(entity, entity.end_angle), kind: 'END' },
    ];
    for (const cardinal of [0, 90, 180, 270]) {
      if (mod360(cardinal - entity.start_angle) <= sweep + 1e-6) {
        out.push({ point: arcPointAt(entity, cardinal), kind: 'QUAD' });
      }
    }
    return out;
  }
  if (entity.type === 'dim') {
    const g = dimGeometry(entity);
    return [
      { point: g.p1, kind: 'END' },
      { point: g.p2, kind: 'END' },
      { point: g.d1, kind: 'END' },
      { point: g.d2, kind: 'END' },
      { point: g.mid, kind: 'MID' },
    ];
  }
  if (entity.type === 'text') {
    return [{ point: entity.position, kind: 'END' }];
  }
  const out = entity.points.map((p) => ({ point: p, kind: 'END' }));
  const pairs = entity.points.slice(1).map((p, i) => [entity.points[i], p]);
  if (entity.closed) pairs.push([entity.points.at(-1), entity.points[0]]);
  for (const [a, b] of pairs) {
    out.push({ point: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], kind: 'MID' });
  }
  return out;
}

export function snapPointDetailed(point, drawing, tolerance, basePoint = null) {
  let best = null,
    bestDistance = tolerance;
  const visible = new Set(drawing.layers.filter((l) => l.visible).map((l) => l.id));
  for (const entity of drawing.entities) {
    if (!visible.has(entity.layer)) continue;
    for (const cand of entitySnapCandidates(entity)) {
      const d = distance(point, cand.point);
      if (d <= bestDistance) {
        best = cand;
        bestDistance = d;
      }
    }
  }
  for (const cand of findAnalyticalSnaps(point, drawing, tolerance, basePoint)) {
    const d = distance(point, cand.point);
    if (
      d < bestDistance - 1e-5 ||
      (Math.abs(d - bestDistance) <= 1e-5 && cand.kind === 'INT' && best && best.kind !== 'END')
    ) {
      best = cand;
      bestDistance = d;
    }
  }
  return best ? { point: [...best.point], kind: best.kind } : null;
}

export function snapPoint(point, drawing, tolerance, basePoint = null) {
  const hit = snapPointDetailed(point, drawing, tolerance, basePoint);
  return hit ? hit.point : null;
}

export function drawingBounds(drawing) {
  const visible = new Set(drawing.layers.filter((l) => l.visible).map((l) => l.id));
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const entity of drawing.entities) {
    if (!visible.has(entity.layer)) continue;
    const pts =
      entity.type === 'arc'
        ? entityPoints(entity).slice(1)
        : entity.type === 'text'
          ? textBoundsPoints(entity)
          : entityPoints(entity);
    for (const [x, y] of pts) {
      box.minX = Math.min(box.minX, x);
      box.minY = Math.min(box.minY, y);
      box.maxX = Math.max(box.maxX, x);
      box.maxY = Math.max(box.maxY, y);
    }
  }
  return box.minX === Infinity ? { minX: -20, minY: -20, maxX: 180, maxY: 120 } : box;
}

export class DrawingStore {
  constructor(document = emptyDrawing()) {
    this.document = validateDrawing(document);
    this.history = [clone(this.document)];
    this.index = 0;
    this.selection = new Set();
    this.layer = this.document.layers[0].id;
  }
  commit(next) {
    const validated = validateDrawing(next);
    this.document = validated;
    this.history = this.history.slice(0, this.index + 1);
    this.history.push(clone(validated));
    if (this.history.length > 100) this.history.shift();
    this.index = this.history.length - 1;
    this.selection = new Set(
      [...this.selection].filter((id) => validated.entities.some((e) => e.id === id)),
    );
    if (!validated.layers.some((l) => l.id === this.layer)) this.layer = validated.layers[0].id;
  }
  get currentLayer() {
    return this.document.layers.find((l) => l.id === this.layer);
  }
  get canUndo() {
    return this.index > 0;
  }
  get canRedo() {
    return this.index < this.history.length - 1;
  }
  undo() {
    if (this.canUndo) {
      this.document = clone(this.history[--this.index]);
      this.selection.clear();
      this.reconcileLayer();
    }
  }
  redo() {
    if (this.canRedo) {
      this.document = clone(this.history[++this.index]);
      this.selection.clear();
      this.reconcileLayer();
    }
  }
  reconcileLayer() {
    if (!this.document.layers.some((l) => l.id === this.layer))
      this.layer = this.document.layers[0].id;
  }
  add(entity) {
    if (this.currentLayer.locked || !this.currentLayer.visible)
      throw new Error('Etkin katman kilitli veya gizli.');
    const next = clone(this.document);
    next.entities.push({ ...entity, id: entity.id || crypto.randomUUID(), layer: this.layer });
    this.commit(next);
  }
  select(id, additive = false) {
    const entity = this.document.entities.find((e) => e.id === id);
    const layer = entity && this.document.layers.find((l) => l.id === entity.layer);
    if (!additive) this.selection.clear();
    if (entity && layer.visible && !layer.locked) {
      if (additive && this.selection.has(id)) this.selection.delete(id);
      else this.selection.add(id);
    }
  }
  selectedEditable() {
    return this.document.entities.filter(
      (e) =>
        this.selection.has(e.id) &&
        this.document.layers.some((l) => l.id === e.layer && l.visible && !l.locked),
    );
  }
  erase() {
    const ids = new Set(this.selectedEditable().map((e) => e.id));
    if (!ids.size) throw new Error('Önce düzenlenebilir nesneleri seçin.');
    this.commit({
      ...clone(this.document),
      entities: this.document.entities.filter((e) => !ids.has(e.id)),
    });
    this.selection.clear();
  }
  move(delta, copy = false) {
    const selected = this.selectedEditable();
    if (!selected.length) throw new Error('Önce düzenlenebilir nesneleri seçin.');
    if (!copy && delta.every((value) => value === 0)) return;
    const ids = new Set(selected.map((e) => e.id));
    const next = clone(this.document);
    if (copy)
      next.entities.push(
        ...selected.map((e) => ({ ...translated(e, delta), id: crypto.randomUUID() })),
      );
    else next.entities = next.entities.map((e) => (ids.has(e.id) ? translated(e, delta) : e));
    this.commit(next);
  }
  offset(distMm, sidePt) {
    if (this.currentLayer.locked || !this.currentLayer.visible)
      throw new Error('Etkin katman kilitli veya gizli.');
    const selected = this.selectedEditable();
    if (selected.length !== 1) throw new Error('OFFSET için tek bir düzenlenebilir nesne seçin.');
    const created = offsetEntityGeometry(selected[0], distMm, sidePt);
    created.id = crypto.randomUUID();
    created.layer = this.layer;
    const next = clone(this.document);
    next.entities.push(created);
    this.commit(next);
  }
  rotate(basePt, angleDeg) {
    const selected = this.selectedEditable();
    if (!selected.length) throw new Error('Önce düzenlenebilir nesneleri seçin.');
    const ids = new Set(selected.map((e) => e.id));
    const next = clone(this.document);
    next.entities = next.entities.map((e) =>
      ids.has(e.id) ? rotateEntity(e, basePt, angleDeg) : e,
    );
    this.commit(next);
  }
  mirror(axisP1, axisP2, eraseSource = false) {
    const selected = this.selectedEditable();
    if (!selected.length) throw new Error('Önce düzenlenebilir nesneleri seçin.');
    const next = clone(this.document);
    if (eraseSource) {
      const ids = new Set(selected.map((e) => e.id));
      next.entities = next.entities.map((e) =>
        ids.has(e.id) ? mirrorEntity(e, axisP1, axisP2) : e,
      );
    } else {
      for (const src of selected) {
        const reflected = mirrorEntity(src, axisP1, axisP2);
        reflected.id = crypto.randomUUID();
        next.entities.push(reflected);
      }
    }
    this.commit(next);
  }
  chamfer(d1, d2 = d1, explicitIds = null, keepPts = null) {
    if (this.currentLayer.locked || !this.currentLayer.visible)
      throw new Error('Etkin katman kilitli veya gizli.');
    const editableIds = new Set(
      this.document.layers.filter((l) => l.visible && !l.locked).map((l) => l.id),
    );
    const targets = explicitIds
      ? explicitIds.map((id) =>
          this.document.entities.find((e) => e.id === id && editableIds.has(e.layer)),
        )
      : this.selectedEditable();
    if (targets.some((t) => !t) || (targets.length !== 1 && targets.length !== 2))
      throw new Error('CHAMFER için bir çoklu çizgi veya iki çizgi seçin.');
    const next = clone(this.document);
    if (targets.length === 1) {
      if (targets[0].type !== 'polyline')
        throw new Error('Tek nesne CHAMFER yalnızca çoklu çizgi destekler.');
      const updated = chamferPolyline(targets[0], d1, d2);
      next.entities = next.entities.map((e) => (e.id === updated.id ? updated : e));
    } else {
      if (targets[0].type !== 'line' || targets[1].type !== 'line')
        throw new Error('İki nesne CHAMFER iki ayrı çizgi gerektirir.');
      const { line1, line2, bevelPoints } = chamferTwoLines(
        targets[0],
        targets[1],
        d1,
        d2,
        keepPts,
      );
      const map = new Map([
        [line1.id, line1],
        [line2.id, line2],
      ]);
      next.entities = next.entities.map((e) => map.get(e.id) || e);
      next.entities.push({
        id: crypto.randomUUID(),
        layer: this.layer,
        type: 'line',
        points: bevelPoints,
      });
    }
    this.commit(next);
  }
  fillet(radius, explicitIds = null, keepPts = null) {
    if (this.currentLayer.locked || !this.currentLayer.visible)
      throw new Error('Etkin katman kilitli veya gizli.');
    const editableIds = new Set(
      this.document.layers.filter((l) => l.visible && !l.locked).map((l) => l.id),
    );
    const targets = explicitIds
      ? explicitIds.map((id) =>
          this.document.entities.find((e) => e.id === id && editableIds.has(e.layer)),
        )
      : this.selectedEditable();
    if (targets.some((t) => !t) || (targets.length !== 1 && targets.length !== 2))
      throw new Error('FILLET için bir çoklu çizgi veya iki çizgi seçin.');
    const next = clone(this.document);
    if (targets.length === 1) {
      if (targets[0].type !== 'polyline')
        throw new Error('Tek nesne FILLET yalnızca çoklu çizgi destekler.');
      const pieces = filletPolylineToPrimitives(
        targets[0],
        radius,
        crypto.randomUUID().slice(0, 8),
      );
      next.entities = next.entities.flatMap((e) => (e.id === targets[0].id ? pieces : [e]));
    } else {
      if (targets[0].type !== 'line' || targets[1].type !== 'line')
        throw new Error('İki nesne FILLET iki ayrı çizgi gerektirir.');
      const { line1, line2, arcSpec } = filletTwoLines(targets[0], targets[1], radius, keepPts);
      const map = new Map([
        [line1.id, line1],
        [line2.id, line2],
      ]);
      next.entities = next.entities.map((e) => map.get(e.id) || e);
      next.entities.push({
        id: crypto.randomUUID(),
        layer: this.layer,
        type: 'arc',
        ...arcSpec,
      });
    }
    this.commit(next);
  }
  trim(pickPt, explicitLineId = null) {
    const editableIds = new Set(
      this.document.layers.filter((l) => l.visible && !l.locked).map((l) => l.id),
    );
    const visibleIds = new Set(this.document.layers.filter((l) => l.visible).map((l) => l.id));
    let target = null;
    if (explicitLineId) {
      target = this.document.entities.find(
        (e) => e.id === explicitLineId && e.type === 'line' && editableIds.has(e.layer),
      );
    } else {
      const selLines = this.selectedEditable().filter((e) => e.type === 'line');
      if (selLines.length === 1) target = selLines[0];
      else {
        let bestD = Infinity;
        for (const e of this.document.entities) {
          if (e.type !== 'line' || !editableIds.has(e.layer)) continue;
          const [a, b] = e.points;
          const dx = b[0] - a[0],
            dy = b[1] - a[1],
            lsq = dx * dx + dy * dy;
          const t = Math.max(
            0,
            Math.min(1, ((pickPt[0] - a[0]) * dx + (pickPt[1] - a[1]) * dy) / lsq),
          );
          const d = distance(pickPt, [a[0] + t * dx, a[1] + t * dy]);
          if (d < bestD) {
            bestD = d;
            target = e;
          }
        }
      }
    }
    if (!target) throw new Error('TRIM için düzenlenebilir bir çizgi bulunamadı.');
    const cutters = this.document.entities.filter((e) => visibleIds.has(e.layer));
    const survivors = trimLineEntity(target, pickPt, cutters);
    const next = clone(this.document);
    next.entities = next.entities.flatMap((e) => (e.id === target.id ? survivors : [e]));
    this.commit(next);
  }
  arrayPolar(center, count, fillDeg = 360, explicitId = null) {
    const editableIds = new Set(
      this.document.layers.filter((l) => l.visible && !l.locked).map((l) => l.id),
    );
    const src = explicitId
      ? this.document.entities.find((e) => e.id === explicitId && editableIds.has(e.layer))
      : this.selectedEditable()[0];
    if (!src) throw new Error('ARRAY için düzenlenebilir bir nesne seçin.');
    const copies = arrayPolarEntities(src, center, count, fillDeg).map((c) => ({
      ...c,
      id: crypto.randomUUID(),
    }));
    const next = clone(this.document);
    next.entities.push(...copies);
    this.commit(next);
  }
  arrayRect(cols, rows, dx, dy, explicitId = null) {
    const editableIds = new Set(
      this.document.layers.filter((l) => l.visible && !l.locked).map((l) => l.id),
    );
    const src = explicitId
      ? this.document.entities.find((e) => e.id === explicitId && editableIds.has(e.layer))
      : this.selectedEditable()[0];
    if (!src) throw new Error('ARRAY için düzenlenebilir bir nesne seçin.');
    const copies = arrayRectEntities(src, cols, rows, dx, dy, translated).map((c) => ({
      ...c,
      id: crypto.randomUUID(),
    }));
    const next = clone(this.document);
    next.entities.push(...copies);
    this.commit(next);
  }
  addLayer(name, color = '#5aa9e6', construction = false) {
    const next = clone(this.document),
      id = crypto.randomUUID();
    const layer = { id, name, color, visible: true, locked: false };
    if (construction) layer.construction = true;
    next.layers.push(layer);
    this.commit(next);
    this.layer = id;
  }
  activateOrAddLayer(rawSpec) {
    const tokens = rawSpec.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) throw new Error('LAYER bir katman adı gerektirir.');
    let construction = false;
    let color = null;
    const nameTokens = [];
    for (const tok of tokens) {
      if (['CONSTRUCTION', 'REF', 'REFERENCE'].includes(tok.toUpperCase())) {
        construction = true;
      } else if (/^#[0-9a-f]{6}$/i.test(tok) && color === null) {
        color = tok.toLowerCase();
      } else {
        nameTokens.push(tok);
      }
    }
    const name = nameTokens.join(' ').trim();
    if (!name) throw new Error('LAYER bir katman adı gerektirir.');
    const existing = this.document.layers.find((l) => l.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      if (color !== null || construction) {
        const patch = {};
        if (color !== null) patch.color = color;
        if (construction) patch.construction = true;
        this.updateLayer(existing.id, patch);
      }
      this.layer = existing.id;
      return existing.id;
    }
    this.addLayer(name, color || '#5aa9e6', construction);
    return this.layer;
  }
  reset(name = 'Untitled') {
    const doc = emptyDrawing();
    doc.name = (name || 'Untitled').trim() || 'Untitled';
    this.commit(doc);
    this.selection.clear();
    this.layer = this.document.layers[0].id;
  }
  updateLayer(id, patch) {
    const next = clone(this.document);
    next.layers = next.layers.map((l) => (l.id === id ? { ...l, ...patch, id: l.id } : l));
    this.commit(next);
    this.selection = new Set(this.selectedEditable().map((e) => e.id));
  }
}
