import http.client
import json
import subprocess
import sys
import threading
from pathlib import Path

import pytest

from cad_lab.commands import DrawingSession
from cad_lab.mcp_server import ChamferMCPBridge, handle_rpc_message
from cad_lab.project import ProjectError
from cad_lab.server import LocalCADServer


@pytest.fixture
def live_server(tmp_path):
    root = tmp_path / "web"
    root.mkdir()
    (root / "index.html").write_text("<h1>Chamfer</h1>", encoding="utf-8")
    (root / "drafting.html").write_text("<h1>Drafting</h1>", encoding="utf-8")
    server = LocalCADServer(("127.0.0.1", 0), root)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)


def _http_json(port, method, path, payload=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    headers = {"Host": f"127.0.0.1:{port}"}
    body = None
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    conn.request(method, path, body=body, headers=headers)
    resp = conn.getresponse()
    raw = resp.read()
    conn.close()
    return resp.status, json.loads(raw.decode("utf-8"))


def test_drawing_session_commands_coordinates_and_undo_redo():
    session = DrawingSession()
    session.execute_batch(
        [
            "NEW Mounting Bracket",
            "LAYER profile #60b7fa",
            "RECTANG 0,0 @100,60 id=outer",
            "LAYER holes #78e69e",
            "CIRCLE 15,15 D 10 id=hole-a",
            "CIRCLE 85,15 @5<90 id=hole-b",
            "LINE 20,30 @60,0 id=slot-axis",
        ]
    )
    assert session.document["name"] == "Mounting Bracket"
    assert len(session.document["layers"]) == 3
    by_id = {e["id"]: e for e in session.document["entities"]}
    assert by_id["outer"]["closed"] is True
    assert by_id["hole-a"]["radius"] == pytest.approx(5.0)
    assert by_id["hole-b"]["radius"] == pytest.approx(5.0)
    assert by_id["slot-axis"]["points"] == [[20.0, 30.0], [80.0, 30.0]]

    session.execute("SELECT hole-a")
    session.execute("COPY 0,0 @0,30")
    assert len(session.document["entities"]) == 5

    session.execute("MOVE 0,0 5,0")
    by_id = {e["id"]: e for e in session.document["entities"]}
    assert by_id["hole-a"]["center"] == [20.0, 15.0]

    assert "Reverted" in session.execute("UNDO")
    by_id = {e["id"]: e for e in session.document["entities"]}
    assert by_id["hole-a"]["center"] == [15.0, 15.0]

    assert "Restored" in session.execute("REDO")
    by_id = {e["id"]: e for e in session.document["entities"]}
    assert by_id["hole-a"]["center"] == [20.0, 15.0]

    session.execute("ERASE slot-axis")
    assert "slot-axis" not in {e["id"] for e in session.document["entities"]}


def test_modify_entity_closes_near_duplicate_gap_cleanly():
    session = DrawingSession()
    session.execute("PLINE 0,0 80,0 80,50 0,50 0,0.4 id=plate")
    updated = session.modify_entity("plate", closed=True)
    assert updated["closed"] is True
    assert len(updated["points"]) == 4
    assert updated["points"] == [[0.0, 0.0], [80.0, 0.0], [80.0, 50.0], [0.0, 50.0]]


def test_locked_layer_blocks_creation_and_modification():
    session = DrawingSession()
    session.execute("CIRCLE 20,20 5 id=c1")
    locked_doc = json.loads(json.dumps(session.document))
    locked_doc["layers"][0]["locked"] = True
    session.replace_document(locked_doc)

    with pytest.raises(ProjectError):
        session.execute("CIRCLE 40,20 5")
    with pytest.raises(ProjectError):
        session.modify_entity("c1", radius=8)


def test_mcp_protocol_and_self_healing_cnc_workflow(tmp_path):
    bridge = ChamferMCPBridge(port=0)

    init_resp = handle_rpc_message(
        bridge,
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"protocolVersion": "2025-03-26"},
        },
    )
    assert init_resp["result"]["protocolVersion"] == "2025-03-26"
    assert init_resp["result"]["serverInfo"]["name"] == "chamfer"

    # Notifications (no id) must return None
    assert (
        handle_rpc_message(bridge, {"jsonrpc": "2.0", "method": "notifications/initialized"})
        is None
    )

    tools_resp = handle_rpc_message(bridge, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
    tool_names = {t["name"] for t in tools_resp["result"]["tools"]}
    assert tool_names == {
        "chamfer_get_drawing",
        "chamfer_execute",
        "chamfer_modify_entity",
        "chamfer_lint",
        "chamfer_export_dxf",
        "chamfer_import_dxf",
        "chamfer_cam_report",
        "chamfer_extrude_3d",
    }

    # Step 1: Create a bracket with an open contour gap (0.35 mm) and thin web clearance (0.5 mm)
    exec_resp = handle_rpc_message(
        bridge,
        {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "chamfer_execute",
                "arguments": {
                    "commands": [
                        "NEW CNC Bracket",
                        "PLINE 0,0 100,0 100,60 0,60 0,0.35 id=outer",
                        "CIRCLE 5.5,30 5 id=mount-hole",
                    ]
                },
            },
        },
    )
    assert exec_resp["result"]["isError"] is False
    step1 = json.loads(exec_resp["result"]["content"][0]["text"])
    assert step1["lint"]["valid"] is False
    issue_codes = {i["code"] for i in step1["lint"]["issues"]}
    assert "OPEN_CONTOUR_GAP" in issue_codes

    # Step 2: Close the outer contour and inspect remaining clearance fault
    fix_outer = handle_rpc_message(
        bridge,
        {
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call",
            "params": {
                "name": "chamfer_modify_entity",
                "arguments": {"id": "outer", "closed": True},
            },
        },
    )
    step2 = json.loads(fix_outer["result"]["content"][0]["text"])
    assert {i["code"] for i in step2["lint"]["issues"]} == {"MIN_CLEARANCE"}

    # Step 3: Shift hole center to achieve >= 1.5 mm web clearance -> valid=True
    fix_hole = handle_rpc_message(
        bridge,
        {
            "jsonrpc": "2.0",
            "id": 5,
            "method": "tools/call",
            "params": {
                "name": "chamfer_modify_entity",
                "arguments": {"id": "mount-hole", "center": [12, 30]},
            },
        },
    )
    step3 = json.loads(fix_hole["result"]["content"][0]["text"])
    assert step3["lint"]["valid"] is True
    assert step3["lint"]["summary"]["errors"] == 0

    # Step 4: Export verified DXF and re-import it
    dxf_file = tmp_path / "verified_bracket.dxf"
    export_resp = handle_rpc_message(
        bridge,
        {
            "jsonrpc": "2.0",
            "id": 6,
            "method": "tools/call",
            "params": {
                "name": "chamfer_export_dxf",
                "arguments": {"output_path": str(dxf_file)},
            },
        },
    )
    exported = json.loads(export_resp["result"]["content"][0]["text"])
    assert exported["lint"]["valid"] is True
    assert dxf_file.is_file()

    reimport_resp = handle_rpc_message(
        bridge,
        {
            "jsonrpc": "2.0",
            "id": 7,
            "method": "tools/call",
            "params": {
                "name": "chamfer_import_dxf",
                "arguments": {"dxf": dxf_file.read_text(encoding="utf-8")},
            },
        },
    )
    reimported = json.loads(reimport_resp["result"]["content"][0]["text"])
    assert reimported["import_report"]["entities"] == 2
    assert reimported["lint"]["valid"] is True


def test_mcp_bridge_live_two_way_sync_with_local_server(live_server):
    bridge = ChamferMCPBridge(port=live_server.server_port)

    # MCP executes commands -> live_server immediately reflects the state for the browser
    result = bridge.call_tool(
        "chamfer_execute",
        {"commands": ["NEW Shared Canvas", "RECTANG 0,0 120,80 id=plate", "CIRCLE 20,20 6 id=h1"]},
    )
    assert result["lint"]["valid"] is True

    status, server_state = _http_json(live_server.server_port, "GET", "/api/drawing/state")
    assert status == 200
    assert server_state["drawing"]["name"] == "Shared Canvas"
    assert len(server_state["drawing"]["entities"]) == 2
    assert server_state["revision"] == result["revision"]

    # Browser edits drawing and pushes /api/drawing/state -> MCP sees the browser edit immediately
    browser_doc = json.loads(json.dumps(server_state["drawing"]))
    browser_doc["entities"].append(
        {"id": "h2", "layer": "0", "type": "circle", "center": [100, 60], "radius": 6}
    )
    post_status, pushed = _http_json(
        live_server.server_port, "POST", "/api/drawing/state", {"drawing": browser_doc}
    )
    assert post_status == 200
    assert pushed["revision"] > result["revision"]

    mcp_view = bridge.call_tool("chamfer_get_drawing", {})
    assert {e["id"] for e in mcp_view["drawing"]["entities"]} == {"plate", "h1", "h2"}
    assert mcp_view["lint"]["valid"] is True


def test_chamfer_mcp_stdio_cli_round_trip():
    stdin_lines = "\n".join(
        [
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}),
            json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}),
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "tools/call",
                    "params": {
                        "name": "chamfer_execute",
                        "arguments": {"commands": ["RECTANG 0,0 50,30 id=box"]},
                    },
                }
            ),
        ]
    )
    proc = subprocess.run(
        [sys.executable, "-m", "cad_lab.mcp_server", "--port", "0"],
        input=stdin_lines + "\n",
        text=True,
        capture_output=True,
        timeout=15,
        check=True,
        cwd=Path(__file__).resolve().parents[1],
    )
    responses = [json.loads(line) for line in proc.stdout.strip().splitlines()]
    assert len(responses) == 2
    assert responses[0]["id"] == 1
    assert responses[0]["result"]["serverInfo"]["name"] == "chamfer"
    call_payload = json.loads(responses[1]["result"]["content"][0]["text"])
    assert call_payload["lint"]["valid"] is True
    assert call_payload["drawing"]["entities"][0]["id"] == "box"


def test_arc_offset_and_dim_commands_and_dxf_round_trip(tmp_path):
    bridge = ChamferMCPBridge(port=0)
    res = bridge.call_tool(
        "chamfer_execute",
        {
            "commands": [
                "NEW Slotted Flange",
                "RECTANG 0,0 120,80 id=outer",
                "OFFSET outer 10 60,40 id=inner-wall",
                "ARC 40,40 60,55 80,40 id=top-dome",
                "ARC C 20,20 8 90 270 id=left-cap",
                "LAYER dims #e09b24",
                "DIM 0,0 120,0 60,-12 id=width-dim",
            ]
        },
    )
    assert res["lint"]["valid"] is True
    by_id = {e["id"]: e for e in res["drawing"]["entities"]}
    assert by_id["inner-wall"]["points"] == [
        [10.0, 10.0],
        [110.0, 10.0],
        [110.0, 70.0],
        [10.0, 70.0],
    ]
    assert by_id["left-cap"]["type"] == "arc"
    assert by_id["left-cap"]["radius"] == pytest.approx(8.0)
    assert by_id["width-dim"]["type"] == "dim"

    dxf_path = tmp_path / "slotted_flange.dxf"
    exported = bridge.call_tool("chamfer_export_dxf", {"output_path": str(dxf_path)})
    assert exported["bytes"] > 0
    reimported = bridge.call_tool(
        "chamfer_import_dxf", {"dxf": dxf_path.read_text(encoding="utf-8")}
    )
    assert reimported["import_report"]["entities"] == 5
    types = [e["type"] for e in reimported["drawing"]["entities"]]
    assert types.count("arc") == 2
    assert types.count("dim") == 1


def test_chamfer_lint_scales_default_clearance_with_thickness():
    bridge = ChamferMCPBridge(port=0)
    bridge.call_tool(
        "chamfer_execute",
        {
            "commands": [
                "NEW 6MM-PLATE",
                "RECTANG 0,0 80,50 id=outer",
                "CIRCLE 15,25 3 id=h1",
                "CIRCLE 23,25 3 id=h2",
            ]
        },
    )
    default_rep = bridge.call_tool("chamfer_lint", {})
    assert default_rep["min_clearance_mm"] == 1.5
    assert default_rep["summary"]["warnings"] == 0

    thick_rep = bridge.call_tool("chamfer_lint", {"thickness_mm": 6.0})
    assert thick_rep["min_clearance_mm"] == 6.0
    assert [i["code"] for i in thick_rep["issues"]] == ["MIN_CLEARANCE"]
