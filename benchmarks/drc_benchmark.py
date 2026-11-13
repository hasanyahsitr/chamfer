"""Deterministic DRC rule & paired reference-fixture regression suite (fault vs clean fixture)."""

import json
import time
from pathlib import Path

from cad_lab.commands import DrawingSession
from cad_lab.extrude import compute_cam_metrics, extrude_drawing_to_part
from cad_lab.linter import lint_drawing


def build_industrial_examples(examples_dir: Path):
    """Generate and verify standard industrial reference CAD drawings in examples/."""
    examples_dir.mkdir(parents=True, exist_ok=True)
    generated = {}

    # 1. NEMA-17 Stepper Motor Faceplate (42.3 x 42.3 mm, 31.0 mm M3 bolt pitch, Ø22 pilot)
    s1 = DrawingSession()
    s1.execute_batch(
        [
            "NEW NEMA17-MOTOR-MOUNT",
            "LAYER 0-PROFILE #dce2ea",
            "RECTANG 0,0 42.3,42.3 id=frame",
            "CHAMFER frame 3.5",
            "LAYER CUTOUTS #5aa9e6",
            "CIRCLE 21.15,21.15 11.0 id=pilot-bore",
            "CIRCLE 5.65,5.65 1.7 id=m3-bl",
            "ARRAY RECT m3-bl 2 2 31.0 31.0",
            "LAYER DIMENSIONS #e09b24",
            "DIM 0,0 42.3,0 21.15,-6.5 id=dim-frame",
            "DIM 5.65,36.65 36.65,36.65 21.15,48.0 id=dim-pitch",
            "TEXT 2.0,-12.0 2.2 NEMA-17 FACEPLATE // 4xM3 // PILOT D22 id=note-spec",
        ]
    )
    generated["nema17-motor-mount.cadlab.json"] = s1.document

    # 2. ISO PN16 DN50 Pipe Flange (Ø165 OD, Ø61.5 ID, 4xØ18 on Ø125 PCD)
    s2 = DrawingSession()
    s2.execute_batch(
        [
            "NEW ISO-DN50-PN16-FLANGE",
            "LAYER 0-PROFILE #dce2ea",
            "CIRCLE 0,0 82.5 id=flange-od",
            "LAYER BORE-AND-BOLTS #5aa9e6",
            "CIRCLE 0,0 30.75 id=pipe-id",
            "CIRCLE 62.5,0 9.0 id=bolt-1",
            "SELECT bolt-1",
            "ROTATE 0,0 45",
            "ARRAY POLAR bolt-1 0,0 4",
            "LAYER DIMENSIONS #e09b24",
            "DIM -82.5,0 82.5,0 0,-96.0 id=dim-od",
            "DIM -30.75,0 30.75,0 0,96.0 id=dim-id",
            "TEXT -52.0,-110.0 3.5 DN50 PN16 // OD 165 // ID 61.5 // 4xD18 PCD 125 id=note",
        ]
    )
    generated["iso-dn50-flange.cadlab.json"] = s2.document

    # 3. EIA-310 19-Inch 1U Rack Panel (482.6 x 44.45 mm, mounting ears + cooling array)
    s3 = DrawingSession()
    s3.execute_batch(
        [
            "NEW EIA-19IN-1U-PANEL",
            "LAYER 0-CHASSIS #dce2ea",
            "RECTANG 0,0 482.6,44.45 id=panel",
            "CHAMFER panel 1.5",
            "LAYER EAR-MOUNTS #5aa9e6",
            "CIRCLE 8.5,6.35 3.2 id=ear-bl",
            "CIRCLE 8.5,38.1 3.2 id=ear-tl",
            "CIRCLE 474.1,6.35 3.2 id=ear-br",
            "CIRCLE 474.1,38.1 3.2 id=ear-tr",
            "LAYER VENTS #6bcf8e",
            "CIRCLE 151.3,14.225 4.0 id=vent-base",
            "ARRAY RECT vent-base 8 2 25.0 16.0",
            "LAYER DIMENSIONS #e09b24",
            "DIM 0,0 482.6,0 241.3,-14.0 id=dim-total-w",
            "DIM 482.6,0 482.6,44.45 500.0,22.225 id=dim-1u-h",
            "DIM 8.5,38.1 474.1,38.1 241.3,56.0 id=dim-mount-pitch",
            "TEXT 150.0,-26.0 4.0 EIA-310 19-INCH 1U PANEL (482.6 x 44.45 MM) id=title",
        ]
    )
    generated["eia-1u-rack-panel.cadlab.json"] = s3.document

    summary = []
    for filename, doc in generated.items():
        lint = lint_drawing(doc)
        if lint["summary"]["errors"] != 0:
            raise RuntimeError(f"Generated example {filename} failed DRC: {lint['issues']}")
        cam = compute_cam_metrics(doc, thickness_mm=4.0)
        _part, solid_info = extrude_drawing_to_part(doc, thickness_mm=4.0)
        out_file = examples_dir / filename
        out_file.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
        summary.append(
            {
                "file": filename,
                "entities": len(doc["entities"]),
                "cut_length_mm": cam["cut_length_mm"],
                "pierces": cam["pierce_count"],
                "volume_mm3": solid_info["volume_mm3"],
                "al6061_g": solid_info["mass_g"]["aluminum_6061"],
            }
        )
    return summary


BENCHMARK_CASES = [
    {
        "id": "C01_OPEN_LASER_LOOP",
        "fault_cmds": [
            "NEW C01",
            "PLINE 0,0 120,0 120,70 0,70 0,0.45 id=outer",
            "CIRCLE 20,20 4 id=h1",
        ],
        "repair_cmds": [
            "NEW C01",
            "RECTANG 0,0 120,70 id=outer",
            "CIRCLE 20,20 4 id=h1",
        ],
        "expected_code": "OPEN_CONTOUR_GAP",
    },
    {
        "id": "C02_BOLT_EDGE_TEAROUT",
        "fault_cmds": [
            "NEW C02",
            "RECTANG 0,0 100,60 id=outer",
            "CIRCLE 3.0,12.0 4.5 id=m8-tear",
        ],
        "repair_cmds": [
            "NEW C02",
            "RECTANG 0,0 100,60 id=outer",
            "CIRCLE 12.0,12.0 4.5 id=m8-safe",
        ],
        "expected_code": "CIRCLE_COLLISION",
    },
    {
        "id": "C03_THIN_WEB_CLEARANCE",
        "fault_cmds": [
            "NEW C03",
            "RECTANG 0,0 90,50 id=outer",
            "CIRCLE 4.8,25.0 4.0 id=thin-web",
        ],
        "repair_cmds": [
            "NEW C03",
            "RECTANG 0,0 90,50 id=outer",
            "CIRCLE 10.0,25.0 4.0 id=safe-web",
        ],
        "expected_code": "MIN_CLEARANCE",
    },
    {
        "id": "C04_OVERLAPPING_BOLT_HOLES",
        "fault_cmds": [
            "NEW C04",
            "RECTANG 0,0 100,60 id=outer",
            "CIRCLE 30,30 5 id=h1",
            "CIRCLE 37,30 5 id=h2",
        ],
        "repair_cmds": [
            "NEW C04",
            "RECTANG 0,0 100,60 id=outer",
            "CIRCLE 25,30 5 id=h1",
            "CIRCLE 45,30 5 id=h2",
        ],
        "expected_code": "CIRCLE_COLLISION",
    },
    {
        "id": "C05_OUTSIDE_STOCK_HOLE",
        "fault_cmds": [
            "NEW C05",
            "RECTANG 0,0 80,50 id=outer",
            "CIRCLE 95,25 4 id=stray",
        ],
        "repair_cmds": [
            "NEW C05",
            "RECTANG 0,0 80,50 id=outer",
            "CIRCLE 65,25 4 id=inside",
        ],
        "expected_code": "OUTSIDE_OUTER_PROFILE",
    },
    {
        "id": "C06_SELF_INTERSECTING_BOWTIE",
        "fault_cmds": [
            "NEW C06",
            "PLINE 0,0 80,60 80,0 0,60 C id=bowtie",
        ],
        "repair_cmds": [
            "NEW C06",
            "PLINE 0,0 80,0 80,60 0,60 C id=clean-box",
        ],
        "expected_code": "SELF_INTERSECTION",
    },
    {
        "id": "C07_DOUBLE_LASER_BURN",
        "fault_cmds": [
            "NEW C07",
            "RECTANG 0,0 100,50 id=outer",
            "LINE 10,0 90,0 id=dup-cut",
        ],
        "repair_cmds": [
            "NEW C07",
            "RECTANG 0,0 100,50 id=outer",
        ],
        "expected_code": "DUPLICATE_GEOMETRY",
    },
    {
        "id": "C08_CHAMFERED_NEMA_CLEARANCE",
        "fault_cmds": [
            "NEW C08",
            "RECTANG 0,0 42.3,42.3 id=outer",
            "CHAMFER outer 8.0",
            "CIRCLE 4.5,4.5 1.7 id=corner-clash",
        ],
        "repair_cmds": [
            "NEW C08",
            "RECTANG 0,0 42.3,42.3 id=outer",
            "CHAMFER outer 3.5",
            "CIRCLE 5.65,5.65 1.7 id=corner-ok",
        ],
        "expected_code": "CIRCLE_COLLISION",
    },
    {
        "id": "C09_MICRO_SEGMENT_STALL",
        "fault_cmds": [
            "NEW C09",
            "RECTANG 0,0 80,50 id=outer",
            "LINE 20,20 20.2,20 id=tiny-burr",
        ],
        "repair_cmds": [
            "NEW C09",
            "RECTANG 0,0 80,50 id=outer",
        ],
        "expected_code": "MICRO_SEGMENT",
    },
    {
        "id": "C10_POLAR_FLANGE_BOLT_OVERLAP",
        "fault_cmds": [
            "NEW C10",
            "CIRCLE 0,0 60 id=od",
            "CIRCLE 0,0 20 id=id",
            "CIRCLE 40,0 9 id=b1",
            "ARRAY POLAR b1 0,0 16",
        ],
        "repair_cmds": [
            "NEW C10",
            "CIRCLE 0,0 60 id=od",
            "CIRCLE 0,0 20 id=id",
            "CIRCLE 40,0 6 id=b1",
            "ARRAY POLAR b1 0,0 6",
        ],
        "expected_code": "CIRCLE_COLLISION",
    },
    {
        "id": "C11_FILLETED_PLATE_CORNER_TEAR",
        "fault_cmds": [
            "NEW C11",
            "RECTANG 0,0 100,60 id=plate",
            "FILLET plate 12",
            "CIRCLE 6,6 3.3 id=bad-corner-bolt",
        ],
        "repair_cmds": [
            "NEW C11",
            "RECTANG 0,0 100,60 id=plate",
            "FILLET plate 8",
            "CIRCLE 14,14 3.3 id=good-corner-bolt",
        ],
        "expected_code": "MIN_CLEARANCE",
    },
    {
        "id": "C12_RECT_VENT_ARRAY_EDGE_CLASH",
        "fault_cmds": [
            "NEW C12",
            "RECTANG 0,0 100,40 id=panel",
            "CIRCLE 15,20 4 id=v1",
            "ARRAY RECT v1 5 1 22 0",
        ],
        "repair_cmds": [
            "NEW C12",
            "RECTANG 0,0 100,40 id=panel",
            "CIRCLE 18,20 4 id=v1",
            "ARRAY RECT v1 4 1 21 0",
        ],
        "expected_code": "CIRCLE_COLLISION",
    },
]


def run_benchmark():
    t0 = time.perf_counter()
    unverified_pass = 0
    detected_faults = 0
    verified_after_loop = 0
    brep_valid_count = 0
    rows = []

    for case in BENCHMARK_CASES:
        s_fault = DrawingSession()
        s_fault.execute_batch(case["fault_cmds"])
        r_fault = lint_drawing(s_fault.document)
        codes = {i["code"] for i in r_fault["issues"]}
        if r_fault["summary"]["errors"] == 0 and r_fault["summary"]["warnings"] == 0:
            unverified_pass += 1
        caught = case["expected_code"] in codes
        if caught:
            detected_faults += 1

        s_rep = DrawingSession()
        s_rep.execute_batch(case["repair_cmds"])
        r_rep = lint_drawing(s_rep.document)
        if r_rep["summary"]["errors"] == 0:
            verified_after_loop += 1
            part, _tel = extrude_drawing_to_part(s_rep.document, thickness_mm=3.0)
            if part.is_valid:
                brep_valid_count += 1

        rows.append(
            {
                "case": case["id"],
                "expected": case["expected_code"],
                "detected_codes": sorted(codes),
                "caught": caught,
                "post_repair_errors": r_rep["summary"]["errors"],
            }
        )

    elapsed_ms = round((time.perf_counter() - t0) * 1000.0, 2)
    total = len(BENCHMARK_CASES)
    return {
        "suite_type": "static_drc_rule_fixture_pairs",
        "note": (
            "Evaluates DRC rule recall on 12 fault fixtures and B-Rep validity on paired "
            "reference fixtures. For end-to-end synthesis, spec compliance, STEP re-import, "
            "and adversarial trap evaluation, run benchmarks/spatial_eval.py."
        ),
        "total_cases": total,
        "unverified_manufacturing_safe_pct": round(unverified_pass / total * 100.0, 1),
        "drc_fault_detection_recall_pct": round(detected_faults / total * 100.0, 1),
        "reference_fixture_verified_pct": round(verified_after_loop / total * 100.0, 1),
        "brep_solid_extrude_valid_pct": round(brep_valid_count / total * 100.0, 1),
        "elapsed_ms": elapsed_ms,
        "cases": rows,
    }


if __name__ == "__main__":
    repo_root = Path(__file__).resolve().parents[1]
    ex_summary = build_industrial_examples(repo_root / "examples")
    bench = run_benchmark()
    print(json.dumps({"examples": ex_summary, "benchmark": bench}, indent=2))
