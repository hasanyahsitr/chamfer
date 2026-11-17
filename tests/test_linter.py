import json
import subprocess
import sys
from pathlib import Path

import pytest

from cad_lab.linter import lint_drawing
from cad_lab.project import ProjectError


def _base_drawing(entities, layers=None):
    return {
        "format": "cad-lab.drawing",
        "schema_version": 1,
        "units": "mm",
        "name": "Lint Test",
        "layers": layers
        or [{"id": "0", "name": "0", "color": "#d5dee7", "visible": True, "locked": False}],
        "entities": entities,
    }


def test_clean_cnc_mounting_plate_passes_with_zero_issues():
    plate = _base_drawing(
        [
            {
                "id": "outer",
                "layer": "0",
                "type": "polyline",
                "points": [[0, 0], [80, 0], [80, 50], [0, 50]],
                "closed": True,
            },
            {"id": "h1", "layer": "0", "type": "circle", "center": [10, 10], "radius": 2.5},
            {"id": "h2", "layer": "0", "type": "circle", "center": [10, 40], "radius": 2.5},
            {"id": "h3", "layer": "0", "type": "circle", "center": [70, 10], "radius": 2.5},
            {"id": "h4", "layer": "0", "type": "circle", "center": [70, 40], "radius": 2.5},
        ]
    )
    report = lint_drawing(plate)
    assert report["valid"] is True
    assert report["status"] == "passed"
    assert report["summary"] == {"errors": 0, "warnings": 0, "checked_entities": 5}
    assert report["issues"] == []


def test_office_layout_example_has_zero_false_positives():
    office_path = Path(__file__).resolve().parents[1] / "examples" / "office-layout.cadlab.json"
    report = lint_drawing(office_path.read_text(encoding="utf-8"))
    assert report["valid"] is True
    assert report["summary"]["errors"] == 0


def test_detects_open_contour_gap_and_self_intersection():
    flawed = _base_drawing(
        [
            {
                "id": "unclosed-wall",
                "layer": "0",
                "type": "polyline",
                "points": [[0, 0], [60, 0], [60, 40], [0, 40], [0, 0.5]],
                "closed": False,
            },
            {
                "id": "bowtie",
                "layer": "0",
                "type": "polyline",
                "points": [[100, 0], [140, 40], [140, 0], [100, 40]],
                "closed": True,
            },
        ]
    )
    report = lint_drawing(flawed)
    assert report["valid"] is False
    codes = {issue["code"] for issue in report["issues"]}
    assert "OPEN_CONTOUR_GAP" in codes
    assert "SELF_INTERSECTION" in codes


def test_detects_circle_collision_thin_clearance_and_outside_hole():
    flawed = _base_drawing(
        [
            {
                "id": "outer",
                "layer": "0",
                "type": "polyline",
                "points": [[0, 0], [80, 0], [80, 50], [0, 50]],
                "closed": True,
            },
            {"id": "edge-crash", "layer": "0", "type": "circle", "center": [79, 25], "radius": 3},
            {"id": "thin-wall", "layer": "0", "type": "circle", "center": [10, 3.3], "radius": 2.5},
            {"id": "stray-hole", "layer": "0", "type": "circle", "center": [110, 25], "radius": 3},
        ]
    )
    report = lint_drawing(flawed)
    assert report["valid"] is False
    codes = {issue["code"] for issue in report["issues"]}
    assert "CIRCLE_COLLISION" in codes
    assert "MIN_CLEARANCE" in codes
    assert "OUTSIDE_OUTER_PROFILE" in codes


def test_detects_duplicate_geometry_and_dangling_gap():
    flawed = _base_drawing(
        [
            {"id": "l1", "layer": "0", "type": "line", "points": [[0, 0], [50, 0]]},
            {"id": "l2", "layer": "0", "type": "line", "points": [[10, 0], [40, 0]]},
            {"id": "l3", "layer": "0", "type": "line", "points": [[50.8, 0], [50.8, 30]]},
            {"id": "c1", "layer": "0", "type": "circle", "center": [25, 25], "radius": 4},
            {"id": "c2", "layer": "0", "type": "circle", "center": [25, 25], "radius": 4},
        ]
    )
    report = lint_drawing(flawed)
    codes = [issue["code"] for issue in report["issues"]]
    assert codes.count("DUPLICATE_GEOMETRY") == 2
    assert "DANGLING_ENDPOINT_GAP" in codes


def test_construction_layer_excluded_while_locked_cutting_layer_is_checked():
    construction_doc = _base_drawing(
        [
            {"id": "part-line", "layer": "0", "type": "line", "points": [[0, 0], [40, 0]]},
            {"id": "axis-dup", "layer": "axes", "type": "line", "points": [[0, 0], [40, 0]]},
        ],
        layers=[
            {"id": "0", "name": "0", "color": "#ffffff", "visible": True, "locked": False},
            {
                "id": "axes",
                "name": "Axes",
                "color": "#527d96",
                "visible": True,
                "locked": True,
                "construction": True,
            },
        ],
    )
    report = lint_drawing(construction_doc)
    assert report["valid"] is True
    assert report["summary"]["checked_entities"] == 1

    # Locked cutting layers (construction=False) MUST still be checked by DRC so
    # collisions on locked geometry are never silently exported to CAM / B-Rep.
    locked_cut_doc = _base_drawing(
        [
            {"id": "part-line", "layer": "0", "type": "line", "points": [[0, 0], [40, 0]]},
            {"id": "locked-dup", "layer": "cut2", "type": "line", "points": [[0, 0], [40, 0]]},
        ],
        layers=[
            {"id": "0", "name": "0", "color": "#ffffff", "visible": True, "locked": False},
            {"id": "cut2", "name": "Cut2", "color": "#527d96", "visible": True, "locked": True},
        ],
    )
    locked_report = lint_drawing(locked_cut_doc)
    assert locked_report["valid"] is False
    assert any(i["code"] == "DUPLICATE_GEOMETRY" for i in locked_report["issues"])


def test_cli_lint_drawing_returns_exit_code_based_on_validity(tmp_path):
    bad_path = tmp_path / "bad.cadlab.json"
    bad_path.write_text(
        json.dumps(
            _base_drawing(
                [
                    {"id": "c1", "layer": "0", "type": "circle", "center": [10, 10], "radius": 5},
                    {"id": "c2", "layer": "0", "type": "circle", "center": [10, 10], "radius": 5},
                ]
            )
        ),
        encoding="utf-8",
    )
    proc = subprocess.run(
        [sys.executable, "-m", "cad_lab.cli", "--lint-drawing", str(bad_path)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 1
    payload = json.loads(proc.stdout)
    assert payload["valid"] is False

    with pytest.raises(ProjectError):
        lint_drawing("{not-json")


def test_thickness_aware_default_clearance_and_explicit_override():
    plate_with_2mm_web = _base_drawing(
        [
            {
                "id": "outer",
                "layer": "0",
                "type": "polyline",
                "points": [[0, 0], [80, 0], [80, 50], [0, 50]],
                "closed": True,
            },
            {"id": "h1", "layer": "0", "type": "circle", "center": [15, 25], "radius": 3},
            {"id": "h2", "layer": "0", "type": "circle", "center": [23, 25], "radius": 3},
        ]
    )

    default_rep = lint_drawing(plate_with_2mm_web)
    assert default_rep["valid"] is True
    assert default_rep["min_clearance_mm"] == 1.5
    assert default_rep["summary"]["warnings"] == 0

    thick_rep = lint_drawing(plate_with_2mm_web, thickness_mm=6.0)
    assert thick_rep["valid"] is True
    assert thick_rep["min_clearance_mm"] == 6.0
    assert thick_rep["summary"]["warnings"] == 1
    assert thick_rep["issues"][0]["code"] == "MIN_CLEARANCE"
    assert "< 6.000 mm" in thick_rep["issues"][0]["message"]

    thin_rep = lint_drawing(plate_with_2mm_web, thickness_mm=0.8)
    assert thin_rep["min_clearance_mm"] == 1.5
    assert thin_rep["summary"]["warnings"] == 0

    override_rep = lint_drawing(plate_with_2mm_web, thickness_mm=6.0, min_clearance_mm=1.2)
    assert override_rep["min_clearance_mm"] == 1.2
    assert override_rep["summary"]["warnings"] == 0
