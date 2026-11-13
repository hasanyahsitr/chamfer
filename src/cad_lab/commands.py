"""Headless deterministic 2D command processor and stateful drawing session."""

import copy
import math
import re
import uuid

from cad_lab.drawing import drawing_to_dxf
from cad_lab.ops import (
    array_polar_entities,
    array_rect_entities,
    chamfer_polyline,
    chamfer_two_lines,
    fillet_polyline_to_primitives,
    fillet_two_lines,
    mirror_entity,
    rotate_entity,
    trim_line_entity,
)
from cad_lab.project import ProjectError

LIMIT = 1e6
EPS = 1e-6

ALIASES = {
    "L": "LINE",
    "PL": "PLINE",
    "C": "CIRCLE",
    "A": "ARC",
    "O": "OFFSET",
    "CHA": "CHAMFER",
    "F": "FILLET",
    "TR": "TRIM",
    "RO": "ROTATE",
    "MI": "MIRROR",
    "AR": "ARRAY",
    "T": "TEXT",
    "DLI": "DIM",
    "DIMLINEAR": "DIM",
    "REC": "RECTANG",
    "RECTANGLE": "RECTANG",
    "M": "MOVE",
    "CO": "COPY",
    "CP": "COPY",
    "E": "ERASE",
    "U": "UNDO",
    "LA": "LAYER",
    "SEL": "SELECT",
}

DEFAULT_PALETTE = (
    "#d4d8de",
    "#5aa9e6",
    "#6bcf8e",
    "#e5a00d",
    "#e06c75",
    "#b48ead",
)


def empty_drawing(name="Untitled"):
    return {
        "format": "cad-lab.drawing",
        "schema_version": 1,
        "units": "mm",
        "name": name[:80].strip() or "Untitled",
        "layers": [{"id": "0", "name": "0", "color": "#d4d8de", "visible": True, "locked": False}],
        "entities": [],
    }


def _finite(val):
    return (
        isinstance(val, (int, float))
        and not isinstance(val, bool)
        and math.isfinite(val)
        and abs(val) <= LIMIT
    )


def _dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _round_pt(pt):
    return [round(float(pt[0]), 6), round(float(pt[1]), 6)]


SCALAR_RE = re.compile(r"^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$", re.IGNORECASE)


def parse_scalar(token):
    if not isinstance(token, str):
        raise ProjectError(f"Invalid numeric scalar: '{token}'.")
    text = token.strip()
    if not text or not SCALAR_RE.fullmatch(text):
        raise ProjectError(f"Invalid numeric scalar: '{token}'.")
    try:
        value = float(text)
    except ValueError as exc:
        raise ProjectError(f"Invalid numeric scalar: '{token}'.") from exc
    if not _finite(value):
        raise ProjectError(f"Scalar out of bounds: '{token}'.")
    return value


def parse_int_scalar(token):
    value = parse_scalar(token)
    if not value.is_integer():
        raise ProjectError(f"Expected integer count, got '{token}'.")
    return int(value)


def parse_point(token, base=None):
    source = token.strip()
    relative = source.startswith("@")
    if relative and base is None:
        raise ProjectError("Relative coordinate requires a prior base point.")
    body = source[1:] if relative else source
    if "<" in body:
        parts = body.split("<")
        if len(parts) != 2:
            raise ProjectError(f"Invalid polar coordinate: '{token}'.")
        length = parse_scalar(parts[0])
        angle_deg = parse_scalar(parts[1])
        if length < 0:
            raise ProjectError("Polar length must be non-negative.")
        rad = math.radians(angle_deg)
        dx, dy = length * math.cos(rad), length * math.sin(rad)
    else:
        parts = body.split(",")
        if len(parts) != 2:
            raise ProjectError(f"Invalid Cartesian coordinate: '{token}'.")
        dx, dy = parse_scalar(parts[0]), parse_scalar(parts[1])

    px = dx + (base[0] if relative else 0.0)
    py = dy + (base[1] if relative else 0.0)
    if not (_finite(px) and _finite(py)):
        raise ProjectError("Coordinate exceeds drawing bounds.")
    return [round(px, 6), round(py, 6)]


def arc_from_three_points(p1, p2, p3):
    x1, y1 = p1
    x2, y2 = p2
    x3, y3 = p3
    denom = 2.0 * ((x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3))
    if abs(denom) <= 1e-6:
        raise ProjectError("Arc points must not be collinear.")
    s1 = x1 * x1 + y1 * y1 - x3 * x3 - y3 * y3
    s2 = x2 * x2 + y2 * y2 - x3 * x3 - y3 * y3
    cx = (s1 * (y2 - y3) - s2 * (y1 - y3)) / denom
    cy = (s2 * (x1 - x3) - s1 * (x2 - x3)) / denom
    radius = math.hypot(x1 - cx, y1 - cy)
    if not (_finite(cx) and _finite(cy) and _finite(radius)) or radius <= EPS:
        raise ProjectError("Computed arc exceeds coordinate bounds.")

    def angle_at(pt):
        return math.degrees(math.atan2(pt[1] - cy, pt[0] - cx)) % 360.0

    a1, a2, a3 = angle_at(p1), angle_at(p2), angle_at(p3)
    ccw_12 = (a2 - a1) % 360.0
    ccw_13 = (a3 - a1) % 360.0
    if ccw_12 < ccw_13:
        start_deg, end_deg = a1, a3
    else:
        start_deg, end_deg = a3, a1
    return {
        "center": [round(cx, 6), round(cy, 6)],
        "radius": round(radius, 6),
        "start_angle": round(start_deg, 6),
        "end_angle": round(end_deg, 6),
    }


def _signed_polygon_area(pts):
    area = 0.0
    n = len(pts)
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        area += x1 * y2 - x2 * y1
    return 0.5 * area


def _point_in_polygon(pt, pts):
    x, y = pt
    inside = False
    n = len(pts)
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        if ((y1 > y) != (y2 > y)) and (x < (x2 - x1) * (y - y1) / ((y2 - y1) or 1e-12) + x1):
            inside = not inside
    return inside


def _line_intersection(p1, d1, p2, d2, fallback, max_miter):
    cross = d1[0] * d2[1] - d1[1] * d2[0]
    if abs(cross) <= 1e-6:
        return fallback
    qp = [p2[0] - p1[0], p2[1] - p1[1]]
    t = (qp[0] * d2[1] - qp[1] * d2[0]) / cross
    hit = [p1[0] + t * d1[0], p1[1] + t * d1[1]]
    if _dist(hit, fallback) > max_miter:
        return fallback
    return hit


def offset_entity_geometry(entity, dist_mm, side_pt):
    if not _finite(dist_mm) or dist_mm <= EPS:
        raise ProjectError("Offset distance must be positive.")
    kind = entity["type"]
    cloned = copy.deepcopy(entity)

    if kind == "line":
        a, b = entity["points"]
        length = _dist(a, b)
        ux, uy = (b[0] - a[0]) / length, (b[1] - a[1]) / length
        nx, ny = -uy, ux
        side = (side_pt[0] - a[0]) * nx + (side_pt[1] - a[1]) * ny
        sign = -1.0 if side < -1e-9 else 1.0
        shift = [sign * dist_mm * nx, sign * dist_mm * ny]
        cloned["points"] = [
            _round_pt([a[0] + shift[0], a[1] + shift[1]]),
            _round_pt([b[0] + shift[0], b[1] + shift[1]]),
        ]
        return cloned

    if kind in {"circle", "arc"}:
        radial = _dist(side_pt, entity["center"])
        next_r = (
            entity["radius"] + dist_mm if radial >= entity["radius"] else entity["radius"] - dist_mm
        )
        if next_r <= EPS or not _finite(next_r):
            raise ProjectError("Offset distance exceeds inner radius.")
        cloned["radius"] = round(next_r, 6)
        return cloned

    if kind == "polyline":
        pts = entity["points"]
        closed = entity["closed"]
        seg_count = len(pts) if closed else len(pts) - 1
        dirs = []
        normals = []
        for i in range(seg_count):
            a = pts[i]
            b = pts[(i + 1) % len(pts)]
            seg_len = _dist(a, b)
            if seg_len <= EPS:
                raise ProjectError("Degenerate polyline segment cannot be offset.")
            ux, uy = (b[0] - a[0]) / seg_len, (b[1] - a[1]) / seg_len
            dirs.append([ux, uy])
            normals.append([-uy, ux])

        if closed:
            inside = _point_in_polygon(side_pt, pts)
            ccw = _signed_polygon_area(pts) >= 0.0
            # Left normal points inward for CCW polygons, outward for CW polygons.
            if inside:
                sign = 1.0 if ccw else -1.0
            else:
                sign = -1.0 if ccw else 1.0
        else:
            best_idx = 0
            best_d = float("inf")
            for i in range(seg_count):
                a, b = pts[i], pts[i + 1]
                dx, dy = b[0] - a[0], b[1] - a[1]
                lsq = dx * dx + dy * dy
                t = max(0.0, min(1.0, ((side_pt[0] - a[0]) * dx + (side_pt[1] - a[1]) * dy) / lsq))
                proj = [a[0] + t * dx, a[1] + t * dy]
                d = _dist(side_pt, proj)
                if d < best_d:
                    best_d = d
                    best_idx = i
            nx, ny = normals[best_idx]
            a = pts[best_idx]
            side = (side_pt[0] - a[0]) * nx + (side_pt[1] - a[1]) * ny
            sign = -1.0 if side < -1e-9 else 1.0

        shifted_starts = [
            [pts[i][0] + sign * dist_mm * normals[i][0], pts[i][1] + sign * dist_mm * normals[i][1]]
            for i in range(seg_count)
        ]
        new_pts = []
        max_miter = 4.0 * dist_mm
        if closed:
            for i in range(len(pts)):
                prev_i = (i - 1) % len(pts)
                fallback = shifted_starts[i]
                hit = _line_intersection(
                    shifted_starts[prev_i],
                    dirs[prev_i],
                    shifted_starts[i],
                    dirs[i],
                    fallback,
                    max_miter,
                )
                new_pts.append(_round_pt(hit))
        else:
            new_pts.append(_round_pt(shifted_starts[0]))
            for i in range(1, len(pts) - 1):
                fallback = shifted_starts[i]
                hit = _line_intersection(
                    shifted_starts[i - 1],
                    dirs[i - 1],
                    shifted_starts[i],
                    dirs[i],
                    fallback,
                    max_miter,
                )
                new_pts.append(_round_pt(hit))
            last_seg = seg_count - 1
            end_shifted = [
                pts[-1][0] + sign * dist_mm * normals[last_seg][0],
                pts[-1][1] + sign * dist_mm * normals[last_seg][1],
            ]
            new_pts.append(_round_pt(end_shifted))

        if any(_dist(new_pts[i], new_pts[i + 1]) <= EPS for i in range(len(new_pts) - 1)):
            raise ProjectError("Offset collapses polyline geometry.")
        if closed and _dist(new_pts[0], new_pts[-1]) <= EPS:
            raise ProjectError("Offset collapses closed polyline geometry.")
        cloned["points"] = new_pts
        return cloned

    raise ProjectError(f"Entity type '{kind}' does not support OFFSET.")


def _translate_entity_inplace(entity, dx, dy):
    kind = entity["type"]
    if kind in {"circle", "arc"}:
        entity["center"] = _round_pt([entity["center"][0] + dx, entity["center"][1] + dy])
    elif kind == "dim":
        entity["p1"] = _round_pt([entity["p1"][0] + dx, entity["p1"][1] + dy])
        entity["p2"] = _round_pt([entity["p2"][0] + dx, entity["p2"][1] + dy])
        entity["dim_point"] = _round_pt([entity["dim_point"][0] + dx, entity["dim_point"][1] + dy])
    elif kind == "text":
        entity["position"] = _round_pt([entity["position"][0] + dx, entity["position"][1] + dy])
    else:
        entity["points"] = [_round_pt([p[0] + dx, p[1] + dy]) for p in entity["points"]]


class DrawingSession:
    """Thread-compatible deterministic 2D CAD document store with command execution."""

    def __init__(self, document=None):
        initial = copy.deepcopy(document) if document is not None else empty_drawing()
        self._validate(initial)
        self.document = initial
        self.history = [copy.deepcopy(initial)]
        self.index = 0
        self.active_layer = self.document["layers"][0]["id"]
        self.selection = set()
        self.revision = 1

    def clone(self):
        """Return an isolated deep copy preserving layer, selection, history, and revision."""
        return copy.deepcopy(self)

    def adopt_from(self, other):
        """Atomically commit full session context from an isolated candidate session."""
        self.document = copy.deepcopy(other.document)
        self.history = copy.deepcopy(other.history)
        self.index = other.index
        self.active_layer = other.active_layer
        self.selection = set(other.selection)
        self.revision = other.revision

    @staticmethod
    def _validate(doc):
        import json

        drawing_to_dxf(json.dumps(doc))

    def _current_layer_obj(self):
        for layer in self.document["layers"]:
            if layer["id"] == self.active_layer:
                return layer
        self.active_layer = self.document["layers"][0]["id"]
        return self.document["layers"][0]

    def _require_writable_layer(self):
        layer = self._current_layer_obj()
        if layer["locked"] or not layer["visible"]:
            raise ProjectError(f"Active layer '{layer['name']}' is locked or hidden.")
        return layer

    def commit(self, next_doc):
        validated = copy.deepcopy(next_doc)
        self._validate(validated)
        self.document = validated
        self.history = self.history[: self.index + 1]
        self.history.append(copy.deepcopy(validated))
        if len(self.history) > 100:
            self.history.pop(0)
        self.index = len(self.history) - 1
        valid_ids = {e["id"] for e in validated["entities"]}
        self.selection = {eid for eid in self.selection if eid in valid_ids}
        if not any(layer["id"] == self.active_layer for layer in validated["layers"]):
            self.active_layer = validated["layers"][0]["id"]
        self.revision += 1

    def replace_document(self, next_doc):
        if next_doc == self.document:
            return False
        self.commit(next_doc)
        return True

    def undo(self):
        if self.index > 0:
            self.index -= 1
            self.document = copy.deepcopy(self.history[self.index])
            self.selection.clear()
            self.revision += 1
            return True
        return False

    def redo(self):
        if self.index < len(self.history) - 1:
            self.index += 1
            self.document = copy.deepcopy(self.history[self.index])
            self.selection.clear()
            self.revision += 1
            return True
        return False

    def _editable_layer_ids(self):
        return {
            layer["id"]
            for layer in self.document["layers"]
            if layer["visible"] and not layer["locked"]
        }

    def execute(self, line):
        text = line.strip()
        if not text:
            return "No-op."
        tokens = text.split()
        raw_cmd = tokens[0].upper()
        cmd = ALIASES.get(raw_cmd, raw_cmd)
        args = tokens[1:]

        if cmd == "NEW":
            name = " ".join(args).strip() or "Untitled"
            self.document = empty_drawing(name)
            self.history = [copy.deepcopy(self.document)]
            self.index = 0
            self.active_layer = "0"
            self.selection.clear()
            self.revision += 1
            return f"NEW · Reset workspace '{self.document['name']}'."

        if cmd == "UNDO":
            return "UNDO · Reverted." if self.undo() else "UNDO · At earliest state."

        if cmd == "REDO":
            return "REDO · Restored." if self.redo() else "REDO · At latest state."

        if cmd == "LAYER":
            if not args:
                raise ProjectError("Usage: LAYER <name> [#rrggbb] [CONSTRUCTION]")
            layer_tokens = list(args)
            construction = False
            if len(layer_tokens) >= 2 and layer_tokens[-1].upper() == "CONSTRUCTION":
                construction = True
                layer_tokens.pop()
            color = None
            if len(layer_tokens) >= 2 and re.fullmatch(r"#[0-9a-fA-F]{6}", layer_tokens[-1]):
                color = layer_tokens[-1]
                name = " ".join(layer_tokens[:-1]).strip()
            else:
                name = " ".join(layer_tokens).strip()
            if not name:
                raise ProjectError("Usage: LAYER <name> [#rrggbb] [CONSTRUCTION]")
            for existing in self.document["layers"]:
                if existing["name"].casefold() == name.casefold() or existing["id"] == name:
                    if color is not None or construction:
                        next_doc = copy.deepcopy(self.document)
                        for item in next_doc["layers"]:
                            if item["id"] == existing["id"]:
                                if color is not None:
                                    item["color"] = color
                                if construction:
                                    item["construction"] = True
                        self.commit(next_doc)
                    self.active_layer = existing["id"]
                    return f"LAYER · Active layer set to '{existing['name']}'."
            next_doc = copy.deepcopy(self.document)
            palette_color = color or DEFAULT_PALETTE[len(next_doc["layers"]) % len(DEFAULT_PALETTE)]
            layer_id = name.lower().replace(" ", "-")
            used_ids = {item["id"] for item in next_doc["layers"]}
            suffix = 1
            base_id = layer_id
            while layer_id in used_ids:
                suffix += 1
                layer_id = f"{base_id}-{suffix}"
            new_layer = {
                "id": layer_id,
                "name": name,
                "color": palette_color,
                "visible": True,
                "locked": False,
            }
            if construction:
                new_layer["construction"] = True
            next_doc["layers"].append(new_layer)
            self.commit(next_doc)
            self.active_layer = layer_id
            return f"LAYER · Created and activated '{name}'."

        if cmd == "SELECT":
            if not args:
                raise ProjectError("Usage: SELECT <ALL|NONE|id1,id2,...>")
            editable = self._editable_layer_ids()
            spec = " ".join(args).strip()
            if spec.upper() == "NONE":
                self.selection.clear()
                return "SELECT · Cleared."
            if spec.upper() == "ALL":
                self.selection = {
                    e["id"] for e in self.document["entities"] if e["layer"] in editable
                }
                return f"SELECT · {len(self.selection)} editable entities selected."
            wanted = {part.strip() for part in spec.replace(",", " ").split() if part.strip()}
            matched = {
                e["id"]
                for e in self.document["entities"]
                if e["id"] in wanted and e["layer"] in editable
            }
            if not matched:
                raise ProjectError(f"No editable entities matched: {', '.join(sorted(wanted))}.")
            self.selection = matched
            return f"SELECT · {len(self.selection)} entities selected."

        if cmd == "ERASE":
            editable = self._editable_layer_ids()
            targets = (
                {part.strip() for part in " ".join(args).replace(",", " ").split() if part.strip()}
                if args
                else set(self.selection)
            )
            if not targets:
                raise ProjectError("Select entities or pass entity IDs to ERASE.")
            next_doc = copy.deepcopy(self.document)
            before = len(next_doc["entities"])
            next_doc["entities"] = [
                e
                for e in next_doc["entities"]
                if not (e["id"] in targets and e["layer"] in editable)
            ]
            removed = before - len(next_doc["entities"])
            if removed == 0:
                raise ProjectError("No matching editable entities to erase.")
            self.commit(next_doc)
            self.selection.clear()
            return f"ERASE · Removed {removed} entities."

        if cmd in {"MOVE", "COPY"}:
            if len(args) != 2:
                raise ProjectError(f"Usage: {cmd} <base_x,y> <target_x,y_or_@dx,dy>")
            editable = self._editable_layer_ids()
            selected = [
                e
                for e in self.document["entities"]
                if e["id"] in self.selection and e["layer"] in editable
            ]
            if not selected:
                raise ProjectError(f"Select editable entities before {cmd}.")
            base = parse_point(args[0])
            target = parse_point(args[1], base)
            dx, dy = target[0] - base[0], target[1] - base[1]
            next_doc = copy.deepcopy(self.document)
            if cmd == "MOVE":
                for entity in next_doc["entities"]:
                    if entity["id"] in self.selection and entity["layer"] in editable:
                        _translate_entity_inplace(entity, dx, dy)
            else:
                for entity in selected:
                    cloned = copy.deepcopy(entity)
                    cloned["id"] = f"{entity['type']}-{uuid.uuid4().hex[:8]}"
                    _translate_entity_inplace(cloned, dx, dy)
                    next_doc["entities"].append(cloned)
            self.commit(next_doc)
            return f"{cmd} · Applied Δ({dx:.4f}, {dy:.4f}) mm to {len(selected)} entities."

        if cmd == "RECTANG":
            if len(args) < 2:
                raise ProjectError("Usage: RECTANG <x1,y1> <x2,y2_or_@w,h> [id=name]")
            self._require_writable_layer()
            entity_id, clean_args = self._extract_id(args, "rect")
            if len(clean_args) != 2:
                raise ProjectError("RECTANG requires exactly two corner points.")
            a = parse_point(clean_args[0])
            b = parse_point(clean_args[1], a)
            if abs(a[0] - b[0]) < EPS or abs(a[1] - b[1]) < EPS:
                raise ProjectError("Rectangle width and height must be non-zero.")
            next_doc = copy.deepcopy(self.document)
            next_doc["entities"].append(
                {
                    "id": entity_id,
                    "layer": self.active_layer,
                    "type": "polyline",
                    "points": [a, [b[0], a[1]], b, [a[0], b[1]]],
                    "closed": True,
                }
            )
            self.commit(next_doc)
            return f"RECTANG · Created '{entity_id}'."

        if cmd == "CIRCLE":
            if len(args) < 2:
                raise ProjectError("Usage: CIRCLE <cx,cy> [D] <radius_or_diameter_or_pt> [id=name]")
            self._require_writable_layer()
            entity_id, clean_args = self._extract_id(args, "circle")
            center = parse_point(clean_args[0])
            diameter_mode = False
            rest = clean_args[1:]
            if rest and rest[0].upper() == "D":
                diameter_mode = True
                rest = rest[1:]
            if len(rest) != 1:
                raise ProjectError("CIRCLE requires a radius, diameter, or boundary point.")
            spec = rest[0]
            if "," in spec or "<" in spec or spec.startswith("@"):
                rim = parse_point(spec, center)
                raw_len = _dist(center, rim)
                radius = raw_len / 2.0 if diameter_mode else raw_len
            else:
                val = parse_scalar(spec)
                radius = val / 2.0 if diameter_mode else val
            if radius <= EPS:
                raise ProjectError("Circle radius must be positive.")
            next_doc = copy.deepcopy(self.document)
            next_doc["entities"].append(
                {
                    "id": entity_id,
                    "layer": self.active_layer,
                    "type": "circle",
                    "center": center,
                    "radius": round(radius, 6),
                }
            )
            self.commit(next_doc)
            return f"CIRCLE · Created '{entity_id}' (R={radius:.4f} mm)."

        if cmd == "ARC":
            if len(args) < 3:
                raise ProjectError(
                    "Usage: ARC <p1> <p2> <p3> [id=name] or "
                    "ARC C <cx,cy> <r> <start_deg> <end_deg> [id=name]"
                )
            self._require_writable_layer()
            entity_id, clean_args = self._extract_id(args, "arc")
            if clean_args and clean_args[0].upper() == "C":
                if len(clean_args) != 5:
                    raise ProjectError(
                        "Usage: ARC C <cx,cy> <radius> <start_deg> <end_deg> [id=name]"
                    )
                center = parse_point(clean_args[1])
                radius = parse_scalar(clean_args[2])
                start_angle = parse_scalar(clean_args[3]) % 360.0
                end_angle = parse_scalar(clean_args[4]) % 360.0
                if radius <= EPS:
                    raise ProjectError("Arc radius must be positive.")
                arc_spec = {
                    "center": center,
                    "radius": round(radius, 6),
                    "start_angle": round(start_angle, 6),
                    "end_angle": round(end_angle, 6),
                }
            else:
                if len(clean_args) != 3:
                    raise ProjectError("3-point ARC requires exactly 3 points.")
                p1 = parse_point(clean_args[0])
                p2 = parse_point(clean_args[1], p1)
                p3 = parse_point(clean_args[2], p2)
                arc_spec = arc_from_three_points(p1, p2, p3)
            next_doc = copy.deepcopy(self.document)
            next_doc["entities"].append(
                {
                    "id": entity_id,
                    "layer": self.active_layer,
                    "type": "arc",
                    **arc_spec,
                }
            )
            self.commit(next_doc)
            return f"ARC · Created '{entity_id}' (R={arc_spec['radius']:.4f} mm)."

        if cmd == "DIM":
            if len(args) < 3:
                raise ProjectError("Usage: DIM <p1> <p2> <dim_point> [id=name]")
            self._require_writable_layer()
            entity_id, clean_args = self._extract_id(args, "dim")
            if len(clean_args) != 3:
                raise ProjectError("DIM requires p1, p2, and dim_point.")
            p1 = parse_point(clean_args[0])
            p2 = parse_point(clean_args[1], p1)
            dp = parse_point(clean_args[2], p2)
            span = _dist(p1, p2)
            if span <= EPS:
                raise ProjectError("Dimension endpoints must be distinct.")
            next_doc = copy.deepcopy(self.document)
            next_doc["entities"].append(
                {
                    "id": entity_id,
                    "layer": self.active_layer,
                    "type": "dim",
                    "p1": p1,
                    "p2": p2,
                    "dim_point": dp,
                }
            )
            self.commit(next_doc)
            return f"DIM · Created '{entity_id}' ({span:.4f} mm)."

        if cmd == "OFFSET":
            if len(args) < 2:
                raise ProjectError("Usage: OFFSET [entity_id] <distance> <side_x,y> [id=name]")
            self._require_writable_layer()
            entity_id, clean_args = self._extract_id(args, "offset")
            editable = self._editable_layer_ids()
            if len(clean_args) == 2:
                selected = [
                    e
                    for e in self.document["entities"]
                    if e["id"] in self.selection and e["layer"] in editable
                ]
                if len(selected) != 1:
                    raise ProjectError("Select one editable entity or pass its ID to OFFSET.")
                source_entity = selected[0]
                dist_val = parse_scalar(clean_args[0])
                side_pt = parse_point(clean_args[1])
            elif len(clean_args) == 3:
                src_id = clean_args[0]
                source_entity = next(
                    (
                        e
                        for e in self.document["entities"]
                        if e["id"] == src_id and e["layer"] in editable
                    ),
                    None,
                )
                if source_entity is None:
                    raise ProjectError(f"Editable entity '{src_id}' not found.")
                dist_val = parse_scalar(clean_args[1])
                side_pt = parse_point(clean_args[2])
            else:
                raise ProjectError("Usage: OFFSET [entity_id] <distance> <side_x,y> [id=name]")

            created = offset_entity_geometry(source_entity, dist_val, side_pt)
            created["id"] = entity_id
            created["layer"] = self.active_layer
            next_doc = copy.deepcopy(self.document)
            next_doc["entities"].append(created)
            self.commit(next_doc)
            return f"OFFSET · Created '{entity_id}' ({dist_val:.4f} mm)."

        if cmd in {"LINE", "PLINE"}:
            if len(args) < 2:
                raise ProjectError(f"Usage: {cmd} <p1> <p2> [p3 ...] [C] [id=name]")
            self._require_writable_layer()
            prefix = "line" if cmd == "LINE" else "pline"
            entity_id, clean_args = self._extract_id(args, prefix)
            close = False
            if clean_args and clean_args[-1].upper() in {"C", "CLOSE"}:
                close = True
                clean_args = clean_args[:-1]
            points = []
            for tok in clean_args:
                pt = parse_point(tok, points[-1] if points else None)
                if points and _dist(pt, points[-1]) < EPS:
                    raise ProjectError("Consecutive points must be distinct.")
                points.append(pt)
            if close and len(points) >= 2 and _dist(points[0], points[-1]) < EPS:
                points.pop()
            if len(points) < (3 if close else 2):
                raise ProjectError(
                    "Closed path requires at least 3 points."
                    if close
                    else f"{cmd} requires at least 2 points."
                )
            next_doc = copy.deepcopy(self.document)
            if cmd == "LINE":
                seq = [*points, points[0]] if close else points
                created_ids = []
                for i in range(1, len(seq)):
                    seg_id = entity_id if len(seq) == 2 else f"{entity_id}-{i}"
                    created_ids.append(seg_id)
                    next_doc["entities"].append(
                        {
                            "id": seg_id,
                            "layer": self.active_layer,
                            "type": "line",
                            "points": [seq[i - 1], seq[i]],
                        }
                    )
                self.commit(next_doc)
                return f"LINE · Created {len(created_ids)} segment(s)."
            next_doc["entities"].append(
                {
                    "id": entity_id,
                    "layer": self.active_layer,
                    "type": "polyline",
                    "points": points,
                    "closed": close,
                }
            )
            self.commit(next_doc)
            return f"PLINE · Created '{entity_id}' ({len(points)} vertices, closed={close})."

        if cmd == "TEXT":
            if len(args) < 3:
                raise ProjectError("Usage: TEXT <x,y> <height> <content...> [rot=deg] [id=name]")
            self._require_writable_layer()
            entity_id, clean_args = self._extract_id(args, "text")
            rot_deg = 0.0
            filtered = []
            for tok in clean_args:
                if tok.lower().startswith("rot="):
                    rot_deg = parse_scalar(tok[4:]) % 360.0
                else:
                    filtered.append(tok)
            if len(filtered) < 3:
                raise ProjectError("TEXT requires <x,y>, <height>, and text content.")
            pos = parse_point(filtered[0])
            height = parse_scalar(filtered[1])
            if not (0.2 <= height <= 10000.0):
                raise ProjectError("Text height must be between 0.2 and 10000 mm.")
            content_str = " ".join(filtered[2:]).strip()
            if not content_str or len(content_str) > 200:
                raise ProjectError("Text content must be 1–200 characters.")
            next_doc = copy.deepcopy(self.document)
            next_doc["entities"].append(
                {
                    "id": entity_id,
                    "layer": self.active_layer,
                    "type": "text",
                    "position": pos,
                    "height": round(height, 6),
                    "rotation": round(rot_deg, 6),
                    "text": content_str,
                }
            )
            self.commit(next_doc)
            return f"TEXT · Created '{entity_id}'."

        if cmd == "ROTATE":
            if len(args) != 2:
                raise ProjectError("Usage: ROTATE <base_x,y> <angle_deg>")
            editable = self._editable_layer_ids()
            selected_ids = {
                e["id"]
                for e in self.document["entities"]
                if e["id"] in self.selection and e["layer"] in editable
            }
            if not selected_ids:
                raise ProjectError("Select editable entities before ROTATE.")
            base_pt = parse_point(args[0])
            angle_deg = parse_scalar(args[1])
            next_doc = copy.deepcopy(self.document)
            next_doc["entities"] = [
                rotate_entity(e, base_pt, angle_deg) if e["id"] in selected_ids else e
                for e in next_doc["entities"]
            ]
            self.commit(next_doc)
            return f"ROTATE · Rotated {len(selected_ids)} entities by {angle_deg:.2f}°."

        if cmd == "MIRROR":
            if len(args) not in {2, 3}:
                raise ProjectError("Usage: MIRROR <axis_p1> <axis_p2> [ERASE]")
            editable = self._editable_layer_ids()
            selected = [
                e
                for e in self.document["entities"]
                if e["id"] in self.selection and e["layer"] in editable
            ]
            if not selected:
                raise ProjectError("Select editable entities before MIRROR.")
            p1 = parse_point(args[0])
            p2 = parse_point(args[1], p1)
            erase_source = len(args) == 3 and args[2].upper() in {"ERASE", "Y", "YES", "TRUE"}
            next_doc = copy.deepcopy(self.document)
            if erase_source:
                sel_ids = {e["id"] for e in selected}
                next_doc["entities"] = [
                    mirror_entity(e, p1, p2) if e["id"] in sel_ids else e
                    for e in next_doc["entities"]
                ]
            else:
                existing_ids = {e["id"] for e in next_doc["entities"]}
                for src in selected:
                    mirrored = mirror_entity(src, p1, p2)
                    cand_id = f"{src['id']}-mir"
                    idx = 2
                    while cand_id in existing_ids:
                        cand_id = f"{src['id']}-mir{idx}"
                        idx += 1
                    mirrored["id"] = cand_id
                    existing_ids.add(cand_id)
                    next_doc["entities"].append(mirrored)
            self.commit(next_doc)
            return f"MIRROR · Reflected {len(selected)} entities."

        if cmd == "CHAMFER":
            if len(args) < 2:
                raise ProjectError(
                    "Usage: CHAMFER <polyline_id> <d1> [d2] or "
                    "CHAMFER <line1_id> <line2_id> <d1> [d2] [keep1=x,y keep2=x,y] [id=bevel]"
                )
            self._require_writable_layer()
            bevel_id, rem_args = self._extract_id(args, "chamfer")
            keep_pts, clean_args = self._extract_keep_pts(rem_args)
            editable = self._editable_layer_ids()
            by_id = {e["id"]: e for e in self.document["entities"] if e["layer"] in editable}
            if clean_args and clean_args[0] in by_id and by_id[clean_args[0]]["type"] == "polyline":
                if len(clean_args) not in {2, 3}:
                    raise ProjectError("Usage: CHAMFER <polyline_id> <d1> [d2]")
                d1 = parse_scalar(clean_args[1])
                d2 = parse_scalar(clean_args[2]) if len(clean_args) == 3 else d1
                updated = chamfer_polyline(by_id[clean_args[0]], d1, d2)
                next_doc = copy.deepcopy(self.document)
                next_doc["entities"] = [
                    updated if e["id"] == updated["id"] else e for e in next_doc["entities"]
                ]
                self.commit(next_doc)
                return f"CHAMFER · Beveled polyline '{updated['id']}' ({d1:.3f}x{d2:.3f} mm)."

            if len(clean_args) in {3, 4} and clean_args[0] in by_id and clean_args[1] in by_id:
                l1 = by_id[clean_args[0]]
                l2 = by_id[clean_args[1]]
                if l1["type"] != "line" or l2["type"] != "line" or l1["id"] == l2["id"]:
                    raise ProjectError("Two-entity CHAMFER requires two distinct editable lines.")
                d1 = parse_scalar(clean_args[2])
                d2 = parse_scalar(clean_args[3]) if len(clean_args) == 4 else d1
                nl1, nl2, bevel_pts = chamfer_two_lines(l1, l2, d1, d2, keep_pts=keep_pts)
                next_doc = copy.deepcopy(self.document)
                replaced = {nl1["id"]: nl1, nl2["id"]: nl2}
                next_doc["entities"] = [replaced.get(e["id"], e) for e in next_doc["entities"]]
                next_doc["entities"].append(
                    {
                        "id": bevel_id,
                        "layer": self.active_layer,
                        "type": "line",
                        "points": bevel_pts,
                    }
                )
                self.commit(next_doc)
                return f"CHAMFER · Created bevel '{bevel_id}' ({d1:.3f}x{d2:.3f} mm)."
            raise ProjectError(
                "Target editable polyline or two editable lines not found for CHAMFER."
            )

        if cmd == "FILLET":
            if len(args) < 2:
                raise ProjectError(
                    "Usage: FILLET <polyline_id> <radius> or "
                    "FILLET <line1_id> <line2_id> <radius> [keep1=x,y keep2=x,y] [id=arc]"
                )
            self._require_writable_layer()
            arc_id, rem_args = self._extract_id(args, "fillet")
            keep_pts, clean_args = self._extract_keep_pts(rem_args)
            editable = self._editable_layer_ids()
            by_id = {e["id"]: e for e in self.document["entities"] if e["layer"] in editable}
            if len(clean_args) == 2 and clean_args[0] in by_id:
                target_ent = by_id[clean_args[0]]
                if target_ent["type"] != "polyline":
                    raise ProjectError("Single-entity FILLET requires an editable polyline.")
                rad = parse_scalar(clean_args[1])
                pieces = fillet_polyline_to_primitives(target_ent, rad, target_ent["id"])
                next_doc = copy.deepcopy(self.document)
                out_entities = []
                for ent in next_doc["entities"]:
                    if ent["id"] == target_ent["id"]:
                        out_entities.extend(pieces)
                    else:
                        out_entities.append(ent)
                next_doc["entities"] = out_entities
                self.commit(next_doc)
                return f"FILLET · Rounded '{target_ent['id']}' into {len(pieces)} segments/arcs."

            if len(clean_args) == 3 and clean_args[0] in by_id and clean_args[1] in by_id:
                l1 = by_id[clean_args[0]]
                l2 = by_id[clean_args[1]]
                if l1["type"] != "line" or l2["type"] != "line" or l1["id"] == l2["id"]:
                    raise ProjectError("Two-entity FILLET requires two distinct editable lines.")
                rad = parse_scalar(clean_args[2])
                nl1, nl2, arc_spec = fillet_two_lines(l1, l2, rad, keep_pts=keep_pts)
                next_doc = copy.deepcopy(self.document)
                replaced = {nl1["id"]: nl1, nl2["id"]: nl2}
                next_doc["entities"] = [replaced.get(e["id"], e) for e in next_doc["entities"]]
                next_doc["entities"].append(
                    {
                        "id": arc_id,
                        "layer": self.active_layer,
                        "type": "arc",
                        **arc_spec,
                    }
                )
                self.commit(next_doc)
                return f"FILLET · Created tangent arc '{arc_id}' (R={rad:.3f} mm)."
            raise ProjectError(
                "Target editable polyline or two editable lines not found for FILLET."
            )

        if cmd == "TRIM":
            if len(args) != 2:
                raise ProjectError("Usage: TRIM <line_id> <pick_x,y>")
            editable = self._editable_layer_ids()
            visible = {
                layer["id"] for layer in self.document["layers"] if layer.get("visible", True)
            }
            target_line = next(
                (
                    e
                    for e in self.document["entities"]
                    if e["id"] == args[0] and e["layer"] in editable and e["type"] == "line"
                ),
                None,
            )
            if target_line is None:
                raise ProjectError(f"Editable line '{args[0]}' not found for TRIM.")
            pick_pt = parse_point(args[1])
            cutters = [e for e in self.document["entities"] if e["layer"] in visible]
            survivors = trim_line_entity(target_line, pick_pt, cutters)
            next_doc = copy.deepcopy(self.document)
            out_entities = []
            for ent in next_doc["entities"]:
                if ent["id"] == target_line["id"]:
                    out_entities.extend(survivors)
                else:
                    out_entities.append(ent)
            next_doc["entities"] = out_entities
            self.commit(next_doc)
            return f"TRIM · Trimmed '{target_line['id']}' ({len(survivors)} segment(s) kept)."

        if cmd == "ARRAY":
            if len(args) < 4:
                raise ProjectError(
                    "Usage: ARRAY POLAR <id> <cx,cy> <count> [fill_deg] or "
                    "ARRAY RECT <id> <cols> <rows> <dx> <dy>"
                )
            mode = args[0].upper()
            editable = self._editable_layer_ids()
            src = next(
                (
                    e
                    for e in self.document["entities"]
                    if e["id"] == args[1] and e["layer"] in editable
                ),
                None,
            )
            if src is None:
                raise ProjectError(f"Editable entity '{args[1]}' not found for ARRAY.")
            if mode == "POLAR":
                if len(args) not in {4, 5}:
                    raise ProjectError("Usage: ARRAY POLAR <id> <cx,cy> <count> [fill_deg]")
                center = parse_point(args[2])
                count = parse_int_scalar(args[3])
                fill_deg = parse_scalar(args[4]) if len(args) == 5 else 360.0
                copies = array_polar_entities(src, center, count, fill_deg)
            elif mode == "RECT":
                if len(args) != 6:
                    raise ProjectError("Usage: ARRAY RECT <id> <cols> <rows> <dx> <dy>")
                cols = parse_int_scalar(args[2])
                rows = parse_int_scalar(args[3])
                dx = parse_scalar(args[4])
                dy = parse_scalar(args[5])
                copies = array_rect_entities(src, cols, rows, dx, dy, _translate_entity_inplace)
            else:
                raise ProjectError("ARRAY mode must be POLAR or RECT.")
            next_doc = copy.deepcopy(self.document)
            if len(next_doc["entities"]) + len(copies) > 5000:
                raise ProjectError("ARRAY exceeds 5000 maximum drawing entities.")
            existing_ids = {e["id"] for e in next_doc["entities"]}
            for item in copies:
                base_cid = item["id"]
                idx = 2
                while item["id"] in existing_ids:
                    item["id"] = f"{base_cid}-{idx}"
                    idx += 1
                existing_ids.add(item["id"])
                next_doc["entities"].append(item)
            self.commit(next_doc)
            return f"ARRAY · Added {len(copies)} instance(s) from '{src['id']}'."

        raise ProjectError(
            f"Unknown command '{raw_cmd}'. Supported: NEW, LAYER, LINE, PLINE, RECTANG, "
            "CIRCLE, ARC, OFFSET, CHAMFER, FILLET, TRIM, ROTATE, MIRROR, ARRAY, TEXT, "
            "DIM, SELECT, MOVE, COPY, ERASE, UNDO, REDO."
        )

    def execute_batch(self, commands):
        if not isinstance(commands, list) or not commands or len(commands) > 500:
            raise ProjectError("Provide between 1 and 500 command strings.")
        for entry in commands:
            if not isinstance(entry, str):
                raise ProjectError("Each command must be a string.")
        tx = copy.deepcopy(self)
        logs = [tx.execute(entry) for entry in commands]
        self.document = tx.document
        self.history = tx.history
        self.index = tx.index
        self.active_layer = tx.active_layer
        self.selection = tx.selection
        self.revision = tx.revision
        return logs

    def modify_entity(self, entity_id, **changes):
        if not isinstance(entity_id, str) or not entity_id:
            raise ProjectError("Entity ID is required.")
        snap_gap_mm = float(changes.pop("snap_gap_mm", 0.5))
        self.last_modify_note = None
        editable = self._editable_layer_ids()
        next_doc = copy.deepcopy(self.document)
        target = None
        for entity in next_doc["entities"]:
            if entity["id"] == entity_id:
                target = entity
                break
        if target is None:
            raise ProjectError(f"Entity '{entity_id}' not found.")
        if target["layer"] not in editable:
            raise ProjectError(f"Entity '{entity_id}' is on a locked or hidden layer.")

        if "layer" in changes and changes["layer"] is not None:
            new_layer = changes["layer"]
            if new_layer not in editable:
                raise ProjectError(f"Target layer '{new_layer}' is missing, locked, or hidden.")
            target["layer"] = new_layer

        if target["type"] in {"circle", "arc"}:
            if "center" in changes and changes["center"] is not None:
                c = changes["center"]
                if not isinstance(c, list) or len(c) != 2 or not all(_finite(v) for v in c):
                    raise ProjectError("Center must be [x, y].")
                target["center"] = _round_pt(c)
            if "radius" in changes and changes["radius"] is not None:
                r = changes["radius"]
                if not _finite(r) or r <= EPS:
                    raise ProjectError("Radius must be positive.")
                target["radius"] = round(float(r), 6)
            if target["type"] == "arc":
                for field in ("start_angle", "end_angle"):
                    if field in changes and changes[field] is not None:
                        if not _finite(changes[field]):
                            raise ProjectError(f"Invalid {field}.")
                        target[field] = round(float(changes[field]) % 360.0, 6)
        elif target["type"] == "dim":
            for field in ("p1", "p2", "dim_point"):
                if field in changes and changes[field] is not None:
                    pt = changes[field]
                    if not isinstance(pt, list) or len(pt) != 2 or not all(_finite(v) for v in pt):
                        raise ProjectError(f"Dimension '{field}' must be [x, y].")
                    target[field] = _round_pt(pt)
        else:
            if "points" in changes and changes["points"] is not None:
                pts = changes["points"]
                if not isinstance(pts, list) or any(
                    not isinstance(p, list) or len(p) != 2 or not all(_finite(v) for v in p)
                    for p in pts
                ):
                    raise ProjectError("Entity points must be [[x, y], ...].")
                target["points"] = [_round_pt(p) for p in pts]
            if (
                target["type"] == "polyline"
                and "closed" in changes
                and changes["closed"] is not None
            ):
                if not isinstance(changes["closed"], bool):
                    raise ProjectError("Polyline 'closed' must be a boolean.")
                target["closed"] = changes["closed"]
                if target["closed"] and len(target["points"]) >= 4:
                    gap = _dist(target["points"][0], target["points"][-1])
                    if gap <= max(0.0, snap_gap_mm) + EPS:
                        dropped = target["points"].pop()
                        if gap > EPS:
                            self.last_modify_note = (
                                f"snapped {gap:.3f} mm closing vertex "
                                f"{dropped} -> {target['points'][0]}"
                            )

        self.commit(next_doc)
        return target

    @staticmethod
    def _extract_keep_pts(args):
        keep1 = None
        keep2 = None
        remaining = []
        for tok in args:
            low = tok.lower()
            if low.startswith("keep1="):
                keep1 = parse_point(tok[6:])
            elif low.startswith("keep2="):
                keep2 = parse_point(tok[6:])
            else:
                remaining.append(tok)
        if (keep1 is None) != (keep2 is None):
            raise ProjectError("Specify both keep1=x,y and keep2=x,y when disambiguating lines.")
        return ((keep1, keep2) if keep1 is not None else None), remaining

    def _extract_id(self, args, prefix):
        explicit_id = None
        remaining = []
        existing_ids = {e["id"] for e in self.document["entities"]}
        for tok in args:
            if tok.lower().startswith("id="):
                candidate = tok[3:].strip()
                if not candidate or candidate in existing_ids:
                    raise ProjectError(f"Invalid or duplicate entity id '{candidate}'.")
                explicit_id = candidate
            else:
                remaining.append(tok)
        if explicit_id is None:
            idx = len(existing_ids) + 1
            while f"{prefix}-{idx}" in existing_ids:
                idx += 1
            explicit_id = f"{prefix}-{idx}"
        return explicit_id, remaining
