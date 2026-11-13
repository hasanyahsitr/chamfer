// Deterministic 2D geometry, topology, and manufacturing rules for millimeter drawings.
import { arcPointAt, arcSweepDeg, distance, validateDrawing } from './model.js';
import {
  analyzeDrawingTopology,
  arcArcMinDistance,
  arcGeometry,
  circleCircleHits,
  cuttingLayerIds,
  segSegHits,
} from './ops.js';

const EPS = 1e-6;
const MAX_PAIR_CHECKS = 250000;
const round4 = (n) => Math.round(n * 1e4) / 1e4;
const roundPt = (p) => [round4(p[0]), round4(p[1])];
const midpoint = (a, b) => [round4((a[0] + b[0]) / 2), round4((a[1] + b[1]) / 2)];
const mod360 = (deg) => ((deg % 360) + 360) % 360;

function entitySegments(entity) {
  const pts = entity.points;
  const segs = pts.slice(1).map((p, i) => [pts[i], p]);
  if (entity.closed) segs.push([pts.at(-1), pts[0]]);
  return segs;
}

function pointToSegment(pt, a, b) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= EPS * EPS) return { dist: distance(pt, a), proj: [...a] };
  const t = Math.max(0, Math.min(1, ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / lenSq));
  const proj = [a[0] + t * dx, a[1] + t * dy];
  return { dist: distance(pt, proj), proj };
}

function segmentIntersection(a, b, c, d, strictInterior = false) {
  const rx = b[0] - a[0],
    ry = b[1] - a[1];
  const sx = d[0] - c[0],
    sy = d[1] - c[1];
  const lenAb = Math.hypot(rx, ry),
    lenCd = Math.hypot(sx, sy);
  if (lenAb <= EPS || lenCd <= EPS) return null;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) <= 1e-9 * lenAb * lenCd) return null;
  const qpx = c[0] - a[0],
    qpy = c[1] - a[1];
  const t = (qpx * sy - qpy * sx) / denom;
  const u = (qpx * ry - qpy * rx) / denom;
  if (strictInterior) {
    const epsT = Math.min(0.05, 1e-4 / lenAb);
    const epsU = Math.min(0.05, 1e-4 / lenCd);
    if (t > epsT && t < 1 - epsT && u > epsU && u < 1 - epsU) {
      return [a[0] + t * rx, a[1] + t * ry];
    }
    return null;
  }
  if (t >= -1e-7 && t <= 1 + 1e-7 && u >= -1e-7 && u <= 1 + 1e-7) {
    const ct = Math.max(0, Math.min(1, t));
    const hit = [a[0] + ct * rx, a[1] + ct * ry];
    for (const p1 of [a, b]) {
      for (const p2 of [c, d]) {
        if (distance(p1, p2) <= 1e-4) return null;
      }
    }
    return hit;
  }
  return null;
}

function colinearOverlap(a, b, c, d) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len <= EPS) return null;
  const ux = dx / len,
    uy = dy / len;
  for (const pt of [c, d]) {
    const perp = Math.abs((pt[0] - a[0]) * uy - (pt[1] - a[1]) * ux);
    if (perp > 1e-4) return null;
  }
  const tc = (c[0] - a[0]) * ux + (c[1] - a[1]) * uy;
  const td = (d[0] - a[0]) * ux + (d[1] - a[1]) * uy;
  const low = Math.max(0, Math.min(tc, td));
  const high = Math.min(len, Math.max(tc, td));
  if (high - low > 1e-3) {
    const mid = (low + high) / 2;
    return { point: [a[0] + mid * ux, a[1] + mid * uy], span: high - low };
  }
  return null;
}

function angleOnArc(angDeg, saDeg, eaDeg, tolDeg = 1e-4) {
  const sweep = mod360(eaDeg - saDeg);
  const rel = mod360(angDeg - saDeg);
  return rel <= sweep + tolDeg || rel >= 360 - tolDeg;
}

function arcOverlapSpanDeg(a1, a2) {
  const sa1 = mod360(a1.start_angle),
    ea1 = mod360(a1.end_angle);
  const sa2 = mod360(a2.start_angle),
    ea2 = mod360(a2.end_angle);
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

function segmentArcInteriorHit(a, b, arcEnt) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const qa = dx * dx + dy * dy;
  if (qa <= EPS * EPS) return null;
  const lenAb = Math.sqrt(qa);
  const [cx, cy] = arcEnt.center;
  const r = arcEnt.radius;
  const fx = a[0] - cx,
    fy = a[1] - cy;
  const qb = 2 * (fx * dx + fy * dy);
  const qc = fx * fx + fy * fy - r * r;
  const disc = qb * qb - 4 * qa * qc;
  if (disc < -1e-9 * qa) return null;
  const sqrtD = Math.sqrt(Math.max(0, disc));
  const { pStart, pEnd } = arcGeometry(arcEnt);
  const epsT = Math.min(0.05, 1e-4 / lenAb);
  for (const sign of [-1, 1]) {
    const t = (-qb + sign * sqrtD) / (2 * qa);
    if (t > epsT && t < 1 - epsT) {
      const hit = [a[0] + t * dx, a[1] + t * dy];
      if (distance(hit, pStart) <= 1e-4 || distance(hit, pEnd) <= 1e-4) continue;
      const ang = mod360((Math.atan2(hit[1] - cy, hit[0] - cx) * 180) / Math.PI);
      if (angleOnArc(ang, arcEnt.start_angle, arcEnt.end_angle, -1e-3)) return hit;
    }
  }
  return null;
}

export function lintDrawing(
  drawing,
  { maxGapMm = 2.0, minClearanceMm = 1.5, minSegmentMm = 0.5, manufacturing = false } = {},
) {
  const validated = validateDrawing(drawing);
  const cutLayers = cuttingLayerIds(validated);
  const entities = validated.entities.filter((e) => cutLayers.has(e.layer));
  const issues = [];

  const addIssue = (code, severity, point, entityIds, message, fixHint, metricMm = null) => {
    const entry = {
      id: `lint-${issues.length + 1}`,
      code,
      severity,
      point: roundPt(point),
      entities: [...entityIds],
      message,
      fix_hint: fixHint,
    };
    if (metricMm !== null) entry.metric_mm = round4(metricMm);
    issues.push(entry);
  };

  const allSegments = [];
  const openEndpoints = [];
  const circles = [];
  const arcs = [];
  const polySegGroups = [];
  let selfPolyPairs = 0;

  for (const entity of entities) {
    if (entity.type === 'dim' || entity.type === 'text') continue;
    if (entity.type === 'circle') {
      circles.push(entity);
      continue;
    }
    if (entity.type === 'arc') {
      arcs.push(entity);
      const sweepDeg = arcSweepDeg(entity.start_angle, entity.end_angle);
      const arcLen = entity.radius * ((sweepDeg * Math.PI) / 180);
      const pStart = arcPointAt(entity, entity.start_angle);
      const pEnd = arcPointAt(entity, entity.end_angle);
      if (arcLen < minSegmentMm - EPS) {
        addIssue(
          'MICRO_SEGMENT',
          'warning',
          midpoint(pStart, pEnd),
          [entity.id],
          `Arc length ${arcLen.toFixed(3)} mm in '${entity.id}' is below ${minSegmentMm.toFixed(3)} mm.`,
          'Erase or merge micro-arcs that can stall CNC path planners.',
          arcLen,
        );
      }
      openEndpoints.push({ id: entity.id, layer: entity.layer, pt: pStart });
      openEndpoints.push({ id: entity.id, layer: entity.layer, pt: pEnd });
      continue;
    }
    const segs = entitySegments(entity);
    segs.forEach(([a, b], idx) => {
      const len = distance(a, b);
      allSegments.push({ id: entity.id, layer: entity.layer, idx, a, b });
      if (len < minSegmentMm - EPS) {
        addIssue(
          'MICRO_SEGMENT',
          'warning',
          midpoint(a, b),
          [entity.id],
          `Segment length ${len.toFixed(3)} mm in '${entity.id}' is below ${minSegmentMm.toFixed(3)} mm.`,
          'Erase or merge micro-segments that can stall CNC path planners.',
          len,
        );
      }
    });

    if (entity.type === 'polyline') {
      const pts = entity.points;
      if (!entity.closed && pts.length >= 3) {
        const gap = distance(pts[0], pts.at(-1));
        if (gap <= maxGapMm + EPS) {
          addIssue(
            'OPEN_CONTOUR_GAP',
            'error',
            midpoint(pts[0], pts.at(-1)),
            [entity.id],
            `Open polyline '${entity.id}' has a ${gap.toFixed(3)} mm gap between start and end.`,
            `Close polyline '${entity.id}' (closed=true) or snap ${JSON.stringify(roundPt(pts.at(-1)))} to ${JSON.stringify(roundPt(pts[0]))}.`,
            gap,
          );
        } else {
          openEndpoints.push({ id: entity.id, layer: entity.layer, pt: pts[0] });
          openEndpoints.push({ id: entity.id, layer: entity.layer, pt: pts.at(-1) });
        }
      } else if (!entity.closed) {
        openEndpoints.push({ id: entity.id, layer: entity.layer, pt: pts[0] });
        openEndpoints.push({ id: entity.id, layer: entity.layer, pt: pts.at(-1) });
      }
      const nS = segs.length;
      if (nS >= 2) {
        selfPolyPairs += (nS * (nS - 1)) / 2;
        polySegGroups.push({ entity, segs });
      }
    } else if (entity.type === 'line') {
      openEndpoints.push({ id: entity.id, layer: entity.layer, pt: entity.points[0] });
      openEndpoints.push({ id: entity.id, layer: entity.layer, pt: entity.points[1] });
    }
  }

  const totalPairs =
    selfPolyPairs +
    (openEndpoints.length * (openEndpoints.length - 1)) / 2 +
    (allSegments.length * (allSegments.length - 1)) / 2 +
    (circles.length * (circles.length - 1)) / 2 +
    circles.length * (allSegments.length + arcs.length) +
    (arcs.length * (arcs.length - 1)) / 2 +
    allSegments.length * arcs.length;
  if (totalPairs > MAX_PAIR_CHECKS) {
    throw new Error(`Drawing exceeds geometric pair-check complexity budget (${MAX_PAIR_CHECKS}).`);
  }

  const reportedSelfHitEntities = new Set();
  for (const { entity, segs } of polySegGroups) {
    let foundHit = null;
    for (let i = 0; i < segs.length && !foundHit; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        const adjacent = j === i + 1 || (entity.closed && i === 0 && j === segs.length - 1);
        if (adjacent) {
          const ov = colinearOverlap(segs[i][0], segs[i][1], segs[j][0], segs[j][1]);
          if (ov) {
            foundHit = ov.point;
            break;
          }
        } else {
          const hits = segSegHits(segs[i][0], segs[i][1], segs[j][0], segs[j][1], []);
          if (hits.length) {
            foundHit = hits[0];
            break;
          }
        }
      }
    }
    if (foundHit) {
      reportedSelfHitEntities.add(entity.id);
      addIssue(
        'SELF_INTERSECTION',
        'error',
        foundHit,
        [entity.id],
        `Polyline '${entity.id}' intersects or overlaps itself at [${roundPt(foundHit).join(', ')}].`,
        'Reorder vertices or split self-intersecting contour into clean loops.',
      );
    }
  }

  const topo = analyzeDrawingTopology(validated);
  const reportedGapEntities = new Set(
    issues.filter((i) => i.code === 'OPEN_CONTOUR_GAP').flatMap((i) => i.entities),
  );

  for (const branch of topo.branched_components) {
    if (branch.reason === 'branch_junction') {
      const jpt = branch.junction_points[0];
      addIssue(
        'BRANCHED_CONTOUR_JUNCTION',
        'error',
        jpt,
        branch.entity_ids,
        `Ambiguous T-branch junction at [${roundPt(jpt).join(', ')}] across [${branch.entity_ids.join(', ')}] prevents manifold loop closure.`,
        'Trim or erase stray branch segments so each contour vertex connects 2 edges.',
      );
    } else if (
      branch.reason === 'self_intersecting_loop' ||
      branch.reason === 'zero_area_degenerate_loop'
    ) {
      if (branch.entity_ids.length === 1 && reportedSelfHitEntities.has(branch.entity_ids[0])) {
        continue;
      }
      const jpt = branch.junction_points[0];
      addIssue(
        'SELF_INTERSECTION',
        'error',
        jpt,
        branch.entity_ids,
        `Contour [${branch.entity_ids.join(', ')}] intersects or folds onto itself at [${roundPt(jpt).join(', ')}].`,
        'Split or trim self-intersecting contour into non-crossing loops.',
      );
    }
  }

  for (const comp of topo.open_components) {
    const compIds = comp.entity_ids;
    if (compIds.some((id) => reportedGapEntities.has(id))) continue;
    const ends = comp.endpoints;
    if (ends.length === 2 && compIds.length >= 2) {
      const gap = distance(ends[0], ends[1]);
      if (gap > 1e-4 && gap <= maxGapMm + EPS) {
        addIssue(
          'OPEN_CONTOUR_GAP',
          'error',
          midpoint(ends[0], ends[1]),
          compIds,
          `Chained contour [${compIds.join(', ')}] leaves a ${gap.toFixed(4)} mm open gap.`,
          `Snap [${roundPt(ends[1]).join(', ')}] to [${roundPt(ends[0]).join(', ')}] to close the loop.`,
          gap,
        );
        compIds.forEach((id) => reportedGapEntities.add(id));
        continue;
      }
    }
    const pt = ends[0] || [0, 0];
    addIssue(
      'UNCLOSED_CUT_CONTOUR',
      manufacturing ? 'error' : 'warning',
      pt,
      compIds,
      `Open cutting geometry [${compIds.join(', ')}] does not form a closed contour.`,
      'Close the contour, trim stray lines, or move reference lines to a construction layer.',
    );
  }

  const seenEndpointPairs = new Set();
  for (let i = 0; i < openEndpoints.length; i++) {
    const a = openEndpoints[i];
    for (let j = i + 1; j < openEndpoints.length; j++) {
      const b = openEndpoints[j];
      if (a.id === b.id) continue;
      const gap = distance(a.pt, b.pt);
      const key = [a.id, b.id].sort().join('::');
      if (gap > 1e-4 && gap <= maxGapMm + EPS && !seenEndpointPairs.has(key)) {
        seenEndpointPairs.add(key);
        addIssue(
          'DANGLING_ENDPOINT_GAP',
          'warning',
          midpoint(a.pt, b.pt),
          [a.id, b.id],
          `Endpoints of '${a.id}' and '${b.id}' miss each other by ${gap.toFixed(3)} mm.`,
          'Snap endpoints together for an airtight corner.',
          gap,
        );
      }
    }
  }

  const entityTypes = new Map(entities.map((e) => [e.id, e.type]));
  const seenOverlaps = new Set();
  const seenCrossings = new Set();
  for (let i = 0; i < allSegments.length; i++) {
    const s1 = allSegments[i];
    for (let j = i + 1; j < allSegments.length; j++) {
      const s2 = allSegments[j];
      if (s1.id === s2.id) continue;
      const key = [s1.id, s2.id].sort().join('::');
      const hit = colinearOverlap(s1.a, s1.b, s2.a, s2.b);
      if (hit && !seenOverlaps.has(key)) {
        seenOverlaps.add(key);
        const bothPolylines =
          entityTypes.get(s1.id) === 'polyline' && entityTypes.get(s2.id) === 'polyline';
        if (bothPolylines) {
          addIssue(
            'SHARED_EDGE_OVERLAP',
            manufacturing ? 'error' : 'warning',
            hit.point,
            [s1.id, s2.id],
            `Polylines '${s1.id}' and '${s2.id}' share a ${hit.span.toFixed(3)} mm overlapping edge.`,
            'Trim shared abutment edge before CNC laser cutting to avoid double-pass.',
            hit.span,
          );
        } else {
          addIssue(
            'DUPLICATE_GEOMETRY',
            'error',
            hit.point,
            [s1.id, s2.id],
            `Entities '${s1.id}' and '${s2.id}' overlap colinearly over ${hit.span.toFixed(3)} mm.`,
            'Erase duplicate overlapping linework to prevent double CNC laser cuts.',
            hit.span,
          );
        }
        continue;
      }
      if (!seenCrossings.has(key)) {
        const crossPt = segmentIntersection(s1.a, s1.b, s2.a, s2.b, true);
        if (crossPt) {
          seenCrossings.add(key);
          addIssue(
            'INTERSECTING_CONTOURS',
            'error',
            crossPt,
            [s1.id, s2.id],
            `Entities '${s1.id}' and '${s2.id}' cross each other at [${roundPt(crossPt).join(', ')}].`,
            'Trim intersecting linework or move reference lines to a construction layer.',
          );
        }
      }
    }
  }

  for (let i = 0; i < arcs.length; i++) {
    const a1 = arcs[i];
    const { pStart: ps1, pEnd: pe1 } = arcGeometry(a1);
    for (let j = i + 1; j < arcs.length; j++) {
      const a2 = arcs[j];
      const key = [a1.id, a2.id].sort().join('::');
      if (distance(a1.center, a2.center) <= 1e-4 && Math.abs(a1.radius - a2.radius) <= 1e-4) {
        const { overlap, midDeg } = arcOverlapSpanDeg(a1, a2);
        if (overlap > 1e-3) {
          const spanMm = a1.radius * ((overlap * Math.PI) / 180);
          const midPt = arcPointAt(a1, midDeg);
          addIssue(
            'DUPLICATE_GEOMETRY',
            'error',
            midPt,
            [a1.id, a2.id],
            `Arcs '${a1.id}' and '${a2.id}' overlap over ${spanMm.toFixed(3)} mm.`,
            `Erase duplicate or overlapping arc '${a2.id}'.`,
            spanMm,
          );
        }
        continue;
      }

      const { pStart: ps2, pEnd: pe2 } = arcGeometry(a2);
      const sharedEnds = [];
      for (const pa of [ps1, pe1]) {
        for (const pb of [ps2, pe2]) {
          if (distance(pa, pb) <= 1e-4) sharedEnds.push(pa);
        }
      }
      const arcHits = circleCircleHits(
        a1.center,
        a1.radius,
        a2.center,
        a2.radius,
        a1,
        a2,
        sharedEnds,
      );
      if (arcHits.length) {
        seenCrossings.add(key);
        addIssue(
          'INTERSECTING_CONTOURS',
          'error',
          arcHits[0],
          [a1.id, a2.id],
          `Arcs '${a1.id}' and '${a2.id}' intersect or touch at [${roundPt(arcHits[0]).join(', ')}].`,
          'Separate or trim colliding arc contours to maintain safe clearance.',
        );
      } else if (!sharedEnds.length) {
        const { minDist, midPoint } = arcArcMinDistance(a1, a2);
        if (minDist < minClearanceMm - EPS) {
          addIssue(
            'MIN_CLEARANCE',
            'warning',
            midPoint,
            [a1.id, a2.id],
            `Clearance between arcs '${a1.id}' and '${a2.id}' is ${minDist.toFixed(3)} mm (< ${minClearanceMm.toFixed(3)} mm).`,
            'Increase spacing between adjacent arc contours.',
            minDist,
          );
        }
      }
    }
  }

  for (const s of allSegments) {
    for (const arcEnt of arcs) {
      const key = [s.id, arcEnt.id].sort().join('::');
      if (seenCrossings.has(key)) continue;
      const hit = segmentArcInteriorHit(s.a, s.b, arcEnt);
      if (hit) {
        seenCrossings.add(key);
        addIssue(
          'INTERSECTING_CONTOURS',
          'error',
          hit,
          [s.id, arcEnt.id],
          `Segment '${s.id}' crosses arc '${arcEnt.id}' at [${roundPt(hit).join(', ')}].`,
          'Trim intersecting geometry so cutting contours do not cross.',
        );
      }
    }
  }

  for (let i = 0; i < circles.length; i++) {
    const c1 = circles[i];
    for (let j = i + 1; j < circles.length; j++) {
      const c2 = circles[j];
      const centerDist = distance(c1.center, c2.center);
      const rSum = c1.radius + c2.radius;
      if (centerDist <= 1e-4 && Math.abs(c1.radius - c2.radius) <= 1e-4) {
        addIssue(
          'DUPLICATE_GEOMETRY',
          'error',
          c1.center,
          [c1.id, c2.id],
          `Circles '${c1.id}' and '${c2.id}' are identical duplicates.`,
          `Erase duplicate circle '${c2.id}'.`,
          0,
        );
      } else if (centerDist >= 0) {
        const rMax = Math.max(c1.radius, c2.radius);
        const rMin = Math.min(c1.radius, c2.radius);
        const mid = midpoint(c1.center, c2.center);
        if (centerDist + rMin < rMax - EPS) {
          const clearance = rMax - (centerDist + rMin);
          if (clearance < minClearanceMm - EPS) {
            addIssue(
              'MIN_CLEARANCE',
              'warning',
              mid,
              [c1.id, c2.id],
              `Nested radial clearance between '${c1.id}' and '${c2.id}' is ${clearance.toFixed(3)} mm (< ${minClearanceMm.toFixed(3)} mm).`,
              'Move inner hole away from outer circular rim.',
              clearance,
            );
          }
        } else if (centerDist <= rSum + EPS) {
          const overlap = Math.min(rSum - centerDist, centerDist + rMin - rMax);
          addIssue(
            'CIRCLE_COLLISION',
            'error',
            mid,
            [c1.id, c2.id],
            `Circles '${c1.id}' and '${c2.id}' intersect or touch.`,
            `Separate circle rims by at least ${minClearanceMm.toFixed(3)} mm.`,
            overlap,
          );
        } else {
          const clearance = centerDist - rSum;
          if (clearance < minClearanceMm - EPS) {
            addIssue(
              'MIN_CLEARANCE',
              'warning',
              mid,
              [c1.id, c2.id],
              `Web thickness between '${c1.id}' and '${c2.id}' is ${clearance.toFixed(3)} mm (< ${minClearanceMm.toFixed(3)} mm).`,
              `Increase center spacing to at least ${(rSum + minClearanceMm).toFixed(3)} mm.`,
              clearance,
            );
          }
        }
      }
    }
  }

  for (const circle of circles) {
    let bestCollision = null;
    let bestClearance = null;
    for (const seg of allSegments) {
      const { dist: minD, proj } = pointToSegment(circle.center, seg.a, seg.b);
      const maxD = Math.max(distance(circle.center, seg.a), distance(circle.center, seg.b));
      if (minD <= circle.radius + EPS && maxD >= circle.radius - EPS) {
        const penetration = circle.radius - minD;
        if (!bestCollision || penetration > bestCollision.penetration) {
          bestCollision = { penetration, proj, id: seg.id };
        }
      } else if (minD > circle.radius + EPS) {
        const clearance = minD - circle.radius;
        if (
          clearance < minClearanceMm - EPS &&
          (!bestClearance || clearance < bestClearance.clearance)
        ) {
          bestClearance = { clearance, proj, id: seg.id };
        }
      }
    }
    for (const arcEnt of arcs) {
      const sweepDeg = arcSweepDeg(arcEnt.start_angle, arcEnt.end_angle);
      const rayDeg = mod360(
        (Math.atan2(circle.center[1] - arcEnt.center[1], circle.center[0] - arcEnt.center[0]) *
          180) /
          Math.PI,
      );
      const candPts = [
        arcPointAt(arcEnt, arcEnt.start_angle),
        arcPointAt(arcEnt, arcEnt.end_angle),
      ];
      if (mod360(rayDeg - arcEnt.start_angle) <= sweepDeg + 1e-4) {
        candPts.push(arcPointAt(arcEnt, rayDeg));
      }
      let nearPt = candPts[0];
      let minD = distance(circle.center, nearPt);
      for (const p of candPts.slice(1)) {
        const d = distance(circle.center, p);
        if (d < minD) {
          minD = d;
          nearPt = p;
        }
      }
      const centerDist = distance(circle.center, arcEnt.center);
      if (centerDist + circle.radius < arcEnt.radius - EPS) {
        const clearance = arcEnt.radius - (centerDist + circle.radius);
        if (
          clearance < minClearanceMm - EPS &&
          (!bestClearance || clearance < bestClearance.clearance)
        ) {
          bestClearance = { clearance, proj: nearPt, id: arcEnt.id };
        }
      } else if (minD <= circle.radius + EPS) {
        const penetration = circle.radius - minD;
        if (!bestCollision || penetration > bestCollision.penetration) {
          bestCollision = { penetration, proj: nearPt, id: arcEnt.id };
        }
      } else {
        const clearance = minD - circle.radius;
        if (
          clearance < minClearanceMm - EPS &&
          (!bestClearance || clearance < bestClearance.clearance)
        ) {
          bestClearance = { clearance, proj: nearPt, id: arcEnt.id };
        }
      }
    }
    if (bestCollision) {
      addIssue(
        'CIRCLE_COLLISION',
        'error',
        bestCollision.proj,
        [circle.id, bestCollision.id],
        `Circle '${circle.id}' collides with '${bestCollision.id}' (overlap ${bestCollision.penetration.toFixed(3)} mm).`,
        `Move circle '${circle.id}' center at least ${(circle.radius + minClearanceMm).toFixed(3)} mm away from '${bestCollision.id}'.`,
        bestCollision.penetration,
      );
    } else if (bestClearance) {
      addIssue(
        'MIN_CLEARANCE',
        'warning',
        bestClearance.proj,
        [circle.id, bestClearance.id],
        `Edge clearance from '${circle.id}' to '${bestClearance.id}' is ${bestClearance.clearance.toFixed(3)} mm (< ${minClearanceMm.toFixed(3)} mm).`,
        `Move circle '${circle.id}' center at least ${(circle.radius + minClearanceMm).toFixed(3)} mm inside '${bestClearance.id}'.`,
        bestClearance.clearance,
      );
    }
  }

  const loops = topo.loops;
  for (const [idsA, idsB] of topo.crossing_loops) {
    const alreadyFlagged = issues.some(
      (iss) =>
        [
          'INTERSECTING_CONTOURS',
          'CIRCLE_COLLISION',
          'DUPLICATE_GEOMETRY',
          'SHARED_EDGE_OVERLAP',
        ].includes(iss.code) &&
        idsA.some((ea) => iss.entities.includes(ea)) &&
        idsB.some((eb) => iss.entities.includes(eb)),
    );
    if (!alreadyFlagged) {
      addIssue(
        'INTERSECTING_CONTOURS',
        'error',
        [0, 0],
        [idsA[0], idsB[0]],
        `Closed contours [${idsA.join(', ')}] and [${idsB.join(', ')}] intersect or touch at their boundaries.`,
        'Separate touching contours so each cut profile is strictly disjoint or nested.',
      );
    }
  }
  const nonCircleRoots = loops.filter((lp) => lp.depth === 0 && lp.source !== 'circle');
  if (nonCircleRoots.length === 1 && topo.open_components.length === 0) {
    const outer = nonCircleRoots[0];
    const outerId = outer.entity_ids[0];
    for (const lp of loops) {
      if (lp.source === 'circle' && lp.depth === 0 && lp.area < outer.area * 0.5) {
        const cid = lp.entity_ids[0];
        const alreadyColliding = issues.some(
          (iss) => iss.code === 'CIRCLE_COLLISION' && iss.entities.includes(cid),
        );
        if (!alreadyColliding) {
          addIssue(
            'OUTSIDE_OUTER_PROFILE',
            manufacturing ? 'error' : 'warning',
            lp.center,
            [cid, outerId],
            `Circle '${cid}' lies outside closed outer profile '${outerId}'.`,
            `Move circle '${cid}' inside the bounds of '${outerId}'.`,
          );
        }
      }
    }
  }

  if (manufacturing) {
    const roots = loops.filter((lp) => lp.depth === 0);
    if (roots.length === 0) {
      addIssue(
        'NO_CLOSED_PROFILE',
        'error',
        [0, 0],
        [],
        'No closed 2D outer profile found for part manufacturing.',
        'Create a closed outer contour before manufacturing export.',
      );
    } else if (roots.length > 1) {
      addIssue(
        'MULTIPLE_OUTER_PROFILES',
        'error',
        roots[1].rep_point,
        roots[1].entity_ids,
        `Found ${roots.length} disjoint outer profiles; single-part mode expects 1.`,
        'Keep a single outer part boundary or move extra profiles to another file.',
      );
    }
    for (const lp of loops) {
      if (lp.depth >= 2) {
        addIssue(
          'NESTED_ISLAND_UNSUPPORTED',
          'error',
          lp.rep_point,
          lp.entity_ids,
          `Nested island [${lp.entity_ids.join(', ')}] inside a cutout drops out during through-cutting.`,
          'Bridge nested islands with tabs or remove unsupported island contours.',
        );
      }
    }
  }

  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;
  return {
    valid: errors === 0,
    profile: manufacturing ? 'manufacturing' : 'drafting',
    status: errors === 0 && warnings === 0 ? 'passed' : errors === 0 ? 'warnings' : 'failed',
    summary: {
      errors,
      warnings,
      checked_entities: entities.length,
    },
    issues,
  };
}

export function previewDrcFix(drawing, issue, { minClearanceMm = 1.5, safetyMarginMm = 0.5 } = {}) {
  if (!issue || !Array.isArray(issue.entities) || !issue.entities.length) return null;
  const editableLayers = new Set(
    drawing.layers.filter((l) => l.visible && !l.locked).map((l) => l.id),
  );
  const nextDoc = structuredClone(drawing);
  const byId = new Map(nextDoc.entities.map((e) => [e.id, e]));

  if (issue.code === 'OPEN_CONTOUR_GAP') {
    if (issue.entities.length === 1) {
      const ent = byId.get(issue.entities[0]);
      if (!ent || ent.type !== 'polyline' || ent.closed || !editableLayers.has(ent.layer))
        return null;
      const startPt = roundPt(ent.points[0]);
      const endPt = roundPt(ent.points.at(-1));
      const gap = distance(ent.points[0], ent.points.at(-1));
      let diffSummary;
      if (ent.points.length > 3 && gap <= 2.0 + EPS) {
        ent.points.pop();
        ent.closed = true;
        diffSummary = `${ent.id}: snapped [${endPt.join(', ')}] -> [${startPt.join(', ')}] (${gap.toFixed(3)} mm) & closed=true`;
      } else {
        ent.closed = true;
        diffSummary = `${ent.id}: closed=true (${gap.toFixed(3)} mm gap)`;
      }
      return {
        nextDoc: validateDrawing(nextDoc),
        previewEntities: [structuredClone(ent)],
        diffSummary,
      };
    }
    const topo = analyzeDrawingTopology(drawing);
    const comp = topo.open_components.find(
      (c) =>
        c.endpoints.length === 2 &&
        c.entity_ids.length === issue.entities.length &&
        c.entity_ids.every((id) => issue.entities.includes(id)),
    );
    if (!comp) return null;
    const [targetPt, openPt] = comp.endpoints;
    for (const id of [...issue.entities].reverse()) {
      const ent = byId.get(id);
      if (!ent || !editableLayers.has(ent.layer)) continue;
      if (ent.type === 'line' || (ent.type === 'polyline' && !ent.closed)) {
        const i0 = 0,
          iLast = ent.points.length - 1;
        if (distance(ent.points[iLast], openPt) <= 1e-3) {
          const old = roundPt(ent.points[iLast]);
          ent.points[iLast] = roundPt(targetPt);
          return {
            nextDoc: validateDrawing(nextDoc),
            previewEntities: [structuredClone(ent)],
            diffSummary: `${ent.id}: snapped [${old.join(', ')}] -> [${roundPt(targetPt).join(', ')}]`,
          };
        }
        if (distance(ent.points[i0], openPt) <= 1e-3) {
          const old = roundPt(ent.points[i0]);
          ent.points[i0] = roundPt(targetPt);
          return {
            nextDoc: validateDrawing(nextDoc),
            previewEntities: [structuredClone(ent)],
            diffSummary: `${ent.id}: snapped [${old.join(', ')}] -> [${roundPt(targetPt).join(', ')}]`,
          };
        }
      }
    }
    return null;
  }

  if (issue.code === 'DUPLICATE_GEOMETRY' && issue.entities.length >= 2) {
    const keepEnt = byId.get(issue.entities[0]);
    const dropEnt = byId.get(issue.entities[1]);
    if (!keepEnt || !dropEnt || !editableLayers.has(dropEnt.layer)) return null;
    nextDoc.entities = nextDoc.entities.filter((e) => e.id !== dropEnt.id);
    return {
      nextDoc: validateDrawing(nextDoc),
      previewEntities: [structuredClone(keepEnt)],
      diffSummary: `Erased duplicate '${dropEnt.id}' (kept '${keepEnt.id}')`,
    };
  }

  if (
    (issue.code === 'CIRCLE_COLLISION' || issue.code === 'MIN_CLEARANCE') &&
    issue.entities.length >= 2
  ) {
    const e1 = byId.get(issue.entities[0]);
    const e2 = byId.get(issue.entities[1]);
    if (!e1 || !e2) return null;

    if (e1.type === 'circle' && e2.type === 'circle') {
      const mover = e1.radius <= e2.radius ? (e1.radius === e2.radius ? e2 : e1) : e2;
      const anchor = mover === e1 ? e2 : e1;
      if (!editableLayers.has(mover.layer)) return null;
      const oldC = roundPt(mover.center);
      const dx = mover.center[0] - anchor.center[0],
        dy = mover.center[1] - anchor.center[1];
      const d = Math.hypot(dx, dy);
      const [ux, uy] = d > EPS ? [dx / d, dy / d] : [1, 0];
      if (
        d + mover.radius < anchor.radius - EPS ||
        (d < anchor.radius && anchor.radius > mover.radius * 2.2)
      ) {
        const targetDist = Math.max(
          0,
          anchor.radius - mover.radius - minClearanceMm - safetyMarginMm,
        );
        mover.center = roundPt([
          anchor.center[0] + ux * targetDist,
          anchor.center[1] + uy * targetDist,
        ]);
      } else {
        const targetDist = anchor.radius + mover.radius + minClearanceMm + safetyMarginMm;
        mover.center = roundPt([
          anchor.center[0] + ux * targetDist,
          anchor.center[1] + uy * targetDist,
        ]);
      }
      return {
        nextDoc: validateDrawing(nextDoc),
        previewEntities: [structuredClone(mover)],
        diffSummary: `${mover.id}: center [${oldC.join(', ')}] -> [${mover.center.join(', ')}] (Ø${round4(mover.radius * 2)} mm preserved)`,
      };
    }

    const circle = e1.type === 'circle' ? e1 : e2.type === 'circle' ? e2 : null;
    const other = circle === e1 ? e2 : e1;
    if (!circle || !editableLayers.has(circle.layer)) return null;
    const oldC = roundPt(circle.center);
    const proj = issue.point;
    let vx = circle.center[0] - proj[0],
      vy = circle.center[1] - proj[1];
    const topo = analyzeDrawingTopology(drawing);
    const outerLoop = topo.outer_loops[0];
    let refCentroid = null;
    if (outerLoop && outerLoop.entity_ids.includes(other.id)) {
      const [bx0, by0, bx1, by1] = outerLoop.bbox;
      refCentroid = [(bx0 + bx1) / 2, (by0 + by1) / 2];
    } else if (other.type === 'polyline' && other.points.length >= 3) {
      const xs = other.points.map((p) => p[0]),
        ys = other.points.map((p) => p[1]);
      refCentroid = [
        (Math.min(...xs) + Math.max(...xs)) / 2,
        (Math.min(...ys) + Math.max(...ys)) / 2,
      ];
    }
    if (Math.hypot(vx, vy) <= EPS && refCentroid) {
      vx = refCentroid[0] - proj[0];
      vy = refCentroid[1] - proj[1];
    }
    if (refCentroid && vx * (refCentroid[0] - proj[0]) + vy * (refCentroid[1] - proj[1]) < 0) {
      vx = -vx;
      vy = -vy;
    }
    const vLen = Math.hypot(vx, vy);
    if (vLen <= EPS) return null;
    const targetDist = circle.radius + minClearanceMm + safetyMarginMm;
    circle.center = roundPt([
      proj[0] + (vx / vLen) * targetDist,
      proj[1] + (vy / vLen) * targetDist,
    ]);
    return {
      nextDoc: validateDrawing(nextDoc),
      previewEntities: [structuredClone(circle)],
      diffSummary: `${circle.id}: center [${oldC.join(', ')}] -> [${circle.center.join(', ')}] (Ø${round4(circle.radius * 2)} mm preserved)`,
    };
  }

  if (issue.code === 'OUTSIDE_OUTER_PROFILE' && issue.entities.length >= 2) {
    const circle = byId.get(issue.entities[0]);
    if (!circle || circle.type !== 'circle' || !editableLayers.has(circle.layer)) return null;
    const topo = analyzeDrawingTopology(drawing);
    const outer = topo.outer_loops.find((lp) => lp.entity_ids.includes(issue.entities[1]));
    if (!outer) return null;
    const [bx0, by0, bx1, by1] = outer.bbox;
    const margin = circle.radius + minClearanceMm + safetyMarginMm;
    if (bx1 - bx0 <= 2 * margin || by1 - by0 <= 2 * margin) return null;
    const oldC = roundPt(circle.center);
    circle.center = roundPt([
      Math.max(bx0 + margin, Math.min(bx1 - margin, circle.center[0])),
      Math.max(by0 + margin, Math.min(by1 - margin, circle.center[1])),
    ]);
    return {
      nextDoc: validateDrawing(nextDoc),
      previewEntities: [structuredClone(circle)],
      diffSummary: `${circle.id}: center [${oldC.join(', ')}] -> [${circle.center.join(', ')}] (inside '${issue.entities[1]}')`,
    };
  }

  return null;
}

export function flawedCncBracketExample() {
  return {
    format: 'cad-lab.drawing',
    schema_version: 1,
    units: 'mm',
    name: 'CNC Montaj Braketi — Denetim',
    layers: [{ id: '0', name: '0', color: '#d5dee7', visible: true, locked: false }],
    entities: [
      {
        id: 'outer-profile',
        type: 'polyline',
        layer: '0',
        points: [
          [0, 0],
          [80, 0],
          [80, 50],
          [0, 50],
          [0, 0.6],
        ],
        closed: false,
      },
      { id: 'hole-ok', type: 'circle', layer: '0', center: [12, 12], radius: 3 },
      { id: 'hole-thin-web', type: 'circle', layer: '0', center: [12, 38], radius: 3 },
      { id: 'hole-bridge', type: 'circle', layer: '0', center: [18.8, 38], radius: 3 },
      { id: 'hole-edge-crash', type: 'circle', layer: '0', center: [78.5, 25], radius: 3 },
    ],
  };
}
