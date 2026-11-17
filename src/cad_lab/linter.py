"""Deterministic 2D geometry and manufacturing checks for planar millimeter drawings."""

import json
import math

from cad_lab.drawing import MAX_DRAWING_BYTES, drawing_to_dxf
from cad_lab.project import ProjectError
from cad_lab.topology import (
    analyze_drawing_topology,
    arc_arc_min_distance,
    arc_geometry,
    circle_circle_hits,
    cutting_layer_ids,
    seg_seg_hits,
)

EPS = 1e-6
MAX_PAIR_CHECKS = 250_000
DEFAULT_MIN_CLEARANCE_MM = 1.5


def resolve_min_clearance_mm(min_clearance_mm=None, thickness_mm=None):
    """Resolve effective edge/web clearance: explicit value, else max(1.5, thickness_mm)."""
    if min_clearance_mm is not None:
        if isinstance(min_clearance_mm, bool):
            raise ProjectError("min_clearance_mm must be a finite number >= 0.")
        try:
            val = float(min_clearance_mm)
        except (TypeError, ValueError) as exc:
            raise ProjectError("min_clearance_mm must be a finite number >= 0.") from exc
        if not math.isfinite(val) or val < 0.0:
            raise ProjectError("min_clearance_mm must be a finite number >= 0.")
        return val
    if thickness_mm is not None:
        if isinstance(thickness_mm, bool):
            raise ProjectError("thickness_mm must be a finite number > 0.")
        try:
            t_val = float(thickness_mm)
        except (TypeError, ValueError) as exc:
            raise ProjectError("thickness_mm must be a finite number > 0.") from exc
        if not math.isfinite(t_val) or t_val <= 0.0:
            raise ProjectError("thickness_mm must be a finite number > 0.")
        return max(DEFAULT_MIN_CLEARANCE_MM, t_val)
    return DEFAULT_MIN_CLEARANCE_MM


def _dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _midpoint(a, b):
    return [round((a[0] + b[0]) / 2.0, 4), round((a[1] + b[1]) / 2.0, 4)]


def _round_pt(pt):
    return [round(float(pt[0]), 4), round(float(pt[1]), 4)]


def _entity_segments(entity):
    points = entity["points"]
    segs = [[points[i], points[i + 1]] for i in range(len(points) - 1)]
    if entity.get("closed"):
        segs.append([points[-1], points[0]])
    return segs


def _point_to_segment(pt, a, b):
    dx = b[0] - a[0]
    dy = b[1] - a[1]
    len_sq = dx * dx + dy * dy
    if len_sq <= EPS * EPS:
        return _dist(pt, a), list(a)
    t = max(0.0, min(1.0, ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / len_sq))
    proj = [a[0] + t * dx, a[1] + t * dy]
    return _dist(pt, proj), proj


def _segment_intersection(a, b, c, d, strict_interior=False):
    """Return proper intersection point of segments AB and CD (excluding shared endpoints)."""
    rx, ry = b[0] - a[0], b[1] - a[1]
    sx, sy = d[0] - c[0], d[1] - c[1]
    len_ab = math.hypot(rx, ry)
    len_cd = math.hypot(sx, sy)
    if len_ab <= EPS or len_cd <= EPS:
        return None
    denom = rx * sy - ry * sx
    if abs(denom) <= 1e-9 * len_ab * len_cd:
        return None
    qpx, qpy = c[0] - a[0], c[1] - a[1]
    t = (qpx * sy - qpy * sx) / denom
    u = (qpx * ry - qpy * rx) / denom
    if strict_interior:
        eps_t = min(0.05, 1e-4 / len_ab)
        eps_u = min(0.05, 1e-4 / len_cd)
        if eps_t < t < 1.0 - eps_t and eps_u < u < 1.0 - eps_u:
            return [a[0] + t * rx, a[1] + t * ry]
        return None
    if -1e-7 <= t <= 1.0 + 1e-7 and -1e-7 <= u <= 1.0 + 1e-7:
        ix = a[0] + max(0.0, min(1.0, t)) * rx
        iy = a[1] + max(0.0, min(1.0, t)) * ry
        pt = [ix, iy]
        for end_ab in (a, b):
            for end_cd in (c, d):
                if _dist(end_ab, end_cd) <= 1e-4:
                    return None
        return pt
    return None


def _colinear_overlap(a, b, c, d):
    """Return midpoint of overlapping span if segments AB and CD are colinear and overlap."""
    dx = b[0] - a[0]
    dy = b[1] - a[1]
    length = math.hypot(dx, dy)
    if length <= EPS:
        return None
    ux, uy = dx / length, dy / length
    for pt in (c, d):
        perp = abs((pt[0] - a[0]) * uy - (pt[1] - a[1]) * ux)
        if perp > 1e-4:
            return None
    tc = (c[0] - a[0]) * ux + (c[1] - a[1]) * uy
    td = (d[0] - a[0]) * ux + (d[1] - a[1]) * uy
    low = max(0.0, min(tc, td))
    high = min(length, max(tc, td))
    if high - low > 1e-3:
        mid_t = (low + high) / 2.0
        return [a[0] + mid_t * ux, a[1] + mid_t * uy], high - low
    return None


def _angle_on_arc(ang_deg, sa_deg, ea_deg, tol_deg=1e-4):
    sweep = (ea_deg - sa_deg) % 360.0
    rel = (ang_deg - sa_deg) % 360.0
    return rel <= sweep + tol_deg or rel >= 360.0 - tol_deg


def _arc_overlap_span_deg(a1, a2):
    """Return overlapping angular span in degrees if two concentric equal-radius arcs overlap."""
    sa1, ea1 = a1["start_angle"] % 360.0, a1["end_angle"] % 360.0
    sa2, ea2 = a2["start_angle"] % 360.0, a2["end_angle"] % 360.0
    sw1 = (ea1 - sa1) % 360.0
    sw2 = (ea2 - sa2) % 360.0

    def intervals(sa, sw):
        if sa + sw <= 360.0:
            return [(sa, sa + sw)]
        return [(sa, 360.0), (0.0, (sa + sw) - 360.0)]

    overlap = 0.0
    mid_deg = sa1
    for l1, r1 in intervals(sa1, sw1):
        for l2, r2 in intervals(sa2, sw2):
            lo = max(l1, l2)
            hi = min(r1, r2)
            if hi - lo > 1e-3:
                overlap += hi - lo
                mid_deg = (lo + hi) * 0.5
    return overlap, mid_deg


def _segment_arc_interior_hit(a, b, arc_ent):
    """Return proper interior intersection between segment AB and arc (excluding shared ends)."""
    dx, dy = b[0] - a[0], b[1] - a[1]
    qa = dx * dx + dy * dy
    if qa <= EPS * EPS:
        return None
    len_ab = math.sqrt(qa)
    cx, cy = arc_ent["center"]
    r = arc_ent["radius"]
    fx, fy = a[0] - cx, a[1] - cy
    qb = 2.0 * (fx * dx + fy * dy)
    qc = fx * fx + fy * fy - r * r
    disc = qb * qb - 4.0 * qa * qc
    if disc < -1e-9 * qa:
        return None
    sqrt_d = math.sqrt(max(0.0, disc))
    ps, _pm, pe, _sw = arc_geometry(arc_ent)
    eps_t = min(0.05, 1e-4 / len_ab)
    for sign in (-1.0, 1.0):
        t = (-qb + sign * sqrt_d) / (2.0 * qa)
        if eps_t < t < 1.0 - eps_t:
            hit = [a[0] + t * dx, a[1] + t * dy]
            if _dist(hit, ps) <= 1e-4 or _dist(hit, pe) <= 1e-4:
                continue
            ang = math.degrees(math.atan2(hit[1] - cy, hit[0] - cx)) % 360.0
            if _angle_on_arc(ang, arc_ent["start_angle"], arc_ent["end_angle"], tol_deg=-1e-3):
                return hit
    return None


def lint_drawing(
    drawing_or_json,
    *,
    max_gap_mm=2.0,
    min_clearance_mm=None,
    thickness_mm=None,
    min_segment_mm=0.5,
    manufacturing=False,
):
    """Validate a 2D drawing and return deterministic geometric & manufacturing diagnostics."""
    min_clearance_mm = resolve_min_clearance_mm(min_clearance_mm, thickness_mm)
    if isinstance(drawing_or_json, bytes):
        if len(drawing_or_json) > MAX_DRAWING_BYTES:
            raise ProjectError("Drawing exceeds the 1 MiB limit.")
        raw_text = drawing_or_json.decode("utf-8")
        data = json.loads(raw_text)
    elif isinstance(drawing_or_json, str):
        if len(drawing_or_json.encode("utf-8")) > MAX_DRAWING_BYTES:
            raise ProjectError("Drawing exceeds the 1 MiB limit.")
        raw_text = drawing_or_json
        try:
            data = json.loads(raw_text)
        except (ValueError, RecursionError) as exc:
            raise ProjectError("Drawing is not valid JSON.") from exc
    elif isinstance(drawing_or_json, dict):
        data = drawing_or_json
        raw_text = json.dumps(data)
    else:
        raise ProjectError("Drawing must be a JSON string or dict.")

    # Reuse strict schema + coordinate validation from DXF exporter.
    drawing_to_dxf(raw_text)

    cut_layers = cutting_layer_ids(data)
    entities = [e for e in data["entities"] if e["layer"] in cut_layers]
    issues = []

    def add_issue(code, severity, point, entity_ids, message, fix_hint, metric_mm=None):
        entry = {
            "id": f"lint-{len(issues) + 1}",
            "code": code,
            "severity": severity,
            "point": _round_pt(point),
            "entities": list(entity_ids),
            "message": message,
            "fix_hint": fix_hint,
        }
        if metric_mm is not None:
            entry["metric_mm"] = round(float(metric_mm), 4)
        issues.append(entry)

    # 1. Per-entity checks: micro-segments, open contour near-gaps, polyline self-intersections
    all_segments = []
    open_endpoints = []
    circles = []
    arcs = []
    poly_seg_groups = []

    for entity in entities:
        eid = entity["id"]
        kind = entity["type"]
        if kind in {"dim", "text"}:
            continue
        if kind == "circle":
            circles.append(entity)
            continue
        if kind == "arc":
            arcs.append(entity)
            p_start, _p_mid, p_end, sweep_deg = arc_geometry(entity)
            arc_len = entity["radius"] * math.radians(sweep_deg)
            if arc_len < min_segment_mm - EPS:
                add_issue(
                    "MICRO_SEGMENT",
                    "warning",
                    _midpoint(p_start, p_end),
                    [eid],
                    f"Arc length {arc_len:.3f} mm in '{eid}' is below {min_segment_mm:.3f} mm.",
                    "Erase or merge micro-arcs that can stall CNC path planners.",
                    arc_len,
                )
            open_endpoints.append((eid, entity["layer"], p_start))
            open_endpoints.append((eid, entity["layer"], p_end))
            continue

        segs = _entity_segments(entity)
        for idx, (a, b) in enumerate(segs):
            seg_len = _dist(a, b)
            all_segments.append((eid, entity["layer"], idx, a, b))
            if seg_len < min_segment_mm - EPS:
                add_issue(
                    "MICRO_SEGMENT",
                    "warning",
                    _midpoint(a, b),
                    [eid],
                    (
                        f"Segment length {seg_len:.3f} mm in '{eid}' is below "
                        f"{min_segment_mm:.3f} mm."
                    ),
                    "Erase or merge micro-segments that can stall CNC path planners.",
                    seg_len,
                )

        if kind == "polyline":
            pts = entity["points"]
            if not entity["closed"] and len(pts) >= 3:
                gap = _dist(pts[0], pts[-1])
                if gap <= max_gap_mm + EPS:
                    add_issue(
                        "OPEN_CONTOUR_GAP",
                        "error",
                        _midpoint(pts[0], pts[-1]),
                        [eid],
                        f"Open polyline '{eid}' has a {gap:.3f} mm gap between start and end.",
                        (
                            f"Close polyline '{eid}' (closed=true) or snap "
                            f"{_round_pt(pts[-1])} to {_round_pt(pts[0])}."
                        ),
                        gap,
                    )
                else:
                    open_endpoints.append((eid, entity["layer"], pts[0]))
                    open_endpoints.append((eid, entity["layer"], pts[-1]))
            elif not entity["closed"]:
                open_endpoints.append((eid, entity["layer"], pts[0]))
                open_endpoints.append((eid, entity["layer"], pts[-1]))
            poly_seg_groups.append((eid, bool(entity["closed"]), segs))
        elif kind == "line":
            open_endpoints.append((eid, entity["layer"], entity["points"][0]))
            open_endpoints.append((eid, entity["layer"], entity["points"][1]))

    self_poly_pairs = sum(len(s) * (len(s) - 1) // 2 for _, _, s in poly_seg_groups)
    total_pairs = (
        self_poly_pairs
        + len(open_endpoints) * (len(open_endpoints) - 1) // 2
        + len(all_segments) * (len(all_segments) - 1) // 2
        + len(circles) * (len(circles) - 1) // 2
        + len(circles) * (len(all_segments) + len(arcs))
        + len(arcs) * (len(arcs) - 1) // 2
        + len(all_segments) * len(arcs)
    )
    if total_pairs > MAX_PAIR_CHECKS:
        raise ProjectError(
            f"Drawing exceeds geometric pair-check complexity budget ({MAX_PAIR_CHECKS})."
        )

    reported_self_hit_entities = set()
    for eid, is_closed, segs in poly_seg_groups:
        n_segs = len(segs)
        found_hit = None
        for i in range(n_segs):
            if found_hit is not None:
                break
            for j in range(i + 1, n_segs):
                adjacent = j == i + 1 or (is_closed and i == 0 and j == n_segs - 1)
                if adjacent:
                    ov = _colinear_overlap(segs[i][0], segs[i][1], segs[j][0], segs[j][1])
                    if ov is not None:
                        found_hit = ov[0]
                        break
                else:
                    hits = seg_seg_hits(
                        segs[i][0], segs[i][1], segs[j][0], segs[j][1], exclude_pts=()
                    )
                    if hits:
                        found_hit = hits[0]
                        break
        if found_hit is not None:
            reported_self_hit_entities.add(eid)
            add_issue(
                "SELF_INTERSECTION",
                "error",
                found_hit,
                [eid],
                f"Polyline '{eid}' intersects or overlaps itself at {_round_pt(found_hit)}.",
                "Reorder vertices or split self-intersecting contour into clean loops.",
            )

    # 2. Topology analysis across all cutting layers (order-independent)
    topo = analyze_drawing_topology(data)
    reported_gap_entities = {
        eid for iss in issues if iss["code"] == "OPEN_CONTOUR_GAP" for eid in iss["entities"]
    }

    for branch in topo["branched_components"]:
        if branch["reason"] == "branch_junction":
            jpt = branch["junction_points"][0]
            add_issue(
                "BRANCHED_CONTOUR_JUNCTION",
                "error",
                jpt,
                branch["entity_ids"],
                (
                    f"Ambiguous T-branch junction at {_round_pt(jpt)} across "
                    f"{branch['entity_ids']} prevents manifold loop closure."
                ),
                "Trim or erase stray branch segments so each contour vertex connects 2 edges.",
            )
        elif branch["reason"] in {"self_intersecting_loop", "zero_area_degenerate_loop"}:
            if (
                len(branch["entity_ids"]) == 1
                and branch["entity_ids"][0] in reported_self_hit_entities
            ):
                continue
            jpt = branch["junction_points"][0]
            add_issue(
                "SELF_INTERSECTION",
                "error",
                jpt,
                branch["entity_ids"],
                (
                    f"Contour {branch['entity_ids']} intersects or folds onto itself "
                    f"at {_round_pt(jpt)}."
                ),
                "Trim or split self-intersecting contour into simple non-crossing loops.",
            )

    for comp in topo["open_components"]:
        comp_ids = comp["entity_ids"]
        if any(eid in reported_gap_entities for eid in comp_ids):
            continue
        ends = comp["endpoints"]
        if len(ends) == 2 and len(comp_ids) >= 2:
            gap = _dist(ends[0], ends[1])
            if 1e-4 < gap <= max_gap_mm + EPS:
                add_issue(
                    "OPEN_CONTOUR_GAP",
                    "error",
                    _midpoint(ends[0], ends[1]),
                    comp_ids,
                    f"Chained contour {comp_ids} leaves a {gap:.4f} mm open gap.",
                    f"Snap {_round_pt(ends[1])} to {_round_pt(ends[0])} to close the loop.",
                    gap,
                )
                reported_gap_entities.update(comp_ids)
                continue
        pt = ends[0] if ends else [0.0, 0.0]
        add_issue(
            "UNCLOSED_CUT_CONTOUR",
            "error" if manufacturing else "warning",
            pt,
            comp_ids,
            f"Open cutting geometry {comp_ids} does not form a closed contour.",
            "Close the contour, trim stray lines, or move reference lines to a construction layer.",
        )

    # 2b. Dangling near-miss endpoints between distinct open entities across cutting layers
    seen_endpoint_pairs = set()
    for i in range(len(open_endpoints)):
        eid_a, _layer_a, pt_a = open_endpoints[i]
        for j in range(i + 1, len(open_endpoints)):
            eid_b, _layer_b, pt_b = open_endpoints[j]
            if eid_a == eid_b:
                continue
            gap = _dist(pt_a, pt_b)
            pair_key = tuple(sorted((eid_a, eid_b)))
            if 1e-4 < gap <= max_gap_mm + EPS and pair_key not in seen_endpoint_pairs:
                seen_endpoint_pairs.add(pair_key)
                add_issue(
                    "DANGLING_ENDPOINT_GAP",
                    "warning",
                    _midpoint(pt_a, pt_b),
                    [eid_a, eid_b],
                    f"Endpoints of '{eid_a}' and '{eid_b}' miss each other by {gap:.3f} mm.",
                    f"Snap endpoint {_round_pt(pt_b)} to {_round_pt(pt_a)} for an airtight corner.",
                    gap,
                )

    # 3. Duplicate / overlapping colinear segments & interior segment crossings across all layers
    entity_types = {e["id"]: e["type"] for e in entities}
    seen_overlaps = set()
    seen_crossings = set()
    for i in range(len(all_segments)):
        eid_a, _la, _, a1, a2 = all_segments[i]
        for j in range(i + 1, len(all_segments)):
            eid_b, _lb, _, b1, b2 = all_segments[j]
            if eid_a == eid_b:
                continue
            pair_key = tuple(sorted((eid_a, eid_b)))
            overlap = _colinear_overlap(a1, a2, b1, b2)
            if overlap is not None and pair_key not in seen_overlaps:
                mid_pt, span = overlap
                seen_overlaps.add(pair_key)
                both_polylines = (
                    entity_types[eid_a] == "polyline" and entity_types[eid_b] == "polyline"
                )
                if both_polylines:
                    add_issue(
                        "SHARED_EDGE_OVERLAP",
                        "error" if manufacturing else "warning",
                        mid_pt,
                        [eid_a, eid_b],
                        (
                            f"Polylines '{eid_a}' and '{eid_b}' share a "
                            f"{span:.3f} mm overlapping edge."
                        ),
                        "Trim shared abutment edge before CNC laser cutting to avoid double-pass.",
                        span,
                    )
                else:
                    add_issue(
                        "DUPLICATE_GEOMETRY",
                        "error",
                        mid_pt,
                        [eid_a, eid_b],
                        f"Entities '{eid_a}' and '{eid_b}' overlap colinearly over {span:.3f} mm.",
                        "Erase duplicate overlapping linework to prevent double CNC laser cuts.",
                        span,
                    )
                continue

            if pair_key not in seen_crossings:
                cross_pt = _segment_intersection(a1, a2, b1, b2, strict_interior=True)
                if cross_pt is not None:
                    seen_crossings.add(pair_key)
                    add_issue(
                        "INTERSECTING_CONTOURS",
                        "error",
                        cross_pt,
                        [eid_a, eid_b],
                        (
                            f"Entities '{eid_a}' and '{eid_b}' cross each other at "
                            f"{_round_pt(cross_pt)}."
                        ),
                        (
                            "Trim intersecting linework or move reference lines to a "
                            "construction layer."
                        ),
                    )

    # 3b. Arc vs Arc duplicates, non-concentric crossings/tangencies, clearance & Seg-Arc hits
    for i in range(len(arcs)):
        a1 = arcs[i]
        ps1, _, pe1, _ = arc_geometry(a1)
        for j in range(i + 1, len(arcs)):
            a2 = arcs[j]
            pair_key = tuple(sorted((a1["id"], a2["id"])))
            cdist = _dist(a1["center"], a2["center"])
            if cdist <= 1e-4 and abs(a1["radius"] - a2["radius"]) <= 1e-4:
                ov_deg, mid_deg = _arc_overlap_span_deg(a1, a2)
                if ov_deg > 1e-3:
                    span_mm = a1["radius"] * math.radians(ov_deg)
                    mid_pt = [
                        a1["center"][0] + a1["radius"] * math.cos(math.radians(mid_deg)),
                        a1["center"][1] + a1["radius"] * math.sin(math.radians(mid_deg)),
                    ]
                    add_issue(
                        "DUPLICATE_GEOMETRY",
                        "error",
                        mid_pt,
                        [a1["id"], a2["id"]],
                        f"Arcs '{a1['id']}' and '{a2['id']}' overlap over {span_mm:.3f} mm.",
                        f"Erase duplicate or overlapping arc '{a2['id']}'.",
                        span_mm,
                    )
                continue

            ps2, _, pe2, _ = arc_geometry(a2)
            shared_ends = [
                pt_a for pt_a in (ps1, pe1) for pt_b in (ps2, pe2) if _dist(pt_a, pt_b) <= 1e-4
            ]
            arc_hits = circle_circle_hits(
                a1["center"],
                a1["radius"],
                a2["center"],
                a2["radius"],
                a1,
                a2,
                exclude_pts=shared_ends,
            )
            if arc_hits:
                seen_crossings.add(pair_key)
                add_issue(
                    "INTERSECTING_CONTOURS",
                    "error",
                    arc_hits[0],
                    [a1["id"], a2["id"]],
                    (
                        f"Arcs '{a1['id']}' and '{a2['id']}' intersect or touch at "
                        f"{_round_pt(arc_hits[0])}."
                    ),
                    "Separate or trim colliding arc contours to maintain safe clearance.",
                )
            elif not shared_ends:
                min_d, mid_pt = arc_arc_min_distance(a1, a2)
                if min_d < min_clearance_mm - EPS:
                    add_issue(
                        "MIN_CLEARANCE",
                        "warning",
                        mid_pt,
                        [a1["id"], a2["id"]],
                        (
                            f"Clearance between arcs '{a1['id']}' and '{a2['id']}' is "
                            f"{min_d:.3f} mm (< {min_clearance_mm:.3f} mm)."
                        ),
                        "Increase spacing between adjacent arc contours.",
                        min_d,
                    )
    for eid_s, _ls, _, s_a, s_b in all_segments:
        for arc_ent in arcs:
            pair_key = tuple(sorted((eid_s, arc_ent["id"])))
            if pair_key in seen_crossings:
                continue
            hit = _segment_arc_interior_hit(s_a, s_b, arc_ent)
            if hit is not None:
                seen_crossings.add(pair_key)
                add_issue(
                    "INTERSECTING_CONTOURS",
                    "error",
                    hit,
                    [eid_s, arc_ent["id"]],
                    f"Segment '{eid_s}' crosses arc '{arc_ent['id']}' at {_round_pt(hit)}.",
                    "Trim intersecting geometry so cutting contours do not cross.",
                )

    # 4. Circle vs Circle checks across all cutting layers
    for i in range(len(circles)):
        c1 = circles[i]
        for j in range(i + 1, len(circles)):
            c2 = circles[j]
            center_dist = _dist(c1["center"], c2["center"])
            r_sum = c1["radius"] + c2["radius"]
            if center_dist <= 1e-4 and abs(c1["radius"] - c2["radius"]) <= 1e-4:
                add_issue(
                    "DUPLICATE_GEOMETRY",
                    "error",
                    c1["center"],
                    [c1["id"], c2["id"]],
                    f"Circles '{c1['id']}' and '{c2['id']}' are identical duplicates.",
                    f"Erase duplicate circle '{c2['id']}'.",
                    0.0,
                )
            elif center_dist >= 0.0:
                r_max = max(c1["radius"], c2["radius"])
                r_min = min(c1["radius"], c2["radius"])
                mid_pt = _midpoint(c1["center"], c2["center"])
                if center_dist + r_min < r_max - EPS:
                    clearance = r_max - (center_dist + r_min)
                    if clearance < min_clearance_mm - EPS:
                        add_issue(
                            "MIN_CLEARANCE",
                            "warning",
                            mid_pt,
                            [c1["id"], c2["id"]],
                            (
                                f"Nested radial clearance between '{c1['id']}' and '{c2['id']}' "
                                f"is {clearance:.3f} mm (< {min_clearance_mm:.3f} mm)."
                            ),
                            "Move inner hole away from outer circular rim.",
                            clearance,
                        )
                elif center_dist <= r_sum + EPS:
                    overlap = min(r_sum - center_dist, (center_dist + r_min) - r_max)
                    add_issue(
                        "CIRCLE_COLLISION",
                        "error",
                        mid_pt,
                        [c1["id"], c2["id"]],
                        f"Circles '{c1['id']}' and '{c2['id']}' intersect or touch.",
                        f"Separate circle rims by at least {min_clearance_mm:.3f} mm.",
                        overlap,
                    )
                else:
                    clearance = center_dist - r_sum
                    if clearance < min_clearance_mm - EPS:
                        add_issue(
                            "MIN_CLEARANCE",
                            "warning",
                            mid_pt,
                            [c1["id"], c2["id"]],
                            (
                                f"Web thickness between '{c1['id']}' and '{c2['id']}' is "
                                f"{clearance:.3f} mm (< {min_clearance_mm:.3f} mm)."
                            ),
                            (
                                "Increase center spacing to at least "
                                f"{r_sum + min_clearance_mm:.3f} mm."
                            ),
                            clearance,
                        )

    # 5. Circle vs Segment & Circle vs Arc checks across all cutting layers
    for circle in circles:
        cid = circle["id"]
        center = circle["center"]
        radius = circle["radius"]
        best_collision = None
        best_clearance = None
        for eid, _layer_id, _, a, b in all_segments:
            min_d, proj = _point_to_segment(center, a, b)
            max_d = max(_dist(center, a), _dist(center, b))
            if min_d <= radius + EPS and max_d >= radius - EPS:
                penetration = radius - min_d
                if best_collision is None or penetration > best_collision[0]:
                    best_collision = (penetration, proj, eid)
            elif min_d > radius + EPS:
                clearance = min_d - radius
                if clearance < min_clearance_mm - EPS and (
                    best_clearance is None or clearance < best_clearance[0]
                ):
                    best_clearance = (clearance, proj, eid)

        for arc_ent in arcs:
            acx, acy = arc_ent["center"]
            ar = arc_ent["radius"]
            sa_deg = arc_ent["start_angle"]
            ea_deg = arc_ent["end_angle"]
            sweep_deg = (ea_deg - sa_deg) % 360.0
            ray_deg = math.degrees(math.atan2(center[1] - acy, center[0] - acx)) % 360.0
            cand_pts = [
                [
                    acx + ar * math.cos(math.radians(sa_deg)),
                    acy + ar * math.sin(math.radians(sa_deg)),
                ],
                [
                    acx + ar * math.cos(math.radians(ea_deg)),
                    acy + ar * math.sin(math.radians(ea_deg)),
                ],
            ]
            if ((ray_deg - sa_deg) % 360.0) <= sweep_deg + 1e-4:
                cand_pts.append(
                    [
                        acx + ar * math.cos(math.radians(ray_deg)),
                        acy + ar * math.sin(math.radians(ray_deg)),
                    ]
                )
            near_pt = min(cand_pts, key=lambda p: _dist(center, p))
            min_d = _dist(center, near_pt)
            # Check if circle is strictly nested inside large outer arc vs colliding
            center_dist = _dist(center, [acx, acy])
            if center_dist + radius < ar - EPS:
                clearance = ar - (center_dist + radius)
                if clearance < min_clearance_mm - EPS and (
                    best_clearance is None or clearance < best_clearance[0]
                ):
                    best_clearance = (clearance, near_pt, arc_ent["id"])
            elif min_d <= radius + EPS:
                penetration = radius - min_d
                if best_collision is None or penetration > best_collision[0]:
                    best_collision = (penetration, near_pt, arc_ent["id"])
            else:
                clearance = min_d - radius
                if clearance < min_clearance_mm - EPS and (
                    best_clearance is None or clearance < best_clearance[0]
                ):
                    best_clearance = (clearance, near_pt, arc_ent["id"])

        if best_collision is not None:
            penetration, proj, eid = best_collision
            add_issue(
                "CIRCLE_COLLISION",
                "error",
                proj,
                [cid, eid],
                f"Circle '{cid}' collides with '{eid}' (overlap {penetration:.3f} mm).",
                (
                    f"Move circle '{cid}' center at least "
                    f"{radius + min_clearance_mm:.3f} mm away from '{eid}'."
                ),
                penetration,
            )
        elif best_clearance is not None:
            clearance, proj, eid = best_clearance
            add_issue(
                "MIN_CLEARANCE",
                "warning",
                proj,
                [cid, eid],
                (
                    f"Edge clearance from '{cid}' to '{eid}' is {clearance:.3f} mm "
                    f"(< {min_clearance_mm:.3f} mm)."
                ),
                (
                    f"Move circle '{cid}' center at least "
                    f"{radius + min_clearance_mm:.3f} mm inside '{eid}'."
                ),
                clearance,
            )

    # 6. Stray hole outside single enclosing outer profile & loop-boundary crossings
    loops = topo["loops"]
    for ids_a, ids_b in topo["crossing_loops"]:
        already_flagged = any(
            iss["code"]
            in {
                "INTERSECTING_CONTOURS",
                "CIRCLE_COLLISION",
                "DUPLICATE_GEOMETRY",
                "SHARED_EDGE_OVERLAP",
            }
            and any(ea in iss["entities"] for ea in ids_a)
            and any(eb in iss["entities"] for eb in ids_b)
            for iss in issues
        )
        if not already_flagged:
            add_issue(
                "INTERSECTING_CONTOURS",
                "error",
                [0.0, 0.0],
                [ids_a[0], ids_b[0]],
                f"Closed contours {ids_a} and {ids_b} intersect or touch at their boundaries.",
                "Separate touching contours so each cut profile is strictly disjoint or nested.",
            )
    non_circle_roots = [lp for lp in loops if lp["depth"] == 0 and lp["source"] != "circle"]
    if len(non_circle_roots) == 1 and not topo["open_components"]:
        outer = non_circle_roots[0]
        outer_id = outer["entity_ids"][0]
        for lp in loops:
            if lp["source"] == "circle" and lp["depth"] == 0 and lp["area"] < outer["area"] * 0.5:
                cid = lp["entity_ids"][0]
                already_colliding = any(
                    iss["code"] == "CIRCLE_COLLISION" and cid in iss["entities"] for iss in issues
                )
                if not already_colliding:
                    add_issue(
                        "OUTSIDE_OUTER_PROFILE",
                        "error" if manufacturing else "warning",
                        list(lp["center"]),
                        [cid, outer_id],
                        f"Circle '{cid}' lies outside closed outer profile '{outer_id}'.",
                        f"Move circle '{cid}' inside the bounds of '{outer_id}'.",
                    )

    if manufacturing:
        roots = [lp for lp in loops if lp["depth"] == 0]
        if len(roots) == 0:
            add_issue(
                "NO_CLOSED_PROFILE",
                "error",
                [0.0, 0.0],
                [],
                "No closed 2D outer profile found for part manufacturing.",
                "Create a closed outer contour before manufacturing export.",
            )
        elif len(roots) > 1:
            add_issue(
                "MULTIPLE_OUTER_PROFILES",
                "error",
                list(roots[1]["rep_point"]),
                roots[1]["entity_ids"],
                f"Found {len(roots)} disjoint outer profiles; single-part mode expects 1.",
                "Keep a single outer part boundary or move extra profiles to another file.",
            )
        for lp in loops:
            if lp["depth"] >= 2:
                add_issue(
                    "NESTED_ISLAND_UNSUPPORTED",
                    "error",
                    list(lp["rep_point"]),
                    lp["entity_ids"],
                    (
                        f"Nested island {lp['entity_ids']} inside a cutout drops out "
                        "during through-cutting."
                    ),
                    "Bridge nested islands with tabs or remove unsupported island contours.",
                )

    errors = sum(1 for item in issues if item["severity"] == "error")
    warnings = sum(1 for item in issues if item["severity"] == "warning")
    return {
        "valid": errors == 0,
        "profile": "manufacturing" if manufacturing else "drafting",
        "min_clearance_mm": round(min_clearance_mm, 4),
        "status": "passed"
        if errors == 0 and warnings == 0
        else ("warnings" if errors == 0 else "failed"),
        "summary": {
            "errors": errors,
            "warnings": warnings,
            "checked_entities": len(entities),
        },
        "issues": issues,
    }
