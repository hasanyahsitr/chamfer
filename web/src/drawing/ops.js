// Analytical 2D CAD modification operators, intersections, topology, and live CAM telemetry.
const EPS = 1e-6;
export const CHAIN_TOL_MM = 1e-4;
const DENSITY_AL6061_G_MM3 = 0.0027;
const DENSITY_STEEL_G_MM3 = 0.00785;
const DENSITY_SS304_G_MM3 = 0.008;

const round6 = (v) => Math.round(v * 1e6) / 1e6;
const round3 = (v) => Math.round(v * 1e3) / 1e3;
const round2 = (v) => Math.round(v * 1e2) / 1e2;
const roundPt = (p) => [round6(p[0]), round6(p[1])];
const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const mod360 = (deg) => ((deg % 360) + 360) % 360;

export function cuttingLayerIds(drawing) {
  return new Set(
    (drawing.layers || []).filter((l) => l.visible !== false && !l.construction).map((l) => l.id),
  );
}

export function arcGeometry(entity) {
  const cx = Number(entity.center[0]),
    cy = Number(entity.center[1]);
  const r = Number(entity.radius);
  const sa = mod360(Number(entity.start_angle));
  const ea = mod360(Number(entity.end_angle));
  const sweep = mod360(ea - sa);
  const midDeg = mod360(sa + sweep * 0.5);
  const saR = (sa * Math.PI) / 180;
  const midR = (midDeg * Math.PI) / 180;
  const eaR = (ea * Math.PI) / 180;
  return {
    pStart: [cx + r * Math.cos(saR), cy + r * Math.sin(saR)],
    pMid: [cx + r * Math.cos(midR), cy + r * Math.sin(midR)],
    pEnd: [cx + r * Math.cos(eaR), cy + r * Math.sin(eaR)],
    sweep,
  };
}

function greenLineTerm(p0, p1) {
  return 0.5 * (p0[0] * p1[1] - p1[0] * p0[1]);
}

function greenArcTerm(cx, cy, r, startDeg, sweepDegSigned) {
  const t1 = (startDeg * Math.PI) / 180;
  const dt = (sweepDegSigned * Math.PI) / 180;
  const t2 = t1 + dt;
  return (
    0.5 *
    (r * r * dt + cx * r * (Math.sin(t2) - Math.sin(t1)) - cy * r * (Math.cos(t2) - Math.cos(t1)))
  );
}

export function chainSignedArea(edges) {
  let total = 0;
  for (const edge of edges) {
    if (edge.kind === 'line') {
      total += greenLineTerm(edge.start, edge.end);
    } else if (edge.kind === 'arc') {
      const ent = edge.entity;
      const cx = Number(ent.center[0]),
        cy = Number(ent.center[1]);
      const r = Number(ent.radius);
      const sa = mod360(Number(ent.start_angle));
      const ea = mod360(Number(ent.end_angle));
      const sweep = mod360(ea - sa);
      total += edge.forward
        ? greenArcTerm(cx, cy, r, sa, sweep)
        : greenArcTerm(cx, cy, r, ea, -sweep);
    }
  }
  return total;
}

export function angleOnArcDeg(angDeg, saDeg, eaDeg, tolDeg = 1e-4) {
  const sweep = mod360(eaDeg - saDeg);
  const rel = mod360(angDeg - saDeg);
  return rel <= sweep + tolDeg || rel >= 360 - tolDeg;
}

export function arcOverlapSpanDeg(a1, a2) {
  const sa1 = mod360(Number(a1.start_angle)),
    ea1 = mod360(Number(a1.end_angle));
  const sa2 = mod360(Number(a2.start_angle)),
    ea2 = mod360(Number(a2.end_angle));
  const sw1 = mod360(ea1 - sa1),
    sw2 = mod360(ea2 - sa2);
  const intervals = (sa, sw) =>
    sa + sw <= 360
      ? [[sa, sa + sw]]
      : [
          [sa, 360],
          [0, sa + sw - 360],
        ];
  let overlap = 0,
    midDeg = sa1;
  for (const [l1, r1] of intervals(sa1, sw1)) {
    for (const [l2, r2] of intervals(sa2, sw2)) {
      const lo = Math.max(l1, l2),
        hi = Math.min(r1, r2);
      if (hi - lo > 1e-3) {
        overlap += hi - lo;
        midDeg = (lo + hi) * 0.5;
      }
    }
  }
  return { overlap, midDeg };
}

function pointToSegDistAndProj(pt, a, b) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const lsq = dx * dx + dy * dy;
  if (lsq <= EPS * EPS) return { dist: dist(pt, a), proj: [...a] };
  const t = Math.max(0, Math.min(1, ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / lsq));
  const proj = [a[0] + t * dx, a[1] + t * dy];
  return { dist: dist(pt, proj), proj };
}

function pointToSegDist(pt, a, b) {
  return pointToSegDistAndProj(pt, a, b).dist;
}

export function pointToArcDistAndProj(pt, arcEnt) {
  const cx = Number(arcEnt.center[0]),
    cy = Number(arcEnt.center[1]);
  const r = Number(arcEnt.radius);
  const sa = mod360(Number(arcEnt.start_angle)),
    ea = mod360(Number(arcEnt.end_angle));
  const { pStart, pEnd } = arcGeometry(arcEnt);
  const cands = [pStart, pEnd];
  const dx = pt[0] - cx,
    dy = pt[1] - cy;
  const dCenter = Math.hypot(dx, dy);
  if (dCenter > EPS) {
    const rayDeg = mod360((Math.atan2(dy, dx) * 180) / Math.PI);
    if (angleOnArcDeg(rayDeg, sa, ea, 1e-6)) {
      const rad = (rayDeg * Math.PI) / 180;
      cands.push([cx + r * Math.cos(rad), cy + r * Math.sin(rad)]);
    }
  }
  let near = cands[0],
    minD = dist(pt, near);
  for (let i = 1; i < cands.length; i++) {
    const d = dist(pt, cands[i]);
    if (d < minD) {
      minD = d;
      near = cands[i];
    }
  }
  return { dist: minD, proj: near };
}

export function segSegHits(a1, a2, b1, b2, excludePts = []) {
  const rx = a2[0] - a1[0],
    ry = a2[1] - a1[1];
  const sx = b2[0] - b1[0],
    sy = b2[1] - b1[1];
  const lenA = Math.hypot(rx, ry),
    lenB = Math.hypot(sx, sy);
  if (lenA <= EPS || lenB <= EPS) return [];
  const denom = rx * sy - ry * sx;
  const hits = [];
  if (Math.abs(denom) <= 1e-9 * lenA * lenB) {
    const ux = rx / lenA,
      uy = ry / lenA;
    if (
      Math.abs((b1[0] - a1[0]) * uy - (b1[1] - a1[1]) * ux) <= 1e-4 &&
      Math.abs((b2[0] - a1[0]) * uy - (b2[1] - a1[1]) * ux) <= 1e-4
    ) {
      const tb1 = (b1[0] - a1[0]) * ux + (b1[1] - a1[1]) * uy;
      const tb2 = (b2[0] - a1[0]) * ux + (b2[1] - a1[1]) * uy;
      const lo = Math.max(0, Math.min(tb1, tb2));
      const hi = Math.min(lenA, Math.max(tb1, tb2));
      if (hi - lo > 1e-4) {
        const mid = 0.5 * (lo + hi);
        return [[a1[0] + mid * ux, a1[1] + mid * uy]];
      }
      if (hi - lo > -1e-5) {
        const mid = 0.5 * (lo + hi);
        hits.push([a1[0] + mid * ux, a1[1] + mid * uy]);
      }
    }
  } else {
    const qpx = b1[0] - a1[0],
      qpy = b1[1] - a1[1];
    const t = (qpx * sy - qpy * sx) / denom;
    const u = (qpx * ry - qpy * rx) / denom;
    const tolT = 1e-5 / lenA,
      tolU = 1e-5 / lenB;
    if (t >= -tolT && t <= 1 + tolT && u >= -tolU && u <= 1 + tolU) {
      const tc = Math.max(0, Math.min(1, t));
      hits.push([a1[0] + tc * rx, a1[1] + tc * ry]);
    }
  }
  return hits.filter((pt) => !excludePts.some((ex) => dist(pt, ex) <= 1e-4));
}

export function segCircleHits(a, b, center, radius, arcEnt = null, excludePts = []) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const qa = dx * dx + dy * dy;
  if (qa <= EPS * EPS) return [];
  const lenAb = Math.sqrt(qa);
  const [cx, cy] = center;
  const fx = a[0] - cx,
    fy = a[1] - cy;
  const qb = 2 * (fx * dx + fy * dy);
  const qc = fx * fx + fy * fy - radius * radius;
  const disc = qb * qb - 4 * qa * qc;
  const hits = [];
  if (disc >= -1e-7 * qa) {
    const sqrtD = Math.sqrt(Math.max(0, disc));
    const tolT = 1e-5 / lenAb;
    for (const sign of [-1, 1]) {
      const t = (-qb + sign * sqrtD) / (2 * qa);
      if (t >= -tolT && t <= 1 + tolT) {
        const tc = Math.max(0, Math.min(1, t));
        const pt = [a[0] + tc * dx, a[1] + tc * dy];
        if (!hits.some((h) => dist(pt, h) <= 1e-5)) hits.push(pt);
      }
    }
  } else {
    const { dist: minD, proj } = pointToSegDistAndProj(center, a, b);
    if (Math.abs(minD - radius) <= 1e-4) hits.push(proj);
  }
  const out = [];
  for (const pt of hits) {
    if (excludePts.some((ex) => dist(pt, ex) <= 1e-4)) continue;
    if (arcEnt !== null && pointToArcDistAndProj(pt, arcEnt).dist > 1e-4) continue;
    out.push(pt);
  }
  return out;
}

export function circleCircleHits(c1, r1, c2, r2, arc1 = null, arc2 = null, excludePts = []) {
  const [x1, y1] = c1,
    [x2, y2] = c2;
  const r1f = Number(r1),
    r2f = Number(r2);
  const dx = x2 - x1,
    dy = y2 - y1;
  const d = Math.hypot(dx, dy);
  const hits = [];
  if (d <= 1e-5) {
    if (Math.abs(r1f - r2f) <= 1e-4) {
      if (arc1 !== null && arc2 !== null) {
        const { overlap, midDeg } = arcOverlapSpanDeg(arc1, arc2);
        if (overlap > 1e-4) {
          const rad = (midDeg * Math.PI) / 180;
          return [[x1 + r1f * Math.cos(rad), y1 + r1f * Math.sin(rad)]];
        } else {
          const { pStart: ps1, pEnd: pe1 } = arcGeometry(arc1);
          const { pStart: ps2, pEnd: pe2 } = arcGeometry(arc2);
          for (const pa of [ps1, pe1]) {
            for (const pb of [ps2, pe2]) {
              if (dist(pa, pb) <= 1e-4) hits.push([0.5 * (pa[0] + pb[0]), 0.5 * (pa[1] + pb[1])]);
            }
          }
        }
      } else if (arc1 !== null) {
        hits.push(arcGeometry(arc1).pMid);
      } else if (arc2 !== null) {
        hits.push(arcGeometry(arc2).pMid);
      } else {
        hits.push([x1 + r1f, y1]);
      }
    }
  } else {
    const rSum = r1f + r2f;
    const rDiff = Math.abs(r1f - r2f);
    if (d <= rSum + 1e-4 && d >= rDiff - 1e-4) {
      const a = (r1f * r1f - r2f * r2f + d * d) / (2 * d);
      const hSq = r1f * r1f - a * a;
      const h = hSq > 0 ? Math.sqrt(hSq) : 0;
      const ux = dx / d,
        uy = dy / d;
      const px = x1 + a * ux,
        py = y1 + a * uy;
      if (h <= 1e-6) {
        hits.push([px, py]);
      } else {
        hits.push([px - h * uy, py + h * ux]);
        hits.push([px + h * uy, py - h * ux]);
      }
    }
  }
  const out = [];
  for (const pt of hits) {
    if (excludePts.some((ex) => dist(pt, ex) <= 1e-4)) continue;
    if (arc1 !== null && pointToArcDistAndProj(pt, arc1).dist > 1e-4) continue;
    if (arc2 !== null && pointToArcDistAndProj(pt, arc2).dist > 1e-4) continue;
    if (!out.some((h) => dist(pt, h) <= 1e-5)) out.push(pt);
  }
  return out;
}

export function arcArcMinDistance(a1, a2) {
  const hits = circleCircleHits(a1.center, a1.radius, a2.center, a2.radius, a1, a2);
  if (hits.length) return { minDist: 0, midPoint: hits[0] };

  const c1 = [Number(a1.center[0]), Number(a1.center[1])];
  const c2 = [Number(a2.center[0]), Number(a2.center[1])];
  const r1 = Number(a1.radius),
    r2 = Number(a2.radius);
  const { pStart: ps1, pEnd: pe1 } = arcGeometry(a1);
  const { pStart: ps2, pEnd: pe2 } = arcGeometry(a2);

  let bestD = Infinity,
    bestMid = [0, 0];
  const consider = (p1, p2) => {
    const d = dist(p1, p2);
    if (d < bestD) {
      bestD = d;
      bestMid = [0.5 * (p1[0] + p2[0]), 0.5 * (p1[1] + p2[1])];
    }
  };

  for (const pt1 of [ps1, pe1]) {
    const { proj } = pointToArcDistAndProj(pt1, a2);
    consider(pt1, proj);
  }
  for (const pt2 of [ps2, pe2]) {
    const { proj } = pointToArcDistAndProj(pt2, a1);
    consider(pt2, proj);
  }

  const dx = c2[0] - c1[0],
    dy = c2[1] - c1[1];
  const dCenters = Math.hypot(dx, dy);
  if (dCenters > EPS) {
    const ang12 = mod360((Math.atan2(dy, dx) * 180) / Math.PI);
    const ang21 = mod360(ang12 + 180);
    for (const aDeg1 of [ang12, ang21]) {
      if (!angleOnArcDeg(aDeg1, Number(a1.start_angle), Number(a1.end_angle))) continue;
      const rad1 = (aDeg1 * Math.PI) / 180;
      const p1 = [c1[0] + r1 * Math.cos(rad1), c1[1] + r1 * Math.sin(rad1)];
      for (const aDeg2 of [ang12, ang21]) {
        if (!angleOnArcDeg(aDeg2, Number(a2.start_angle), Number(a2.end_angle))) continue;
        const rad2 = (aDeg2 * Math.PI) / 180;
        const p2 = [c2[0] + r2 * Math.cos(rad2), c2[1] + r2 * Math.sin(rad2)];
        consider(p1, p2);
      }
    }
  }
  return { minDist: bestD, midPoint: bestMid };
}

export function pointOnLoopBoundary(pt, loop, tol = 1e-4) {
  if (loop.source === 'circle') {
    return Math.abs(dist(pt, loop.center) - loop.radius) <= tol;
  }
  for (const edge of loop.edges) {
    if (edge.kind === 'line') {
      if (pointToSegDist(pt, edge.start, edge.end) <= tol) return true;
    } else if (edge.kind === 'arc') {
      if (pointToArcDistAndProj(pt, edge.entity).dist <= tol) return true;
    }
  }
  return false;
}

export function pointStrictlyInsideLoop(pt, loop, tol = 1e-4) {
  const [bx0, by0, bx1, by1] = loop.bbox;
  if (pt[0] <= bx0 + tol || pt[0] >= bx1 - tol || pt[1] <= by0 + tol || pt[1] >= by1 - tol)
    return false;
  if (loop.source === 'circle') {
    return dist(pt, loop.center) < loop.radius - tol;
  }
  if (pointOnLoopBoundary(pt, loop, tol)) return false;

  const critYs = [];
  for (const edge of loop.edges) {
    critYs.push(edge.start[1], edge.end[1]);
    if (edge.kind === 'arc') {
      const cy = Number(edge.entity.center[1]);
      const r = Number(edge.entity.radius);
      critYs.push(cy - r, cy + r);
    }
  }

  const maxShift = tol * 0.25;
  let yRay = pt[1];
  for (let step = 0; step < 33; step++) {
    const sign = step % 2 === 1 ? 1 : -1;
    const cand = pt[1] + sign * Math.floor((step + 1) / 2) * (maxShift / 17);
    if (critYs.every((cyVal) => Math.abs(cand - cyVal) > 1e-9)) {
      yRay = cand;
      break;
    }
  }

  let crossings = 0;
  const x0 = pt[0];
  for (const edge of loop.edges) {
    if (edge.kind === 'line') {
      const [x1, y1] = edge.start,
        [x2, y2] = edge.end;
      if (y1 > yRay !== y2 > yRay) {
        const xHit = x1 + ((yRay - y1) * (x2 - x1)) / (y2 - y1);
        if (xHit > x0) crossings += 1;
      }
    } else if (edge.kind === 'arc') {
      const ent = edge.entity;
      const cx = Number(ent.center[0]),
        cy = Number(ent.center[1]);
      const r = Number(ent.radius);
      const sa = mod360(Number(ent.start_angle)),
        ea = mod360(Number(ent.end_angle));
      const dy = yRay - cy;
      if (Math.abs(dy) >= r) continue;
      const dx = Math.sqrt(Math.max(0, r * r - dy * dy));
      for (const sgn of [-1, 1]) {
        const xHit = cx + sgn * dx;
        if (xHit <= x0) continue;
        const angDeg = mod360((Math.atan2(dy, sgn * dx) * 180) / Math.PI);
        if (angleOnArcDeg(angDeg, sa, ea, 0)) crossings += 1;
      }
    }
  }
  return crossings % 2 === 1;
}

function loopBbox(loop) {
  if (loop.source === 'circle') {
    const [cx, cy] = loop.center;
    const r = loop.radius;
    return [cx - r, cy - r, cx + r, cy + r];
  }
  const xs = [],
    ys = [];
  for (const edge of loop.edges) {
    xs.push(edge.start[0], edge.end[0]);
    ys.push(edge.start[1], edge.end[1]);
    if (edge.kind === 'arc') {
      const ent = edge.entity;
      const [cx, cy] = ent.center;
      const r = ent.radius;
      const sa = mod360(ent.start_angle);
      const sweep = mod360(ent.end_angle - sa);
      if (edge.mid) {
        xs.push(edge.mid[0]);
        ys.push(edge.mid[1]);
      }
      for (const q of [0, 90, 180, 270]) {
        if (mod360(q - sa) <= sweep + 1e-6) {
          xs.push(cx + r * Math.cos((q * Math.PI) / 180));
          ys.push(cy + r * Math.sin((q * Math.PI) / 180));
        }
      }
    }
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function edgeEdgeHits(e1, e2, excludePts = []) {
  if (e1.kind === 'line' && e2.kind === 'line') {
    return segSegHits(e1.start, e1.end, e2.start, e2.end, excludePts);
  }
  if (e1.kind === 'line' && e2.kind === 'arc') {
    const a = e2.entity;
    return segCircleHits(e1.start, e1.end, a.center, Number(a.radius), a, excludePts);
  }
  if (e1.kind === 'arc' && e2.kind === 'line') {
    const a = e1.entity;
    return segCircleHits(e2.start, e2.end, a.center, Number(a.radius), a, excludePts);
  }
  const a1 = e1.entity,
    a2 = e2.entity;
  return circleCircleHits(
    a1.center,
    Number(a1.radius),
    a2.center,
    Number(a2.radius),
    a1,
    a2,
    excludePts,
  );
}

function chainedLoopSelfHit(edges) {
  const n = edges.length;
  for (const edge of edges) {
    if (edge.kind === 'line' && dist(edge.start, edge.end) <= 1e-4) {
      return [...edge.start];
    }
  }
  for (let i = 0; i < n; i++) {
    const e1 = edges[i];
    for (let j = i + 1; j < n; j++) {
      const e2 = edges[j];
      const shared = [];
      if (j === i + 1) shared.push(e1.end);
      if (i === 0 && j === n - 1) shared.push(e1.start);
      const hits = edgeEdgeHits(e1, e2, shared);
      if (hits.length) return hits[0];
    }
  }
  return null;
}

export function loopsIntersect(la, lb) {
  const [ax0, ay0, ax1, ay1] = la.bbox;
  const [bx0, by0, bx1, by1] = lb.bbox;
  if (ax1 < bx0 - 1e-4 || bx1 < ax0 - 1e-4 || ay1 < by0 - 1e-4 || by1 < ay0 - 1e-4) {
    return { hit: false, point: null };
  }
  if (la.source === 'circle' && lb.source === 'circle') {
    const hits = circleCircleHits(la.center, la.radius, lb.center, lb.radius);
    return hits.length ? { hit: true, point: hits[0] } : { hit: false, point: null };
  }
  if (la.source === 'circle') {
    for (const edge of lb.edges) {
      const hits =
        edge.kind === 'line'
          ? segCircleHits(edge.start, edge.end, la.center, la.radius)
          : circleCircleHits(
              la.center,
              la.radius,
              edge.entity.center,
              Number(edge.entity.radius),
              null,
              edge.entity,
            );
      if (hits.length) return { hit: true, point: hits[0] };
    }
    return { hit: false, point: null };
  }
  if (lb.source === 'circle') {
    return loopsIntersect(lb, la);
  }
  for (const e1 of la.edges) {
    for (const e2 of lb.edges) {
      const hits = edgeEdgeHits(e1, e2);
      if (hits.length) return { hit: true, point: hits[0] };
    }
  }
  return { hit: false, point: null };
}

function ptLessOrEq(a, b) {
  return a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]);
}

function cmpTuple(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

function canonicalEdgeSortKey(edge) {
  const { p0, p1 } = edge;
  const [lo, hi] = ptLessOrEq(p0, p1) ? [p0, p1] : [p1, p0];
  const mid = edge.mid || [(p0[0] + p1[0]) * 0.5, (p0[1] + p1[1]) * 0.5];
  const r5 = (v) => Math.round(v * 1e5) / 1e5;
  return [r5(lo[0]), r5(lo[1]), r5(hi[0]), r5(hi[1]), edge.kind, r5(mid[0]), r5(mid[1])];
}

export function analyzeDrawingTopology(drawing, chainTol = CHAIN_TOL_MM) {
  const cutLayers = cuttingLayerIds(drawing);
  const cuttingEntities = (drawing.entities || []).filter(
    (e) => cutLayers.has(e.layer) && e.type !== 'dim' && e.type !== 'text',
  );

  const loops = [];
  const graphPrimitives = [];
  const branchedComponents = [];

  for (const ent of cuttingEntities) {
    if (ent.type === 'circle') {
      const cx = Number(ent.center[0]),
        cy = Number(ent.center[1]);
      const r = Number(ent.radius);
      const loop = {
        source: 'circle',
        center: [cx, cy],
        radius: r,
        area: Math.PI * r * r,
        perimeter: 2 * Math.PI * r,
        entity_ids: [ent.id],
        edges: [],
        rep_point: [cx + r, cy],
      };
      loop.bbox = loopBbox(loop);
      loops.push(loop);
    } else if (ent.type === 'polyline' && ent.closed) {
      const pts = ent.points.map((p) => [Number(p[0]), Number(p[1])]);
      const edges = pts.map((pt, i) => ({
        kind: 'line',
        start: pt,
        mid: null,
        end: pts[(i + 1) % pts.length],
        entity: ent,
        forward: true,
      }));
      const selfHit = chainedLoopSelfHit(edges);
      if (selfHit !== null) {
        branchedComponents.push({
          entity_ids: [ent.id],
          junction_points: [[...selfHit]],
          reason: 'self_intersecting_loop',
        });
        continue;
      }
      const area = Math.abs(chainSignedArea(edges));
      if (area <= 1e-4) {
        branchedComponents.push({
          entity_ids: [ent.id],
          junction_points: [pts.length ? [...pts[0]] : [0, 0]],
          reason: 'zero_area_degenerate_loop',
        });
        continue;
      }
      const perim = edges.reduce((s, e) => s + dist(e.start, e.end), 0);
      const loop = {
        source: 'polyline',
        points: pts,
        area,
        perimeter: perim,
        entity_ids: [ent.id],
        edges,
        rep_point: pts[0],
      };
      loop.bbox = loopBbox(loop);
      loops.push(loop);
    } else if (ent.type === 'polyline' && !ent.closed) {
      const pts = ent.points.map((p) => [Number(p[0]), Number(p[1])]);
      for (let i = 0; i < pts.length - 1; i++) {
        graphPrimitives.push({
          kind: 'line',
          p0: pts[i],
          mid: null,
          p1: pts[i + 1],
          length: dist(pts[i], pts[i + 1]),
          entity: ent,
          entity_id: ent.id,
        });
      }
    } else if (ent.type === 'line') {
      const p0 = [Number(ent.points[0][0]), Number(ent.points[0][1])];
      const p1 = [Number(ent.points[1][0]), Number(ent.points[1][1])];
      graphPrimitives.push({
        kind: 'line',
        p0,
        mid: null,
        p1,
        length: dist(p0, p1),
        entity: ent,
        entity_id: ent.id,
      });
    } else if (ent.type === 'arc') {
      const { pStart, pMid, pEnd, sweep } = arcGeometry(ent);
      graphPrimitives.push({
        kind: 'arc',
        p0: pStart,
        mid: pMid,
        p1: pEnd,
        length: Number(ent.radius) * ((sweep * Math.PI) / 180),
        entity: ent,
        entity_id: ent.id,
      });
    }
  }

  const sortedPrims = [...graphPrimitives]
    .map((p) => ({ p, key: canonicalEdgeSortKey(p) }))
    .sort((a, b) => cmpTuple(a.key, b.key))
    .map((x) => x.p);

  const rawEndpoints = [];
  sortedPrims.forEach((prim, idx) => {
    rawEndpoints.push({
      rx: round6(prim.p0[0]),
      ry: round6(prim.p0[1]),
      pt: prim.p0,
      pIdx: idx,
      slot: 0,
    });
    rawEndpoints.push({
      rx: round6(prim.p1[0]),
      ry: round6(prim.p1[1]),
      pt: prim.p1,
      pIdx: idx,
      slot: 1,
    });
  });
  rawEndpoints.sort((a, b) => (a.rx !== b.rx ? a.rx - b.rx : a.ry - b.ry));

  const vertices = [];
  const primV = sortedPrims.map(() => [null, null]);
  for (const item of rawEndpoints) {
    let matchedV = null;
    let bestD = chainTol;
    for (let vIdx = 0; vIdx < vertices.length; vIdx++) {
      const d = dist(item.pt, vertices[vIdx]);
      if (d <= bestD) {
        bestD = d;
        matchedV = vIdx;
      }
    }
    if (matchedV === null) {
      matchedV = vertices.length;
      vertices.push([item.pt[0], item.pt[1]]);
    }
    primV[item.pIdx][item.slot] = matchedV;
  }

  const adj = vertices.map(() => []);
  primV.forEach(([u, v], pIdx) => {
    adj[u].push([v, pIdx]);
    if (u !== v) adj[v].push([u, pIdx]);
    else adj[u].push([u, pIdx]);
  });

  const visitedV = new Array(vertices.length).fill(false);
  const openComponents = [];

  for (let startV = 0; startV < vertices.length; startV++) {
    if (visitedV[startV] || !adj[startV].length) continue;
    const compV = [];
    const compE = new Set();
    const queue = [startV];
    visitedV[startV] = true;
    while (queue.length) {
      const curr = queue.pop();
      compV.push(curr);
      for (const [nxt, eIdx] of adj[curr]) {
        compE.add(eIdx);
        if (!visitedV[nxt]) {
          visitedV[nxt] = true;
          queue.push(nxt);
        }
      }
    }

    const eIds = [...new Set([...compE].map((eIdx) => sortedPrims[eIdx].entity_id))].sort();
    const highDeg = compV.filter((v) => adj[v].length > 2);
    if (highDeg.length > 0) {
      branchedComponents.push({
        entity_ids: eIds,
        junction_points: highDeg.map((v) => [...vertices[v]]),
        reason: 'branch_junction',
      });
      continue;
    }

    if (compV.some((v) => adj[v].length !== 2)) {
      const endPts = compV.filter((v) => adj[v].length === 1).map((v) => [...vertices[v]]);
      openComponents.push({
        entity_ids: eIds,
        endpoints: endPts,
      });
      continue;
    }

    let originV = compV[0];
    for (const v of compV.slice(1)) {
      if (cmpTuple(vertices[v], vertices[originV]) < 0) originV = v;
    }
    const orderedEdges = [];
    const usedCompE = new Set();
    let currV = originV;
    while (usedCompE.size < compE.size) {
      const candidates = adj[currV]
        .filter(([, eIdx]) => !usedCompE.has(eIdx))
        .map(([_, eIdx]) => eIdx);
      if (!candidates.length) break;
      const eIdx = Math.min(...candidates);
      usedCompE.add(eIdx);
      const prim = sortedPrims[eIdx];
      const [u, v] = primV[eIdx];
      const fwd = currV === u;
      const nextV = fwd ? v : u;
      orderedEdges.push({
        kind: prim.kind,
        start: vertices[currV],
        mid: prim.mid,
        end: vertices[nextV],
        entity: prim.entity,
        forward: fwd,
      });
      currV = nextV;
      if (currV === originV && usedCompE.size === compE.size) break;
    }

    const area = Math.abs(chainSignedArea(orderedEdges));
    const perim = [...compE].reduce((s, eIdx) => s + sortedPrims[eIdx].length, 0);
    if (area <= 1e-4) {
      branchedComponents.push({
        entity_ids: eIds,
        junction_points: [[...vertices[originV]]],
        reason: 'zero_area_degenerate_loop',
      });
      continue;
    }

    const selfHit = chainedLoopSelfHit(orderedEdges);
    if (selfHit !== null) {
      branchedComponents.push({
        entity_ids: eIds,
        junction_points: [[...selfHit]],
        reason: 'self_intersecting_loop',
      });
      continue;
    }

    const loop = {
      source: 'chained',
      area,
      perimeter: perim,
      entity_ids: eIds,
      edges: orderedEdges,
      rep_point: orderedEdges[0].start,
    };
    loop.bbox = loopBbox(loop);
    loops.push(loop);
  }

  loops.sort((a, b) => b.area - a.area);

  const crossingLoops = [];
  for (let i = 0; i < loops.length; i++) {
    for (let j = i + 1; j < loops.length; j++) {
      if (loopsIntersect(loops[i], loops[j]).hit) {
        crossingLoops.push([loops[i].entity_ids, loops[j].entity_ids]);
      }
    }
  }

  loops.forEach((loop, idx) => {
    const ancestors = [];
    const probe = loop.rep_point;
    for (let ancIdx = 0; ancIdx < idx; ancIdx++) {
      const anc = loops[ancIdx];
      if (anc.area <= loop.area + EPS) continue;
      if (pointStrictlyInsideLoop(probe, anc, 1e-4)) ancestors.push(ancIdx);
    }
    loop.depth = ancestors.length;
    loop.parent_idx = ancestors.length ? ancestors[ancestors.length - 1] : null;
  });

  return {
    loops,
    outer_loops: loops.filter((lp) => lp.depth === 0),
    hole_loops: loops.filter((lp) => lp.depth === 1),
    island_loops: loops.filter((lp) => lp.depth >= 2),
    open_components: openComponents,
    branched_components: branchedComponents,
    crossing_loops: crossingLoops,
    cutting_entities: cuttingEntities,
  };
}

function rotatePt(pt, base, rad) {
  const dx = pt[0] - base[0],
    dy = pt[1] - base[1];
  const c = Math.cos(rad),
    s = Math.sin(rad);
  return roundPt([base[0] + dx * c - dy * s, base[1] + dx * s + dy * c]);
}

function reflectPt(pt, p1, p2) {
  const vx = p2[0] - p1[0],
    vy = p2[1] - p1[1];
  const len2 = vx * vx + vy * vy;
  if (len2 <= EPS * EPS) throw new Error('Mirror axis points must be distinct.');
  const wx = pt[0] - p1[0],
    wy = pt[1] - p1[1];
  const proj = (wx * vx + wy * vy) / len2;
  const fx = p1[0] + proj * vx,
    fy = p1[1] + proj * vy;
  return roundPt([2 * fx - pt[0], 2 * fy - pt[1]]);
}

export function rotateEntity(entity, basePt, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  const out = structuredClone(entity);
  if (out.type === 'circle') {
    out.center = rotatePt(out.center, basePt, rad);
  } else if (out.type === 'arc') {
    out.center = rotatePt(out.center, basePt, rad);
    out.start_angle = round6(mod360(out.start_angle + angleDeg));
    out.end_angle = round6(mod360(out.end_angle + angleDeg));
  } else if (out.type === 'dim') {
    out.p1 = rotatePt(out.p1, basePt, rad);
    out.p2 = rotatePt(out.p2, basePt, rad);
    out.dim_point = rotatePt(out.dim_point, basePt, rad);
  } else if (out.type === 'text') {
    out.position = rotatePt(out.position, basePt, rad);
    out.rotation = round6(mod360((out.rotation || 0) + angleDeg));
  } else {
    out.points = out.points.map((p) => rotatePt(p, basePt, rad));
  }
  return out;
}

export function mirrorEntity(entity, axisP1, axisP2) {
  if (dist(axisP1, axisP2) <= EPS) throw new Error('Mirror axis requires two distinct points.');
  const axisDeg = (Math.atan2(axisP2[1] - axisP1[1], axisP2[0] - axisP1[0]) * 180) / Math.PI;
  const out = structuredClone(entity);
  if (out.type === 'circle') {
    out.center = reflectPt(out.center, axisP1, axisP2);
  } else if (out.type === 'arc') {
    out.center = reflectPt(out.center, axisP1, axisP2);
    const oldS = out.start_angle,
      oldE = out.end_angle;
    out.start_angle = round6(mod360(2 * axisDeg - oldE));
    out.end_angle = round6(mod360(2 * axisDeg - oldS));
  } else if (out.type === 'dim') {
    out.p1 = reflectPt(out.p1, axisP1, axisP2);
    out.p2 = reflectPt(out.p2, axisP1, axisP2);
    out.dim_point = reflectPt(out.dim_point, axisP1, axisP2);
  } else if (out.type === 'text') {
    out.position = reflectPt(out.position, axisP1, axisP2);
    out.rotation = round6(mod360(2 * axisDeg - (out.rotation || 0)));
  } else {
    out.points = out.points.map((p) => reflectPt(p, axisP1, axisP2));
  }
  return out;
}

function infiniteLineIntersection(a1, a2, b1, b2) {
  const d1x = a2[0] - a1[0],
    d1y = a2[1] - a1[1];
  const d2x = b2[0] - b1[0],
    d2y = b2[1] - b1[1];
  const cross = d1x * d2y - d1y * d2x;
  if (Math.abs(cross) <= 1e-9)
    throw new Error('Lines are parallel or collinear; no corner intersection exists.');
  const qpx = b1[0] - a1[0],
    qpy = b1[1] - a1[1];
  const t = (qpx * d2y - qpy * d2x) / cross;
  return [a1[0] + t * d1x, a1[1] + t * d1y];
}

function selectKeptEndpoint(lineEntity, interPt, keepPt = null) {
  const [p0, p1] = lineEntity.points;
  const dx = p1[0] - p0[0],
    dy = p1[1] - p0[1];
  const segLen2 = dx * dx + dy * dy;
  const d0 = dist(p0, interPt),
    d1 = dist(p1, interPt);
  if (keepPt) {
    const v0 =
      (p0[0] - interPt[0]) * (keepPt[0] - interPt[0]) +
      (p0[1] - interPt[1]) * (keepPt[1] - interPt[1]);
    const v1 =
      (p1[0] - interPt[0]) * (keepPt[0] - interPt[0]) +
      (p1[1] - interPt[1]) * (keepPt[1] - interPt[1]);
    if (Math.abs(v0 - v1) <= 1e-9)
      throw new Error('Keep-side pick point lies on the intersection.');
    return v0 > v1 ? { far: p0, trimIdx: 1, len: d0 } : { far: p1, trimIdx: 0, len: d1 };
  }
  const t = ((interPt[0] - p0[0]) * dx + (interPt[1] - p0[1]) * dy) / Math.max(segLen2, 1e-12);
  if (d0 > 1e-3 && d1 > 1e-3 && t > 0 && t < 1) {
    throw new Error(
      `Ambiguous crossing on line '${lineEntity.id || ''}': trim to an L-corner or specify keep-side points.`,
    );
  }
  return d0 >= d1 ? { far: p0, trimIdx: 1, len: d0 } : { far: p1, trimIdx: 0, len: d1 };
}

export function chamferTwoLines(line1, line2, d1, d2 = d1, keepPts = null) {
  if (d1 <= EPS || d2 <= EPS) throw new Error('Chamfer distances must be positive.');
  const inter = infiniteLineIntersection(
    line1.points[0],
    line1.points[1],
    line2.points[0],
    line2.points[1],
  );
  const k1 = selectKeptEndpoint(line1, inter, keepPts?.[0] || null);
  const k2 = selectKeptEndpoint(line2, inter, keepPts?.[1] || null);
  if (k1.len <= d1 + 1e-4 || k2.len <= d2 + 1e-4)
    throw new Error('Chamfer distance exceeds available line length.');
  const u1 = [(k1.far[0] - inter[0]) / k1.len, (k1.far[1] - inter[1]) / k1.len];
  const u2 = [(k2.far[0] - inter[0]) / k2.len, (k2.far[1] - inter[1]) / k2.len];
  const t1 = roundPt([inter[0] + d1 * u1[0], inter[1] + d1 * u1[1]]);
  const t2 = roundPt([inter[0] + d2 * u2[0], inter[1] + d2 * u2[1]]);
  if (dist(t1, t2) <= EPS) throw new Error('Degenerate chamfer bevel.');
  const nl1 = structuredClone(line1),
    nl2 = structuredClone(line2);
  nl1.points[k1.trimIdx] = t1;
  nl2.points[k2.trimIdx] = t2;
  return { line1: nl1, line2: nl2, bevelPoints: [t1, t2] };
}

export function chamferPolyline(entity, d1, d2 = d1) {
  if (d1 <= EPS || d2 <= EPS) throw new Error('Chamfer distances must be positive.');
  const pts = entity.points,
    closed = entity.closed,
    n = pts.length;
  if (n < 3) throw new Error('Polyline requires at least 3 vertices to chamfer.');
  const segCount = closed ? n : n - 1;
  const segLens = Array.from({ length: segCount }, (_, i) => dist(pts[i], pts[(i + 1) % n]));
  const cornerFlags = Array.from({ length: n }, (_, i) => {
    if (!closed && (i === 0 || i === n - 1)) return false;
    const prev = pts[(i - 1 + n) % n],
      curr = pts[i],
      next = pts[(i + 1) % n];
    const vin = [curr[0] - prev[0], curr[1] - prev[1]];
    const vout = [next[0] - curr[0], next[1] - curr[1]];
    const lin = Math.hypot(...vin),
      lout = Math.hypot(...vout);
    if (lin <= EPS || lout <= EPS) return false;
    return Math.abs(vin[0] * vout[1] - vin[1] * vout[0]) / (lin * lout) > 1e-4;
  });
  if (!cornerFlags.some(Boolean))
    throw new Error('Polyline has no non-collinear corners to chamfer.');
  for (let s = 0; s < segCount; s++) {
    const needed = (cornerFlags[s] ? d2 : 0) + (cornerFlags[(s + 1) % n] ? d1 : 0);
    if (segLens[s] <= needed + 1e-4)
      throw new Error('Chamfer distance exceeds polyline edge length.');
  }
  const newPts = [];
  for (let i = 0; i < n; i++) {
    if (!cornerFlags[i]) {
      newPts.push(roundPt(pts[i]));
      continue;
    }
    const prev = pts[(i - 1 + n) % n],
      curr = pts[i],
      next = pts[(i + 1) % n];
    const lin = dist(prev, curr),
      lout = dist(curr, next);
    newPts.push(
      roundPt([
        curr[0] - (d1 * (curr[0] - prev[0])) / lin,
        curr[1] - (d1 * (curr[1] - prev[1])) / lin,
      ]),
      roundPt([
        curr[0] + (d2 * (next[0] - curr[0])) / lout,
        curr[1] + (d2 * (next[1] - curr[1])) / lout,
      ]),
    );
  }
  const updated = structuredClone(entity);
  updated.points = newPts;
  return updated;
}

function cornerFilletGeom(inter, u1, len1, u2, len2, radius) {
  const dot = Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1]));
  const theta = Math.acos(dot);
  if (theta <= 1e-4 || Math.abs(Math.PI - theta) <= 1e-4)
    throw new Error('Cannot fillet collinear or parallel segments.');
  const half = theta / 2;
  const tDist = radius / Math.tan(half);
  if (len1 <= tDist + 1e-4 || len2 <= tDist + 1e-4)
    throw new Error('Fillet radius exceeds available edge length.');
  const cDist = radius / Math.sin(half);
  const bx = u1[0] + u2[0],
    by = u1[1] + u2[1],
    bLen = Math.hypot(bx, by);
  const center = roundPt([inter[0] + (cDist * bx) / bLen, inter[1] + (cDist * by) / bLen]);
  const t1 = roundPt([inter[0] + tDist * u1[0], inter[1] + tDist * u1[1]]);
  const t2 = roundPt([inter[0] + tDist * u2[0], inter[1] + tDist * u2[1]]);
  const a1 = mod360((Math.atan2(t1[1] - center[1], t1[0] - center[0]) * 180) / Math.PI);
  const a2 = mod360((Math.atan2(t2[1] - center[1], t2[0] - center[0]) * 180) / Math.PI);
  const [sa, ea] = mod360(a2 - a1) < 180 ? [a1, a2] : [a2, a1];
  return {
    t1,
    t2,
    tDist,
    arcSpec: {
      center,
      radius: round6(radius),
      start_angle: round6(sa),
      end_angle: round6(ea),
    },
  };
}

export function filletTwoLines(line1, line2, radius, keepPts = null) {
  if (radius <= EPS) throw new Error('Fillet radius must be positive.');
  const inter = infiniteLineIntersection(
    line1.points[0],
    line1.points[1],
    line2.points[0],
    line2.points[1],
  );
  const k1 = selectKeptEndpoint(line1, inter, keepPts?.[0] || null);
  const k2 = selectKeptEndpoint(line2, inter, keepPts?.[1] || null);
  const u1 = [(k1.far[0] - inter[0]) / k1.len, (k1.far[1] - inter[1]) / k1.len];
  const u2 = [(k2.far[0] - inter[0]) / k2.len, (k2.far[1] - inter[1]) / k2.len];
  const { t1, t2, arcSpec } = cornerFilletGeom(inter, u1, k1.len, u2, k2.len, radius);
  const nl1 = structuredClone(line1),
    nl2 = structuredClone(line2);
  nl1.points[k1.trimIdx] = t1;
  nl2.points[k2.trimIdx] = t2;
  return { line1: nl1, line2: nl2, arcSpec };
}

export function filletPolylineToPrimitives(entity, radius, baseId = entity.id) {
  if (radius <= EPS) throw new Error('Fillet radius must be positive.');
  const pts = entity.points,
    closed = entity.closed,
    n = pts.length;
  if (n < 3) throw new Error('Polyline requires at least 3 vertices to fillet.');
  const segCount = closed ? n : n - 1;
  const segLens = Array.from({ length: segCount }, (_, i) => dist(pts[i], pts[(i + 1) % n]));
  if (segLens.some((len) => len <= EPS)) {
    throw new Error('Polyline contains a zero-length degenerate segment.');
  }
  const corners = new Map();
  for (let i = 0; i < n; i++) {
    if (!closed && (i === 0 || i === n - 1)) continue;
    const prev = pts[(i - 1 + n) % n],
      curr = pts[i],
      next = pts[(i + 1) % n];
    const lPrev = dist(curr, prev),
      lNext = dist(curr, next);
    const uPrev = [(prev[0] - curr[0]) / lPrev, (prev[1] - curr[1]) / lPrev];
    const uNext = [(next[0] - curr[0]) / lNext, (next[1] - curr[1]) / lNext];
    if (Math.abs(uPrev[0] * uNext[1] - uPrev[1] * uNext[0]) <= 1e-4) continue;
    corners.set(i, cornerFilletGeom(curr, uPrev, lPrev, uNext, lNext, radius));
  }
  if (!corners.size) throw new Error('Polyline has no non-collinear corners to fillet.');
  for (let s = 0; s < segCount; s++) {
    const ts = corners.get(s)?.tDist || 0;
    const te = corners.get((s + 1) % n)?.tDist || 0;
    if (segLens[s] <= ts + te + 1e-4)
      throw new Error('Fillet radius exceeds polyline edge length.');
  }
  const generated = [];
  for (let s = 0; s < segCount; s++) {
    const vStart = s,
      vEnd = (s + 1) % n;
    const pa = corners.has(vStart) ? corners.get(vStart).t2 : roundPt(pts[vStart]);
    const pb = corners.has(vEnd) ? corners.get(vEnd).t1 : roundPt(pts[vEnd]);
    generated.push({
      id: `${baseId}-edge-${s + 1}`,
      layer: entity.layer,
      type: 'line',
      points: [pa, pb],
    });
    if (corners.has(vEnd)) {
      generated.push({
        id: `${baseId}-fillet-${vEnd + 1}`,
        layer: entity.layer,
        type: 'arc',
        ...corners.get(vEnd).arcSpec,
      });
    }
  }
  return generated;
}

function segSegT(a, b, c, d, includeEnds = false) {
  const rx = b[0] - a[0],
    ry = b[1] - a[1];
  const sx = d[0] - c[0],
    sy = d[1] - c[1];
  const lenAb = Math.hypot(rx, ry),
    lenCd = Math.hypot(sx, sy);
  if (lenAb <= EPS || lenCd <= EPS) return [];
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) <= 1e-9 * lenAb * lenCd) return [];
  const qpx = c[0] - a[0],
    qpy = c[1] - a[1];
  const t = (qpx * sy - qpy * sx) / denom;
  const u = (qpx * ry - qpy * rx) / denom;
  if (includeEnds) {
    if (t >= -1e-6 && t <= 1 + 1e-6 && u >= -1e-6 && u <= 1 + 1e-6)
      return [Math.max(0, Math.min(1, t))];
    return [];
  }
  const epsT = Math.min(0.05, 1e-4 / lenAb);
  const epsU = Math.min(0.05, 1e-4 / lenCd);
  if (t > epsT && t < 1 - epsT && u >= -epsU && u <= 1 + epsU) return [t];
  return [];
}

function angleOnArc(angDeg, arcAngles) {
  if (!arcAngles) return true;
  const [sa, ea] = arcAngles;
  const sweep = mod360(ea - sa);
  const rel = mod360(angDeg - sa);
  return rel <= sweep + 1e-4 || rel >= 360 - 1e-4;
}

function segCircleT(a, b, center, radius, arcAngles = null, includeEnds = false) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const fx = a[0] - center[0],
    fy = a[1] - center[1];
  const qa = dx * dx + dy * dy;
  if (qa <= EPS * EPS) return [];
  const lenAb = Math.sqrt(qa);
  const epsT = Math.min(0.05, 1e-4 / lenAb);
  const qb = 2 * (fx * dx + fy * dy);
  const qc = fx * fx + fy * fy - radius * radius;
  const disc = qb * qb - 4 * qa * qc;
  if (disc < -1e-9 * qa) return [];
  const sqrtD = Math.sqrt(Math.max(0, disc));
  const ts = [];
  for (const sign of [-1, 1]) {
    const t = (-qb + sign * sqrtD) / (2 * qa);
    const valid = includeEnds ? t >= -1e-6 && t <= 1 + 1e-6 : t > epsT && t < 1 - epsT;
    if (valid) {
      const ct = Math.max(0, Math.min(1, t));
      const px = a[0] + ct * dx,
        py = a[1] + ct * dy;
      const ang = mod360((Math.atan2(py - center[1], px - center[0]) * 180) / Math.PI);
      if (angleOnArc(ang, arcAngles)) ts.push(ct);
    }
  }
  return ts;
}

export function trimLineEntity(targetLine, pickPt, cuttingEntities) {
  const [a, b] = targetLine.points;
  const segLen = dist(a, b);
  if (segLen <= EPS) throw new Error('Degenerate target line.');
  const epsT = Math.min(0.05, 1e-4 / segLen);
  const cuts = [0, 1];
  for (const other of cuttingEntities) {
    if (other.id === targetLine.id || other.type === 'dim' || other.type === 'text') continue;
    if (other.type === 'line') {
      cuts.push(...segSegT(a, b, other.points[0], other.points[1]));
    } else if (other.type === 'polyline') {
      const pts = other.points,
        cnt = other.closed ? pts.length : pts.length - 1;
      for (let i = 0; i < cnt; i++) cuts.push(...segSegT(a, b, pts[i], pts[(i + 1) % pts.length]));
    } else if (other.type === 'circle') {
      cuts.push(...segCircleT(a, b, other.center, other.radius));
    } else if (other.type === 'arc') {
      cuts.push(
        ...segCircleT(a, b, other.center, other.radius, [other.start_angle, other.end_angle]),
      );
    }
  }
  const sortedT = [0];
  for (const val of cuts.sort((x, y) => x - y)) {
    if (val - sortedT.at(-1) > epsT) sortedT.push(val);
  }
  if (1 - sortedT.at(-1) > epsT) sortedT.push(1);
  else sortedT[sortedT.length - 1] = 1;

  if (sortedT.length <= 2)
    throw new Error('Target line has no cutting intersections to trim against.');

  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const tPick = Math.max(
    0,
    Math.min(1, ((pickPt[0] - a[0]) * dx + (pickPt[1] - a[1]) * dy) / (segLen * segLen)),
  );
  for (const cutT of sortedT.slice(1, -1)) {
    if (Math.abs(tPick - cutT) <= epsT) {
      throw new Error(
        'Pick point lies directly on a cutting intersection; click the span to remove.',
      );
    }
  }
  let dropIdx = 0;
  for (let i = 0; i < sortedT.length - 1; i++) {
    if (sortedT[i] <= tPick && tPick <= sortedT[i + 1]) {
      dropIdx = i;
      break;
    }
  }
  const ptAt = (p) => roundPt([a[0] + p * dx, a[1] + p * dy]);
  const [tLo, tHi] = [sortedT[dropIdx], sortedT[dropIdx + 1]];
  if (tLo <= epsT) {
    const updated = structuredClone(targetLine);
    updated.points = [ptAt(tHi), roundPt(b)];
    return [updated];
  }
  if (tHi >= 1 - epsT) {
    const updated = structuredClone(targetLine);
    updated.points = [roundPt(a), ptAt(tLo)];
    return [updated];
  }
  const leftPiece = structuredClone(targetLine);
  leftPiece.points = [roundPt(a), ptAt(tLo)];
  const rightPiece = structuredClone(targetLine);
  rightPiece.id = `${targetLine.id}-trim-${crypto.randomUUID().slice(0, 6)}`;
  rightPiece.points = [ptAt(tHi), roundPt(b)];
  return [leftPiece, rightPiece];
}

export function arrayPolarEntities(entity, center, count, fillDeg = 360) {
  if (!Number.isInteger(count) || count < 2 || count > 360)
    throw new Error('Polar array count must be an integer between 2 and 360.');
  if (Math.abs(fillDeg) <= EPS || Math.abs(fillDeg) > 360 + EPS)
    throw new Error('Polar array fill angle must be in (0, 360] degrees.');
  const fullCircle = Math.abs(Math.abs(fillDeg) - 360) <= 1e-4;
  const step = fullCircle ? fillDeg / count : fillDeg / (count - 1);
  return Array.from({ length: count - 1 }, (_, idx) => {
    const copy = rotateEntity(entity, center, step * (idx + 1));
    copy.id = `${entity.id}-p${idx + 2}`;
    return copy;
  });
}

export function arrayRectEntities(entity, cols, rows, dx, dy, translateFn) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1)
    throw new Error('Rectangular array columns and rows must be >= 1.');
  if (cols * rows < 2 || cols * rows > 500)
    throw new Error('Rectangular array must produce between 2 and 500 total items.');
  if (cols > 1 && Math.abs(dx) <= EPS)
    throw new Error('Column spacing dx must be non-zero when cols > 1.');
  if (rows > 1 && Math.abs(dy) <= EPS)
    throw new Error('Row spacing dy must be non-zero when rows > 1.');
  const copies = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (r === 0 && c === 0) continue;
      const item = translateFn(entity, [c * dx, r * dy]);
      item.id = `${entity.id}-r${r + 1}c${c + 1}`;
      copies.push(item);
    }
  }
  return copies;
}

function circleCircleIntersections(c1, r1, a1, c2, r2, a2) {
  const dx = c2[0] - c1[0],
    dy = c2[1] - c1[1];
  const d = Math.hypot(dx, dy);
  if (d <= EPS || d > r1 + r2 + EPS || d < Math.abs(r1 - r2) - EPS) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const hSq = Math.max(0, r1 * r1 - a * a);
  const h = Math.sqrt(hSq);
  const mx = c1[0] + (a * dx) / d,
    my = c1[1] + (a * dy) / d;
  const rx = (-dy * h) / d,
    ry = (dx * h) / d;
  const raw =
    h <= 1e-7
      ? [[mx, my]]
      : [
          [mx + rx, my + ry],
          [mx - rx, my - ry],
        ];
  return raw.filter(([px, py]) => {
    const ang1 = mod360((Math.atan2(py - c1[1], px - c1[0]) * 180) / Math.PI);
    const ang2 = mod360((Math.atan2(py - c2[1], px - c2[0]) * 180) / Math.PI);
    return angleOnArc(ang1, a1) && angleOnArc(ang2, a2);
  });
}

export function findAnalyticalSnaps(point, drawing, tolerance, basePoint = null) {
  const visible = new Set(drawing.layers.filter((l) => l.visible).map((l) => l.id));
  const segs = [];
  const circles = [];
  for (const e of drawing.entities) {
    if (!visible.has(e.layer) || e.type === 'dim' || e.type === 'text') continue;
    if (e.type === 'line') {
      segs.push({ id: e.id, a: e.points[0], b: e.points[1] });
    } else if (e.type === 'polyline') {
      const pts = e.points,
        cnt = e.closed ? pts.length : pts.length - 1;
      for (let i = 0; i < cnt; i++)
        segs.push({ id: e.id, a: pts[i], b: pts[(i + 1) % pts.length] });
    } else if (e.type === 'circle') {
      circles.push({ id: e.id, center: e.center, radius: e.radius, angles: null });
    } else if (e.type === 'arc') {
      circles.push({
        id: e.id,
        center: e.center,
        radius: e.radius,
        angles: [e.start_angle, e.end_angle],
      });
    }
  }

  const nearSegs = segs.filter(({ a, b }) => {
    const minX = Math.min(a[0], b[0]) - tolerance,
      maxX = Math.max(a[0], b[0]) + tolerance;
    const minY = Math.min(a[1], b[1]) - tolerance,
      maxY = Math.max(a[1], b[1]) + tolerance;
    return point[0] >= minX && point[0] <= maxX && point[1] >= minY && point[1] <= maxY;
  });
  const nearCircles = circles.filter(
    ({ center, radius }) => Math.abs(dist(point, center) - radius) <= tolerance * 1.5,
  );

  const candidates = [];
  for (let i = 0; i < nearSegs.length; i++) {
    for (let j = i + 1; j < nearSegs.length; j++) {
      if (nearSegs[i].id === nearSegs[j].id) continue;
      for (const t of segSegT(nearSegs[i].a, nearSegs[i].b, nearSegs[j].a, nearSegs[j].b, true)) {
        const hit = [
          nearSegs[i].a[0] + t * (nearSegs[i].b[0] - nearSegs[i].a[0]),
          nearSegs[i].a[1] + t * (nearSegs[i].b[1] - nearSegs[i].a[1]),
        ];
        candidates.push({ point: hit, kind: 'INT' });
      }
    }
    for (const c of nearCircles) {
      for (const t of segCircleT(
        nearSegs[i].a,
        nearSegs[i].b,
        c.center,
        c.radius,
        c.angles,
        true,
      )) {
        const hit = [
          nearSegs[i].a[0] + t * (nearSegs[i].b[0] - nearSegs[i].a[0]),
          nearSegs[i].a[1] + t * (nearSegs[i].b[1] - nearSegs[i].a[1]),
        ];
        candidates.push({ point: hit, kind: 'INT' });
      }
    }
  }
  for (let i = 0; i < nearCircles.length; i++) {
    for (let j = i + 1; j < nearCircles.length; j++) {
      const c1 = nearCircles[i],
        c2 = nearCircles[j];
      for (const hit of circleCircleIntersections(
        c1.center,
        c1.radius,
        c1.angles,
        c2.center,
        c2.radius,
        c2.angles,
      )) {
        candidates.push({ point: hit, kind: 'INT' });
      }
    }
  }

  if (basePoint) {
    for (const { a, b } of nearSegs) {
      const dx = b[0] - a[0],
        dy = b[1] - a[1],
        lenSq = dx * dx + dy * dy;
      if (lenSq <= EPS * EPS) continue;
      const t = ((basePoint[0] - a[0]) * dx + (basePoint[1] - a[1]) * dy) / lenSq;
      if (t >= -1e-6 && t <= 1 + 1e-6) {
        const ct = Math.max(0, Math.min(1, t));
        const foot = [a[0] + ct * dx, a[1] + ct * dy];
        if (dist(foot, basePoint) > EPS) candidates.push({ point: foot, kind: 'PER' });
      }
    }
    for (const c of nearCircles) {
      const d = dist(basePoint, c.center);
      if (d <= EPS) continue;
      const ux = (basePoint[0] - c.center[0]) / d,
        uy = (basePoint[1] - c.center[1]) / d;
      for (const sign of [1, -1]) {
        const foot = [c.center[0] + sign * c.radius * ux, c.center[1] + sign * c.radius * uy];
        const ang = mod360(
          (Math.atan2(foot[1] - c.center[1], foot[0] - c.center[0]) * 180) / Math.PI,
        );
        if (angleOnArc(ang, c.angles)) candidates.push({ point: foot, kind: 'PER' });
      }
    }
  }
  return candidates;
}

export function computeCamMetrics(drawing, thicknessMm = 3.0) {
  const thickness = Number(thicknessMm);
  if (!Number.isFinite(thickness) || thickness < 0.1 || thickness > 500) {
    throw new Error('Sheet thickness must be between 0.1 and 500 mm.');
  }
  const topo = analyzeDrawingTopology(drawing);
  const cutting = topo.cutting_entities;
  let cutLength = 0;
  const xs = [],
    ys = [];

  for (const e of cutting) {
    if (e.type === 'circle') {
      const [cx, cy] = e.center;
      const r = e.radius;
      cutLength += 2 * Math.PI * r;
      xs.push(cx - r, cx + r);
      ys.push(cy - r, cy + r);
    } else if (e.type === 'polyline') {
      const pts = e.points;
      for (const p of pts) {
        xs.push(p[0]);
        ys.push(p[1]);
      }
      const cnt = e.closed ? pts.length : pts.length - 1;
      for (let i = 0; i < cnt; i++) cutLength += dist(pts[i], pts[(i + 1) % pts.length]);
    } else if (e.type === 'line') {
      const [p0, p1] = e.points;
      xs.push(p0[0], p1[0]);
      ys.push(p0[1], p1[1]);
      cutLength += dist(p0, p1);
    } else if (e.type === 'arc') {
      const [cx, cy] = e.center;
      const r = e.radius;
      const { pStart, pMid, pEnd, sweep } = arcGeometry(e);
      for (const [px, py] of [pStart, pMid, pEnd]) {
        xs.push(px);
        ys.push(py);
      }
      for (const q of [0, 90, 180, 270]) {
        if (mod360(q - e.start_angle) <= sweep + 1e-6) {
          xs.push(cx + r * Math.cos((q * Math.PI) / 180));
          ys.push(cy + r * Math.sin((q * Math.PI) / 180));
        }
      }
      cutLength += r * ((sweep * Math.PI) / 180);
    }
  }

  const loops = topo.loops;
  const openCount = topo.open_components.length + topo.branched_components.length;
  const pierceCount = loops.length + openCount;
  const outerArea = topo.outer_loops.reduce((s, lp) => s + lp.area, 0);

  let netArea = 0;
  for (const lp of loops) {
    if (lp.depth % 2 === 0) netArea += lp.area;
    else netArea -= lp.area;
  }
  netArea = Math.max(0, netArea);

  const bboxW = xs.length ? Math.max(...xs) - Math.min(...xs) : 0;
  const bboxH = ys.length ? Math.max(...ys) - Math.min(...ys) : 0;
  const bboxArea = bboxW * bboxH;
  const utilPct = bboxArea > 1e-6 && netArea > 0 ? (netArea / bboxArea) * 100 : 0;
  const scrapPct = netArea > 0 ? Math.max(0, 100 - utilPct) : 0;
  const volumeMm3 = netArea * thickness;
  const massAl = round2(volumeMm3 * DENSITY_AL6061_G_MM3);
  const massSteel = round2(volumeMm3 * DENSITY_STEEL_G_MM3);
  const massSs = round2(volumeMm3 * DENSITY_SS304_G_MM3);

  return {
    thickness_mm: round3(thickness),
    cut_length_mm: round3(cutLength),
    pierce_count: pierceCount,
    closed_loops: loops.length,
    outer_loops: topo.outer_loops.length,
    hole_loops: topo.hole_loops.length,
    island_loops: topo.island_loops.length,
    open_components: openCount,
    outer_area_mm2: round3(outerArea),
    net_area_mm2: round3(netArea),
    bbox_mm: [round3(bboxW), round3(bboxH)],
    scrap_pct: round2(scrapPct),
    volume_mm3: round3(volumeMm3),
    mass_al6061_g: massAl,
    mass_steel_s235_g: massSteel,
    mass_g: {
      aluminum_6061: massAl,
      steel_s235: massSteel,
      stainless_304: massSs,
    },
  };
}
