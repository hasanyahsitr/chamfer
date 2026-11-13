"""Validated 2D drawing interchange for an explicitly supported DXF subset."""

import io
import json
import math
import re
import uuid

import ezdxf

from cad_lab.project import ProjectError

MAX_DRAWING_BYTES = 1024 * 1024
MAX_TOTAL_SEGMENTS = 10000


def _arc_sweep_deg(start_angle, end_angle):
    return (end_angle - start_angle) % 360.0


def drawing_from_dxf(content):
    """Import supported planar model-space entities, rejecting unsupported geometry."""
    if not isinstance(content, str) or len(content.encode("utf-8")) > MAX_DRAWING_BYTES:
        raise ProjectError("DXF input exceeds the 1 MiB limit.")
    if not content.strip():
        raise ProjectError("DXF input is empty.")
    try:
        document = ezdxf.read(io.StringIO(content, newline=None))
    except (ezdxf.DXFError, ValueError, IndexError) as exc:
        raise ProjectError("Invalid ASCII DXF input.") from exc
    if document.units != ezdxf.units.MM:
        raise ProjectError("Only DXF files explicitly declaring millimeter units are supported.")
    model = document.modelspace()
    if len(model) > 5000:
        raise ProjectError("At most 5000 entities are supported.")
    supported_dxf = {"LINE", "LWPOLYLINE", "CIRCLE", "ARC", "DIMENSION", "TEXT"}
    unsupported = {entity.dxftype() for entity in model} - supported_dxf
    if unsupported:
        raise ProjectError("Unsupported DXF entities: " + ", ".join(sorted(unsupported)))
    if any(len(layout) for layout in document.layouts if layout.name != "Model"):
        raise ProjectError(
            "Paper-space content is not supported; the original file was not changed."
        )
    used_layers = {entity.dxf.layer for entity in model} | {"0"}
    if len(used_layers) > 100:
        raise ProjectError("At most 100 used layers are supported.")
    layers = []
    for name in sorted(used_layers, key=lambda value: (value != "0", value)):
        if name not in document.layers:
            raise ProjectError("An entity references a missing DXF layer.")
        layer = document.layers.get(name)
        if layer.dxf.linetype.upper() != "CONTINUOUS":
            raise ProjectError("Non-continuous layer linetypes are not supported.")
        rgb = layer.rgb or ezdxf.colors.aci2rgb(abs(layer.dxf.color))
        is_construction = int(layer.dxf.get("plot", 1)) == 0
        layer_dict = {
            "id": name,
            "name": name,
            "color": "#" + "".join(f"{v:02x}" for v in rgb),
            "visible": not layer.is_off() and not layer.is_frozen(),
            "locked": layer.is_locked(),
        }
        if is_construction:
            layer_dict["construction"] = True
        layers.append(layer_dict)
    entities = []
    for entity in model:
        if (
            entity.dxf.get("color", 256) != 256
            or entity.dxf.hasattr("true_color")
            or entity.dxf.get("linetype", "BYLAYER").upper() != "BYLAYER"
            or entity.dxf.get("lineweight", -1) != -1
            or (entity.dxf.is_supported("thickness") and abs(entity.dxf.get("thickness", 0)) > 1e-9)
        ):
            raise ProjectError(
                "Per-entity style overrides and extrusion thickness are not supported."
            )
        extrusion = entity.dxf.get("extrusion", (0, 0, 1))
        if any(abs(a - b) > 1e-9 for a, b in zip(extrusion, (0, 0, 1), strict=True)):
            raise ProjectError("Only world-XY planar entities are supported.")
        common = {"id": str(uuid.uuid4()), "layer": entity.dxf.layer}
        kind = entity.dxftype()
        if kind == "LINE":
            start, end = entity.dxf.start, entity.dxf.end
            if abs(start.z) > 1e-9 or abs(end.z) > 1e-9:
                raise ProjectError("3D lines are not supported in the 2D importer.")
            entities.append({**common, "type": "line", "points": [list(start)[:2], list(end)[:2]]})
        elif kind == "CIRCLE":
            if abs(entity.dxf.center.z) > 1e-9:
                raise ProjectError("Only circles in the world-XY plane are supported.")
            entities.append(
                {
                    **common,
                    "type": "circle",
                    "center": list(entity.dxf.center)[:2],
                    "radius": entity.dxf.radius,
                }
            )
        elif kind == "ARC":
            if abs(entity.dxf.center.z) > 1e-9:
                raise ProjectError("Only arcs in the world-XY plane are supported.")
            entities.append(
                {
                    **common,
                    "type": "arc",
                    "center": list(entity.dxf.center)[:2],
                    "radius": entity.dxf.radius,
                    "start_angle": float(entity.dxf.start_angle) % 360.0,
                    "end_angle": float(entity.dxf.end_angle) % 360.0,
                }
            )
        elif kind == "DIMENSION":
            dim_subtype = int(entity.dxf.get("dimtype", 0)) & 0x07
            if dim_subtype not in {0, 1}:
                raise ProjectError(
                    "Only linear/aligned DXF dimensions (subtypes 0 and 1) are supported; "
                    "angular, radial, and ordinate dimensions are rejected."
                )
            dp = entity.dxf.get("defpoint", None)
            dp2 = entity.dxf.get("defpoint2", None)
            dp3 = entity.dxf.get("defpoint3", None)
            if dp is None or dp2 is None or dp3 is None:
                raise ProjectError("Unsupported DXF dimension subtype.")
            if abs(dp.z) > 1e-9 or abs(dp2.z) > 1e-9 or abs(dp3.z) > 1e-9:
                raise ProjectError("Only planar XY dimensions are supported.")
            p1_xy = list(dp2)[:2]
            p2_xy = list(dp3)[:2]
            actual_meas = entity.get_measurement()
            if actual_meas is not None and not math.isclose(
                float(actual_meas), math.dist(p1_xy, p2_xy), rel_tol=1e-5, abs_tol=1e-4
            ):
                raise ProjectError("DXF dimension measurement does not match aligned span.")
            entities.append(
                {
                    **common,
                    "type": "dim",
                    "p1": p1_xy,
                    "p2": p2_xy,
                    "dim_point": list(dp)[:2],
                }
            )
        elif kind == "TEXT":
            ins = entity.dxf.insert
            if abs(ins.z) > 1e-9:
                raise ProjectError("Only planar XY text entities are supported.")
            entities.append(
                {
                    **common,
                    "type": "text",
                    "position": list(ins)[:2],
                    "height": float(entity.dxf.height),
                    "rotation": float(entity.dxf.get("rotation", 0.0)) % 360.0,
                    "text": str(entity.dxf.text),
                }
            )
        else:
            points = list(entity.get_points("xyseb"))
            if (
                abs(entity.dxf.elevation) > 1e-9
                or abs(entity.dxf.const_width) > 1e-9
                or any(any(abs(v) > 1e-9 for v in p[2:]) for p in points)
            ):
                raise ProjectError("Polyline arcs, widths and elevation are not supported.")
            entities.append(
                {
                    **common,
                    "type": "polyline",
                    "points": [list(p)[:2] for p in points],
                    "closed": entity.closed,
                }
            )
    drawing = {
        "format": "cad-lab.drawing",
        "schema_version": 1,
        "units": "mm",
        "name": "DXF Drawing",
        "layers": layers,
        "entities": entities,
    }
    # Reuse export validation to enforce the same accepted numeric/entity subset.
    drawing_to_dxf(json.dumps(drawing))
    return {
        "drawing": drawing,
        "report": {
            "entities": len(entities),
            "units": "mm",
            "scope": "Model space, planar geometry only",
            "note": (
                "Unused block definitions, extended metadata and layout settings are not imported."
            ),
        },
    }


def _number(value):
    return type(value) in (int, float) and -1e6 <= value <= 1e6 and math.isfinite(value)


def _point(value):
    return isinstance(value, list) and len(value) == 2 and all(_number(v) for v in value)


def drawing_to_dxf(content, *, cut_only=False):
    if len(content.encode("utf-8")) > MAX_DRAWING_BYTES:
        raise ProjectError("Drawing exceeds the 1 MiB limit.")
    try:
        data = json.loads(content)
    except (ValueError, RecursionError) as exc:
        raise ProjectError("Drawing is not valid JSON.") from exc
    if (
        not isinstance(data, dict)
        or data.get("format") != "cad-lab.drawing"
        or type(data.get("schema_version")) is not int
        or data["schema_version"] != 1
        or data.get("units") != "mm"
    ):
        raise ProjectError("Unsupported drawing format, version, or units.")
    doc_name = data.get("name")
    if not isinstance(doc_name, str) or not doc_name.strip() or len(doc_name) > 80:
        raise ProjectError("Drawing name must be between 1 and 80 non-blank characters.")
    layers, entities = data.get("layers"), data.get("entities")
    if not isinstance(layers, list) or not 1 <= len(layers) <= 100:
        raise ProjectError("A drawing requires 1–100 layers.")
    if not isinstance(entities, list) or len(entities) > 5000:
        raise ProjectError("At most 5000 entities are supported.")
    document = ezdxf.new("R2010", units=ezdxf.units.MM)
    names, used_names = {}, set()
    non_cutting_layers = set()
    for layer in layers:
        if not isinstance(layer, dict):
            raise ProjectError("Invalid layer.")
        name, identifier = layer.get("name"), layer.get("id")
        if (
            not isinstance(name, str)
            or not name.strip()
            or len(name) > 80
            or re.search(r'[<>/\\":;?*|=\x00-\x1f]', name)
            or not isinstance(identifier, str)
            or not identifier
            or identifier in names
            or name.casefold() in used_names
        ):
            raise ProjectError("Layer names and identifiers must be valid and unique.")
        color = layer.get("color")
        construction = layer.get("construction", False)
        if (
            not isinstance(color, str)
            or not re.fullmatch(r"#[0-9a-fA-F]{6}", color)
            or type(layer.get("visible")) is not bool
            or type(layer.get("locked")) is not bool
            or type(construction) is not bool
        ):
            raise ProjectError("Invalid layer properties.")
        names[identifier] = name
        used_names.add(name.casefold())
        if construction or not layer["visible"]:
            non_cutting_layers.add(identifier)
        if cut_only and (construction or not layer["visible"]) and name != "0":
            continue
        target = document.layers.get("0") if name == "0" else document.layers.new(name)
        target.rgb = tuple(int(color[i : i + 2], 16) for i in (1, 3, 5))
        target.dxf.plot = 0 if construction else 1
        if not layer["visible"]:
            target.off()
        if layer["locked"]:
            target.lock()
    model = document.modelspace()
    ids = set()
    total_segments = 0
    for entity in entities:
        if not isinstance(entity, dict):
            raise ProjectError("Invalid drawing entity.")
        identifier = entity.get("id")
        layer_id = entity.get("layer")
        if (
            not isinstance(identifier, str)
            or not identifier
            or identifier in ids
            or not isinstance(layer_id, str)
            or layer_id not in names
        ):
            raise ProjectError("Entity identifiers and layers must be valid.")
        ids.add(identifier)
        attributes = {"layer": names[entity["layer"]]}
        kind = entity.get("type")
        skip_emit = cut_only and (layer_id in non_cutting_layers or kind in {"dim", "text"})
        if not isinstance(kind, str):
            raise ProjectError("Invalid entity type.")
        if kind == "circle":
            radius = entity.get("radius")
            if not _point(entity.get("center")) or not _number(radius) or radius <= 1e-6:
                raise ProjectError("Invalid circle.")
            if not skip_emit:
                model.add_circle(entity["center"], radius, dxfattribs=attributes)
        elif kind == "arc":
            radius = entity.get("radius")
            sa = entity.get("start_angle")
            ea = entity.get("end_angle")
            if (
                not _point(entity.get("center"))
                or not _number(radius)
                or radius <= 1e-6
                or not _number(sa)
                or not _number(ea)
            ):
                raise ProjectError("Invalid arc.")
            sweep = _arc_sweep_deg(sa, ea)
            if sweep <= 1e-4 or sweep >= 360.0 - 1e-4:
                raise ProjectError("Arc angular sweep must be strictly between 0 and 360 degrees.")
            if not skip_emit:
                model.add_arc(
                    entity["center"], radius, sa % 360.0, ea % 360.0, dxfattribs=attributes
                )
        elif kind == "dim":
            p1 = entity.get("p1")
            p2 = entity.get("p2")
            dp = entity.get("dim_point")
            if not (_point(p1) and _point(p2) and _point(dp)):
                raise ProjectError("Invalid dimension points.")
            span = math.dist(p1, p2)
            if span <= 1e-6:
                raise ProjectError("Dimension measured points must be distinct.")
            if not skip_emit:
                nx = -(p2[1] - p1[1]) / span
                ny = (p2[0] - p1[0]) / span
                signed_offset = (dp[0] - p1[0]) * nx + (dp[1] - p1[1]) * ny
                dim_obj = model.add_aligned_dim(
                    p1=p1, p2=p2, distance=signed_offset, dxfattribs=attributes
                )
                dim_obj.render()
        elif kind == "text":
            pos = entity.get("position")
            height = entity.get("height")
            rot = entity.get("rotation", 0.0)
            content_str = entity.get("text")
            if (
                not _point(pos)
                or not _number(height)
                or not (0.2 <= height <= 10000.0)
                or not _number(rot)
                or not isinstance(content_str, str)
                or not content_str.strip()
                or len(content_str) > 200
                or any(ord(ch) < 32 for ch in content_str)
            ):
                raise ProjectError("Invalid text entity.")
            if not skip_emit:
                model.add_text(
                    content_str,
                    dxfattribs={
                        **attributes,
                        "insert": pos,
                        "height": float(height),
                        "rotation": float(rot) % 360.0,
                    },
                )
        elif kind in {"line", "polyline"}:
            points = entity.get("points")
            if (
                not isinstance(points, list)
                or not 2 <= len(points) <= 1000
                or not all(_point(point) for point in points)
                or any(math.dist(a, b) < 1e-6 for a, b in zip(points, points[1:], strict=False))
            ):
                raise ProjectError("Invalid line points.")
            if kind == "line":
                if len(points) != 2:
                    raise ProjectError("A line requires two points.")
                total_segments += 1
                if total_segments > MAX_TOTAL_SEGMENTS:
                    raise ProjectError(
                        f"Drawing exceeds maximum {MAX_TOTAL_SEGMENTS} total segments."
                    )
                if not skip_emit:
                    model.add_line(*points, dxfattribs=attributes)
            else:
                if type(entity.get("closed")) is not bool:
                    raise ProjectError("Polyline closure must be explicit.")
                if entity["closed"]:
                    if len(points) < 3:
                        raise ProjectError("A closed polyline requires at least three points.")
                    if math.dist(points[-1], points[0]) < 1e-6:
                        raise ProjectError(
                            "Closed polyline start and end vertices must be distinct."
                        )
                total_segments += len(points) if entity["closed"] else len(points) - 1
                if total_segments > MAX_TOTAL_SEGMENTS:
                    raise ProjectError(
                        f"Drawing exceeds maximum {MAX_TOTAL_SEGMENTS} total segments."
                    )
                if not skip_emit:
                    model.add_lwpolyline(points, close=entity["closed"], dxfattribs=attributes)
        else:
            raise ProjectError(
                "Supported DXF exports: LINE, LWPOLYLINE, CIRCLE, ARC, DIMENSION and TEXT."
            )
    output = io.StringIO()
    document.write(output)
    return output.getvalue().encode("utf-8")
