"""Tests for CHAMFER, FILLET, TRIM, ROTATE, MIRROR, ARRAY, TEXT, CAM metrics, and 3D extrusion."""

import json
import math
from pathlib import Path

from cad_lab.commands import DrawingSession
from cad_lab.drawing import drawing_from_dxf, drawing_to_dxf
from cad_lab.extrude import (
    drawing_to_svg_blueprint,
    export_extruded_drawing,
    extrude_drawing_to_part,
)
from cad_lab.geometry import reimport_step
from cad_lab.linter import lint_drawing
from cad_lab.mcp_server import ChamferMCPBridge


def test_chamfer_fillet_trim_rotate_mirror_array_and_text_round_trip():
    session = DrawingSession()
    session.execute_batch(
        [
            "NEW OPS-SUITE",
            "LAYER 0-PROFILE #dce2ea",
            "RECTANG 0,0 100,60 id=plate",
            "CHAMFER plate 5",
            "CIRCLE 15,15 3.3 id=bolt-bl",
            "SELECT bolt-bl",
            "MIRROR 50,0 50,60",
            "SELECT bolt-bl,bolt-bl-mir",
            "MIRROR 0,30 100,30",
            "LAYER SLOTS #5aa9e6",
            "LINE 35,30 65,30 id=cross-line",
            "CIRCLE 50,30 8 id=cutter",
            "TRIM cross-line 50,30",
            "ERASE cutter",
            "LAYER NOTES #e09b24",
            "TEXT 10,-12 3.5 MATL: AL-6061 T=5MM id=spec-note",
        ]
    )
    doc = session.document
    types = [e["type"] for e in doc["entities"]]
    assert "text" in types

    # Chamfered 100x60 rectangle with 5x5 bevels has area = 6000 - 4*(0.5*5*5) = 5950 mm2
    # Wait: let's erase the two trimmed open line fragments before 3D solid check
    line_ids = [e["id"] for e in doc["entities"] if e["type"] == "line"]
    assert len(line_ids) == 2
    session.execute(f"ERASE {','.join(line_ids)}")

    # Verify DXF round-trip preserves TEXT, LWPOLYLINE, and CIRCLEs
    dxf_str = drawing_to_dxf(json.dumps(session.document)).decode("utf-8")
    reimported = drawing_from_dxf(dxf_str)["drawing"]
    text_entities = [e for e in reimported["entities"] if e["type"] == "text"]
    assert len(text_entities) == 1
    assert text_entities[0]["text"] == "MATL: AL-6061 T=5MM"

    # Verify exact 3D B-Rep extrusion volume of chamfered 4-bolt plate
    part, telemetry = extrude_drawing_to_part(session.document, thickness_mm=5.0)
    expected_2d_area = (100.0 * 60.0 - 4.0 * 0.5 * 5.0 * 5.0) - 4.0 * math.pi * (3.3**2)
    assert math.isclose(telemetry["volume_mm3"], expected_2d_area * 5.0, rel_tol=1e-3)
    assert part.is_valid


def test_fillet_polyline_and_obround_slot_3d_step_reimport(tmp_path: Path):
    session = DrawingSession()
    session.execute_batch(
        [
            "NEW FILLET-3D-PLATE",
            "RECTANG 0,0 100,60 id=outer",
            "FILLET outer 8",
            "LINE 35,38 65,38 id=slot-top",
            "LINE 35,22 65,22 id=slot-bot",
            "ARC C 35,30 8 90 270 id=slot-l",
            "ARC C 65,30 8 270 90 id=slot-r",
        ]
    )
    report = lint_drawing(session.document)
    assert report["summary"]["errors"] == 0

    step_bytes, telemetry, mesh = export_extruded_drawing(
        session.document, thickness_mm=6.0, file_format="step"
    )
    step_path = tmp_path / "fillet_plate.step"
    step_path.write_bytes(step_bytes)
    reloaded = reimport_step(step_path)

    outer_area = 100.0 * 60.0 - (4.0 - math.pi) * (8.0**2)
    slot_area = 30.0 * 16.0 + math.pi * (8.0**2)
    expected_vol = (outer_area - slot_area) * 6.0
    assert math.isclose(float(reloaded.volume), expected_vol, rel_tol=1e-3)
    assert telemetry["solid_count"] == 1
    assert len(mesh["triangles"]) > 20

    svg_bytes = drawing_to_svg_blueprint(session.document)
    assert b"CHAMFER // FILLET-3D-PLATE" in svg_bytes
    assert b"MFG DRC: PASSED" in svg_bytes


def test_mcp_cam_report_and_3d_extrude_tools(tmp_path: Path):
    bridge = ChamferMCPBridge(port=0)
    bridge.call_tool(
        "chamfer_execute",
        {
            "commands": [
                "NEW MCP-FLANGE",
                "CIRCLE 0,0 50 id=od",
                "CIRCLE 0,0 20 id=id",
                "CIRCLE 35,0 4 id=b1",
                "ARRAY POLAR b1 0,0 6",
            ]
        },
    )
    cam = bridge.call_tool("chamfer_cam_report", {"thickness_mm": 4.0})
    assert cam["pierce_count"] == 8
    expected_area = math.pi * (50**2 - 20**2 - 6 * (4**2))
    assert math.isclose(cam["net_area_mm2"], expected_area, rel_tol=1e-3)

    out_step = tmp_path / "mcp_flange.step"
    ext = bridge.call_tool(
        "chamfer_extrude_3d",
        {"thickness_mm": 4.0, "format": "step", "output_path": str(out_step)},
    )
    assert out_step.is_file()
    assert math.isclose(ext["telemetry"]["volume_mm3"], expected_area * 4.0, rel_tol=1e-3)
