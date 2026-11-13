"""Tests for local runtime auto-discovery and DRC-verified closed-loop CAD synthesis."""

import json
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from cad_lab.commands import DrawingSession
from cad_lab.drawing import drawing_to_dxf
from cad_lab.server import LocalCADServer
from cad_lab.synthesis import discover_runtimes, synthesize_drawing


class _FakeOllamaHandler(BaseHTTPRequestHandler):
    call_count = 0
    received_messages = []

    def log_message(self, *_args):
        pass

    def do_GET(self):
        if self.path == "/api/tags":
            payload = {
                "models": [
                    {"name": "phi3:mini"},
                    {"name": "qwen2.5-coder:7b"},
                ]
            }
            raw = json.dumps(payload).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        if self.path == "/api/chat":
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            type(self).call_count += 1
            type(self).received_messages.append(body["messages"])
            if type(self).call_count == 1:
                # Deliberately flawed Pass 1: open outer contour + bolt hole violating clearance
                reply = "\n".join(
                    [
                        "```",
                        "NEW BRACKET-PASS1",
                        "LAYER 0-PROFILE #dce2ea",
                        "PLINE 0,0 100,0 100,60 0,60 0,0.4 id=outer",
                        "CIRCLE 3,12 3.3 id=bolt-1",
                        "```",
                    ]
                )
            else:
                # Repaired Pass 2 after receiving millimeter DRC diagnostic feedback
                reply = "\n".join(
                    [
                        "NEW BRACKET-VERIFIED",
                        "LAYER 0-PROFILE #dce2ea",
                        "RECTANG 0,0 100,60 id=outer",
                        "CIRCLE 12,12 3.3 id=bolt-bl",
                        "CIRCLE 88,12 3.3 id=bolt-br",
                        "CIRCLE 88,48 3.3 id=bolt-tr",
                        "CIRCLE 12,48 3.3 id=bolt-tl",
                        "LAYER DIMENSIONS #e09b24",
                        "DIM 0,0 100,0 50,-10 id=dim-w",
                    ]
                )
            raw = json.dumps({"message": {"role": "assistant", "content": reply}}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        self.send_response(404)
        self.end_headers()


class _FakeV1Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        if self.path == "/v1/models":
            raw = json.dumps({"data": [{"id": "deepseek-coder-v2-lite"}]}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        if self.path == "/v1/chat/completions":
            length = int(self.headers.get("Content-Length", "0"))
            _ = self.rfile.read(length)
            script = "NEW V1-PLATE\nRECTANG 0,0 80,50 id=outer\nCIRCLE 40,25 8 id=bore"
            raw = json.dumps({"choices": [{"message": {"content": script}}]}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        self.send_response(404)
        self.end_headers()


def test_local_runtime_discovery_and_closed_loop_self_repair():
    _FakeOllamaHandler.call_count = 0
    _FakeOllamaHandler.received_messages = []

    with (
        ThreadingHTTPServer(("127.0.0.1", 0), _FakeOllamaHandler) as ollama_srv,
        ThreadingHTTPServer(("127.0.0.1", 0), _FakeV1Handler) as v1_srv,
    ):
        t1 = threading.Thread(target=ollama_srv.serve_forever, daemon=True)
        t2 = threading.Thread(target=v1_srv.serve_forever, daemon=True)
        t1.start()
        t2.start()
        try:
            targets = [
                {
                    "provider": "ollama",
                    "label": "Ollama",
                    "kind": "ollama",
                    "base_url": f"http://127.0.0.1:{ollama_srv.server_port}",
                },
                {
                    "provider": "lmstudio",
                    "label": "LM Studio",
                    "kind": "v1",
                    "base_url": f"http://127.0.0.1:{v1_srv.server_port}",
                },
            ]
            info = discover_runtimes(targets=targets)
            assert info["external_detected"] is True
            # qwen2.5-coder:7b should rank ahead of phi3:mini
            assert info["active"]["id"] == "ollama:qwen2.5-coder:7b"
            ids = [item["id"] for item in info["available"]]
            assert "lmstudio:deepseek-coder-v2-lite" in ids
            assert "parametric:chamfer-rule-v1" in ids

            session = DrawingSession()
            result = synthesize_drawing(
                session,
                "100x60mm mounting bracket with 4 M6 corner holes",
                targets=targets,
            )
            assert len(result["passes"]) == 2
            assert result["passes"][0]["errors"] >= 2
            assert "OPEN_CONTOUR_GAP" in result["passes"][0]["issues"]
            assert result["passes"][1]["errors"] == 0
            assert result["lint"]["summary"]["errors"] == 0
            # Verify DRC diagnostic feedback was actually sent in Pass 2 prompt
            second_turn_prompt = _FakeOllamaHandler.received_messages[1][-1]["content"]
            assert "OPEN_CONTOUR_GAP" in second_turn_prompt

            # Also verify v1 chat-completions runtime execution
            v1_result = synthesize_drawing(
                session,
                "80x50 plate with center bore",
                runtime_id="lmstudio:deepseek-coder-v2-lite",
                targets=targets,
            )
            assert v1_result["lint"]["summary"]["errors"] == 0
            assert v1_result["drawing"]["name"] == "V1-PLATE"
        finally:
            ollama_srv.shutdown()
            v1_srv.shutdown()


def test_offline_parametric_compiler_and_auto_clearance_repair():
    session = DrawingSession()
    clean = synthesize_drawing(
        session,
        "140x80 plaka, 4xM6 delik, 36x14 kanal, 5mm flanş, ölçülendir",
        runtime_id="parametric:chamfer-rule-v1",
    )
    assert len(clean["passes"]) == 1
    assert clean["lint"]["summary"]["errors"] == 0
    dxf_bytes = drawing_to_dxf(json.dumps(clean["drawing"]))
    assert b"ARC" in dxf_bytes
    assert b"DIMENSION" in dxf_bytes

    # Tight edge inset (4 mm for M8 hole radius 4.5 mm) must trigger Pass 1 DRC error -> Pass 2 fix
    repaired = synthesize_drawing(
        session,
        "100x60 plaka, 4xM8 delik kenardan 4mm pay, ölçülendir",
        runtime_id="parametric:chamfer-rule-v1",
    )
    assert len(repaired["passes"]) == 2
    assert repaired["passes"][0]["errors"] > 0
    assert repaired["passes"][1]["errors"] == 0
    assert repaired["lint"]["summary"]["errors"] == 0

    # Architectural room layout with wall offset + door swing arc
    room = synthesize_drawing(
        session,
        "4000x3000 oda duvar 200 kapı 900",
        runtime_id="parametric:chamfer-rule-v1",
    )
    assert room["lint"]["summary"]["errors"] == 0
    kinds = {e["type"] for e in room["drawing"]["entities"]}
    assert {"polyline", "line", "arc", "dim"}.issubset(kinds)


def test_server_runtime_and_synthesize_http_endpoints(tmp_path: Path):
    web_root = tmp_path / "dist"
    web_root.mkdir()
    (web_root / "index.html").write_text("<!doctype html><title>ok</title>", encoding="utf-8")

    with LocalCADServer(("127.0.0.1", 0), web_root) as srv:
        thread = threading.Thread(target=srv.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{srv.server_port}"
        try:
            with urllib.request.urlopen(f"{base}/api/drawing/runtime", timeout=3) as resp:
                rt = json.loads(resp.read().decode("utf-8"))
            assert "available" in rt
            assert any(item["kind"] == "parametric" for item in rt["available"])

            req = urllib.request.Request(
                f"{base}/api/drawing/synthesize",
                data=json.dumps(
                    {
                        "spec": "120x70 plate, 4xM6 holes, 30x12 slot",
                        "runtime": "parametric:chamfer-rule-v1",
                    }
                ).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=5) as resp:
                out = json.loads(resp.read().decode("utf-8"))
            assert out["lint"]["summary"]["errors"] == 0
            assert len(out["drawing"]["entities"]) >= 9
        finally:
            srv.shutdown()
