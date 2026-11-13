"""Analytical 2D geometric modification operators: CHAMFER, FILLET, TRIM, ROTATE, MIRROR, ARRAY."""

import copy
import math
import uuid

from cad_lab.project import ProjectError

EPS = 1e-6
LIMIT = 1e6


def _round_pt(pt):
    return [round(float(pt[0]), 6), round(float(pt[1]), 6)]


def _dist(a, b):
    return math.hypot(b[0] - a[0], b[1] - a[1])


def _rotate_pt(pt, base, rad):
    dx = pt[0] - base[0]
    dy = pt[1] - base[1]
    c = math.cos(rad)
    s = math.sin(rad)
    return _round_pt([base[0] + dx * c - dy * s, base[1] + dx * s + dy * c])


def _reflect_pt(pt, p1, p2):
    vx = p2[0] - p1[0]
    vy = p2[1] - p1[1]
    seg_len2 = vx * vx + vy * vy
    if seg_len2 <= EPS * EPS:
        raise ProjectError("Mirror axis points must be distinct.")
    wx = pt[0] - p1[0]
    wy = pt[1] - p1[1]
    proj = (wx * vx + wy * vy) / seg_len2
    foot_x = p1[0] + proj * vx
    foot_y = p1[1] + proj * vy
    return _round_pt([2.0 * foot_x - pt[0], 2.0 * foot_y - pt[1]])


def rotate_entity(entity, base_pt, angle_deg):
    """Return a rotated copy of an entity around base_pt by angle_deg CCW."""
    rad = math.radians(angle_deg)
    out = copy.deepcopy(entity)
    kind = out["type"]
    if kind == "circle":
        out["center"] = _rotate_pt(out["center"], base_pt, rad)
    elif kind == "arc":
        out["center"] = _rotate_pt(out["center"], base_pt, rad)
        out["start_angle"] = round((out["start_angle"] + angle_deg) % 360.0, 6)
        out["end_angle"] = round((out["end_angle"] + angle_deg) % 360.0, 6)
    elif kind == "dim":
        out["p1"] = _rotate_pt(out["p1"], base_pt, rad)
        out["p2"] = _rotate_pt(out["p2"], base_pt, rad)
        out["dim_point"] = _rotate_pt(out["dim_point"], base_pt, rad)
    elif kind == "text":
        out["position"] = _rotate_pt(out["position"], base_pt, rad)
        out["rotation"] = round((out.get("rotation", 0.0) + angle_deg) % 360.0, 6)
    else:
        out["points"] = [_rotate_pt(p, base_pt, rad) for p in out["points"]]
    return out


def mirror_entity(entity, axis_p1, axis_p2):
    """Return a reflected copy of an entity across the infinite line through axis_p1 -> axis_p2."""
    if _dist(axis_p1, axis_p2) <= EPS:
        raise ProjectError("Mirror axis requires two distinct points.")
    axis_deg = math.degrees(math.atan2(axis_p2[1] - axis_p1[1], axis_p2[0] - axis_p1[0]))
    out = copy.deepcopy(entity)
    kind = out["type"]
    if kind == "circle":
        out["center"] = _reflect_pt(out["center"], axis_p1, axis_p2)
    elif kind == "arc":
        out["center"] = _reflect_pt(out["center"], axis_p1, axis_p2)
        old_s = out["start_angle"]
        old_e = out["end_angle"]
        out["start_angle"] = round((2.0 * axis_deg - old_e) % 360.0, 6)
        out["end_angle"] = round((2.0 * axis_deg - old_s) % 360.0, 6)
    elif kind == "dim":
        out["p1"] = _reflect_pt(out["p1"], axis_p1, axis_p2)
        out["p2"] = _reflect_pt(out["p2"], axis_p1, axis_p2)
        out["dim_point"] = _reflect_pt(out["dim_point"], axis_p1, axis_p2)
    elif kind == "text":
        out["position"] = _reflect_pt(out["position"], axis_p1, axis_p2)
        old_rot = out.get("rotation", 0.0)
        out["rotation"] = round((2.0 * axis_deg - old_rot) % 360.0, 6)
    else:
        out["points"] = [_reflect_pt(p, axis_p1, axis_p2) for p in out["points"]]
    return out


def _infinite_line_intersection(a1, a2, b1, b2):
    d1x, d1y = a2[0] - a1[0], a2[1] - a1[1]
    d2x, d2y = b2[0] - b1[0], b2[1] - b1[1]
    cross = d1x * d2y - d1y * d2x
    if abs(cross) <= 1e-9:
        raise ProjectError("Lines are parallel or collinear; no corner intersection exists.")
    qpx, qpy = b1[0] - a1[0], b1[1] - a1[1]
    t = (qpx * d2y - qpy * d2x) / cross
    return [a1[0] + t * d1x, a1[1] + t * d1y]


def _select_kept_endpoint(line_entity, inter_pt, keep_pt=None):
    p0, p1 = line_entity["points"]
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    seg_len2 = dx * dx + dy * dy
    d0 = _dist(p0, inter_pt)
    d1 = _dist(p1, inter_pt)
    if keep_pt is not None:
        v0 = (p0[0] - inter_pt[0]) * (keep_pt[0] - inter_pt[0]) + (p0[1] - inter_pt[1]) * (
            keep_pt[1] - inter_pt[1]
        )
        v1 = (p1[0] - inter_pt[0]) * (keep_pt[0] - inter_pt[0]) + (p1[1] - inter_pt[1]) * (
            keep_pt[1] - inter_pt[1]
        )
        if abs(v0 - v1) <= 1e-9:
            raise ProjectError("Keep-side pick point lies on the intersection.")
        if v0 > v1:
            return 0, p0, 1, d0
        return 1, p1, 0, d1

    t = ((inter_pt[0] - p0[0]) * dx + (inter_pt[1] - p0[1]) * dy) / max(seg_len2, 1e-12)
    # If intersection lies strictly inside the segment, quadrant choice is ambiguous.
    if d0 > 1e-3 and d1 > 1e-3 and 0.0 < t < 1.0:
        raise ProjectError(
            f"Ambiguous crossing on line '{line_entity.get('id', '')}': trim to an L-corner "
            "or specify keep-side points."
        )
    if d0 >= d1:
        return 0, p0, 1, d0
    return 1, p1, 0, d1


def chamfer_two_lines(line1, line2, d1, d2=None, keep_pts=None):
    """Trim two intersecting lines back from their corner by d1, d2 and return bevel points."""
    if d2 is None:
        d2 = d1
    if d1 <= EPS or d2 <= EPS:
        raise ProjectError("Chamfer distances must be positive.")
    inter = _infinite_line_intersection(
        line1["points"][0], line1["points"][1], line2["points"][0], line2["points"][1]
    )
    kp1 = keep_pts[0] if keep_pts else None
    kp2 = keep_pts[1] if keep_pts else None
    _, far1, trim_idx1, len1 = _select_kept_endpoint(line1, inter, kp1)
    _, far2, trim_idx2, len2 = _select_kept_endpoint(line2, inter, kp2)
    if len1 <= d1 + 1e-4 or len2 <= d2 + 1e-4:
        raise ProjectError("Chamfer distance exceeds available line length.")
    u1 = [(far1[0] - inter[0]) / len1, (far1[1] - inter[1]) / len1]
    u2 = [(far2[0] - inter[0]) / len2, (far2[1] - inter[1]) / len2]
    t1 = _round_pt([inter[0] + d1 * u1[0], inter[1] + d1 * u1[1]])
    t2 = _round_pt([inter[0] + d2 * u2[0], inter[1] + d2 * u2[1]])
    if _dist(t1, t2) <= EPS:
        raise ProjectError("Degenerate chamfer bevel.")
    new_l1 = copy.deepcopy(line1)
    new_l2 = copy.deepcopy(line2)
    new_l1["points"][trim_idx1] = t1
    new_l2["points"][trim_idx2] = t2
    return new_l1, new_l2, [t1, t2]


def chamfer_polyline(entity, d1, d2=None):
    """Bevel corners of an open or closed polyline by incoming d1 and outgoing d2."""
    if d2 is None:
        d2 = d1
    if d1 <= EPS or d2 <= EPS:
        raise ProjectError("Chamfer distances must be positive.")
    pts = entity["points"]
    closed = entity["closed"]
    n = len(pts)
    if n < 3:
        raise ProjectError("Polyline requires at least 3 vertices to chamfer.")

    seg_count = n if closed else n - 1
    seg_lens = [_dist(pts[i], pts[(i + 1) % n]) for i in range(seg_count)]

    corner_flags = [False] * n
    for i in range(n):
        if not closed and (i == 0 or i == n - 1):
            continue
        prev_pt = pts[(i - 1) % n]
        curr_pt = pts[i]
        next_pt = pts[(i + 1) % n]
        v_in = [curr_pt[0] - prev_pt[0], curr_pt[1] - prev_pt[1]]
        v_out = [next_pt[0] - curr_pt[0], next_pt[1] - curr_pt[1]]
        l_in = math.hypot(*v_in)
        l_out = math.hypot(*v_out)
        if l_in <= EPS or l_out <= EPS:
            continue
        cross = abs(v_in[0] * v_out[1] - v_in[1] * v_out[0]) / (l_in * l_out)
        if cross > 1e-4:
            corner_flags[i] = True

    if not any(corner_flags):
        raise ProjectError("Polyline has no non-collinear corners to chamfer.")

    for s_idx in range(seg_count):
        start_v = s_idx
        end_v = (s_idx + 1) % n
        needed = (d2 if corner_flags[start_v] else 0.0) + (d1 if corner_flags[end_v] else 0.0)
        if seg_lens[s_idx] <= needed + 1e-4:
            raise ProjectError("Chamfer distance exceeds polyline edge length.")

    new_pts = []
    for i in range(n):
        if not corner_flags[i]:
            new_pts.append(_round_pt(pts[i]))
            continue
        prev_pt = pts[(i - 1) % n]
        curr_pt = pts[i]
        next_pt = pts[(i + 1) % n]
        l_in = _dist(prev_pt, curr_pt)
        l_out = _dist(curr_pt, next_pt)
        p_in = _round_pt(
            [
                curr_pt[0] - d1 * (curr_pt[0] - prev_pt[0]) / l_in,
                curr_pt[1] - d1 * (curr_pt[1] - prev_pt[1]) / l_in,
            ]
        )
        p_out = _round_pt(
            [
                curr_pt[0] + d2 * (next_pt[0] - curr_pt[0]) / l_out,
                curr_pt[1] + d2 * (next_pt[1] - curr_pt[1]) / l_out,
            ]
        )
        new_pts.append(p_in)
        new_pts.append(p_out)

    updated = copy.deepcopy(entity)
    updated["points"] = new_pts
    return updated


def _corner_fillet_geom(inter, u1, len1, u2, len2, radius):
    dot = max(-1.0, min(1.0, u1[0] * u2[0] + u1[1] * u2[1]))
    theta = math.acos(dot)
    if theta <= 1e-4 or abs(math.pi - theta) <= 1e-4:
        raise ProjectError("Cannot fillet collinear or parallel segments.")
    half = theta / 2.0
    t_dist = radius / math.tan(half)
    if len1 <= t_dist + 1e-4 or len2 <= t_dist + 1e-4:
        raise ProjectError("Fillet radius exceeds available edge length.")
    c_dist = radius / math.sin(half)
    bx, by = u1[0] + u2[0], u1[1] + u2[1]
    b_len = math.hypot(bx, by)
    center = _round_pt([inter[0] + c_dist * bx / b_len, inter[1] + c_dist * by / b_len])
    t1 = _round_pt([inter[0] + t_dist * u1[0], inter[1] + t_dist * u1[1]])
    t2 = _round_pt([inter[0] + t_dist * u2[0], inter[1] + t_dist * u2[1]])
    a1 = math.degrees(math.atan2(t1[1] - center[1], t1[0] - center[0])) % 360.0
    a2 = math.degrees(math.atan2(t2[1] - center[1], t2[0] - center[0])) % 360.0
    if ((a2 - a1) % 360.0) < 180.0:
        sa, ea = a1, a2
    else:
        sa, ea = a2, a1
    arc_spec = {
        "center": center,
        "radius": round(float(radius), 6),
        "start_angle": round(sa, 6),
        "end_angle": round(ea, 6),
    }
    return t1, t2, t_dist, arc_spec


def fillet_two_lines(line1, line2, radius, keep_pts=None):
    """Trim two intersecting lines and construct a tangent circular ARC between them."""
    if radius <= EPS:
        raise ProjectError("Fillet radius must be positive.")
    inter = _infinite_line_intersection(
        line1["points"][0], line1["points"][1], line2["points"][0], line2["points"][1]
    )
    kp1 = keep_pts[0] if keep_pts else None
    kp2 = keep_pts[1] if keep_pts else None
    _, far1, trim_idx1, len1 = _select_kept_endpoint(line1, inter, kp1)
    _, far2, trim_idx2, len2 = _select_kept_endpoint(line2, inter, kp2)
    u1 = [(far1[0] - inter[0]) / len1, (far1[1] - inter[1]) / len1]
    u2 = [(far2[0] - inter[0]) / len2, (far2[1] - inter[1]) / len2]
    t1, t2, _, arc_spec = _corner_fillet_geom(inter, u1, len1, u2, len2, radius)
    new_l1 = copy.deepcopy(line1)
    new_l2 = copy.deepcopy(line2)
    new_l1["points"][trim_idx1] = t1
    new_l2["points"][trim_idx2] = t2
    return new_l1, new_l2, arc_spec


def fillet_polyline_to_primitives(entity, radius, base_id):
    """Convert a polyline's sharp corners into watertight trimmed LINEs + tangent ARCs."""
    if radius <= EPS:
        raise ProjectError("Fillet radius must be positive.")
    pts = list(entity["points"])
    closed = entity["closed"]
    if closed and len(pts) >= 4 and _dist(pts[0], pts[-1]) <= EPS:
        pts = pts[:-1]
    n = len(pts)
    if n < 3:
        raise ProjectError("Polyline requires at least 3 vertices to fillet.")
    seg_count = n if closed else n - 1
    seg_lens = [_dist(pts[i], pts[(i + 1) % n]) for i in range(seg_count)]
    if any(seg_len <= EPS for seg_len in seg_lens):
        raise ProjectError("Polyline contains a zero-length segment.")

    corner_data = {}
    for i in range(n):
        if not closed and (i == 0 or i == n - 1):
            continue
        prev_pt = pts[(i - 1) % n]
        curr_pt = pts[i]
        next_pt = pts[(i + 1) % n]
        l_prev = _dist(curr_pt, prev_pt)
        l_next = _dist(curr_pt, next_pt)
        u_prev = [(prev_pt[0] - curr_pt[0]) / l_prev, (prev_pt[1] - curr_pt[1]) / l_prev]
        u_next = [(next_pt[0] - curr_pt[0]) / l_next, (next_pt[1] - curr_pt[1]) / l_next]
        cross = abs(u_prev[0] * u_next[1] - u_prev[1] * u_next[0])
        if cross <= 1e-4:
            continue
        t_in, t_out, t_dist, arc_spec = _corner_fillet_geom(
            curr_pt, u_prev, l_prev, u_next, l_next, radius
        )
        corner_data[i] = (t_in, t_out, t_dist, arc_spec)

    if not corner_data:
        raise ProjectError("Polyline has no non-collinear corners to fillet.")

    for s_idx in range(seg_count):
        v_start = s_idx
        v_end = (s_idx + 1) % n
        trim_s = corner_data[v_start][2] if v_start in corner_data else 0.0
        trim_e = corner_data[v_end][2] if v_end in corner_data else 0.0
        if seg_lens[s_idx] <= trim_s + trim_e + 1e-4:
            raise ProjectError("Fillet radius exceeds polyline edge length.")

    layer = entity["layer"]
    generated = []
    for s_idx in range(seg_count):
        v_start = s_idx
        v_end = (s_idx + 1) % n
        p_a = corner_data[v_start][1] if v_start in corner_data else _round_pt(pts[v_start])
        p_b = corner_data[v_end][0] if v_end in corner_data else _round_pt(pts[v_end])
        generated.append(
            {
                "id": f"{base_id}-edge-{s_idx + 1}",
                "layer": layer,
                "type": "line",
                "points": [p_a, p_b],
            }
        )
        if v_end in corner_data:
            generated.append(
                {
                    "id": f"{base_id}-fillet-{v_end + 1}",
                    "layer": layer,
                    "type": "arc",
                    **corner_data[v_end][3],
                }
            )
    return generated


def _segment_segment_t(a, b, c, d):
    rx, ry = b[0] - a[0], b[1] - a[1]
    sx, sy = d[0] - c[0], d[1] - c[1]
    len_ab = math.hypot(rx, ry)
    len_cd = math.hypot(sx, sy)
    if len_ab <= EPS or len_cd <= EPS:
        return []
    denom = rx * sy - ry * sx
    # Parallel / collinear check normalized by segment lengths
    if abs(denom) <= 1e-9 * len_ab * len_cd:
        return []
    qpx, qpy = c[0] - a[0], c[1] - a[1]
    t = (qpx * sy - qpy * sx) / denom
    u = (qpx * ry - qpy * rx) / denom
    eps_t = min(0.05, 1e-4 / len_ab)
    eps_u = min(0.05, 1e-4 / len_cd)
    if eps_t < t < 1.0 - eps_t and -eps_u <= u <= 1.0 + eps_u:
        return [t]
    return []


def _segment_circle_t(a, b, center, radius, arc_angles=None):
    dx, dy = b[0] - a[0], b[1] - a[1]
    fx, fy = a[0] - center[0], a[1] - center[1]
    qa = dx * dx + dy * dy
    if qa <= EPS * EPS:
        return []
    len_ab = math.sqrt(qa)
    eps_t = min(0.05, 1e-4 / len_ab)
    qb = 2.0 * (fx * dx + fy * dy)
    qc = fx * fx + fy * fy - radius * radius
    disc = qb * qb - 4.0 * qa * qc
    if disc < -1e-9 * qa:
        return []
    disc = max(0.0, disc)
    sqrt_d = math.sqrt(disc)
    ts = []
    for sign in (-1.0, 1.0):
        t = (-qb + sign * sqrt_d) / (2.0 * qa)
        if eps_t < t < 1.0 - eps_t:
            if arc_angles is not None:
                px, py = a[0] + t * dx, a[1] + t * dy
                ang = math.degrees(math.atan2(py - center[1], px - center[0])) % 360.0
                sa, ea = arc_angles
                sweep = (ea - sa) % 360.0
                rel = (ang - sa) % 360.0
                if rel > sweep + 1e-4 and rel < 360.0 - 1e-4:
                    continue
            ts.append(t)
    return ts


def trim_line_entity(target_line, pick_pt, cutting_entities):
    """Trim the sub-segment of target_line closest to pick_pt bounded by cutting_entities."""
    a, b = target_line["points"]
    seg_len = _dist(a, b)
    if seg_len <= EPS:
        raise ProjectError("Degenerate target line.")

    eps_t = min(0.05, 1e-4 / seg_len)
    cuts = [0.0, 1.0]
    for other in cutting_entities:
        if other["id"] == target_line["id"]:
            continue
        kind = other["type"]
        if kind in {"dim", "text"}:
            continue
        if kind == "line":
            cuts.extend(_segment_segment_t(a, b, other["points"][0], other["points"][1]))
        elif kind == "polyline":
            pts = other["points"]
            cnt = len(pts) if other["closed"] else len(pts) - 1
            for i in range(cnt):
                cuts.extend(_segment_segment_t(a, b, pts[i], pts[(i + 1) % len(pts)]))
        elif kind == "circle":
            cuts.extend(_segment_circle_t(a, b, other["center"], other["radius"]))
        elif kind == "arc":
            cuts.extend(
                _segment_circle_t(
                    a,
                    b,
                    other["center"],
                    other["radius"],
                    (other["start_angle"], other["end_angle"]),
                )
            )

    sorted_t = [0.0]
    for val in sorted(cuts):
        if val - sorted_t[-1] > eps_t:
            sorted_t.append(val)
    if 1.0 - sorted_t[-1] > eps_t:
        sorted_t.append(1.0)
    else:
        sorted_t[-1] = 1.0

    if len(sorted_t) <= 2:
        raise ProjectError("Target line has no cutting intersections to trim against.")

    dx, dy = b[0] - a[0], b[1] - a[1]
    t_pick = ((pick_pt[0] - a[0]) * dx + (pick_pt[1] - a[1]) * dy) / (seg_len * seg_len)
    t_pick = max(0.0, min(1.0, t_pick))

    for cut_t in sorted_t[1:-1]:
        if abs(t_pick - cut_t) <= eps_t:
            raise ProjectError(
                "Pick point lies directly on a cutting intersection; click the span to remove."
            )

    drop_idx = 0
    for idx in range(len(sorted_t) - 1):
        if sorted_t[idx] <= t_pick <= sorted_t[idx + 1]:
            drop_idx = idx
            break

    def pt_at(param):
        return _round_pt([a[0] + param * dx, a[1] + param * dy])

    t_lo, t_hi = sorted_t[drop_idx], sorted_t[drop_idx + 1]
    if t_lo <= eps_t:
        updated = copy.deepcopy(target_line)
        updated["points"] = [pt_at(t_hi), _round_pt(b)]
        return [updated]
    if t_hi >= 1.0 - eps_t:
        updated = copy.deepcopy(target_line)
        updated["points"] = [_round_pt(a), pt_at(t_lo)]
        return [updated]

    left_piece = copy.deepcopy(target_line)
    left_piece["points"] = [_round_pt(a), pt_at(t_lo)]
    right_piece = copy.deepcopy(target_line)
    right_piece["id"] = f"{target_line['id']}-trim-{uuid.uuid4().hex[:6]}"
    right_piece["points"] = [pt_at(t_hi), _round_pt(b)]
    return [left_piece, right_piece]


def array_polar_entities(entity, center, count, fill_deg=360.0):
    """Generate count-1 rotated copies around center (total instances = count)."""
    if not isinstance(count, int) or count < 2 or count > 360:
        raise ProjectError("Polar array count must be an integer between 2 and 360.")
    if abs(fill_deg) <= EPS or abs(fill_deg) > 360.0 + EPS:
        raise ProjectError("Polar array fill angle must be in (0, 360] degrees.")
    full_circle = abs(abs(fill_deg) - 360.0) <= 1e-4
    step = fill_deg / count if full_circle else fill_deg / (count - 1)
    copies = []
    for i in range(1, count):
        clone = rotate_entity(entity, center, step * i)
        clone["id"] = f"{entity['id']}-p{i + 1}"
        copies.append(clone)
    return copies


def array_rect_entities(entity, cols, rows, dx, dy, translate_fn):
    """Generate (cols * rows - 1) rectangular grid copies."""
    if not isinstance(cols, int) or not isinstance(rows, int) or cols < 1 or rows < 1:
        raise ProjectError("Rectangular array columns and rows must be >= 1.")
    if cols * rows < 2 or cols * rows > 500:
        raise ProjectError("Rectangular array must produce between 2 and 500 total items.")
    if cols > 1 and abs(dx) <= EPS:
        raise ProjectError("Column spacing dx must be non-zero when cols > 1.")
    if rows > 1 and abs(dy) <= EPS:
        raise ProjectError("Row spacing dy must be non-zero when rows > 1.")
    copies = []
    for r in range(rows):
        for c in range(cols):
            if r == 0 and c == 0:
                continue
            clone = copy.deepcopy(entity)
            clone["id"] = f"{entity['id']}-r{r + 1}c{c + 1}"
            translate_fn(clone, c * dx, r * dy)
            copies.append(clone)
    return copies
