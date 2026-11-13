"""2D-to-3D Open CASCADE B-Rep solid extrusion, CNC/laser CAM telemetry, and ISO SVG plotting."""

import html
import json
import math
import tempfile
from pathlib import Path

import build123d as bd

from cad_lab.drawing import MAX_DRAWING_BYTES, drawing_to_dxf
from cad_lab.geometry import export_part, mesh_data
from cad_lab.linter import lint_drawing
from cad_lab.project import ProjectError
from cad_lab.topology import analyze_drawing_topology, arc_geometry

DENSITY_AL6061_G_MM3 = 0.00270
DENSITY_STEEL_G_MM3 = 0.00785
DENSITY_SS304_G_MM3 = 0.00800


def _load_validated_drawing(drawing_or_json):
    if isinstance(drawing_or_json, bytes):
        if len(drawing_or_json) > MAX_DRAWING_BYTES:
            raise ProjectError("Drawing exceeds 1 MiB limit.")
        raw = drawing_or_json.decode("utf-8")
        data = json.loads(raw)
    elif isinstance(drawing_or_json, str):
        if len(drawing_or_json.encode("utf-8")) > MAX_DRAWING_BYTES:
            raise ProjectError("Drawing exceeds 1 MiB limit.")
        raw = drawing_or_json
        data = json.loads(raw)
    elif isinstance(drawing_or_json, dict):
        data = drawing_or_json
        raw = json.dumps(data)
    else:
        raise ProjectError("Expected a drawing dict or JSON string.")
    drawing_to_dxf(raw)
    return data


def compute_cam_metrics(drawing_or_json, thickness_mm=3.0):
    """Compute laser/waterjet cutting path length, pierce count, analytical net area, and mass."""
    if not isinstance(thickness_mm, (int, float)) or not (0.1 <= float(thickness_mm) <= 500.0):
        raise ProjectError("Sheet thickness must be between 0.1 and 500 mm.")
    thickness = float(thickness_mm)
    data = _load_validated_drawing(drawing_or_json)
    topo = analyze_drawing_topology(data)
    cutting = topo["cutting_entities"]

    cut_length = 0.0
    xs, ys = [], []
    for ent in cutting:
        kind = ent["type"]
        if kind == "circle":
            r = ent["radius"]
            cx, cy = ent["center"]
            cut_length += 2.0 * math.pi * r
            xs.extend([cx - r, cx + r])
            ys.extend([cy - r, cy + r])
        elif kind == "polyline":
            pts = ent["points"]
            for p in pts:
                xs.append(p[0])
                ys.append(p[1])
            seg_cnt = len(pts) if ent["closed"] else len(pts) - 1
            for i in range(seg_cnt):
                cut_length += math.dist(pts[i], pts[(i + 1) % len(pts)])
        elif kind == "line":
            p0, p1 = ent["points"]
            xs.extend([p0[0], p1[0]])
            ys.extend([p0[1], p1[1]])
            cut_length += math.dist(p0, p1)
        elif kind == "arc":
            cx, cy = ent["center"]
            r = ent["radius"]
            ps, pm, pe, sweep = arc_geometry(ent)
            for px, py in (ps, pm, pe):
                xs.append(px)
                ys.append(py)
            for quad_deg in (0.0, 90.0, 180.0, 270.0):
                if ((quad_deg - ent["start_angle"]) % 360.0) <= sweep + 1e-6:
                    xs.append(cx + r * math.cos(math.radians(quad_deg)))
                    ys.append(cy + r * math.sin(math.radians(quad_deg)))
            cut_length += r * math.radians(sweep)

    loops = topo["loops"]
    closed_loop_count = len(loops)
    open_count = len(topo["open_components"]) + len(topo["branched_components"])
    pierce_count = closed_loop_count + open_count

    outer_loops = [lp for lp in loops if lp["depth"] == 0]
    hole_loops = [lp for lp in loops if lp["depth"] == 1]
    island_loops = [lp for lp in loops if lp["depth"] >= 2]

    outer_area = sum(lp["area"] for lp in outer_loops)
    # Even-odd Jordan curve fill rule across containment hierarchy
    net_area = 0.0
    for lp in loops:
        if lp["depth"] % 2 == 0:
            net_area += lp["area"]
        else:
            net_area -= lp["area"]
    net_area = max(0.0, net_area)

    if xs and ys:
        bbox_w = max(xs) - min(xs)
        bbox_h = max(ys) - min(ys)
    else:
        bbox_w = 0.0
        bbox_h = 0.0
    bbox_area = bbox_w * bbox_h
    utilization_pct = (net_area / bbox_area * 100.0) if bbox_area > 1e-6 and net_area > 0 else 0.0
    scrap_pct = max(0.0, 100.0 - utilization_pct) if net_area > 0 else 0.0
    volume_mm3 = net_area * thickness

    return {
        "thickness_mm": round(thickness, 3),
        "cut_length_mm": round(cut_length, 3),
        "pierce_count": pierce_count,
        "closed_loops": closed_loop_count,
        "outer_loops": len(outer_loops),
        "hole_loops": len(hole_loops),
        "island_loops": len(island_loops),
        "open_components": open_count,
        "outer_area_mm2": round(outer_area, 3),
        "net_area_mm2": round(net_area, 3),
        "bbox_mm": [round(bbox_w, 3), round(bbox_h, 3)],
        "scrap_pct": round(scrap_pct, 2),
        "volume_mm3": round(volume_mm3, 3),
        "mass_g": {
            "aluminum_6061": round(volume_mm3 * DENSITY_AL6061_G_MM3, 2),
            "steel_s235": round(volume_mm3 * DENSITY_STEEL_G_MM3, 2),
            "stainless_304": round(volume_mm3 * DENSITY_SS304_G_MM3, 2),
        },
    }


def _loop_to_face(loop):
    if loop["source"] == "circle":
        cx, cy = loop["center"]
        wire = bd.Wire.make_circle(loop["radius"], bd.Plane.XY.offset(0))
        face = bd.Pos(cx, cy, 0) * bd.Face(wire)
    elif loop["source"] == "polyline":
        pts_3d = [bd.Vector(p[0], p[1], 0.0) for p in loop["points"]]
        edges = [
            bd.Edge.make_line(pts_3d[i], pts_3d[(i + 1) % len(pts_3d)]) for i in range(len(pts_3d))
        ]
        face = bd.Face(bd.Wire(edges))
    else:
        edges = []
        for edge in loop["edges"]:
            v_s = bd.Vector(edge["start"][0], edge["start"][1], 0.0)
            v_e = bd.Vector(edge["end"][0], edge["end"][1], 0.0)
            if edge["kind"] == "line":
                edges.append(bd.Edge.make_line(v_s, v_e))
            else:
                v_m = bd.Vector(edge["mid"][0], edge["mid"][1], 0.0)
                edges.append(bd.Edge.make_three_point_arc(v_s, v_m, v_e))
        face = bd.Face(bd.Wire(edges))
    return -face if face.normal_at().Z < 0 else face


def extrude_drawing_to_part(drawing_or_json, thickness_mm=5.0):
    """Extrude a verified single-part planar 2D profile into an Open CASCADE 3D Solid."""
    if not isinstance(thickness_mm, (int, float)) or not (0.2 <= float(thickness_mm) <= 500.0):
        raise ProjectError("Extrusion thickness must be between 0.2 and 500 mm.")
    thickness = float(thickness_mm)
    data = _load_validated_drawing(drawing_or_json)
    topo = analyze_drawing_topology(data)

    if topo["branched_components"]:
        ids = topo["branched_components"][0]["entity_ids"]
        raise ProjectError(
            f"Cannot extrude non-manifold or degenerate branched contour {ids}; "
            "trim stray branches or remove duplicate overlapping arcs/lines."
        )
    if topo["open_components"]:
        ids = [eid for comp in topo["open_components"] for eid in comp["entity_ids"]]
        raise ProjectError(
            f"Cannot extrude drawing with unclosed cutting entities {ids}; "
            "close all contours or move reference lines to a construction layer."
        )
    if topo["crossing_loops"]:
        pair = topo["crossing_loops"][0]
        raise ProjectError(
            f"Intersecting or boundary-straddling contours {pair[0]} and {pair[1]} "
            "cannot be extruded cleanly."
        )

    loops = topo["loops"]
    if not loops:
        raise ProjectError("No closed 2D profile found to extrude into a 3D solid.")

    outer_loops = [lp for lp in loops if lp["depth"] == 0]
    if len(outer_loops) != 1:
        raise ProjectError(
            f"Single-part 3D extrusion requires exactly 1 outer contour, found {len(outer_loops)}."
        )

    island_loops = [lp for lp in loops if lp["depth"] >= 2]
    if island_loops:
        raise ProjectError(
            "Nested islands inside cutouts (containment depth >= 2) are disconnected in "
            "single-solid through-extrusion and are rejected."
        )

    hole_loops = [lp for lp in loops if lp["depth"] == 1]

    # Run manufacturing DRC error gate so colliding/self-intersecting/duplicate contours never pass
    mfg_lint = lint_drawing(data, manufacturing=True)
    blocking = [i for i in mfg_lint["issues"] if i["severity"] == "error"]
    if blocking:
        first = blocking[0]
        raise ProjectError(f"Manufacturing DRC failed [{first['code']}]: {first['message']}")

    outer_face = _loop_to_face(outer_loops[0])
    inner_faces = [_loop_to_face(lp) for lp in hole_loops]

    part = bd.extrude(outer_face, amount=thickness)
    for hole_face in inner_faces:
        part = part - bd.extrude(hole_face, amount=thickness)

    solids = part.solids()
    vol = float(part.volume)
    surf = float(part.area)
    expected_area = outer_loops[0]["area"] - sum(lp["area"] for lp in hole_loops)
    expected_vol = expected_area * thickness
    total_perim = outer_loops[0]["perimeter"] + sum(lp["perimeter"] for lp in hole_loops)
    expected_surf = 2.0 * expected_area + total_perim * thickness

    if not part.is_valid or len(solids) != 1 or vol <= 1e-3 or expected_vol <= 1e-3:
        raise ProjectError("2D profile did not produce a valid positive-volume single 3D solid.")

    top_faces = [
        f
        for f in part.faces()
        if abs(float(f.center().Z) - thickness) <= 1e-3
        and abs(abs(float(f.normal_at().Z)) - 1.0) <= 1e-3
    ]
    if len(top_faces) != 1 or len(top_faces[0].inner_wires()) != len(hole_loops):
        raise ProjectError(
            "3D B-Rep face topology does not preserve all closed internal hole contours."
        )

    if not math.isclose(vol, expected_vol, rel_tol=3e-3, abs_tol=5e-2) or not math.isclose(
        surf, expected_surf, rel_tol=3e-3, abs_tol=5e-2
    ):
        raise ProjectError(
            f"3D B-Rep solid ({vol:.3f} mm³) diverged from 2D analytical prism "
            f"({expected_vol:.3f} mm³)."
        )

    telemetry = {
        "name": data.get("name", "Part"),
        "thickness_mm": round(thickness, 3),
        "volume_mm3": round(vol, 3),
        "expected_volume_mm3": round(expected_vol, 3),
        "surface_area_mm2": round(float(part.area), 3),
        "solid_count": len(solids),
        "closed_loops": len(loops),
        "hole_count": len(hole_loops),
        "mass_g": {
            "aluminum_6061": round(vol * DENSITY_AL6061_G_MM3, 2),
            "steel_s235": round(vol * DENSITY_STEEL_G_MM3, 2),
            "stainless_304": round(vol * DENSITY_SS304_G_MM3, 2),
        },
    }
    return part, telemetry


def export_extruded_drawing(drawing_or_json, thickness_mm=5.0, file_format="step"):
    """Extrude a 2D drawing and return exported STEP or STL bytes plus 3D telemetry."""
    part, telemetry = extrude_drawing_to_part(drawing_or_json, thickness_mm=thickness_mm)
    fmt = file_format.lower().strip()
    if fmt not in {"step", "stl"}:
        raise ProjectError("Supported 3D export formats: 'step' and 'stl'.")
    with tempfile.TemporaryDirectory(prefix="chamfer-3d-") as tmpdir:
        out_path = Path(tmpdir) / f"model.{fmt}"
        export_part(part, out_path, fmt)
        raw_bytes = out_path.read_bytes()
    return raw_bytes, telemetry, mesh_data(part)


def drawing_to_svg_blueprint(drawing_or_json, thickness_mm=3.0, manufacturing=True):
    """Render an ISO-styled cleanroom vector SVG engineering blueprint with title block."""
    data = _load_validated_drawing(drawing_or_json)
    lint = lint_drawing(data, manufacturing=manufacturing)
    cam = compute_cam_metrics(data, thickness_mm=thickness_mm)

    visible_layers = {layer["id"]: layer for layer in data["layers"] if layer.get("visible", True)}
    vis_entities = [e for e in data["entities"] if e["layer"] in visible_layers]

    xs, ys = [0.0, 100.0], [0.0, 60.0]
    if vis_entities:
        xs, ys = [], []
        for ent in vis_entities:
            k = ent["type"]
            if k in {"line", "polyline"}:
                for p in ent["points"]:
                    xs.append(p[0])
                    ys.append(p[1])
            elif k in {"circle", "arc"}:
                cx, cy = ent["center"]
                r = ent["radius"]
                xs.extend([cx - r, cx + r])
                ys.extend([cy - r, cy + r])
            elif k == "dim":
                for p in (ent["p1"], ent["p2"], ent["dim_point"]):
                    xs.append(p[0])
                    ys.append(p[1])
            elif k == "text":
                xs.append(ent["position"][0])
                ys.append(ent["position"][1])

    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    span_x = max(max_x - min_x, 20.0)
    span_y = max(max_y - min_y, 20.0)
    pad = max(span_x, span_y) * 0.14

    vx = min_x - pad
    vw = span_x + 2.0 * pad
    title_h = max(span_y * 0.18, 14.0)
    vy = -max_y - pad
    vh = span_y + 2.0 * pad + title_h
    stroke_base = max(span_x, span_y) * 0.0035

    svg_lines = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vx:.3f} {vy:.3f} {vw:.3f} {vh:.3f}" '
        'width="1200" height="850" style="background:#0b0d10;font-family:Consolas,monospace">',
        f'<rect x="{vx:.3f}" y="{vy:.3f}" width="{vw:.3f}" height="{vh:.3f}" fill="#0b0d10"/>',
        f'<rect x="{vx + pad * 0.25:.3f}" y="{vy + pad * 0.25:.3f}" '
        f'width="{vw - pad * 0.5:.3f}" height="{vh - pad * 0.5:.3f}" '
        f'fill="none" stroke="#323a46" stroke-width="{stroke_base * 0.9:.3f}"/>',
        '<g transform="scale(1,-1)">',
    ]

    for ent in vis_entities:
        color = visible_layers[ent["layer"]]["color"]
        k = ent["type"]
        if k == "line":
            (x1, y1), (x2, y2) = ent["points"]
            svg_lines.append(
                f'<line x1="{x1:.4f}" y1="{y1:.4f}" x2="{x2:.4f}" y2="{y2:.4f}" '
                f'stroke="{color}" stroke-width="{stroke_base:.4f}" fill="none"/>'
            )
        elif k == "polyline":
            pts_attr = " ".join(f"{p[0]:.4f},{p[1]:.4f}" for p in ent["points"])
            tag = "polygon" if ent["closed"] else "polyline"
            svg_lines.append(
                f'<{tag} points="{pts_attr}" stroke="{color}" '
                f'stroke-width="{stroke_base:.4f}" fill="none"/>'
            )
        elif k == "circle":
            cx, cy = ent["center"]
            svg_lines.append(
                f'<circle cx="{cx:.4f}" cy="{cy:.4f}" r="{ent["radius"]:.4f}" '
                f'stroke="{color}" stroke-width="{stroke_base:.4f}" fill="none"/>'
            )
        elif k == "arc":
            ps, _pm, pe, sweep = arc_geometry(ent)
            large_arc = 1 if sweep > 180.0 else 0
            r = ent["radius"]
            svg_lines.append(
                f'<path d="M {ps[0]:.4f} {ps[1]:.4f} A {r:.4f} {r:.4f} 0 {large_arc} 1 '
                f'{pe[0]:.4f} {pe[1]:.4f}" stroke="{color}" '
                f'stroke-width="{stroke_base:.4f}" fill="none"/>'
            )
        elif k == "dim":
            p1, p2, dp = ent["p1"], ent["p2"], ent["dim_point"]
            span = math.dist(p1, p2)
            if span > 1e-6:
                ux, uy = (p2[0] - p1[0]) / span, (p2[1] - p1[1]) / span
                nx, ny = -uy, ux
                off = (dp[0] - p1[0]) * nx + (dp[1] - p1[1]) * ny
                d1 = [p1[0] + off * nx, p1[1] + off * ny]
                d2 = [p2[0] + off * nx, p2[1] + off * ny]
                mid = [(d1[0] + d2[0]) * 0.5, (d1[1] + d2[1]) * 0.5]
                svg_lines.append(
                    f'<line x1="{p1[0]:.3f}" y1="{p1[1]:.3f}" x2="{d1[0]:.3f}" y2="{d1[1]:.3f}" '
                    f'stroke="{color}" stroke-width="{stroke_base * 0.7:.4f}"/>'
                )
                svg_lines.append(
                    f'<line x1="{p2[0]:.3f}" y1="{p2[1]:.3f}" x2="{d2[0]:.3f}" y2="{d2[1]:.3f}" '
                    f'stroke="{color}" stroke-width="{stroke_base * 0.7:.4f}"/>'
                )
                svg_lines.append(
                    f'<line x1="{d1[0]:.3f}" y1="{d1[1]:.3f}" x2="{d2[0]:.3f}" y2="{d2[1]:.3f}" '
                    f'stroke="{color}" stroke-width="{stroke_base * 0.8:.4f}"/>'
                )
                fs = stroke_base * 7.5
                svg_lines.append(
                    f'<text x="{mid[0]:.3f}" y="{-mid[1]:.3f}" transform="scale(1,-1)" '
                    f'fill="{color}" font-size="{fs:.3f}" text-anchor="middle" '
                    f'dominant-baseline="central">{span:.2f}</text>'
                )
        elif k == "text":
            tx, ty = ent["position"]
            th = ent["height"]
            rot = ent.get("rotation", 0.0)
            escaped = html.escape(ent["text"])
            svg_lines.append(
                f'<text x="{tx:.3f}" y="{-ty:.3f}" '
                f'transform="scale(1,-1) rotate({-rot:.2f} {tx:.3f} {-ty:.3f})" '
                f'fill="{color}" font-size="{th:.3f}">{escaped}</text>'
            )

    svg_lines.append("</g>")

    tb_y = vy + vh - pad * 0.25 - title_h * 0.82
    tb_x = vx + pad * 0.25
    tb_w = vw - pad * 0.5
    tb_h = title_h * 0.82
    fs_title = tb_h * 0.28
    fs_meta = tb_h * 0.20
    errs = lint["summary"]["errors"]
    warns = lint["summary"]["warnings"]
    prefix = "MFG DRC" if manufacturing else "DRAFT LINT"
    if errs == 0 and warns == 0 and (not manufacturing or cam["closed_loops"] >= 1):
        drc_str = f"{prefix}: PASSED (0 ERR / 0 WARN)"
        drc_col = "#3fb950"
    elif errs == 0 and manufacturing and cam["closed_loops"] == 0:
        drc_str = f"{prefix}: NO CUT PROFILE"
        drc_col = "#d29922"
    elif errs == 0:
        drc_str = f"{prefix}: WARNINGS (0 ERR / {warns} WARN)"
        drc_col = "#d29922"
    else:
        drc_str = f"{prefix}: FAILED ({errs} ERR / {warns} WARN)"
        drc_col = "#e5534b"
    part_title = html.escape(data.get("name", "UNTITLED"))

    svg_lines.extend(
        [
            f'<rect x="{tb_x:.3f}" y="{tb_y:.3f}" width="{tb_w:.3f}" height="{tb_h:.3f}" '
            f'fill="#12151a" stroke="#323a46" stroke-width="{stroke_base * 0.9:.3f}"/>',
            f'<text x="{tb_x + tb_h * 0.35:.3f}" y="{tb_y + tb_h * 0.44:.3f}" '
            f'fill="#e6ebf2" font-size="{fs_title:.3f}" font-weight="bold">'
            f"CHAMFER // {part_title}</text>",
            f'<text x="{tb_x + tb_h * 0.35:.3f}" y="{tb_y + tb_h * 0.78:.3f}" '
            f'fill="#939da8" font-size="{fs_meta:.3f}">'
            f"UNITS: MM  |  CUT: {cam['cut_length_mm']:.1f} MM  |  PIERCES: {cam['pierce_count']}  "
            f"|  AREA: {cam['net_area_mm2']:.1f} MM²</text>",
            f'<text x="{tb_x + tb_w - tb_h * 0.35:.3f}" y="{tb_y + tb_h * 0.62:.3f}" '
            f'fill="{drc_col}" font-size="{fs_meta * 1.05:.3f}" font-weight="bold" '
            f'text-anchor="end">{drc_str}</text>',
            "</svg>",
        ]
    )
    return ("\n".join(svg_lines) + "\n").encode("utf-8")
