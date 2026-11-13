"""Permanent adversarial regression suite covering topological, geometric, transactional,
DXF round-trip, synthesis spec-compliance, and HTTP/MCP bridge invariants.
"""

from __future__ import annotations

import copy
import io
import json
import math
import shutil
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import ezdxf
import pytest

from cad_lab.commands import DrawingSession
from cad_lab.drawing import drawing_from_dxf, drawing_to_dxf
from cad_lab.extrude import (
    compute_cam_metrics,
    drawing_to_svg_blueprint,
    extrude_drawing_to_part,
)
from cad_lab.linter import lint_drawing
from cad_lab.mcp_server import ChamferMCPBridge, handle_rpc_message
from cad_lab.ops import trim_line_entity
from cad_lab.project import ProjectError
from cad_lab.server import LocalCADServer
from cad_lab.synthesis import synthesize_drawing, verify_synthesized_spec


def test_disjoint_outer_profiles_cam_area_and_single_part_rejection():
    s = DrawingSession()
    s.execute_batch(
        [
            "NEW DISJOINT",
            "RECTANG 0,0 100,60 id=a",
            "RECTANG 200,0 240,20 id=b",
        ]
    )
    cam = compute_cam_metrics(s.document, thickness_mm=5.0)
    assert cam["closed_loops"] == 2
    assert math.isclose(cam["net_area_mm2"], 6800.0, abs_tol=1e-3)

    drc_mfg = lint_drawing(s.document, manufacturing=True)
    assert drc_mfg["valid"] is False
    assert any(i["code"] == "MULTIPLE_OUTER_PROFILES" for i in drc_mfg["issues"])

    with pytest.raises(ProjectError, match="outer"):
        extrude_drawing_to_part(s.document, thickness_mm=5.0)


def test_nested_island_inside_hole_even_odd_area_and_extrude_rejection():
    s = DrawingSession()
    s.execute_batch(
        [
            "NEW ISLAND",
            "RECTANG 0,0 100,100 id=outer",
            "RECTANG 20,20 80,80 id=hole",
            "RECTANG 40,40 60,60 id=island",
        ]
    )
    cam = compute_cam_metrics(s.document, thickness_mm=4.0)
    # 10000 - 3600 + 400 = 6800
    assert math.isclose(cam["net_area_mm2"], 6800.0, abs_tol=1e-3)

    drc_mfg = lint_drawing(s.document, manufacturing=True)
    assert drc_mfg["valid"] is False
    assert any(i["code"] == "NESTED_ISLAND_UNSUPPORTED" for i in drc_mfg["issues"])

    with pytest.raises(ProjectError, match="island"):
        extrude_drawing_to_part(s.document, thickness_mm=4.0)


def test_line_chaining_is_order_independent_and_rejects_t_branch():
    edges = [
        "LINE 0,0 50,0 id=e1",
        "LINE 50,0 50,50 id=e2",
        "LINE 50,50 0,50 id=e3",
        "LINE 0,50 0,0 id=e4",
    ]
    spur = "LINE 50,0 80,0 id=spur"

    s_first = DrawingSession()
    s_first.execute_batch(["NEW BRANCH-FIRST", spur, *edges])
    s_last = DrawingSession()
    s_last.execute_batch(["NEW BRANCH-LAST", *edges, spur])

    cam_first = compute_cam_metrics(s_first.document)
    cam_last = compute_cam_metrics(s_last.document)
    assert cam_first["closed_loops"] == 0
    assert cam_last["closed_loops"] == 0

    for doc in (s_first.document, s_last.document):
        rep = lint_drawing(doc)
        assert rep["valid"] is False
        assert any(i["code"] == "BRANCHED_CONTOUR_JUNCTION" for i in rep["issues"])
        with pytest.raises(ProjectError):
            extrude_drawing_to_part(doc, thickness_mm=3.0)


def test_near_gap_0_005mm_is_not_silently_closed_and_stray_cut_is_rejected():
    s_gap = DrawingSession()
    s_gap.execute_batch(
        [
            "NEW NEAR-GAP",
            "LINE 0,0 100,0 id=l1",
            "LINE 100,0 100,60 id=l2",
            "LINE 100,60 0,60 id=l3",
            "LINE 0,60 0,0.005 id=l4",
        ]
    )
    cam = compute_cam_metrics(s_gap.document)
    assert cam["closed_loops"] == 0
    assert cam["net_area_mm2"] == 0.0
    rep = lint_drawing(s_gap.document)
    assert any(i["code"] == "OPEN_CONTOUR_GAP" for i in rep["issues"])
    with pytest.raises(ProjectError):
        extrude_drawing_to_part(s_gap.document, thickness_mm=4.0)

    s_stray = DrawingSession()
    s_stray.execute_batch(
        [
            "NEW STRAY-CUT",
            "RECTANG 0,0 100,60 id=outer",
            "LINE 20,30 80,30 id=slit",
        ]
    )
    rep_stray = lint_drawing(s_stray.document)
    assert any(i["code"] == "UNCLOSED_CUT_CONTOUR" for i in rep_stray["issues"])
    with pytest.raises(ProjectError):
        extrude_drawing_to_part(s_stray.document, thickness_mm=4.0)


def test_locked_cutting_layer_cross_layer_collision_and_twin_arcs():
    s = DrawingSession()
    s.execute_batch(
        [
            "NEW CROSS-LOCKED",
            "LAYER 0-OUTER #dce2ea",
            "RECTANG 0,0 100,60 id=outer",
            "LAYER HOLES #5aa9e6",
            "CIRCLE 99,30 4 id=edge-crash",
        ]
    )
    doc = s.document
    for lyr in doc["layers"]:
        if lyr["id"] == "0-outer":
            lyr["locked"] = True

    rep = lint_drawing(doc)
    assert rep["valid"] is False
    assert any(i["code"] == "CIRCLE_COLLISION" for i in rep["issues"])

    s_arcs = DrawingSession()
    s_arcs.execute_batch(
        [
            "NEW TWIN-ARCS",
            "ARC C 0,0 25 0 180 id=a1",
            "ARC C 0,0 25 0 180 id=a2",
        ]
    )
    rep_arcs = lint_drawing(s_arcs.document)
    assert rep_arcs["valid"] is False
    assert any(i["code"] == "DUPLICATE_GEOMETRY" for i in rep_arcs["issues"])
    with pytest.raises(ProjectError):
        extrude_drawing_to_part(s_arcs.document, thickness_mm=4.0)


def test_execute_batch_is_transactional_and_rolls_back_on_error():
    s = DrawingSession()
    s.execute("RECTANG 0,0 50,50 id=seed")
    rev_before = s.revision
    snap_before = s.document

    with pytest.raises(ProjectError):
        s.execute_batch(
            [
                "CIRCLE 25,25 5 id=temp-hole",
                "UNKNOWN_COMMAND 1 2 3",
            ]
        )

    assert s.revision == rev_before
    assert s.document == snap_before


@pytest.mark.parametrize("bolt_count", [3, 5, 8])
def test_parametric_synthesis_honors_exact_bolt_counts(bolt_count: int):
    s = DrawingSession()
    res = synthesize_drawing(
        s,
        f"160x95 mm plate with {bolt_count}xM6 holes",
        runtime_id="parametric:chamfer-rule-v1",
        targets=[],
    )
    assert res["lint"]["valid"] is True
    circles = [e for e in res["drawing"]["entities"] if e["type"] == "circle"]
    assert len(circles) == bolt_count
    assert all(math.isclose(c["radius"], 3.3, abs_tol=1e-4) for c in circles)


def test_failed_llm_synthesis_never_overwrites_session_or_accepts_blank_canvas(monkeypatch):
    s = DrawingSession()
    s.execute("RECTANG 0,0 60,40 id=existing-part")
    before = s.document
    rev_before = s.revision

    monkeypatch.setattr(
        "cad_lab.synthesis.discover_runtimes",
        lambda targets=None: {
            "available": [
                {
                    "id": "ollama:mock",
                    "provider": "ollama",
                    "label": "Mock Local Runtime",
                    "kind": "v1_chat",
                    "model": "mock",
                    "base_url": "http://127.0.0.1:9",
                    "local": True,
                }
            ],
            "active": {
                "id": "ollama:mock",
                "provider": "ollama",
                "label": "Mock Local Runtime",
                "kind": "v1_chat",
                "model": "mock",
                "base_url": "http://127.0.0.1:9",
                "local": True,
            },
        },
    )
    monkeypatch.setattr(
        "cad_lab.synthesis._call_external_runtime",
        lambda runtime, messages, timeout_s=30.0: "NEW Empty",
    )

    with pytest.raises(ProjectError, match="active drawing kept unchanged|without modifying"):
        synthesize_drawing(
            s, "120x80 plate with 4xM6 holes", runtime_id="ollama:mock", max_repairs=1
        )

    assert s.document == before
    assert s.revision == rev_before


def test_mcp_bridge_propagates_http_422_and_survives_malformed_jsonrpc(tmp_path):
    class Reject422Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.dumps({"error": "Layer '0' is locked."}).encode("utf-8")
            self.send_response(422)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            return

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Reject422Handler)
    port = httpd.server_address[1]
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    try:
        bridge = ChamferMCPBridge(port=port)
        resp = handle_rpc_message(
            bridge,
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "chamfer_execute",
                    "arguments": {"commands": ["RECTANG 0,0 50,50"]},
                },
            },
        )
        # Tool call returns structured isError=True rather than executing locally
        assert resp["result"]["isError"] is True
        assert "locked" in resp["result"]["content"][0]["text"]
        assert bridge.session.document["entities"] == []
    finally:
        httpd.shutdown()
        httpd.server_close()

    # Malformed JSON-RPC payloads must return -32602 without crashing handler
    local_bridge = ChamferMCPBridge(port=0)
    bad_msgs = [
        {"jsonrpc": "2.0", "id": 10, "method": 123, "params": {}},
        {"jsonrpc": "2.0", "id": 11, "method": "tools/call", "params": []},
        {
            "jsonrpc": "2.0",
            "id": 12,
            "method": "tools/call",
            "params": {"name": "chamfer_get_drawing", "arguments": []},
        },
    ]
    responses = [handle_rpc_message(local_bridge, m) for m in bad_msgs]
    assert len(responses) == 3
    assert all(item["error"]["code"] in (-32600, -32602) for item in responses)

    # Overwrite protection on export
    handle_rpc_message(
        local_bridge,
        {
            "jsonrpc": "2.0",
            "id": 20,
            "method": "tools/call",
            "params": {
                "name": "chamfer_execute",
                "arguments": {"commands": ["RECTANG 0,0 40,30 id=box"]},
            },
        },
    )
    existing = tmp_path / "out.dxf"
    existing.write_text("PROTECTED", encoding="utf-8")
    denied = handle_rpc_message(
        local_bridge,
        {
            "jsonrpc": "2.0",
            "id": 21,
            "method": "tools/call",
            "params": {
                "name": "chamfer_export_dxf",
                "arguments": {"output_path": str(existing)},
            },
        },
    )
    assert denied["result"]["isError"] is True
    assert existing.read_text(encoding="utf-8") == "PROTECTED"


def test_http_server_expected_revision_cas_and_idempotency():
    web_root = Path(__file__).resolve().parents[1] / "web" / "dist"
    httpd = LocalCADServer(("127.0.0.1", 0), web_root)
    port = httpd.server_port
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    base = f"http://127.0.0.1:{port}"
    try:
        r1_req = urllib.request.Request(
            f"{base}/api/drawing/exec",
            data=json.dumps(
                {"commands": ["RECTANG 0,0 50,40 id=p1"], "request_id": "req-fixed-1"}
            ).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(r1_req) as resp:
            first = json.loads(resp.read().decode("utf-8"))
        # Re-sending identical request_id returns cached response without re-executing
        r1_dup = urllib.request.Request(
            f"{base}/api/drawing/exec",
            data=json.dumps(
                {"commands": ["CIRCLE 20,20 5 id=should-not-run"], "request_id": "req-fixed-1"}
            ).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(r1_dup) as resp:
            dup = json.loads(resp.read().decode("utf-8"))
        assert dup["revision"] == first["revision"]
        assert len(dup["drawing"]["entities"]) == 1

        # Stale expected_revision triggers 409 Conflict
        stale_req = urllib.request.Request(
            f"{base}/api/drawing/state",
            data=json.dumps(
                {"drawing": first["drawing"], "expected_revision": first["revision"] - 1}
            ).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with pytest.raises(urllib.error.HTTPError) as exc_info:
            urllib.request.urlopen(stale_req)
        assert exc_info.value.code == 409
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_dxf_importer_rejects_rotated_projected_dimension_distortion():
    doc = ezdxf.new("R2010")
    doc.header["$INSUNITS"] = 4
    msp = doc.modelspace()
    msp.add_line((0, 0), (10, 10))
    # Horizontal linear dimension (angle=0) measuring X-projection=10.0 across diagonal span=14.1421
    dim = msp.add_linear_dim(base=(5, -5), p1=(0, 0), p2=(10, 10), angle=0)
    dim.render()
    buf = io.StringIO()
    doc.write(buf)

    with pytest.raises(ProjectError, match="aligned|dimension"):
        drawing_from_dxf(buf.getvalue())


def test_trim_long_segment_duplicate_closure_x_chamfer_and_300deg_arc_area():
    # 1. Physical-distance TRIM on 1,000,000 mm segment (1 mm overhang at x=-1..0)
    target = {"id": "long", "layer": "0", "type": "line", "points": [[-1.0, 0.0], [999999.0, 0.0]]}
    cutter = {"id": "cut", "layer": "0", "type": "line", "points": [[0.0, -50.0], [0.0, 50.0]]}
    res = trim_line_entity(target, [-0.5, 0.0], [target, cutter])
    assert len(res) == 1
    assert math.isclose(res[0]["points"][0][0], 0.0, abs_tol=1e-6)
    assert math.isclose(res[0]["points"][1][0], 999999.0, abs_tol=1e-6)

    with pytest.raises(ProjectError, match="intersection"):
        trim_line_entity(target, [0.0, 0.0], [target, cutter])

    # 2. Closed polyline repeating start point at end is rejected
    with pytest.raises(ProjectError, match="distinct|repeat"):
        drawing_to_dxf(
            json.dumps(
                {
                    "format": "cad-lab.drawing",
                    "schema_version": 1,
                    "units": "mm",
                    "name": "DupClosure",
                    "layers": [
                        {
                            "id": "0",
                            "name": "0",
                            "color": "#ffffff",
                            "visible": True,
                            "locked": False,
                        }
                    ],
                    "entities": [
                        {
                            "id": "p",
                            "layer": "0",
                            "type": "polyline",
                            "points": [[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]],
                            "closed": True,
                        }
                    ],
                }
            )
        )

    # 3. X-crossing CHAMFER requires keep1/keep2 and is invariant to endpoint reversal
    s_amb = DrawingSession()
    s_amb.execute_batch(["LINE -20,0 20,0 id=h", "LINE 0,-20 0,20 id=v"])
    with pytest.raises(ProjectError, match="keep"):
        s_amb.execute("CHAMFER h v 4")

    s_q1_a = DrawingSession()
    s_q1_a.execute_batch(
        ["LINE -20,0 20,0 id=h", "LINE 0,-20 0,20 id=v", "CHAMFER h v 4 keep1=15,0 keep2=0,15"]
    )
    s_q1_b = DrawingSession()
    s_q1_b.execute_batch(
        ["LINE 20,0 -20,0 id=h", "LINE 0,20 0,-20 id=v", "CHAMFER h v 4 keep1=15,0 keep2=0,15"]
    )
    bevel_a = sorted(s_q1_a.document["entities"][-1]["points"])
    bevel_b = sorted(s_q1_b.document["entities"][-1]["points"])
    assert bevel_a == [[0.0, 4.0], [4.0, 0.0]]
    assert bevel_b == [[0.0, 4.0], [4.0, 0.0]]

    # 4. 300-degree major arc + closing chord analytical Green's area == B-Rep volume / thickness
    r = 30.0
    x_c = round(r * math.cos(math.radians(30.0)), 6)
    y_t = round(r * math.sin(math.radians(30.0)), 6)
    s_arc = DrawingSession()
    s_arc.execute_batch(
        [
            "NEW MAJOR-ARC",
            f"ARC C 0,0 {r} 30 330 id=maj-arc",
            f"LINE {x_c},{-y_t} {x_c},{y_t} id=chord",
        ]
    )
    cam = compute_cam_metrics(s_arc.document, thickness_mm=5.0)
    part, tel = extrude_drawing_to_part(s_arc.document, thickness_mm=5.0)
    assert part.is_valid
    assert math.isclose(cam["net_area_mm2"], tel["volume_mm3"] / 5.0, rel_tol=1e-4, abs_tol=0.05)


def test_r01_non_concentric_arc_pierce_and_clearance():
    ang = math.radians(7.5)
    d = 900.2
    cx = d * math.cos(ang)
    cy = d * math.sin(ang)
    s = DrawingSession()
    s.execute_batch(
        [
            "NEW R01-ARC-PIERCE",
            "ARC C 0,0 1000 0 180 id=o1",
            "ARC C 0,0 1000 180 360 id=o2",
            f"ARC C {cx:.6f},{cy:.6f} 100 0 180 id=i1",
            f"ARC C {cx:.6f},{cy:.6f} 100 180 360 id=i2",
        ]
    )
    rep = lint_drawing(s.document, manufacturing=True)
    assert rep["valid"] is False
    assert any(iss["code"] == "INTERSECTING_CONTOURS" for iss in rep["issues"])
    with pytest.raises(ProjectError):
        extrude_drawing_to_part(s.document, thickness_mm=5.0)

    # Non-concentric inner arc contour with 1.0 mm clearance (< 1.5 mm) emits MIN_CLEARANCE
    d_near = 899.0
    s_near = DrawingSession()
    s_near.execute_batch(
        [
            "NEW R01-ARC-NEAR",
            "ARC C 0,0 1000 0 180 id=o1",
            "ARC C 0,0 1000 180 360 id=o2",
            f"ARC C {d_near * math.cos(ang):.6f},{d_near * math.sin(ang):.6f} 100 0 180 id=i1",
            f"ARC C {d_near * math.cos(ang):.6f},{d_near * math.sin(ang):.6f} 100 180 360 id=i2",
        ]
    )
    rep_near = lint_drawing(s_near.document, manufacturing=True)
    assert rep_near["valid"] is True
    assert any(iss["code"] == "MIN_CLEARANCE" for iss in rep_near["issues"])


def test_r02_equal_area_wrong_slot_pcd_mismatch_and_unsupported_features():
    # Equal-area rectangular hole substituted for 34x8 obround slot must fail verification
    slot_area = (34.0 - 8.0) * 8.0 + math.pi * 4.0 * 4.0
    rect_h = slot_area / 20.0
    s_slot = DrawingSession()
    s_slot.execute_batch(
        [
            "NEW FAKE-SLOT",
            "RECTANG 0,0 110,55 id=outer",
            f"RECTANG 45,{(55.0 - rect_h) / 2.0:.6f} 65,{(55.0 + rect_h) / 2.0:.6f} id=fake",
        ]
    )
    slot_errs = verify_synthesized_spec(s_slot.document, "110x55 bracket slot 34x8mm")
    assert len(slot_errs) >= 1
    assert any("slot" in e.lower() for e in slot_errs)

    # Wrong PCD (57.8 vs 68) on circular flange must fail verification
    s_flange = DrawingSession()
    s_flange.execute_batch(
        [
            "NEW WRONG-PCD",
            "CIRCLE 0,0 50 id=od",
            "CIRCLE 0,0 15 id=id",
            "CIRCLE 28.9,0 3.3 id=b1",
            "ARRAY POLAR b1 0,0 3 360",
        ]
    )
    flange_errs = verify_synthesized_spec(
        s_flange.document, "circular flange OD 100 ID 30 3xM6 PCD 68"
    )
    assert len(flange_errs) >= 1
    assert any("pcd" in e.lower() for e in flange_errs)

    # Unsupported 3D/machining features in free-text prompt must be rejected explicitly
    s_unsup = DrawingSession()
    with pytest.raises(ProjectError, match="outside 2D planar"):
        synthesize_drawing(
            s_unsup,
            "100x60 plate 4xM6 with countersink pocket",
            runtime_id="parametric:chamfer-rule-v1",
            targets=[],
        )
    assert s_unsup.document["entities"] == []


def test_r03_http_state_rejects_complexity_overflow_without_mutating_session():
    web_root = Path(__file__).resolve().parents[1] / "web" / "dist"
    httpd = LocalCADServer(("127.0.0.1", 0), web_root)
    port = httpd.server_port
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    base = f"http://127.0.0.1:{port}"
    try:
        init_req = urllib.request.Request(
            f"{base}/api/drawing/exec",
            data=json.dumps({"commands": ["RECTANG 0,0 100,60 id=base"]}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(init_req) as resp:
            before = json.loads(resp.read().decode("utf-8"))
        assert len(before["drawing"]["entities"]) == 1
        rev_before = before["revision"]

        # 708 circles -> 708*707/2 = 250,278 pairs > MAX_PAIR_CHECKS (250,000)
        circles = [
            {
                "id": f"c-{k}",
                "layer": "0",
                "type": "circle",
                "center": [float((k % 30) * 12), float((k // 30) * 12)],
                "radius": 2.0,
            }
            for k in range(708)
        ]
        bad_doc = {
            "format": "cad-lab.drawing",
            "schema_version": 1,
            "units": "mm",
            "name": "Overflow708",
            "layers": [
                {"id": "0", "name": "0", "color": "#ffffff", "visible": True, "locked": False}
            ],
            "entities": circles,
        }
        bad_req = urllib.request.Request(
            f"{base}/api/drawing/state",
            data=json.dumps({"drawing": bad_doc}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with pytest.raises(urllib.error.HTTPError) as exc_info:
            urllib.request.urlopen(bad_req)
        assert exc_info.value.code == 422

        # Subsequent GET /api/drawing/state must succeed cleanly with unchanged document & revision
        with urllib.request.urlopen(f"{base}/api/drawing/state") as resp2:
            after = json.loads(resp2.read().decode("utf-8"))
        assert after["revision"] == rev_before
        assert len(after["drawing"]["entities"]) == 1
        assert after["drawing"]["entities"][0]["id"] == "base"
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_r04_mcp_post_connection_reset_never_falls_back_to_local_session():
    class DropAfterReadHandler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("Content-Length", "0"))
            if length > 0:
                self.rfile.read(length)
            # Simulate abrupt connection loss after request body arrived at server
            self.connection.close()

        def log_message(self, *args):
            return

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), DropAfterReadHandler)
    port = httpd.server_address[1]
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    try:
        bridge = ChamferMCPBridge(port=port)
        resp = handle_rpc_message(
            bridge,
            {
                "jsonrpc": "2.0",
                "id": 99,
                "method": "tools/call",
                "params": {
                    "name": "chamfer_execute",
                    "arguments": {"commands": ["RECTANG 0,0 80,50 id=uncertain"]},
                },
            },
        )
        assert resp["result"]["isError"] is True
        assert "uncertain" in resp["result"]["content"][0]["text"].lower()
        assert bridge.session.document["entities"] == []
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_r05_construction_layer_preserved_across_dxf_and_cut_only_option():
    s = DrawingSession()
    s.execute_batch(
        [
            "NEW R05-CONSTRUCTION",
            "RECTANG 0,0 100,60 id=outer",
            "LAYER GUIDE #888888 CONSTRUCTION",
            "CIRCLE 50,30 10 id=guide-circle",
        ]
    )
    dxf_text = drawing_to_dxf(json.dumps(s.document)).decode("utf-8")
    ez_doc = ezdxf.read(io.StringIO(dxf_text))
    assert len(ez_doc.audit().errors) == 0

    reimported = drawing_from_dxf(dxf_text)["drawing"]
    guide_layers = [ly for ly in reimported["layers"] if ly["name"] == "GUIDE"]
    assert len(guide_layers) == 1 and guide_layers[0].get("construction") is True

    cam = compute_cam_metrics(reimported, thickness_mm=5.0)
    assert math.isclose(cam["net_area_mm2"], 6000.0, abs_tol=1e-3)
    part, tel = extrude_drawing_to_part(reimported, thickness_mm=5.0)
    assert part.is_valid
    assert math.isclose(tel["volume_mm3"], 30000.0, abs_tol=1e-2)

    cut_dxf = drawing_to_dxf(json.dumps(s.document), cut_only=True).decode("utf-8")
    cut_reimported = drawing_from_dxf(cut_dxf)["drawing"]
    assert len(cut_reimported["entities"]) == 1
    assert cut_reimported["entities"][0]["type"] == "polyline"


def test_r06_and_r07_static_root_workbench_and_svg_manufacturing_drc_stamp():
    dist_dir = Path(__file__).resolve().parents[1] / "web" / "dist"
    index_html = (dist_dir / "index.html").read_text(encoding="utf-8")
    drafting_html = (dist_dir / "drafting.html").read_text(encoding="utf-8")
    plate_html = (dist_dir / "plate.html").read_text(encoding="utf-8")
    assert 'id="drawing-canvas"' in index_html
    assert 'id="drawing-canvas"' in drafting_html
    assert 'href="/plate.html"' in index_html
    assert 'id="viewport"' in plate_html

    # Two disjoint circles fail manufacturing DRC -> SVG must stamp MFG DRC: FAILED
    s = DrawingSession()
    s.execute_batch(["NEW TWO-CIRCLES", "CIRCLE 0,0 20 id=c1", "CIRCLE 100,0 20 id=c2"])
    svg_text = drawing_to_svg_blueprint(s.document).decode("utf-8")
    assert "MFG DRC: FAILED" in svg_text
    assert "VERIFIED" not in svg_text
    assert "PASSED" not in svg_text


def test_r08_deeply_nested_json_rejected_without_crashing_mcp_process():
    deep_line = "[" * 3000 + "]" * 3000
    valid_req = json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
    proc = subprocess.run(
        [sys.executable, "-m", "cad_lab.mcp_server", "--port", "0"],
        input=f"{deep_line}\n{valid_req}\n",
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert proc.returncode == 0
    lines = [ln for ln in proc.stdout.strip().splitlines() if ln.strip()]
    assert len(lines) == 2
    err_resp = json.loads(lines[0])
    ok_resp = json.loads(lines[1])
    assert err_resp["error"]["code"] == -32700
    assert len(ok_resp["result"]["tools"]) >= 6


def test_r09_closed_polyline_self_touch_backtrack_and_split_arc_contours_rejected():
    cases = [
        # Closed polyline revisiting vertex (50,0) on non-adjacent edges
        ["NEW SELF-TOUCH", "PLINE 0,0 50,0 50,50 25,25 50,0 100,0 100,100 0,100 C id=outer"],
        # Closed polyline colinearly backtracking along bottom edge
        ["NEW BACKTRACK", "PLINE 0,0 100,0 80,0 100,0 100,60 0,60 C id=outer"],
        # Split LINE+ARC contour pinching vertex (50,0) with degree 4
        [
            "NEW SPLIT-ARC-PINCH",
            "LINE 0,0 50,0 id=l1",
            "LINE 50,0 50,50 id=l2",
            "ARC C 50,25 25 90 270 id=a1",
            "LINE 50,0 100,0 id=l3",
            "LINE 100,0 100,100 id=l4",
            "LINE 100,100 0,100 id=l5",
            "LINE 0,100 0,0 id=l6",
        ],
        # Split LINE+ARC simple degree-2 loop where top arc bows down to touch bottom line at (50,0)
        [
            "NEW SPLIT-ARC-TANGENT",
            "LINE 0,0 100,0 id=bot",
            "LINE 100,0 100,50 id=right",
            "ARC C 50,50 50 180 0 id=bow",
            "LINE 0,50 0,0 id=left",
        ],
    ]
    for cmds in cases:
        s = DrawingSession()
        s.execute_batch(cmds)
        drc_mfg = lint_drawing(s.document, manufacturing=True)
        drc_draft = lint_drawing(s.document, manufacturing=False)
        assert drc_mfg["valid"] is False, f"Expected mfg DRC failure for {cmds[0]}"
        assert drc_draft["valid"] is False, f"Expected drafting DRC failure for {cmds[0]}"
        svg_text = drawing_to_svg_blueprint(s.document).decode("utf-8")
        assert "MFG DRC: FAILED" in svg_text
        assert "PASSED" not in svg_text
        with pytest.raises(ProjectError):
            extrude_drawing_to_part(s.document, thickness_mm=5.0)


def test_r10_http_exec_preserves_layer_selection_undo_redo_and_rolls_back_on_error():
    web_root = Path(__file__).resolve().parents[1] / "web" / "dist"
    httpd = LocalCADServer(("127.0.0.1", 0), web_root)
    port = httpd.server_port
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    base = f"http://127.0.0.1:{port}"

    def post_exec(payload):
        req = urllib.request.Request(
            f"{base}/api/drawing/exec",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read().decode("utf-8"))

    try:
        st1, _ = post_exec({"commands": ["RECTANG 0,0 100,60 id=outer"]})
        assert st1 == 200
        st2, r2 = post_exec({"commands": ["LAYER GUIDE #999999 CONSTRUCTION"]})
        assert st2 == 200
        assert "Created and activated 'GUIDE'" in r2["log"][0]

        st3, r3 = post_exec({"commands": ["CIRCLE 50,30 10 id=reference"]})
        assert st3 == 200
        ref_ent = next(e for e in r3["drawing"]["entities"] if e["id"] == "reference")
        assert ref_ent["layer"] == "guide"
        assert lint_drawing(r3["drawing"], manufacturing=True)["valid"] is True
        part, tel = extrude_drawing_to_part(r3["drawing"], thickness_mm=5.0)
        assert part.is_valid
        assert tel["hole_count"] == 0
        assert math.isclose(tel["volume_mm3"], 30000.0, abs_tol=1e-2)

        # UNDO and REDO across separate HTTP requests
        st_u, r_u = post_exec({"commands": ["UNDO"]})
        assert st_u == 200
        assert len(r_u["drawing"]["entities"]) == 1
        st_r, r_r = post_exec({"commands": ["REDO"]})
        assert st_r == 200
        assert len(r_r["drawing"]["entities"]) == 2

        # SELECT then MOVE across separate HTTP requests
        st_s, _ = post_exec({"commands": ["SELECT reference"]})
        assert st_s == 200
        st_m, r_m = post_exec({"commands": ["MOVE 0,0 5,0"]})
        assert st_m == 200
        moved_ref = next(e for e in r_m["drawing"]["entities"] if e["id"] == "reference")
        assert moved_ref["center"] == [55.0, 30.0]

        # Complexity overflow on /exec rolls back document, active_layer, selection, and revision
        snap_doc = copy.deepcopy(httpd.session.document)
        snap_rev = httpd.session.revision
        snap_layer = httpd.session.active_layer
        st_fail, _ = post_exec(
            {
                "commands": [
                    "LAYER 0",
                    "CIRCLE 10,10 1 id=seedA",
                    "ARRAY RECT seedA 20 20 12 12",
                    "CIRCLE 10000,10 1 id=seedB",
                    "ARRAY RECT seedB 20 20 12 12",
                ]
            }
        )
        assert st_fail == 422
        assert httpd.session.document == snap_doc
        assert httpd.session.revision == snap_rev
        assert httpd.session.active_layer == snap_layer
    finally:
        httpd.shutdown()
        httpd.server_close()
        t.join(timeout=5)


def test_r11c_real_http_bridge_stale_get_preserves_unsynced_undo():
    node_bin = shutil.which("node")
    if node_bin is None:
        pytest.skip("node not installed")

    repo_root = Path(__file__).resolve().parents[1]
    web_root = repo_root / "web" / "dist"
    httpd = LocalCADServer(("127.0.0.1", 0), web_root)
    port = httpd.server_port
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    base = f"http://127.0.0.1:{port}"

    node_script = """
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const base = process.argv[1];
const appSource = fs.readFileSync(path.join(process.cwd(), 'web/src/drawing/app.js'), 'utf8');
const start = appSource.indexOf('function pushWorkspaceState(');
const end = appSource.indexOf('function renderRuntimeSelect()', start);
const syncSlice = appSource.slice(start, end);

const packet = async (route, options) => {
  const res = await fetch(base + route, options);
  const data = await res.json();
  return { status: res.status, data };
};
const execCmd = async (commands) => {
  const p = await packet('/api/drawing/exec', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commands }),
  });
  if (p.status !== 200) throw new Error(JSON.stringify(p));
  return p.data;
};

const initial = await execCmd(['RECTANG 0,0 100,60 id=outer']);
const original = structuredClone(initial.drawing);
const addHole = (id, x) => {
  const doc = structuredClone(original);
  doc.entities.push({ id, type: 'circle', layer: '0', center: [x, 30], radius: 3 });
  return doc;
};
const posts = [];
const gets = [];
const commits = [];
const wrap = (p) => ({
  status: p.status,
  ok: p.status >= 200 && p.status < 300,
  headers: { get: () => 'application/json' },
  json: async () => structuredClone(p.data),
});
const ctx = {
  bridgeConnected: true,
  serverRevision: initial.revision,
  lastSyncedJson: JSON.stringify(original),
  pendingSyncJson: null,
  saved: JSON.stringify(original),
  document: { hidden: false },
  engine: { tool: false },
  panning: false,
  selectBox: false,
  requestBusy: false,
  store: {
    document: structuredClone(original),
    commit(doc) {
      this.document = structuredClone(doc);
      commits.push(this.document.entities.map((e) => e.id));
    },
  },
  makeRequestId: () => `http-audit-${posts.length + 1}`,
  renderRuntimeSelect() {},
  refreshRuntimes() {},
  render() {},
  fit() {},
  log() {},
  fetch: (route, options) =>
    new Promise((resolve, reject) => {
      if (options?.method === 'POST') posts.push({ route, options, resolve, reject });
      else gets.push({ captured: packet(route, options), resolve, reject });
    }),
};
vm.createContext(ctx);
vm.runInContext(syncSlice, ctx);
const tick = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};
const deliverPost = async (idx) => {
  const p = await packet(posts[idx].route, posts[idx].options);
  posts[idx].resolve(wrap(p));
  await tick();
  return p;
};
const deliverGet = async (idx) => {
  const p = await gets[idx].captured;
  gets[idx].resolve(wrap(p));
  await tick();
  return p;
};

ctx.store.document = addHole('temporary-X', 10);
ctx.pushWorkspaceState();
ctx.store.document = structuredClone(original);
ctx.pushWorkspaceState();

await execCmd(['SELECT outer']);
await execCmd(['MOVE 0,0 1,0']);
const rev4 = await execCmd(['UNDO']);
if (rev4.revision !== 4) throw new Error('Expected rev 4');

const p0 = await deliverPost(0);
if (p0.status !== 409) throw new Error('Expected 409 on post 0');
const capturedOldGet = await gets[0].captured;
if (capturedOldGet.data.revision !== 4) throw new Error('Expected rev 4 GET');

const acknowledgedA = addHole('acknowledged-A', 25);
ctx.store.document = structuredClone(acknowledgedA);
ctx.saved = JSON.stringify(acknowledgedA);
ctx.pushWorkspaceState();
const p1 = await deliverPost(1);
if (p1.status !== 409) throw new Error('Expected 409 on post 1');
ctx.reconcileSyncConflict('push');
const p2 = await deliverPost(2);
if (p2.data.revision !== 5) throw new Error('Expected rev 5 ACK on post 2');

ctx.store.document = structuredClone(original);
ctx.pushWorkspaceState();
await execCmd(['SELECT acknowledged-A']);
const moved = await execCmd(['MOVE 0,0 25,0']);
if (moved.revision !== 6) throw new Error('Expected rev 6 on server');
const p3 = await deliverPost(3);
if (p3.status !== 409) throw new Error('Expected 409 on undo post');

const conflictBefore = vm.runInContext('syncConflictRevision', ctx);
await deliverGet(0);
const falseAck = ctx.lastSyncedJson === JSON.stringify(ctx.store.document);
const conflictAfter = vm.runInContext('syncConflictRevision', ctx);

const pollPromise = ctx.pollWorkspaceState(false);
await deliverGet(1);
await pollPromise;

console.log(
  JSON.stringify({
    falseAck,
    conflictBefore,
    conflictAfter,
    finalLocalIds: ctx.store.document.entities.map((e) => e.id),
    commits,
    localUndoOverwritten: JSON.stringify(ctx.store.document) !== JSON.stringify(original),
    savedMarkedClean: ctx.saved === JSON.stringify(ctx.store.document),
  }),
);
"""
    try:
        proc = subprocess.run(
            [node_bin, "--input-type=module", "-e", node_script, base],
            cwd=repo_root,
            capture_output=True,
            text=True,
            timeout=20,
            check=True,
        )
        result = json.loads(proc.stdout)
        assert result["falseAck"] is False
        assert result["conflictBefore"] == 6
        assert result["conflictAfter"] == 6
        assert result["finalLocalIds"] == ["outer"]
        assert result["commits"] == []
        assert result["localUndoOverwritten"] is False
        assert result["savedMarkedClean"] is False
    finally:
        httpd.shutdown()
        httpd.server_close()
        t.join(timeout=5)
