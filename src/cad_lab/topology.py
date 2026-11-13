"""Order-independent 2D planar contour topology, analytical curve intersections, and nesting."""

import math

EPS = 1e-6
CHAIN_TOL_MM = 1e-4


def cutting_layer_ids(drawing_data):
    """Return IDs of visible non-construction layers participating in physical geometry."""
    return {
        layer["id"]
        for layer in drawing_data.get("layers", [])
        if layer.get("visible", True) and not layer.get("construction", False)
    }


def arc_geometry(entity):
    """Return ((sx, sy), (mx, my), (ex, ey), sweep_deg) for a CCW arc entity."""
    cx, cy = float(entity["center"][0]), float(entity["center"][1])
    r = float(entity["radius"])
    sa = float(entity["start_angle"]) % 360.0
    ea = float(entity["end_angle"]) % 360.0
    sweep = (ea - sa) % 360.0
    mid_deg = (sa + sweep * 0.5) % 360.0
    sa_r = math.radians(sa)
    mid_r = math.radians(mid_deg)
    ea_r = math.radians(ea)
    p_start = (cx + r * math.cos(sa_r), cy + r * math.sin(sa_r))
    p_mid = (cx + r * math.cos(mid_r), cy + r * math.sin(mid_r))
    p_end = (cx + r * math.cos(ea_r), cy + r * math.sin(ea_r))
    return p_start, p_mid, p_end, sweep


def angle_on_arc_deg(ang_deg, sa_deg, ea_deg, tol_deg=1e-4):
    """Return True if ang_deg lies within CCW sweep [sa_deg, ea_deg] within tol_deg."""
    sa = float(sa_deg) % 360.0
    sweep = (float(ea_deg) - sa) % 360.0
    rel = (float(ang_deg) - sa) % 360.0
    if tol_deg >= 0.0:
        return rel <= sweep + tol_deg or rel >= 360.0 - tol_deg
    return (-tol_deg) < rel < (sweep + tol_deg)


def arc_overlap_span_deg(a1, a2):
    """Angular overlap in degrees (and midpoint angle) of two concentric equal-radius CCW arcs."""
    sa1, ea1 = float(a1["start_angle"]) % 360.0, float(a1["end_angle"]) % 360.0
    sa2, ea2 = float(a2["start_angle"]) % 360.0, float(a2["end_angle"]) % 360.0
    sw1 = (ea1 - sa1) % 360.0
    sw2 = (ea2 - sa2) % 360.0

    def _intervals(sa, sw):
        if sa + sw <= 360.0:
            return [(sa, sa + sw)]
        return [(sa, 360.0), (0.0, sa + sw - 360.0)]

    overlap = 0.0
    mid_angle = sa1
    for l1, r1 in _intervals(sa1, sw1):
        for l2, r2 in _intervals(sa2, sw2):
            lo = max(l1, l2)
            hi = min(r1, r2)
            if hi - lo > 1e-4:
                overlap += hi - lo
                mid_angle = (lo + hi) * 0.5
    return overlap, mid_angle


def point_to_segment_dist(pt, a, b):
    dx = b[0] - a[0]
    dy = b[1] - a[1]
    lsq = dx * dx + dy * dy
    if lsq <= EPS * EPS:
        return math.hypot(pt[0] - a[0], pt[1] - a[1])
    t = max(0.0, min(1.0, ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / lsq))
    return math.hypot(pt[0] - (a[0] + t * dx), pt[1] - (a[1] + t * dy))


def point_to_arc_dist_and_proj(pt, arc_ent):
    """Exact Euclidean distance and closest point from pt to a circular arc."""
    cx, cy = float(arc_ent["center"][0]), float(arc_ent["center"][1])
    r = float(arc_ent["radius"])
    dx = pt[0] - cx
    dy = pt[1] - cy
    dc = math.hypot(dx, dy)
    if dc > 1e-12:
        ang = math.degrees(math.atan2(dy, dx)) % 360.0
        if angle_on_arc_deg(ang, arc_ent["start_angle"], arc_ent["end_angle"], tol_deg=0.0):
            return abs(dc - r), [cx + r * dx / dc, cy + r * dy / dc]
    ps, _pm, pe, _sw = arc_geometry(arc_ent)
    ds = math.hypot(pt[0] - ps[0], pt[1] - ps[1])
    de = math.hypot(pt[0] - pe[0], pt[1] - pe[1])
    if ds <= de:
        return ds, [ps[0], ps[1]]
    return de, [pe[0], pe[1]]


def _near_any(pt, excluded_pts, tol=1e-4):
    return any(math.hypot(pt[0] - ex[0], pt[1] - ex[1]) <= tol for ex in excluded_pts)


def seg_seg_hits(a0, a1, b0, b1, exclude_pts=()):
    """Exact intersections (or colinear overlap midpoint) between two closed line segments."""
    rx, ry = a1[0] - a0[0], a1[1] - a0[1]
    sx, sy = b1[0] - b0[0], b1[1] - b0[1]
    len_a = math.hypot(rx, ry)
    len_b = math.hypot(sx, sy)
    if len_a <= EPS or len_b <= EPS:
        return []
    denom = rx * sy - ry * sx
    if abs(denom) <= 1e-9 * len_a * len_b:
        ux, uy = rx / len_a, ry / len_a
        for pt in (b0, b1):
            if abs((pt[0] - a0[0]) * uy - (pt[1] - a0[1]) * ux) > 1e-4:
                return []
        tc = (b0[0] - a0[0]) * ux + (b0[1] - a0[1]) * uy
        td = (b1[0] - a0[0]) * ux + (b1[1] - a0[1]) * uy
        lo = max(0.0, min(tc, td))
        hi = min(len_a, max(tc, td))
        if hi - lo > 1e-4:
            mid = 0.5 * (lo + hi)
            return [[a0[0] + mid * ux, a0[1] + mid * uy]]
        if hi >= lo - 1e-5:
            hit = [a0[0] + lo * ux, a0[1] + lo * uy]
            if not _near_any(hit, exclude_pts):
                return [hit]
        return []

    qpx, qpy = b0[0] - a0[0], b0[1] - a0[1]
    t = (qpx * sy - qpy * sx) / denom
    u = (qpx * ry - qpy * rx) / denom
    eps_t = 1e-5 / len_a
    eps_u = 1e-5 / len_b
    if -eps_t <= t <= 1.0 + eps_t and -eps_u <= u <= 1.0 + eps_u:
        ct = max(0.0, min(1.0, t))
        hit = [a0[0] + ct * rx, a0[1] + ct * ry]
        if not _near_any(hit, exclude_pts):
            return [hit]
    return []


def seg_circle_hits(p0, p1, center, radius, arc_ent=None, exclude_pts=()):
    """Exact intersections/tangencies between a line segment and a full circle or CCW arc."""
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    qa = dx * dx + dy * dy
    if qa <= EPS * EPS:
        return []
    len_ab = math.sqrt(qa)
    cx, cy = float(center[0]), float(center[1])
    r = float(radius)
    fx, fy = p0[0] - cx, p0[1] - cy
    qb = 2.0 * (fx * dx + fy * dy)
    qc = fx * fx + fy * fy - r * r
    disc = qb * qb - 4.0 * qa * qc
    tol_disc = 2e-5 * qa * max(1.0, r)
    if disc < -tol_disc:
        return []
    sqrt_d = math.sqrt(max(0.0, disc))
    eps_t = 1e-5 / len_ab
    hits = []
    candidates = (
        [(-qb) / (2.0 * qa)]
        if sqrt_d <= 1e-7 * len_ab
        else [
            (-qb - sqrt_d) / (2.0 * qa),
            (-qb + sqrt_d) / (2.0 * qa),
        ]
    )
    for t in candidates:
        if -eps_t <= t <= 1.0 + eps_t:
            ct = max(0.0, min(1.0, t))
            hit = [p0[0] + ct * dx, p0[1] + ct * dy]
            if _near_any(hit, exclude_pts):
                continue
            if arc_ent is not None:
                ang = math.degrees(math.atan2(hit[1] - cy, hit[0] - cx)) % 360.0
                tol_deg = math.degrees(1e-4 / max(r, 1e-3))
                if not angle_on_arc_deg(
                    ang, arc_ent["start_angle"], arc_ent["end_angle"], tol_deg=tol_deg
                ):
                    continue
            if not _near_any(hit, hits, tol=1e-4):
                hits.append(hit)
    return hits


def circle_circle_hits(c1, r1, c2, r2, arc1=None, arc2=None, exclude_pts=()):
    """Exact intersections/tangencies/overlaps between circles or circular arcs."""
    x1, y1 = float(c1[0]), float(c1[1])
    x2, y2 = float(c2[0]), float(c2[1])
    r1 = float(r1)
    r2 = float(r2)
    d = math.hypot(x2 - x1, y2 - y1)

    if d <= 1e-4:
        if abs(r1 - r2) > 1e-4:
            return []
        if arc1 is not None and arc2 is not None:
            ov_deg, mid_deg = arc_overlap_span_deg(arc1, arc2)
            if ov_deg > 1e-4:
                rad = math.radians(mid_deg)
                return [[x1 + r1 * math.cos(rad), y1 + r1 * math.sin(rad)]]
            # Check endpoint touch on concentric arcs
            ps1, _, pe1, _ = arc_geometry(arc1)
            ps2, _, pe2, _ = arc_geometry(arc2)
            pts = []
            for p_a in (ps1, pe1):
                for p_b in (ps2, pe2):
                    if math.dist(p_a, p_b) <= 1e-4 and not _near_any(p_a, exclude_pts):
                        pts.append([p_a[0], p_a[1]])
            return pts
        elif arc1 is not None:
            _, pm, _, _ = arc_geometry(arc1)
            return [[pm[0], pm[1]]]
        elif arc2 is not None:
            _, pm, _, _ = arc_geometry(arc2)
            return [[pm[0], pm[1]]]
        return [[x1 + r1, y1]]

    if d > r1 + r2 + 1e-5 or d < abs(r1 - r2) - 1e-5:
        return []

    a = (r1 * r1 - r2 * r2 + d * d) / (2.0 * d)
    h_sq = r1 * r1 - a * a
    if h_sq < -1e-4 * max(1.0, r1 * r1):
        return []
    h = math.sqrt(max(0.0, h_sq))
    ux, uy = (x2 - x1) / d, (y2 - y1) / d
    mx, my = x1 + a * ux, y1 + a * uy
    nx, ny = -uy, ux

    raw_pts = [[mx, my]] if h <= 1e-6 else [[mx + h * nx, my + h * ny], [mx - h * nx, my - h * ny]]
    hits = []
    tol_deg1 = math.degrees(1e-4 / max(r1, 1e-3))
    tol_deg2 = math.degrees(1e-4 / max(r2, 1e-3))
    for pt in raw_pts:
        if _near_any(pt, exclude_pts):
            continue
        if arc1 is not None:
            ang1 = math.degrees(math.atan2(pt[1] - y1, pt[0] - x1)) % 360.0
            if not angle_on_arc_deg(ang1, arc1["start_angle"], arc1["end_angle"], tol_deg=tol_deg1):
                continue
        if arc2 is not None:
            ang2 = math.degrees(math.atan2(pt[1] - y2, pt[0] - x2)) % 360.0
            if not angle_on_arc_deg(ang2, arc2["start_angle"], arc2["end_angle"], tol_deg=tol_deg2):
                continue
        if not _near_any(pt, hits, tol=1e-4):
            hits.append(pt)
    return hits


def arc_arc_min_distance(a1, a2):
    """Exact minimum Euclidean distance and closest midpoint between two non-intersecting arcs."""
    c1, r1 = a1["center"], float(a1["radius"])
    c2, r2 = a2["center"], float(a2["radius"])
    ps1, _, pe1, _ = arc_geometry(a1)
    ps2, _, pe2, _ = arc_geometry(a2)

    candidates_a1 = [ps1, pe1]
    candidates_a2 = [ps2, pe2]
    dx = c2[0] - c1[0]
    dy = c2[1] - c1[1]
    dc = math.hypot(dx, dy)
    if dc > 1e-9:
        base_deg = math.degrees(math.atan2(dy, dx)) % 360.0
        for deg in (base_deg, (base_deg + 180.0) % 360.0):
            rad = math.radians(deg)
            if angle_on_arc_deg(deg, a1["start_angle"], a1["end_angle"], tol_deg=0.0):
                candidates_a1.append((c1[0] + r1 * math.cos(rad), c1[1] + r1 * math.sin(rad)))
            if angle_on_arc_deg(deg, a2["start_angle"], a2["end_angle"], tol_deg=0.0):
                candidates_a2.append((c2[0] + r2 * math.cos(rad), c2[1] + r2 * math.sin(rad)))

    best_d = float("inf")
    best_mid = [0.0, 0.0]
    for pt in candidates_a1:
        d, proj = point_to_arc_dist_and_proj(pt, a2)
        if d < best_d:
            best_d = d
            best_mid = [(pt[0] + proj[0]) * 0.5, (pt[1] + proj[1]) * 0.5]
    for pt in candidates_a2:
        d, proj = point_to_arc_dist_and_proj(pt, a1)
        if d < best_d:
            best_d = d
            best_mid = [(pt[0] + proj[0]) * 0.5, (pt[1] + proj[1]) * 0.5]
    return best_d, best_mid


def _green_line_term(p0, p1):
    return 0.5 * (p0[0] * p1[1] - p1[0] * p0[1])


def _green_arc_term(cx, cy, r, start_deg, sweep_deg_signed):
    """Exact Green's theorem integral 0.5 * int (x dy - y dx) along a circular arc."""
    t1 = math.radians(start_deg)
    dt = math.radians(sweep_deg_signed)
    t2 = t1 + dt
    return 0.5 * (
        r * r * dt + cx * r * (math.sin(t2) - math.sin(t1)) - cy * r * (math.cos(t2) - math.cos(t1))
    )


def chain_signed_area(edges):
    """Exact analytical signed area enclosed by a closed sequence of line/arc edges."""
    total = 0.0
    for edge in edges:
        if edge["kind"] == "line":
            total += _green_line_term(edge["start"], edge["end"])
        elif edge["kind"] == "arc":
            ent = edge["entity"]
            cx, cy = float(ent["center"][0]), float(ent["center"][1])
            r = float(ent["radius"])
            sa = float(ent["start_angle"]) % 360.0
            ea = float(ent["end_angle"]) % 360.0
            sweep = (ea - sa) % 360.0
            if edge["forward"]:
                total += _green_arc_term(cx, cy, r, sa, sweep)
            else:
                total += _green_arc_term(cx, cy, r, ea, -sweep)
    return total


def point_on_loop_boundary(pt, loop, tol=1e-4):
    """Return True if pt lies within tol of loop's exact analytical boundary."""
    if loop["source"] == "circle":
        c = loop["center"]
        return abs(math.hypot(pt[0] - c[0], pt[1] - c[1]) - loop["radius"]) <= tol
    for edge in loop["edges"]:
        if edge["kind"] == "line":
            if point_to_segment_dist(pt, edge["start"], edge["end"]) <= tol:
                return True
        elif edge["kind"] == "arc":
            d, _ = point_to_arc_dist_and_proj(pt, edge["entity"])
            if d <= tol:
                return True
    return False


def point_strictly_inside_loop(pt, loop, tol=1e-4):
    """Exact analytical curve-aware interior predicate (zero polygon chord approximation)."""
    bx0, by0, bx1, by1 = loop["bbox"]
    if pt[0] <= bx0 + tol or pt[0] >= bx1 - tol or pt[1] <= by0 + tol or pt[1] >= by1 - tol:
        return False
    if loop["source"] == "circle":
        c = loop["center"]
        return math.hypot(pt[0] - c[0], pt[1] - c[1]) < loop["radius"] - tol
    if point_on_loop_boundary(pt, loop, tol=tol):
        return False

    # Choose a horizontal +X ray y_ray within (pt[1] - tol*0.25, pt[1] + tol*0.25) that avoids
    # every exact vertex y and horizontal arc tangent y = cy +- r. Since dist(pt, loop) > tol,
    # shifting y within tol*0.25 cannot cross any boundary curve.
    crit_ys = []
    for edge in loop["edges"]:
        crit_ys.append(edge["start"][1])
        crit_ys.append(edge["end"][1])
        if edge["kind"] == "arc":
            cy = float(edge["entity"]["center"][1])
            r = float(edge["entity"]["radius"])
            crit_ys.extend([cy - r, cy + r])

    step = min(1e-7, tol * 0.01)
    y_ray = float(pt[1]) + step * 1.37
    while any(abs(y_ray - cy_val) <= 1e-11 for cy_val in crit_ys):
        y_ray += step * 2.11

    px = float(pt[0])
    crossings = 0
    for edge in loop["edges"]:
        if edge["kind"] == "line":
            (x1, y1), (x2, y2) = edge["start"], edge["end"]
            if (y1 > y_ray) != (y2 > y_ray):
                x_hit = x1 + (y_ray - y1) * (x2 - x1) / (y2 - y1)
                if x_hit > px:
                    crossings += 1
        elif edge["kind"] == "arc":
            ent = edge["entity"]
            cx, cy = float(ent["center"][0]), float(ent["center"][1])
            r = float(ent["radius"])
            dy = y_ray - cy
            if abs(dy) < r:
                dx = math.sqrt(max(0.0, r * r - dy * dy))
                sa = float(ent["start_angle"]) % 360.0
                sweep = (float(ent["end_angle"]) - sa) % 360.0
                for x_cand in (cx - dx, cx + dx):
                    if x_cand > px:
                        ang = math.degrees(math.atan2(dy, x_cand - cx)) % 360.0
                        rel = (ang - sa) % 360.0
                        if 0.0 < rel < sweep:
                            crossings += 1
    return (crossings % 2) == 1


def _edges_intersect(e1, e2, exclude_pts=()):
    if e1["kind"] == "line" and e2["kind"] == "line":
        return seg_seg_hits(e1["start"], e1["end"], e2["start"], e2["end"], exclude_pts)
    if e1["kind"] == "line" and e2["kind"] == "arc":
        ent = e2["entity"]
        return seg_circle_hits(
            e1["start"], e1["end"], ent["center"], ent["radius"], ent, exclude_pts
        )
    if e1["kind"] == "arc" and e2["kind"] == "line":
        ent = e1["entity"]
        return seg_circle_hits(
            e2["start"], e2["end"], ent["center"], ent["radius"], ent, exclude_pts
        )
    a1, a2 = e1["entity"], e2["entity"]
    return circle_circle_hits(
        a1["center"], a1["radius"], a2["center"], a2["radius"], a1, a2, exclude_pts
    )


def _chained_loop_self_hit(edges):
    n = len(edges)
    for edge in edges:
        if edge["kind"] == "line" and math.dist(edge["start"], edge["end"]) <= 1e-4:
            return list(edge["start"])
    for i in range(n):
        for j in range(i + 1, n):
            excluded = []
            if j == i + 1:
                excluded.append(edges[i]["end"])
            if i == 0 and j == n - 1:
                excluded.append(edges[n - 1]["end"])
            hits = _edges_intersect(edges[i], edges[j], exclude_pts=excluded)
            if hits:
                return hits[0]
    return None


def _bboxes_overlap(b1, b2, pad=1e-4):
    return not (
        b1[2] + pad < b2[0] or b2[2] + pad < b1[0] or b1[3] + pad < b2[1] or b2[3] + pad < b1[1]
    )


def loops_intersect(la, lb):
    """Exact analytical boundary intersection / tangency test between two closed loops."""
    if not _bboxes_overlap(la["bbox"], lb["bbox"], pad=1e-4):
        return False
    if la["source"] == "circle" and lb["source"] == "circle":
        return bool(circle_circle_hits(la["center"], la["radius"], lb["center"], lb["radius"]))
    if la["source"] == "circle":
        c, r = la["center"], la["radius"]
        for edge in lb["edges"]:
            if edge["kind"] == "line":
                if seg_circle_hits(edge["start"], edge["end"], c, r):
                    return True
            else:
                ent = edge["entity"]
                if circle_circle_hits(c, r, ent["center"], ent["radius"], None, ent):
                    return True
        return False
    if lb["source"] == "circle":
        return loops_intersect(lb, la)

    for e1 in la["edges"]:
        for e2 in lb["edges"]:
            if _edges_intersect(e1, e2):
                return True
    return False


def _loop_bbox(loop):
    xs, ys = [], []
    if loop["source"] == "circle":
        cx, cy = loop["center"]
        r = loop["radius"]
        return (cx - r, cy - r, cx + r, cy + r)
    for edge in loop["edges"]:
        xs.extend([edge["start"][0], edge["end"][0]])
        ys.extend([edge["start"][1], edge["end"][1]])
        if edge["kind"] == "arc":
            ent = edge["entity"]
            cx, cy = ent["center"]
            r = ent["radius"]
            sa = ent["start_angle"] % 360.0
            sweep = (ent["end_angle"] - sa) % 360.0
            if edge["mid"] is not None:
                xs.append(edge["mid"][0])
                ys.append(edge["mid"][1])
            for q in (0.0, 90.0, 180.0, 270.0):
                if ((q - sa) % 360.0) <= sweep + 1e-6:
                    xs.append(cx + r * math.cos(math.radians(q)))
                    ys.append(cy + r * math.sin(math.radians(q)))
    return (min(xs), min(ys), max(xs), max(ys))


def _canonical_edge_sort_key(edge):
    p0, p1 = edge["p0"], edge["p1"]
    lo, hi = (p0, p1) if p0 <= p1 else (p1, p0)
    mid = edge["mid"] or ((p0[0] + p1[0]) * 0.5, (p0[1] + p1[1]) * 0.5)
    return (
        round(lo[0], 5),
        round(lo[1], 5),
        round(hi[0], 5),
        round(hi[1], 5),
        edge["kind"],
        round(mid[0], 5),
        round(mid[1], 5),
    )


def analyze_drawing_topology(drawing_data, chain_tol=CHAIN_TOL_MM):
    """Extract order-independent closed loops, exact containment hierarchy, and invalid cuts."""
    cut_layers = cutting_layer_ids(drawing_data)
    cutting_entities = [
        e
        for e in drawing_data.get("entities", [])
        if e["layer"] in cut_layers and e["type"] not in {"dim", "text"}
    ]

    loops = []
    graph_primitives = []
    branched_components = []

    for ent in cutting_entities:
        kind = ent["type"]
        if kind == "circle":
            cx, cy = float(ent["center"][0]), float(ent["center"][1])
            r = float(ent["radius"])
            loop = {
                "source": "circle",
                "center": (cx, cy),
                "radius": r,
                "area": math.pi * r * r,
                "perimeter": 2.0 * math.pi * r,
                "entity_ids": [ent["id"]],
                "edges": [],
                "rep_point": (cx + r, cy),
            }
            loop["bbox"] = _loop_bbox(loop)
            loops.append(loop)
        elif kind == "polyline" and ent.get("closed"):
            pts = [(float(p[0]), float(p[1])) for p in ent["points"]]
            edges = [
                {
                    "kind": "line",
                    "start": pts[i],
                    "mid": None,
                    "end": pts[(i + 1) % len(pts)],
                    "entity": ent,
                    "forward": True,
                }
                for i in range(len(pts))
            ]
            self_hit = _chained_loop_self_hit(edges)
            if self_hit is not None:
                branched_components.append(
                    {
                        "entity_ids": [ent["id"]],
                        "junction_points": [list(self_hit)],
                        "reason": "self_intersecting_loop",
                    }
                )
                continue
            area = abs(chain_signed_area(edges))
            if area <= 1e-4:
                branched_components.append(
                    {
                        "entity_ids": [ent["id"]],
                        "junction_points": [list(pts[0])] if pts else [[0.0, 0.0]],
                        "reason": "zero_area_degenerate_loop",
                    }
                )
                continue
            perim = sum(math.dist(e["start"], e["end"]) for e in edges)
            loop = {
                "source": "polyline",
                "points": pts,
                "area": area,
                "perimeter": perim,
                "entity_ids": [ent["id"]],
                "edges": edges,
                "rep_point": pts[0],
            }
            loop["bbox"] = _loop_bbox(loop)
            loops.append(loop)
        elif kind == "polyline" and not ent.get("closed"):
            pts = [(float(p[0]), float(p[1])) for p in ent["points"]]
            for i in range(len(pts) - 1):
                graph_primitives.append(
                    {
                        "kind": "line",
                        "p0": pts[i],
                        "mid": None,
                        "p1": pts[i + 1],
                        "length": math.dist(pts[i], pts[i + 1]),
                        "entity": ent,
                        "entity_id": ent["id"],
                    }
                )
        elif kind == "line":
            p0 = (float(ent["points"][0][0]), float(ent["points"][0][1]))
            p1 = (float(ent["points"][1][0]), float(ent["points"][1][1]))
            graph_primitives.append(
                {
                    "kind": "line",
                    "p0": p0,
                    "mid": None,
                    "p1": p1,
                    "length": math.dist(p0, p1),
                    "entity": ent,
                    "entity_id": ent["id"],
                }
            )
        elif kind == "arc":
            ps, pm, pe, sweep = arc_geometry(ent)
            graph_primitives.append(
                {
                    "kind": "arc",
                    "p0": ps,
                    "mid": pm,
                    "p1": pe,
                    "length": float(ent["radius"]) * math.radians(sweep),
                    "entity": ent,
                    "entity_id": ent["id"],
                }
            )

    sorted_prims = sorted(graph_primitives, key=_canonical_edge_sort_key)

    raw_endpoints = []
    for idx, prim in enumerate(sorted_prims):
        raw_endpoints.append((round(prim["p0"][0], 6), round(prim["p0"][1], 6), prim["p0"], idx, 0))
        raw_endpoints.append((round(prim["p1"][0], 6), round(prim["p1"][1], 6), prim["p1"], idx, 1))
    raw_endpoints.sort(key=lambda item: (item[0], item[1]))

    vertices = []
    prim_v = [[None, None] for _ in sorted_prims]

    for _rx, _ry, pt, p_idx, end_slot in raw_endpoints:
        matched_v = None
        best_d = chain_tol
        for v_idx, v_pt in enumerate(vertices):
            d = math.hypot(pt[0] - v_pt[0], pt[1] - v_pt[1])
            if d <= best_d:
                best_d = d
                matched_v = v_idx
        if matched_v is None:
            matched_v = len(vertices)
            vertices.append(pt)
        prim_v[p_idx][end_slot] = matched_v

    adj = {i: [] for i in range(len(vertices))}
    for p_idx, (u, v) in enumerate(prim_v):
        adj[u].append((v, p_idx))
        adj[v].append((u, p_idx))

    visited_v = [False] * len(vertices)
    visited_e = [False] * len(sorted_prims)
    open_components = []

    for start_v in range(len(vertices)):
        if visited_v[start_v] or not adj[start_v]:
            continue
        comp_v = []
        comp_e = set()
        queue = [start_v]
        visited_v[start_v] = True
        while queue:
            curr = queue.pop()
            comp_v.append(curr)
            for nxt, e_idx in adj[curr]:
                comp_e.add(e_idx)
                if not visited_v[nxt]:
                    visited_v[nxt] = True
                    queue.append(nxt)
        for e_idx in comp_e:
            visited_e[e_idx] = True

        degrees = {v: len(adj[v]) for v in comp_v}
        e_ids = sorted({sorted_prims[e_idx]["entity_id"] for e_idx in comp_e})

        if any(deg > 2 for deg in degrees.values()):
            junctions = [list(vertices[v]) for v, deg in degrees.items() if deg > 2]
            branched_components.append(
                {
                    "entity_ids": e_ids,
                    "junction_points": junctions,
                    "reason": "branch_junction",
                }
            )
            continue

        if any(deg != 2 for deg in degrees.values()):
            end_pts = [list(vertices[v]) for v, deg in degrees.items() if deg == 1]
            open_components.append(
                {
                    "entity_ids": e_ids,
                    "endpoints": end_pts,
                }
            )
            continue

        ordered_edges = []
        used_comp_e = set()
        curr_v = min(comp_v, key=lambda v: vertices[v])
        origin_v = curr_v
        while len(used_comp_e) < len(comp_e):
            candidates = [e_idx for _nbr, e_idx in adj[curr_v] if e_idx not in used_comp_e]
            if not candidates:
                break
            e_idx = min(candidates)
            used_comp_e.add(e_idx)
            prim = sorted_prims[e_idx]
            u, v = prim_v[e_idx]
            if curr_v == u:
                fwd = True
                next_v = v
            else:
                fwd = False
                next_v = u
            ordered_edges.append(
                {
                    "kind": prim["kind"],
                    "start": vertices[curr_v],
                    "mid": prim["mid"],
                    "end": vertices[next_v],
                    "entity": prim["entity"],
                    "forward": fwd,
                }
            )
            curr_v = next_v
            if curr_v == origin_v and len(used_comp_e) == len(comp_e):
                break

        area = abs(chain_signed_area(ordered_edges))
        perim = sum(sorted_prims[e_idx]["length"] for e_idx in comp_e)
        if area <= 1e-4:
            branched_components.append(
                {
                    "entity_ids": e_ids,
                    "junction_points": [list(vertices[origin_v])],
                    "reason": "zero_area_degenerate_loop",
                }
            )
            continue

        self_hit = _chained_loop_self_hit(ordered_edges)
        if self_hit is not None:
            branched_components.append(
                {
                    "entity_ids": e_ids,
                    "junction_points": [list(self_hit)],
                    "reason": "self_intersecting_loop",
                }
            )
            continue

        loop = {
            "source": "chained",
            "area": area,
            "perimeter": perim,
            "entity_ids": e_ids,
            "edges": ordered_edges,
            "rep_point": ordered_edges[0]["start"],
        }
        loop["bbox"] = _loop_bbox(loop)
        loops.append(loop)

    loops.sort(key=lambda item: item["area"], reverse=True)

    # Exact analytical boundary-to-boundary intersection / tangency check among closed loops
    crossing_loops = []
    n_loops = len(loops)
    for i in range(n_loops):
        for j in range(i + 1, n_loops):
            if loops_intersect(loops[i], loops[j]):
                crossing_loops.append((loops[i]["entity_ids"], loops[j]["entity_ids"]))

    # Build exact containment tree (parent = smallest-area ancestor strictly containing loop)
    for idx, loop in enumerate(loops):
        ancestors = []
        probe = loop["rep_point"]
        for anc_idx in range(idx):
            anc = loops[anc_idx]
            if anc["area"] <= loop["area"] + EPS:
                continue
            if point_strictly_inside_loop(probe, anc, tol=1e-4):
                ancestors.append(anc_idx)
        loop["depth"] = len(ancestors)
        loop["parent_idx"] = ancestors[-1] if ancestors else None

    return {
        "loops": loops,
        "outer_loops": [lp for lp in loops if lp["depth"] == 0],
        "hole_loops": [lp for lp in loops if lp["depth"] == 1],
        "island_loops": [lp for lp in loops if lp["depth"] >= 2],
        "open_components": open_components,
        "branched_components": branched_components,
        "crossing_loops": crossing_loops,
        "cutting_entities": cutting_entities,
    }
