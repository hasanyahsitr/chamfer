"""Multi-Gate Spatial CAD Verification Suite (Chamfer 0.3).

Evaluates deterministic 2D CAD rule synthesis (or an optional external LLM runtime via
--runtime), atomic DSL execution, Python/JS DRC & topology parity, R2010 DXF round-trip
preservation (including non-cutting construction layers), raw-entity specification
compliance (independent of cad_lab.topology and cad_lab.extrude), Open CASCADE STEP
re-import volume + 3D surface area + bounding-box accuracy, browser previewDrcFix
repair without tampering healthy features, and adversarial trap rejection.

Note on scope: By default (--runtime parametric:chamfer-rule-v1), positive synthesis
tasks measure Chamfer's offline deterministic rule compiler and verification gates,
not open-ended LLM spatial reasoning. Pass --runtime <provider:model> to benchmark an
external local or remote LLM runtime against the exact same gates.
"""

from __future__ import annotations

import argparse
import io
import json
import math
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import ezdxf
from build123d import export_step, import_step

from cad_lab.commands import DrawingSession
from cad_lab.drawing import drawing_from_dxf
from cad_lab.extrude import compute_cam_metrics, extrude_drawing_to_part
from cad_lab.linter import lint_drawing
from cad_lab.synthesis import synthesize_drawing

REPO_ROOT = Path(__file__).resolve().parents[1]
THICKNESS_MM = 5.0


def _circle_area(r: float) -> float:
    return math.pi * r * r


def _circle_perim(r: float) -> float:
    return 2.0 * math.pi * r


def _rect_area_with_chamfer(w: float, h: float, c: float = 0.0) -> float:
    return w * h - 2.0 * c * c


def _rect_perim_with_chamfer(w: float, h: float, c: float = 0.0) -> float:
    return 2.0 * (w + h) - 4.0 * (2.0 - math.sqrt(2.0)) * c


def _rect_area_with_fillet(w: float, h: float, r: float = 0.0) -> float:
    return w * h - (4.0 - math.pi) * r * r


def _rect_perim_with_fillet(w: float, h: float, r: float = 0.0) -> float:
    return 2.0 * (w + h) - 2.0 * (4.0 - math.pi) * r


def _slot_area(total_len: float, width: float) -> float:
    r = width / 2.0
    straight = max(0.0, total_len - 2.0 * r)
    return straight * width + math.pi * r * r


def _slot_perim(total_len: float, width: float) -> float:
    return 2.0 * max(0.0, total_len - width) + math.pi * width


def build_positive_tasks() -> list[dict]:
    """36 deterministic mechanical part tasks across 6 shop-floor families."""
    tasks: list[dict] = []

    # Family 1: Bolted rectangular plates (1..8 holes — explicitly covers 3, 5, 7, 8)
    bolt_configs = [
        ("P01_RECT_1xM6", 90.0, 60.0, 1, "M6", 3.3),
        ("P02_RECT_2xM6", 110.0, 60.0, 2, "M6", 3.3),
        ("P03_RECT_3xM6", 130.0, 65.0, 3, "M6", 3.3),
        ("P04_RECT_4xM5", 100.0, 70.0, 4, "M5", 2.75),
        ("P05_RECT_5xM6", 140.0, 90.0, 5, "M6", 3.3),
        ("P06_RECT_6xM6", 150.0, 90.0, 6, "M6", 3.3),
        ("P07_RECT_7xM4", 160.0, 95.0, 7, "M4", 2.25),
        ("P08_RECT_8xM6", 180.0, 100.0, 8, "M6", 3.3),
    ]
    for tid, w, h, cnt, metric, hole_r in bolt_configs:
        tasks.append(
            {
                "id": tid,
                "family": "bolted_rect_plate",
                "mode": "synthesis",
                "spec": f"{w:g}x{h:g} mm mounting plate with {cnt}x{metric} holes",
                "expected_bbox": (w, h),
                "expected_hole_count": cnt,
                "expected_hole_radii": sorted([hole_r] * cnt),
                "expected_area_mm2": w * h - cnt * _circle_area(hole_r),
                "expected_perimeter_mm": 2.0 * (w + h) + cnt * _circle_perim(hole_r),
            }
        )

    # Family 2: Chamfered mounting plates & motor faceplates (6 tasks)
    chamfer_configs = [
        ("P09_CHAMFER_4xM4", 70.0, 55.0, 4.0, 4, "M4", 2.25, None),
        ("P10_CHAMFER_4xM5", 95.0, 65.0, 5.0, 4, "M5", 2.75, None),
        ("P11_CHAMFER_4xM6", 120.0, 80.0, 6.0, 4, "M6", 3.3, None),
        ("P12_CHAMFER_6xM6", 155.0, 95.0, 6.0, 6, "M6", 3.3, None),
        ("P13_CHAMFER_BORE_4xM5", 90.0, 90.0, 5.0, 4, "M5", 2.75, 14.0),
        ("P14_CHAMFER_BORE_4xM8", 130.0, 130.0, 8.0, 4, "M8", 4.5, 22.0),
    ]
    for tid, w, h, ch, cnt, metric, hole_r, bore_r in chamfer_configs:
        bore_clause = f" center bore {bore_r * 2.0:g}mm" if bore_r else ""
        radii = [hole_r] * cnt + ([bore_r] if bore_r else [])
        cut_area = cnt * _circle_area(hole_r) + (_circle_area(bore_r) if bore_r else 0.0)
        cut_perim = cnt * _circle_perim(hole_r) + (_circle_perim(bore_r) if bore_r else 0.0)
        tasks.append(
            {
                "id": tid,
                "family": "chamfered_mount",
                "mode": "synthesis",
                "spec": f"{w:g}x{h:g} plate {cnt}x{metric}{bore_clause} chamfer {ch:g}mm",
                "expected_bbox": (w, h),
                "expected_hole_count": len(radii),
                "expected_hole_radii": sorted(radii),
                "expected_chamfer_mm": ch,
                "expected_bore_r": bore_r,
                "expected_area_mm2": _rect_area_with_chamfer(w, h, ch) - cut_area,
                "expected_perimeter_mm": _rect_perim_with_chamfer(w, h, ch) + cut_perim,
            }
        )

    # Family 3: Filleted brackets (6 tasks)
    fillet_configs = [
        ("P15_FILLET_2xM6", 110.0, 55.0, 6.0, 2, "M6", 3.3, None),
        ("P16_FILLET_4xM5", 100.0, 70.0, 8.0, 4, "M5", 2.75, None),
        ("P17_FILLET_4xM6", 125.0, 85.0, 10.0, 4, "M6", 3.3, None),
        ("P18_FILLET_6xM5", 150.0, 85.0, 8.0, 6, "M5", 2.75, None),
        ("P19_FILLET_BORE_4xM6", 110.0, 110.0, 10.0, 4, "M6", 3.3, 16.0),
        ("P20_FILLET_8xM5", 175.0, 95.0, 8.0, 8, "M5", 2.75, None),
    ]
    for tid, w, h, fr, cnt, metric, hole_r, bore_r in fillet_configs:
        bore_clause = f" center bore {bore_r * 2.0:g}mm" if bore_r else ""
        radii = [hole_r] * cnt + ([bore_r] if bore_r else [])
        cut_area = cnt * _circle_area(hole_r) + (_circle_area(bore_r) if bore_r else 0.0)
        cut_perim = cnt * _circle_perim(hole_r) + (_circle_perim(bore_r) if bore_r else 0.0)
        tasks.append(
            {
                "id": tid,
                "family": "filleted_bracket",
                "mode": "synthesis",
                "spec": f"{w:g}x{h:g} rounded bracket fillet {fr:g}mm {cnt}x{metric}{bore_clause}",
                "expected_bbox": (w, h),
                "expected_hole_count": len(radii),
                "expected_hole_radii": sorted(radii),
                "expected_fillet_mm": fr,
                "expected_bore_r": bore_r,
                "expected_area_mm2": _rect_area_with_fillet(w, h, fr) - cut_area,
                "expected_perimeter_mm": _rect_perim_with_fillet(w, h, fr) + cut_perim,
            }
        )

    # Family 4: Obround slotted brackets (chained LINE + ARC inner loops, 6 tasks)
    slot_configs = [
        ("P21_SLOT_ONLY", 110.0, 55.0, 34.0, 8.0, 0, "M6", 3.3, 0.0),
        ("P22_SLOT_2xM5", 120.0, 60.0, 36.0, 8.0, 2, "M5", 2.75, 0.0),
        ("P23_SLOT_4xM6", 130.0, 75.0, 40.0, 10.0, 4, "M6", 3.3, 0.0),
        ("P24_SLOT_CHAMFER_4xM6", 140.0, 80.0, 44.0, 10.0, 4, "M6", 3.3, 5.0),
        ("P25_SLOT_4xM8", 160.0, 95.0, 50.0, 12.0, 4, "M8", 4.5, 6.0),
        ("P26_SLOT_6xM5", 165.0, 90.0, 38.0, 8.0, 6, "M5", 2.75, 4.0),
    ]
    for tid, w, h, sl, sw, cnt, metric, hole_r, ch in slot_configs:
        bolt_clause = f" {cnt}x{metric}" if cnt > 0 else ""
        ch_clause = f" chamfer {ch:g}mm" if ch > 0 else ""
        outer_a = _rect_area_with_chamfer(w, h, ch)
        outer_p = _rect_perim_with_chamfer(w, h, ch)
        cut_a = _slot_area(sl, sw) + cnt * _circle_area(hole_r)
        cut_p = _slot_perim(sl, sw) + cnt * _circle_perim(hole_r)
        tasks.append(
            {
                "id": tid,
                "family": "slotted_bracket",
                "mode": "synthesis",
                "spec": f"{w:g}x{h:g} bracket slot {sl:g}x{sw:g}mm{bolt_clause}{ch_clause}",
                "expected_bbox": (w, h),
                "expected_hole_count": cnt + 1,
                "expected_hole_radii": sorted([hole_r] * cnt),
                "expected_slot": (sl, sw),
                "expected_chamfer_mm": ch if ch > 0 else None,
                "expected_area_mm2": outer_a - cut_a,
                "expected_perimeter_mm": outer_p + cut_p,
            }
        )

    # Family 5: Circular bolted flanges (6 tasks)
    flange_configs = [
        ("P27_FLANGE_3BOLT", 100.0, 30.0, 3, "M6", 3.3, 68.0),
        ("P28_FLANGE_4BOLT", 120.0, 40.0, 4, "M8", 4.5, 85.0),
        ("P29_FLANGE_5BOLT", 135.0, 45.0, 5, "M8", 4.5, 95.0),
        ("P30_FLANGE_6BOLT", 150.0, 50.0, 6, "M8", 4.5, 110.0),
        ("P31_FLANGE_8BOLT", 170.0, 60.0, 8, "M8", 4.5, 125.0),
        ("P32_FLANGE_4xM10", 165.0, 60.0, 4, "M10", 5.5, 125.0),
    ]
    for tid, od, id_mm, cnt, metric, hole_r, pcd in flange_configs:
        od_r = od / 2.0
        id_r = id_mm / 2.0
        radii = sorted([id_r] + [hole_r] * cnt)
        area = _circle_area(od_r) - _circle_area(id_r) - cnt * _circle_area(hole_r)
        perim = _circle_perim(od_r) + _circle_perim(id_r) + cnt * _circle_perim(hole_r)
        tasks.append(
            {
                "id": tid,
                "family": "circular_flange",
                "mode": "synthesis",
                "spec": f"circular flange OD {od:g} ID {id_mm:g} {cnt}x{metric} PCD {pcd:g}",
                "expected_bbox": (od, od),
                "expected_hole_count": cnt + 1,
                "expected_hole_radii": radii,
                "expected_flange": {
                    "od_r": od_r,
                    "id_r": id_r,
                    "bolt_count": cnt,
                    "bolt_r": hole_r,
                    "pcd": pcd,
                },
                "expected_area_mm2": area,
                "expected_perimeter_mm": perim,
            }
        )

    # Family 6: Non-rectangular stepped L-brackets & gussets via atomic CAD DSL (4 tasks)
    tasks.append(
        {
            "id": "P33_L_BRACKET_3xM6",
            "family": "non_rect_polygon_dsl",
            "mode": "commands",
            "commands": [
                "NEW L-BRACKET-3XM6",
                "LAYER 0-PROFILE #dce2ea",
                "PLINE 0,0 100,0 100,35 40,35 40,90 0,90 C id=outer",
                "LAYER CUTS #5aa9e6",
                "CIRCLE 20,17.5 3.3 id=h1",
                "CIRCLE 80,17.5 3.3 id=h2",
                "CIRCLE 20,70 3.3 id=h3",
            ],
            "expected_bbox": (100.0, 90.0),
            "expected_hole_count": 3,
            "expected_hole_radii": [3.3, 3.3, 3.3],
            "expected_area_mm2": 5700.0 - 3.0 * _circle_area(3.3),
            "expected_perimeter_mm": 380.0 + 3.0 * _circle_perim(3.3),
        }
    )
    tasks.append(
        {
            "id": "P34_TRAPEZOID_GUSSET_4xM8",
            "family": "non_rect_polygon_dsl",
            "mode": "commands",
            "commands": [
                "NEW GUSSET-4XM8",
                "LAYER 0-PROFILE #dce2ea",
                "PLINE 0,0 120,0 120,30 30,100 0,100 C id=outer",
                "LAYER CUTS #5aa9e6",
                "CIRCLE 20,20 4.5 id=h1",
                "CIRCLE 95,16 4.5 id=h2",
                "CIRCLE 18,80 4.5 id=h3",
                "CIRCLE 50,45 10.0 id=lighten-1",
            ],
            "expected_bbox": (120.0, 100.0),
            "expected_hole_count": 4,
            "expected_hole_radii": sorted([4.5, 4.5, 4.5, 10.0]),
            "expected_area_mm2": 8850.0 - 3.0 * _circle_area(4.5) - _circle_area(10.0),
            "expected_perimeter_mm": (
                280.0 + math.hypot(90.0, 70.0) + 3.0 * _circle_perim(4.5) + _circle_perim(10.0)
            ),
        }
    )
    tasks.append(
        {
            "id": "P35_T_JUNCTION_PLATE",
            "family": "non_rect_polygon_dsl",
            "mode": "commands",
            "commands": [
                "NEW T-JUNCTION-PLATE",
                "LAYER 0-PROFILE #dce2ea",
                "PLINE 0,50 35,50 35,0 85,0 85,50 120,50 120,90 0,90 C id=outer",
                "LAYER CUTS #5aa9e6",
                "CIRCLE 18,70 3.3 id=h1",
                "CIRCLE 60,70 3.3 id=h2",
                "CIRCLE 102,70 3.3 id=h3",
                "CIRCLE 60,20 3.3 id=h4",
            ],
            "expected_bbox": (120.0, 90.0),
            "expected_hole_count": 4,
            "expected_hole_radii": [3.3, 3.3, 3.3, 3.3],
            "expected_area_mm2": 7300.0 - 4.0 * _circle_area(3.3),
            "expected_perimeter_mm": 420.0 + 4.0 * _circle_perim(3.3),
        }
    )
    r_key = 18.0
    cx_k, cy_k = 60.0, 45.0
    x_chord = round(cx_k + r_key * math.cos(math.radians(30.0)), 6)
    y_top = round(cy_k + r_key * math.sin(math.radians(30.0)), 6)
    y_bot = round(cy_k - r_key * math.sin(math.radians(30.0)), 6)
    d_cut_area = 0.5 * (r_key**2) * (5.0 * math.pi / 3.0 + math.sin(math.pi / 3.0))
    d_cut_perim = r_key * (5.0 * math.pi / 3.0) + (y_top - y_bot)
    tasks.append(
        {
            "id": "P36_D_SHAFT_300DEG_ARC_PLATE",
            "family": "non_rect_polygon_dsl",
            "mode": "commands",
            "commands": [
                "NEW D-SHAFT-MOUNT",
                "LAYER 0-PROFILE #dce2ea",
                "RECTANG 0,0 120,90 id=outer",
                "LAYER CUTS #5aa9e6",
                f"ARC C {cx_k},{cy_k} {r_key} 30 330 id=d-arc",
                f"LINE {x_chord},{y_bot} {x_chord},{y_top} id=d-flat",
                "CIRCLE 18,18 3.3 id=m6-1",
                "CIRCLE 102,18 3.3 id=m6-2",
                "CIRCLE 18,72 3.3 id=m6-3",
                "CIRCLE 102,72 3.3 id=m6-4",
            ],
            "expected_bbox": (120.0, 90.0),
            "expected_hole_count": 5,
            "expected_hole_radii": [3.3, 3.3, 3.3, 3.3],
            "expected_area_mm2": 120.0 * 90.0 - d_cut_area - 4.0 * _circle_area(3.3),
            "expected_perimeter_mm": 420.0 + d_cut_perim + 4.0 * _circle_perim(3.3),
        }
    )

    return tasks


def build_adversarial_traps() -> list[dict]:
    """14 adversarial / tampering candidates that MUST be rejected by the spatial eval."""
    eq_slot_area = _slot_area(34.0, 8.0)
    eq_rect_h = eq_slot_area / 20.0
    return [
        {
            "id": "TRAP_01_BLANK_CANVAS",
            "description": "Empty drawing ('NEW Empty') submitted for a 120x80 4xM6 spec",
            "commands": ["NEW Empty"],
            "expected_bbox": (120.0, 80.0),
            "expected_hole_count": 4,
            "expected_hole_radii": [3.3, 3.3, 3.3, 3.3],
            "expected_area_mm2": 120.0 * 80.0 - 4.0 * _circle_area(3.3),
            "expected_perimeter_mm": 400.0 + 4.0 * _circle_perim(3.3),
        },
        {
            "id": "TRAP_02_MISSING_HOLES_6_OF_8",
            "description": "DRC-clean plate that silently drops 2 of 8 requested M6 holes",
            "commands": [
                "NEW SIX-INSTEAD-OF-EIGHT",
                "RECTANG 0,0 180,100 id=outer",
                "CIRCLE 20,20 3.3 id=h1",
                "ARRAY RECT h1 3 2 70 60",
            ],
            "expected_bbox": (180.0, 100.0),
            "expected_hole_count": 8,
            "expected_hole_radii": [3.3] * 8,
            "expected_area_mm2": 180.0 * 100.0 - 8.0 * _circle_area(3.3),
            "expected_perimeter_mm": 560.0 + 8.0 * _circle_perim(3.3),
        },
        {
            "id": "TRAP_03_SHRUNK_HOLE_TAMPERING",
            "description": (
                "Candidate silences edge-clearance warning by shrinking M6 hole to r=1.5 mm"
            ),
            "commands": [
                "NEW SHRUNK-HOLE-CHEAT",
                "RECTANG 0,0 100,60 id=outer",
                "CIRCLE 3.5,30 1.5 id=shrunk-m6",
                "CIRCLE 85,30 3.3 id=ok-m6",
            ],
            "expected_bbox": (100.0, 60.0),
            "expected_hole_count": 2,
            "expected_hole_radii": [3.3, 3.3],
            "expected_area_mm2": 100.0 * 60.0 - 2.0 * _circle_area(3.3),
            "expected_perimeter_mm": 320.0 + 2.0 * _circle_perim(3.3),
        },
        {
            "id": "TRAP_04_WRONG_OUTER_ENVELOPE",
            "description": "DRC-clean 100x60 plate returned for a 120x80 specification",
            "commands": [
                "NEW WRONG-ENVELOPE",
                "RECTANG 0,0 100,60 id=outer",
                "CIRCLE 15,15 3.3 id=h1",
                "ARRAY RECT h1 2 2 70 30",
            ],
            "expected_bbox": (120.0, 80.0),
            "expected_hole_count": 4,
            "expected_hole_radii": [3.3, 3.3, 3.3, 3.3],
            "expected_area_mm2": 120.0 * 80.0 - 4.0 * _circle_area(3.3),
            "expected_perimeter_mm": 400.0 + 4.0 * _circle_perim(3.3),
        },
        {
            "id": "TRAP_05_CROSS_LAYER_LOCKED_COLLISION",
            "description": "Outer profile on locked layer collided by hole on another layer",
            "setup_fn": lambda: _make_locked_cross_layer_trap(),
            "expected_bbox": (100.0, 60.0),
            "expected_hole_count": 1,
            "expected_hole_radii": [4.0],
            "expected_area_mm2": 100.0 * 60.0 - _circle_area(4.0),
            "expected_perimeter_mm": 320.0 + _circle_perim(4.0),
        },
        {
            "id": "TRAP_06_NEAR_GAP_0_005MM",
            "description": "0.005 mm open laser contour gap must not be silently closed",
            "commands": [
                "NEW NEAR-GAP",
                "PLINE 0,0 100,0 100,60 0,60 0,0.005 id=gap-outer",
            ],
            "expected_bbox": (100.0, 60.0),
            "expected_hole_count": 0,
            "expected_hole_radii": [],
            "expected_area_mm2": 6000.0,
            "expected_perimeter_mm": 320.0,
        },
        {
            "id": "TRAP_07_DISJOINT_SECOND_PART",
            "description": "Two disjoint outer plates must be rejected in single-part mode",
            "commands": [
                "NEW DISJOINT",
                "RECTANG 0,0 100,60 id=part-a",
                "RECTANG 200,0 240,20 id=part-b",
            ],
            "expected_bbox": (100.0, 60.0),
            "expected_hole_count": 0,
            "expected_hole_radii": [],
            "expected_area_mm2": 6000.0,
            "expected_perimeter_mm": 320.0,
        },
        {
            "id": "TRAP_08_NESTED_ISLAND_DROPOUT",
            "description": "Floating island inside cutout drops out during laser cutting",
            "commands": [
                "NEW ISLAND-DROPOUT",
                "RECTANG 0,0 100,100 id=outer",
                "RECTANG 20,20 80,80 id=window",
                "RECTANG 40,40 60,60 id=floating-island",
            ],
            "expected_bbox": (100.0, 100.0),
            "expected_hole_count": 1,
            "expected_hole_radii": [],
            "expected_area_mm2": 6400.0,
            "expected_perimeter_mm": 640.0,
        },
        {
            "id": "TRAP_09_T_BRANCH_AMBIGUITY",
            "description": "Degree-3 T-branch junction on cutting contour",
            "commands": [
                "NEW T-BRANCH",
                "LINE 0,0 50,0 id=e1",
                "LINE 50,0 80,0 id=spur",
                "LINE 50,0 50,50 id=e2",
                "LINE 50,50 0,50 id=e3",
                "LINE 0,50 0,0 id=e4",
            ],
            "expected_bbox": (50.0, 50.0),
            "expected_hole_count": 0,
            "expected_hole_radii": [],
            "expected_area_mm2": 2500.0,
            "expected_perimeter_mm": 200.0,
        },
        {
            "id": "TRAP_10_DUPLICATE_ZERO_AREA_ARCS",
            "description": "Two identical overlapping 180-deg arcs enclosing zero area",
            "commands": [
                "NEW TWIN-ARCS",
                "ARC C 0,0 25 0 180 id=a1",
                "ARC C 0,0 25 0 180 id=a2",
            ],
            "expected_bbox": (50.0, 25.0),
            "expected_hole_count": 0,
            "expected_hole_radii": [],
            "expected_area_mm2": 0.5 * math.pi * 25.0 * 25.0,
            "expected_perimeter_mm": 50.0 + 25.0 * math.pi,
        },
        {
            "id": "TRAP_11_EQUAL_AREA_RECT_FOR_SLOT",
            "description": (
                "Equal-area 20x12.913mm rectangle substituted for a 34x8mm obround slot"
            ),
            "commands": [
                "NEW EQUAL-AREA-WRONG-SLOT",
                "RECTANG 0,0 110,55 id=outer",
                (
                    f"RECTANG 45,{(55.0 - eq_rect_h) / 2.0:.6f} "
                    f"65,{(55.0 + eq_rect_h) / 2.0:.6f} id=fake-slot"
                ),
            ],
            "expected_bbox": (110.0, 55.0),
            "expected_hole_count": 1,
            "expected_hole_radii": [],
            "expected_slot": (34.0, 8.0),
            "expected_area_mm2": 110.0 * 55.0 - eq_slot_area,
            "expected_perimeter_mm": 330.0 + _slot_perim(34.0, 8.0),
        },
        {
            "id": "TRAP_12_SHRUNK_PCD_BOLT_CIRCLE",
            "description": (
                "Circular flange with correct OD/ID/hole count/area but wrong PCD (57.8 vs 68)"
            ),
            "commands": [
                "NEW WRONG-PCD-FLANGE",
                "CIRCLE 0,0 50 id=od",
                "CIRCLE 0,0 15 id=id",
                "CIRCLE 28.9,0 3.3 id=b1",
                "ARRAY POLAR b1 0,0 3 360",
            ],
            "expected_bbox": (100.0, 100.0),
            "expected_hole_count": 4,
            "expected_hole_radii": sorted([15.0, 3.3, 3.3, 3.3]),
            "expected_flange": {
                "od_r": 50.0,
                "id_r": 15.0,
                "bolt_count": 3,
                "bolt_r": 3.3,
                "pcd": 68.0,
            },
            "expected_area_mm2": _circle_area(50.0) - _circle_area(15.0) - 3.0 * _circle_area(3.3),
            "expected_perimeter_mm": (
                _circle_perim(50.0) + _circle_perim(15.0) + 3.0 * _circle_perim(3.3)
            ),
        },
        {
            "id": "TRAP_13_NON_CONCENTRIC_CROSSING_ARCS",
            "description": (
                "Large R=1000 outer arc contour pierced 0.2mm by non-concentric R=100 inner arc"
            ),
            "setup_fn": lambda: _make_non_concentric_crossing_arcs_trap(),
            "expected_bbox": (2000.0, 2000.0),
            "expected_hole_count": 1,
            "expected_hole_radii": [],
            "expected_area_mm2": _circle_area(1000.0) - _circle_area(100.0),
            "expected_perimeter_mm": _circle_perim(1000.0) + _circle_perim(100.0),
        },
        {
            "id": "TRAP_14_CONSTRUCTION_CIRCLE_NOT_A_HOLE",
            "description": ("Construction-layer reference circle masquerading as a cut M6 hole"),
            "commands": [
                "NEW CONSTRUCTION-FAKE-HOLE",
                "RECTANG 0,0 90,60 id=outer",
                "LAYER REF #808080 CONSTRUCTION",
                "CIRCLE 45,30 3.3 id=ref-only",
            ],
            "expected_bbox": (90.0, 60.0),
            "expected_hole_count": 1,
            "expected_hole_radii": [3.3],
            "expected_area_mm2": 90.0 * 60.0 - _circle_area(3.3),
            "expected_perimeter_mm": 300.0 + _circle_perim(3.3),
        },
        {
            "id": "TRAP_15_SELF_TOUCHING_CLOSED_POLYLINE",
            "description": (
                "Closed polyline revisiting vertex (50,0) on non-adjacent edges to form pinch loop"
            ),
            "commands": [
                "NEW SELF-TOUCH-TRAP",
                "PLINE 0,0 50,0 50,50 25,25 50,0 100,0 100,100 0,100 C id=outer",
            ],
            "expected_bbox": (100.0, 100.0),
            "expected_hole_count": 0,
            "expected_hole_radii": [],
            "expected_area_mm2": 10000.0,
            "expected_perimeter_mm": 400.0,
        },
    ]


def _make_locked_cross_layer_trap() -> dict:
    s = DrawingSession()
    s.execute_batch(
        [
            "NEW LOCKED-ESCAPE",
            "LAYER 0-OUTER #dce2ea",
            "RECTANG 0,0 100,60 id=outer",
            "LAYER CUTS #5aa9e6",
            "CIRCLE 99,30 4 id=edge-crash",
        ]
    )
    doc = s.document
    for layer in doc["layers"]:
        if layer["id"] == "0-OUTER":
            layer["locked"] = True
    return doc


def _make_non_concentric_crossing_arcs_trap() -> dict:
    s = DrawingSession()
    ang = math.radians(7.5)
    d = 900.2
    cx = d * math.cos(ang)
    cy = d * math.sin(ang)
    s.execute_batch(
        [
            "NEW ARC-PIERCE-TRAP",
            "ARC C 0,0 1000 0 180 id=o1",
            "ARC C 0,0 1000 180 360 id=o2",
            f"ARC C {cx:.6f},{cy:.6f} 100 0 180 id=i1",
            f"ARC C {cx:.6f},{cy:.6f} 100 180 360 id=i2",
        ]
    )
    return s.document


def _raw_cutting_entities(doc: dict) -> list[dict]:
    """Return cutting entities directly from raw JSON without calling cad_lab.topology."""
    cut_layers = {
        layer["id"]
        for layer in doc.get("layers", [])
        if layer.get("visible", True) and not layer.get("construction", False)
    }
    return [
        e
        for e in doc.get("entities", [])
        if e["layer"] in cut_layers and e["type"] not in {"dim", "text"}
    ]


def _raw_entity_bbox_and_perim(
    entities: list[dict],
) -> tuple[tuple[float, float, float, float], float]:
    """Independent raw bounding box and total cut length directly from JSON primitives."""
    xs: list[float] = []
    ys: list[float] = []
    total_perim = 0.0
    for ent in entities:
        t = ent["type"]
        if t == "circle":
            cx, cy = float(ent["center"][0]), float(ent["center"][1])
            r = float(ent["radius"])
            xs.extend([cx - r, cx + r])
            ys.extend([cy - r, cy + r])
            total_perim += 2.0 * math.pi * r
        elif t == "polyline":
            pts = [(float(p[0]), float(p[1])) for p in ent["points"]]
            for x, y in pts:
                xs.append(x)
                ys.append(y)
            for i in range(len(pts) - 1):
                total_perim += math.dist(pts[i], pts[i + 1])
            if ent.get("closed") and len(pts) >= 2:
                total_perim += math.dist(pts[-1], pts[0])
        elif t == "line":
            p0 = (float(ent["points"][0][0]), float(ent["points"][0][1]))
            p1 = (float(ent["points"][1][0]), float(ent["points"][1][1]))
            xs.extend([p0[0], p1[0]])
            ys.extend([p0[1], p1[1]])
            total_perim += math.dist(p0, p1)
        elif t == "arc":
            cx, cy = float(ent["center"][0]), float(ent["center"][1])
            r = float(ent["radius"])
            sa = float(ent["start_angle"]) % 360.0
            ea = float(ent["end_angle"]) % 360.0
            sweep = (ea - sa) % 360.0
            total_perim += r * math.radians(sweep)
            for ang in (sa, ea, (sa + sweep * 0.5) % 360.0):
                xs.append(cx + r * math.cos(math.radians(ang)))
                ys.append(cy + r * math.sin(math.radians(ang)))
            for q in (0.0, 90.0, 180.0, 270.0):
                if ((q - sa) % 360.0) <= sweep + 1e-6:
                    xs.append(cx + r * math.cos(math.radians(q)))
                    ys.append(cy + r * math.sin(math.radians(q)))
    if not xs:
        return (0.0, 0.0, 0.0, 0.0), 0.0
    return (min(xs), min(ys), max(xs), max(ys)), total_perim


def check_spec_compliance(doc: dict, task: dict) -> tuple[bool, list[str]]:
    """Independent raw-entity specification oracle (zero imports from cad_lab.topology/extrude)."""
    reasons: list[str] = []
    cut_ents = _raw_cutting_entities(doc)
    if not cut_ents:
        return False, ["no_cutting_entities"]

    (bx0, by0, bx1, by1), raw_perim = _raw_entity_bbox_and_perim(cut_ents)
    actual_w = bx1 - bx0
    actual_h = by1 - by0
    exp_w, exp_h = task["expected_bbox"]
    if abs(actual_w - exp_w) > 0.05 or abs(actual_h - exp_h) > 0.05:
        reasons.append(f"bbox=({actual_w:.3f}x{actual_h:.3f})!=({exp_w:.3f}x{exp_h:.3f})")

    exp_perim = task.get("expected_perimeter_mm")
    if exp_perim is not None and abs(raw_perim - exp_perim) > 0.15:
        reasons.append(f"raw_perimeter={raw_perim:.3f}!={exp_perim:.3f}")

    circles = [e for e in cut_ents if e["type"] == "circle"]
    lines = [e for e in cut_ents if e["type"] == "line"]
    arcs = [e for e in cut_ents if e["type"] == "arc"]
    closed_polys = [e for e in cut_ents if e["type"] == "polyline" and e.get("closed")]
    open_polys = [e for e in cut_ents if e["type"] == "polyline" and not e.get("closed")]
    if open_polys:
        reasons.append("open_polyline_present")

    # Identify outer circular boundary if circular flange
    outer_circle_id = None
    if task.get("expected_flange"):
        fl = task["expected_flange"]
        od_cands = [c for c in circles if abs(float(c["radius"]) - fl["od_r"]) <= 0.03]
        if len(od_cands) != 1:
            reasons.append("missing_flange_outer_circle")
        else:
            outer_circle = od_cands[0]
            outer_circle_id = outer_circle["id"]
            ocx, ocy = float(outer_circle["center"][0]), float(outer_circle["center"][1])
            inner_circles = [c for c in circles if c["id"] != outer_circle_id]
            id_cands = [
                c
                for c in inner_circles
                if abs(float(c["radius"]) - fl["id_r"]) <= 0.03
                and math.hypot(float(c["center"][0]) - ocx, float(c["center"][1]) - ocy) <= 0.05
            ]
            if not id_cands:
                reasons.append("missing_concentric_flange_id_bore")
            else:
                id_id = id_cands[0]["id"]
                bolts = [c for c in inner_circles if c["id"] != id_id]
                if len(bolts) != fl["bolt_count"]:
                    reasons.append(f"flange_bolts={len(bolts)}!={fl['bolt_count']}")
                else:
                    target_pr = fl["pcd"] / 2.0
                    for b in bolts:
                        r_dist = math.hypot(
                            float(b["center"][0]) - ocx, float(b["center"][1]) - ocy
                        )
                        if abs(r_dist - target_pr) > 0.08:
                            reasons.append(f"bolt_pcd={r_dist * 2.0:.3f}!={fl['pcd']:.3f}")
                            break
                    if fl["bolt_count"] >= 2:
                        angs = sorted(
                            math.degrees(
                                math.atan2(float(b["center"][1]) - ocy, float(b["center"][0]) - ocx)
                            )
                            % 360.0
                            for b in bolts
                        )
                        exp_step = 360.0 / fl["bolt_count"]
                        for k in range(len(angs)):
                            diff = (angs[(k + 1) % len(angs)] - angs[k]) % 360.0
                            if abs(diff - exp_step) > 0.5:
                                reasons.append("non_uniform_bolt_circle_angles")
                                break

    hole_circles = [c for c in circles if c["id"] != outer_circle_id]
    circle_radii = sorted(round(float(c["radius"]), 4) for c in hole_circles)
    exp_radii = sorted(round(float(r), 4) for r in task["expected_hole_radii"])
    if len(circle_radii) != len(exp_radii) or any(
        abs(a - b) > 0.02 for a, b in zip(circle_radii, exp_radii, strict=True)
    ):
        reasons.append(f"circle_radii={circle_radii}!={exp_radii}")

    # Verify center bore concentricity on plates
    if task.get("expected_bore_r"):
        bore_r = task["expected_bore_r"]
        mid_x, mid_y = 0.5 * (bx0 + bx1), 0.5 * (by0 + by1)
        if not any(
            abs(float(c["radius"]) - bore_r) <= 0.03
            and math.hypot(float(c["center"][0]) - mid_x, float(c["center"][1]) - mid_y) <= 0.1
            for c in hole_circles
        ):
            reasons.append("missing_concentric_center_bore")

    # Verify corner chamfers directly on outer closed polyline
    if task.get("expected_chamfer_mm"):
        ch = task["expected_chamfer_mm"]
        exp_bevel = ch * math.sqrt(2.0)
        if len(closed_polys) != 1 or len(closed_polys[0]["points"]) != 8:
            reasons.append("missing_8_vertex_chamfer_outer_polyline")
        else:
            pts = [(float(p[0]), float(p[1])) for p in closed_polys[0]["points"]]
            seg_lens = [math.dist(pts[i], pts[(i + 1) % 8]) for i in range(8)]
            bevel_count = sum(1 for slen in seg_lens if abs(slen - exp_bevel) <= 0.05)
            if bevel_count != 4:
                reasons.append(f"chamfer_bevel_edges={bevel_count}!=4")

    # Verify corner fillets directly on raw arcs
    if task.get("expected_fillet_mm"):
        fr = task["expected_fillet_mm"]
        fillet_arcs = [
            a
            for a in arcs
            if abs(float(a["radius"]) - fr) <= 0.04
            and abs(((float(a["end_angle"]) - float(a["start_angle"])) % 360.0) - 90.0) <= 0.5
        ]
        if len(fillet_arcs) != 4 or len(lines) < 4:
            reasons.append(f"fillet_quarter_arcs={len(fillet_arcs)}!=4")

    # Verify true obround capsule slot (2 180-deg arcs of radius W/2 + 2 straight segments L-W)
    if task.get("expected_slot"):
        sl, sw = task["expected_slot"]
        sr = sw / 2.0
        straight_len = sl - sw
        endcap_arcs = [
            a
            for a in arcs
            if abs(float(a["radius"]) - sr) <= 0.04
            and abs(((float(a["end_angle"]) - float(a["start_angle"])) % 360.0) - 180.0) <= 0.5
        ]
        slot_lines = [
            ln
            for ln in lines
            if abs(
                math.dist(
                    (float(ln["points"][0][0]), float(ln["points"][0][1])),
                    (float(ln["points"][1][0]), float(ln["points"][1][1])),
                )
                - straight_len
            )
            <= 0.05
        ]
        if len(endcap_arcs) != 2 or len(slot_lines) < 2:
            reasons.append(
                f"invalid_obround_slot_primitives(arcs={len(endcap_arcs)},lines={len(slot_lines)})"
            )
        else:
            c_dist = math.hypot(
                float(endcap_arcs[0]["center"][0]) - float(endcap_arcs[1]["center"][0]),
                float(endcap_arcs[0]["center"][1]) - float(endcap_arcs[1]["center"][1]),
            )
            if abs(c_dist - straight_len) > 0.05:
                reasons.append(f"slot_center_span={c_dist:.3f}!={straight_len:.3f}")

    return len(reasons) == 0, reasons


def check_step_oracle(
    doc: dict,
    expected_area_mm2: float,
    tmp_dir: Path,
    tag: str,
    expected_perimeter_mm: float | None = None,
    expected_bbox: tuple[float, float] | None = None,
) -> tuple[bool, str, float]:
    """Extrude via OCCT, write ISO 10303-21 STEP, re-import STEP, verify volume + 3D area + bbox."""
    try:
        part, _tel = extrude_drawing_to_part(doc, thickness_mm=THICKNESS_MM)
        step_path = tmp_dir / f"{tag}.step"
        export_step(part, str(step_path))
        reimported = import_step(str(step_path))
        solids = reimported.solids()
        if not reimported.is_valid or len(solids) != 1:
            return False, f"step_invalid_or_solids={len(solids)}", 0.0
        vol = float(reimported.volume)
        expected_vol = expected_area_mm2 * THICKNESS_MM
        if vol <= 0.0 or abs(vol - expected_vol) > 1.5:
            return False, f"step_vol={vol:.2f}!=expected={expected_vol:.2f}", vol

        if expected_perimeter_mm is not None:
            surf_area = float(reimported.area)
            expected_surf = 2.0 * expected_area_mm2 + expected_perimeter_mm * THICKNESS_MM
            if abs(surf_area - expected_surf) > max(1.5, 1e-3 * expected_surf):
                return (
                    False,
                    f"step_surface_area={surf_area:.2f}!=expected={expected_surf:.2f}",
                    vol,
                )

        if expected_bbox is not None:
            bb = reimported.bounding_box()
            if (
                abs(float(bb.size.X) - expected_bbox[0]) > 0.08
                or abs(float(bb.size.Y) - expected_bbox[1]) > 0.08
                or abs(float(bb.size.Z) - THICKNESS_MM) > 0.05
            ):
                return (
                    False,
                    f"step_bbox=({bb.size.X:.2f}x{bb.size.Y:.2f}x{bb.size.Z:.2f})",
                    vol,
                )

        return True, "ok", round(vol, 2)
    except Exception as exc:
        return False, str(exc), 0.0


def evaluate_js_batch(drawings_by_id: dict[str, dict], tmp_dir: Path) -> dict[str, dict]:
    """Run Node.js twin engine (ops.js + linter.js + dxf.js) + previewDrcFix repair suite."""
    js_runner = tmp_dir / "run_js_eval.mjs"
    in_path = tmp_dir / "js_eval_in.json"
    out_path = tmp_dir / "js_eval_out.json"
    ops_url = (REPO_ROOT / "web/src/drawing/ops.js").as_uri()
    linter_url = (REPO_ROOT / "web/src/drawing/linter.js").as_uri()
    dxf_url = (REPO_ROOT / "web/src/drawing/dxf.js").as_uri()

    js_runner.write_text(
        f"""import fs from 'node:fs';
import {{ computeCamMetrics }} from '{ops_url}';
import {{ lintDrawing, previewDrcFix }} from '{linter_url}';
import {{ exportDrawingToDxf, importDrawingFromDxf }} from '{dxf_url}';

const payload = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const out = {{ tasks: {{}}, auto_repair: [] }};

for (const [id, doc] of Object.entries(payload.drawings)) {{
  const cam = computeCamMetrics(doc, payload.thickness);
  const drc = lintDrawing(doc, {{ manufacturing: true }});
  const dxf = exportDrawingToDxf(doc);
  const round = importDrawingFromDxf(dxf, doc.name);
  const roundCam = computeCamMetrics(round.drawing, payload.thickness);
  out.tasks[id] = {{
    closed_loops: cam.closed_loops,
    net_area_mm2: cam.net_area_mm2,
    valid: drc.valid,
    errors: drc.summary.errors,
    warnings: drc.summary.warnings,
    dxf_text: dxf,
    js_roundtrip_area_mm2: roundCam.net_area_mm2,
  }};
}}

for (const faultCase of payload.repair_cases) {{
  let working = structuredClone(faultCase.doc);
  const initialCircles = working.entities
    .filter((e) => e.type === 'circle')
    .map((e) => e.radius)
    .sort((a, b) => a - b);
  const initialHealthyCenters = Object.fromEntries(
    working.entities
      .filter((e) => (faultCase.healthy_ids || []).includes(e.id))
      .map((e) => [e.id, e.center]),
  );
  let steps = 0;
  for (let i = 0; i < 16; i++) {{
    const rep = lintDrawing(working, {{ manufacturing: true }});
    let applied = false;
    for (const iss of rep.issues) {{
      const fix = previewDrcFix(working, iss);
      if (fix) {{
        working = fix.nextDoc;
        steps++;
        applied = true;
        break;
      }}
    }}
    if (!applied) break;
  }}
  const afterDrc = lintDrawing(working, {{ manufacturing: true }});
  const afterCircles = working.entities
    .filter((e) => e.type === 'circle')
    .map((e) => e.radius)
    .sort((a, b) => a - b);
  const healthyCentersPreserved = Object.entries(initialHealthyCenters).every(([hid, c0]) => {{
    const ent = working.entities.find((e) => e.id === hid);
    return ent && Math.hypot(ent.center[0] - c0[0], ent.center[1] - c0[1]) <= 1e-6;
  }});
  out.auto_repair.push({{
    id: faultCase.id,
    steps,
    repaired_doc: working,
    valid: afterDrc.valid && afterDrc.summary.warnings === 0,
    radii_preserved: JSON.stringify(initialCircles) === JSON.stringify(afterCircles),
    healthy_centers_preserved: healthyCentersPreserved,
  }});
}}

fs.writeFileSync(process.argv[3], JSON.stringify(out), 'utf8');
""",
        encoding="utf-8",
    )
    in_path.write_text(
        json.dumps(
            {
                "thickness": THICKNESS_MM,
                "drawings": drawings_by_id,
                "repair_cases": _build_autonomous_repair_cases(),
            }
        ),
        encoding="utf-8",
    )
    proc = subprocess.run(
        ["node", str(js_runner), str(in_path), str(out_path)],
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
    )
    if proc.returncode != 0:
        raise RuntimeError(f"Node eval failed ({proc.returncode}): {proc.stderr}")
    return json.loads(out_path.read_text(encoding="utf-8"))


def _build_autonomous_repair_cases() -> list[dict]:
    """6 faulty drawings evaluated with genuine previewDrcFix (zero scripted repair_cmds)."""
    cases = []

    s1 = DrawingSession()
    s1.execute_batch(
        [
            "NEW R1-FLAWED-BRACKET",
            "PLINE 0,0 80,0 80,50 0,50 0,0.6 id=outer-profile",
            "CIRCLE 12,12 3 id=hole-ok",
            "CIRCLE 12,38 3 id=hole-thin-web",
            "CIRCLE 18.8,38 3 id=hole-bridge",
            "CIRCLE 78.5,25 3 id=hole-edge-crash",
        ]
    )
    cases.append(
        {
            "id": "R1_UI_FAULT_BRACKET",
            "doc": s1.document,
            "healthy_ids": ["hole-ok"],
            "expected_area_mm2": 80.0 * 50.0 - 4.0 * _circle_area(3.0),
            "expected_perimeter_mm": 260.0 + 4.0 * _circle_perim(3.0),
            "expected_bbox": (80.0, 50.0),
        }
    )

    s2 = DrawingSession()
    s2.execute_batch(
        [
            "NEW R2-OUTSIDE-AND-CHAIN-GAP",
            "LINE 0,0 100,0 id=b",
            "LINE 100,0 100,60 id=r",
            "LINE 100,60 0,60 id=t",
            "LINE 0,60 0,0.4 id=l",
            "CIRCLE 20,30 4 id=ok-hole",
            "CIRCLE 98.8,30 4 id=edge-tear",
        ]
    )
    cases.append(
        {
            "id": "R2_CHAIN_GAP_AND_TEAROUT",
            "doc": s2.document,
            "healthy_ids": ["ok-hole"],
            "expected_area_mm2": 100.0 * 60.0 - 2.0 * _circle_area(4.0),
            "expected_perimeter_mm": 320.0 + 2.0 * _circle_perim(4.0),
            "expected_bbox": (100.0, 60.0),
        }
    )

    s3 = DrawingSession()
    s3.execute_batch(
        [
            "NEW R3-DUP-AND-OVERLAP",
            "RECTANG 0,0 110,65 id=outer",
            "LINE 10,0 90,0 id=dup-burn",
            "CIRCLE 35,32.5 4.5 id=b1",
            "CIRCLE 41.0,32.5 4.5 id=b2",
        ]
    )
    cases.append(
        {
            "id": "R3_DUP_BURN_AND_BOLT_CLASH",
            "doc": s3.document,
            "healthy_ids": ["b1"],
            "expected_area_mm2": 110.0 * 65.0 - 2.0 * _circle_area(4.5),
            "expected_perimeter_mm": 350.0 + 2.0 * _circle_perim(4.5),
            "expected_bbox": (110.0, 65.0),
        }
    )

    s4 = DrawingSession()
    s4.execute_batch(
        [
            "NEW R4-OUTSIDE-PROFILE",
            "RECTANG 0,0 90,55 id=outer",
            "CIRCLE 112,27.5 3.3 id=stray-m6",
        ]
    )
    cases.append(
        {
            "id": "R4_STRAY_OUTSIDE_HOLE",
            "doc": s4.document,
            "healthy_ids": [],
            "expected_area_mm2": 90.0 * 55.0 - _circle_area(3.3),
            "expected_perimeter_mm": 290.0 + _circle_perim(3.3),
            "expected_bbox": (90.0, 55.0),
        }
    )

    s5 = DrawingSession()
    s5.execute_batch(
        [
            "NEW R5-FLANGE-RIM-THIN",
            "CIRCLE 0,0 55 id=od",
            "CIRCLE 0,0 18 id=id",
            "CIRCLE 50.8,0 4.5 id=rim-clash",
            "CIRCLE -36,0 4.5 id=ok-bolt",
        ]
    )
    cases.append(
        {
            "id": "R5_FLANGE_RIM_CLEARANCE",
            "doc": s5.document,
            "healthy_ids": ["od", "id", "ok-bolt"],
            "expected_area_mm2": _circle_area(55.0) - _circle_area(18.0) - 2.0 * _circle_area(4.5),
            "expected_perimeter_mm": (
                _circle_perim(55.0) + _circle_perim(18.0) + 2.0 * _circle_perim(4.5)
            ),
            "expected_bbox": (110.0, 110.0),
        }
    )

    s6 = DrawingSession()
    s6.execute_batch(
        [
            "NEW R6-CORNER-CLEARANCE",
            "RECTANG 0,0 100,60 id=outer",
            "CIRCLE 3.5,12 2.75 id=tl-close",
            "CIRCLE 96.5,48 2.75 id=br-close",
            "CIRCLE 12,48 2.75 id=tl-ok",
            "CIRCLE 88,12 2.75 id=br-ok",
        ]
    )
    cases.append(
        {
            "id": "R6_TWO_EDGE_CLEARANCE_FAULTS",
            "doc": s6.document,
            "healthy_ids": ["tl-ok", "br-ok"],
            "expected_area_mm2": 100.0 * 60.0 - 4.0 * _circle_area(2.75),
            "expected_perimeter_mm": 320.0 + 4.0 * _circle_perim(2.75),
            "expected_bbox": (100.0, 60.0),
        }
    )

    return cases


def run_spatial_eval(runtime_id: str = "parametric:chamfer-rule-v1") -> dict:
    t0 = time.perf_counter()
    positive_tasks = build_positive_tasks()
    adversarial_traps = build_adversarial_traps()

    candidate_docs: dict[str, dict] = {}
    exec_ok: dict[str, bool] = {}
    exec_notes: dict[str, list[str]] = {}

    for task in positive_tasks:
        try:
            if task["mode"] == "synthesis":
                session = DrawingSession()
                targets = [] if runtime_id.startswith("parametric:") else None
                res = synthesize_drawing(
                    session,
                    task["spec"],
                    runtime_id=runtime_id,
                    targets=targets,
                )
                exec_ok[task["id"]] = bool(res["lint"]["valid"])
                candidate_docs[task["id"]] = res["drawing"]
                exec_notes[task["id"]] = []
            else:
                session = DrawingSession()
                session.execute_batch(task["commands"])
                exec_ok[task["id"]] = True
                candidate_docs[task["id"]] = session.document
                exec_notes[task["id"]] = []
        except Exception as exc:
            exec_ok[task["id"]] = False
            candidate_docs[task["id"]] = DrawingSession().document
            exec_notes[task["id"]] = [str(exc)]

    for trap in adversarial_traps:
        if "setup_fn" in trap:
            candidate_docs[trap["id"]] = trap["setup_fn"]()
            exec_ok[trap["id"]] = True
        else:
            session = DrawingSession()
            session.execute_batch(trap["commands"])
            candidate_docs[trap["id"]] = session.document
            exec_ok[trap["id"]] = True

    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        js_batch = evaluate_js_batch(candidate_docs, tmp_dir)

        positive_rows = []
        gate_counts = {
            "syntax_atomic": 0,
            "drc_manufacturing": 0,
            "js_engine_parity": 0,
            "dxf_roundtrip": 0,
            "spec_compliance": 0,
            "brep_step_oracle": 0,
            "all_gates_passed": 0,
        }

        for task in positive_tasks:
            tid = task["id"]
            doc = candidate_docs[tid]
            g_syntax = exec_ok[tid]
            py_drc = lint_drawing(doc, manufacturing=True)
            g_drc = py_drc["valid"] and py_drc["summary"]["warnings"] == 0

            py_cam = compute_cam_metrics(doc, thickness_mm=THICKNESS_MM)
            js_info = js_batch["tasks"][tid]
            g_parity = (
                py_cam["closed_loops"] == js_info["closed_loops"]
                and abs(py_cam["net_area_mm2"] - js_info["net_area_mm2"]) <= 0.05
                and py_drc["valid"] == js_info["valid"]
                and py_drc["summary"]["errors"] == js_info["errors"]
            )

            # Audit JS-exported DXF with ezdxf + Python re-import
            dxf_doc = ezdxf.read(io.StringIO(js_info["dxf_text"]))
            auditor = dxf_doc.audit()
            py_reimported = drawing_from_dxf(js_info["dxf_text"])["drawing"]
            py_re_cam = compute_cam_metrics(py_reimported, thickness_mm=THICKNESS_MM)
            g_dxf = (
                len(auditor.errors) == 0
                and abs(py_re_cam["net_area_mm2"] - py_cam["net_area_mm2"]) <= 0.05
                and abs(js_info["js_roundtrip_area_mm2"] - py_cam["net_area_mm2"]) <= 0.05
            )

            g_spec, spec_reasons = check_spec_compliance(doc, task)
            g_step, step_note, step_vol = check_step_oracle(
                doc,
                task["expected_area_mm2"],
                tmp_dir,
                tid,
                expected_perimeter_mm=task.get("expected_perimeter_mm"),
                expected_bbox=task.get("expected_bbox"),
            )

            all_ok = g_syntax and g_drc and g_parity and g_dxf and g_spec and g_step
            if g_syntax:
                gate_counts["syntax_atomic"] += 1
            if g_drc:
                gate_counts["drc_manufacturing"] += 1
            if g_parity:
                gate_counts["js_engine_parity"] += 1
            if g_dxf:
                gate_counts["dxf_roundtrip"] += 1
            if g_spec:
                gate_counts["spec_compliance"] += 1
            if g_step:
                gate_counts["brep_step_oracle"] += 1
            if all_ok:
                gate_counts["all_gates_passed"] += 1

            positive_rows.append(
                {
                    "id": tid,
                    "family": task["family"],
                    "syntax_atomic": g_syntax,
                    "drc_manufacturing": g_drc,
                    "js_engine_parity": g_parity,
                    "dxf_roundtrip": g_dxf,
                    "spec_compliance": g_spec,
                    "brep_step_oracle": g_step,
                    "step_volume_mm3": step_vol,
                    "passed": all_ok,
                    "notes": exec_notes[tid] + spec_reasons + ([] if g_step else [step_note]),
                }
            )

        trap_rows = []
        rejected_traps = 0
        for trap in adversarial_traps:
            tid = trap["id"]
            doc = candidate_docs[tid]
            py_drc = lint_drawing(doc, manufacturing=True)
            js_info = js_batch["tasks"][tid]
            g_drc = py_drc["valid"]
            g_spec, spec_reasons = check_spec_compliance(doc, trap)
            g_step, step_note, _ = check_step_oracle(
                doc,
                trap["expected_area_mm2"],
                tmp_dir,
                tid,
                expected_perimeter_mm=trap.get("expected_perimeter_mm"),
                expected_bbox=trap.get("expected_bbox"),
            )
            overall_accepted = g_drc and g_spec and g_step
            rejected = not overall_accepted and (py_drc["valid"] == js_info["valid"])
            if rejected:
                rejected_traps += 1
            trap_rows.append(
                {
                    "id": tid,
                    "description": trap["description"],
                    "drc_valid": g_drc,
                    "js_drc_parity": py_drc["valid"] == js_info["valid"],
                    "spec_compliant": g_spec,
                    "step_oracle_valid": g_step,
                    "rejected_as_expected": rejected,
                    "rejection_reasons": (
                        [i["code"] for i in py_drc["issues"]]
                        + spec_reasons
                        + ([] if g_step else [step_note])
                    ),
                }
            )

        repair_meta = {c["id"]: c for c in _build_autonomous_repair_cases()}
        repair_rows = []
        repair_verified = 0
        for item in js_batch["auto_repair"]:
            rid = item["id"]
            rdoc = item["repaired_doc"]
            rmeta = repair_meta[rid]
            py_drc = lint_drawing(rdoc, manufacturing=True)
            g_step, step_note, step_vol = check_step_oracle(
                rdoc,
                rmeta["expected_area_mm2"],
                tmp_dir,
                rid,
                expected_perimeter_mm=rmeta["expected_perimeter_mm"],
                expected_bbox=rmeta["expected_bbox"],
            )
            ok = (
                item["valid"]
                and item["radii_preserved"]
                and item["healthy_centers_preserved"]
                and py_drc["valid"]
                and py_drc["summary"]["warnings"] == 0
                and g_step
            )
            if ok:
                repair_verified += 1
            repair_rows.append(
                {
                    "id": rid,
                    "steps": item["steps"],
                    "radii_preserved": item["radii_preserved"],
                    "healthy_centers_preserved": item["healthy_centers_preserved"],
                    "drc_clean": py_drc["valid"] and py_drc["summary"]["warnings"] == 0,
                    "step_oracle_valid": g_step,
                    "step_volume_mm3": step_vol,
                    "verified": ok,
                    "note": step_note,
                }
            )

    elapsed_s = round(time.perf_counter() - t0, 2)
    n_pos = len(positive_tasks)
    n_traps = len(adversarial_traps)
    n_rep = len(repair_rows)

    return {
        "suite": "chamfer-spatial-eval-v2",
        "evaluated_synthesis_runtime": runtime_id,
        "scope_note": (
            "Default runtime 'parametric:chamfer-rule-v1' evaluates the deterministic rule "
            "compiler and verification gates, not general LLM spatial reasoning."
            if runtime_id.startswith("parametric:")
            else f"Evaluated external synthesis runtime: {runtime_id}"
        ),
        "thickness_mm": THICKNESS_MM,
        "elapsed_seconds": elapsed_s,
        "positive_synthesis_and_dsl": {
            "total_tasks": n_pos,
            "gate_pass_counts": gate_counts,
            "all_gates_pass_rate_pct": round(gate_counts["all_gates_passed"] / n_pos * 100.0, 1),
            "tasks": positive_rows,
        },
        "adversarial_trap_rejection": {
            "total_traps": n_traps,
            "rejected_count": rejected_traps,
            "false_accept_count": n_traps - rejected_traps,
            "rejection_rate_pct": round(rejected_traps / n_traps * 100.0, 1),
            "traps": trap_rows,
        },
        "autonomous_drc_repair": {
            "total_fault_parts": n_rep,
            "verified_without_spec_tampering": repair_verified,
            "verified_rate_pct": round(repair_verified / n_rep * 100.0, 1),
            "cases": repair_rows,
        },
    }


def _print_human_table(report: dict) -> None:
    pos = report["positive_synthesis_and_dsl"]
    traps = report["adversarial_trap_rejection"]
    rep = report["autonomous_drc_repair"]
    gc = pos["gate_pass_counts"]
    n = pos["total_tasks"]

    print(
        f"Chamfer Spatial Eval v2 "
        f"({report['elapsed_seconds']}s, runtime={report['evaluated_synthesis_runtime']}, "
        f"thickness={report['thickness_mm']} mm)"
    )
    print(f"Scope: {report['scope_note']}")
    print("=" * 78)
    print(f"1. Positive Rule-Compiler & DSL Tasks ({n} parts across 6 mechanical families)")
    print(f"   - Atomic Command Execution        : {gc['syntax_atomic']}/{n}")
    print(f"   - Manufacturing DRC (0 err/warn)  : {gc['drc_manufacturing']}/{n}")
    print(f"   - Python <-> JS Engine Parity     : {gc['js_engine_parity']}/{n}")
    print(f"   - R2010 DXF Audit & Round-Trip    : {gc['dxf_roundtrip']}/{n}")
    print(f"   - Raw-JSON Spec & Feature Oracle  : {gc['spec_compliance']}/{n}")
    print(f"   - OCCT STEP Vol + 3D Area + BBox  : {gc['brep_step_oracle']}/{n}")
    print(
        f"   => ALL 6 CHECKS PASSED            : "
        f"{gc['all_gates_passed']}/{n} ({pos['all_gates_pass_rate_pct']}%)"
    )
    print("-" * 78)
    print(
        f"2. Curated Adversarial & Spec Traps  : "
        f"{traps['rejected_count']}/{traps['total_traps']} rejected in suite "
        f"(suite false accepts: {traps['false_accept_count']})"
    )
    print(
        f"3. Deterministic DRC Preview-Repair  : "
        f"{rep['verified_without_spec_tampering']}/{rep['total_fault_parts']} "
        f"healed + STEP-verified (radii & healthy hole centers preserved)"
    )
    print("=" * 78)

    failed_pos = [r for r in pos["tasks"] if not r["passed"]]
    if failed_pos:
        print("FAILED POSITIVE TASKS:")
        for r in failed_pos:
            print(f"  [FAIL] {r['id']}: {r['notes']}")

    false_accepts = [t for t in traps["traps"] if not t["rejected_as_expected"]]
    if false_accepts:
        print("FALSE ACCEPTS ON ADVERSARIAL TRAPS:")
        for t in false_accepts:
            print(f"  [FALSE ACCEPT] {t['id']}: {t['description']}")

    failed_rep = [r for r in rep["cases"] if not r["verified"]]
    if failed_rep:
        print("FAILED AUTONOMOUS REPAIRS:")
        for r in failed_rep:
            print(f"  [FAIL] {r['id']}: {r}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Run Chamfer spatial verification suite.")
    parser.add_argument(
        "--runtime",
        type=str,
        default="parametric:chamfer-rule-v1",
        help="Synthesis runtime id (e.g. parametric:chamfer-rule-v1 or ollama:qwen2.5-coder:7b).",
    )
    parser.add_argument("--json", action="store_true", help="Print full JSON report to stdout.")
    parser.add_argument("--out", type=str, default="", help="Optional path to write JSON report.")
    args = parser.parse_args()

    report = run_spatial_eval(runtime_id=args.runtime)
    if args.out:
        Path(args.out).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        _print_human_table(report)

    ok = (
        report["positive_synthesis_and_dsl"]["gate_pass_counts"]["all_gates_passed"]
        == report["positive_synthesis_and_dsl"]["total_tasks"]
        and report["adversarial_trap_rejection"]["false_accept_count"] == 0
        and report["autonomous_drc_repair"]["verified_without_spec_tampering"]
        == report["autonomous_drc_repair"]["total_fault_parts"]
    )
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
