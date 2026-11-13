"""Loopback-only, stateless bridge between the local UI and the CAD kernel."""

import argparse
import json
import mimetypes
import tempfile
import threading
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

from cad_lab.commands import DrawingSession
from cad_lab.drawing import MAX_DRAWING_BYTES, drawing_from_dxf, drawing_to_dxf
from cad_lab.extrude import (
    compute_cam_metrics,
    drawing_to_svg_blueprint,
    export_extruded_drawing,
    extrude_drawing_to_part,
)
from cad_lab.geometry import build_plate, export_part, mesh_data
from cad_lab.linter import lint_drawing
from cad_lab.mcp_server import check_json_depth
from cad_lab.project import MAX_PROJECT_BYTES, Project, ProjectError
from cad_lab.synthesis import discover_runtimes, synthesize_drawing


def _parse_bounded_json(text):
    check_json_depth(text)
    return json.loads(text)


class RevisionConflictError(Exception):
    """Raised when an optimistic concurrency expected_revision check fails."""

    def __init__(self, expected, actual, drawing):
        super().__init__(
            f"Drawing revision conflict: expected revision {expected}, current is {actual}."
        )
        self.actual = actual
        self.drawing = drawing


class LocalCADServer(ThreadingHTTPServer):
    def __init__(self, address, web_root):
        self.web_root = Path(web_root).resolve()
        self.geometry_lock = threading.Lock()
        self.geometry_slots = threading.BoundedSemaphore(4)
        self.session_lock = threading.Lock()
        self.session = DrawingSession()
        self.idempotency_cache = OrderedDict()
        super().__init__(address, CADHandler)

    def get_cached_mutation(self, route, request_id):
        if not isinstance(request_id, str) or not request_id or len(request_id) > 128:
            return None
        return self.idempotency_cache.get((route, request_id))

    def put_cached_mutation(self, route, request_id, response_payload):
        if not isinstance(request_id, str) or not request_id or len(request_id) > 128:
            return
        key = (route, request_id)
        self.idempotency_cache[key] = response_payload
        self.idempotency_cache.move_to_end(key)
        while len(self.idempotency_cache) > 128:
            self.idempotency_cache.popitem(last=False)

    @property
    def allowed_hosts(self):
        return {f"127.0.0.1:{self.server_port}", f"localhost:{self.server_port}"}


EXTRUDE_EXPORT_FILENAMES = {
    "step": "part.step",
    "stl": "part.stl",
}
PLATE_EXPORT_FORMATS = {
    "/api/export/step": ("step", "plate.step"),
    "/api/export/stl": ("stl", "plate.stl"),
}


class CADHandler(BaseHTTPRequestHandler):
    server_version = "Chamfer"

    def log_message(self, *_args):
        pass

    def _send(self, status, payload, content_type="application/json; charset=utf-8", filename=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header(
            "Content-Security-Policy",
            (
                "default-src 'self'; script-src 'self'; style-src 'self'; "
                "connect-src 'self'; img-src 'self' data: blob:; "
                "object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
            ),
        )
        if filename:
            safe_filename = (
                str(filename).replace("\r", "").replace("\n", "").replace('"', "").replace(";", "")
            )
            self.send_header("Content-Disposition", f'attachment; filename="{safe_filename}"')
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def _json(self, status, data):
        self._send(status, json.dumps(data, allow_nan=False).encode("utf-8"))

    def _check_expected_revision(self, payload):
        if not isinstance(payload, dict) or payload.get("expected_revision") is None:
            return
        exp = payload["expected_revision"]
        if type(exp) is not int:
            raise ProjectError("expected_revision must be an integer.")
        if exp != self.server.session.revision:
            raise RevisionConflictError(
                exp, self.server.session.revision, self.server.session.document
            )

    def _local_request(self):
        host = self.headers.get("Host", "")
        if host not in self.server.allowed_hosts:
            self._json(403, {"error": "Only loopback hosts are allowed."})
            return False
        origin = self.headers.get("Origin")
        if origin is not None and origin not in {
            f"http://{host}" for host in self.server.allowed_hosts
        }:
            self._json(403, {"error": "Cross-origin requests are not allowed."})
            return False
        return True

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if not self._local_request():
            return
        route = urlsplit(self.path).path
        if route == "/api/project":
            self._json(200, Project().to_dict())
            return
        if route == "/api/drawing/state":
            with self.server.session_lock:
                doc = self.server.session.document
                rev = self.server.session.revision
            try:
                lint_res = lint_drawing(doc)
            except ProjectError as exc:
                self._json(422, {"error": str(exc)})
                return
            self._json(200, {"revision": rev, "drawing": doc, "lint": lint_res})
            return
        if route == "/api/drawing/runtime":
            self._json(200, discover_runtimes())
            return
        if route.startswith("/api/"):
            self._json(404, {"error": "Unknown endpoint."})
            return
        try:
            default_page = (
                "drafting.html"
                if (self.server.web_root / "drafting.html").is_file()
                else "index.html"
            )
            relative = unquote(route).lstrip("/") or default_page
            path = (self.server.web_root / relative).resolve()
            if not path.is_relative_to(self.server.web_root) or not path.is_file():
                self._json(404, {"error": "Not found. Build the web application first."})
                return
            content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            if path.suffix == ".js":
                content_type = "text/javascript"
            self._send(200, path.read_bytes(), content_type)
        except (OSError, ValueError):
            self._json(404, {"error": "Not found."})

    def do_POST(self):
        if not self._local_request():
            return
        route = urlsplit(self.path).path
        if route == "/api/drawing/import-dxf":
            body_limit = 2 * MAX_DRAWING_BYTES + 1024
        elif route in {
            "/api/drawing/dxf",
            "/api/drawing/svg",
            "/api/drawing/cam",
            "/api/drawing/extrude",
            "/api/drawing/lint",
            "/api/drawing/state",
            "/api/drawing/exec",
            "/api/drawing/synthesize",
        }:
            body_limit = MAX_DRAWING_BYTES
        else:
            body_limit = MAX_PROJECT_BYTES
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._json(400, {"error": "Invalid content length."})
            return
        if size <= 0:
            self._json(413, {"error": "Send a project no larger than 64 KiB."})
            return
        try:
            self.connection.settimeout(10)
            # Consume bounded bodies before rejecting them; closing a socket with unread
            # data can discard the error response on Windows. Never read an unbounded body.
            raw = self.rfile.read(min(size, body_limit + 1))
            if size > body_limit:
                self._json(413, {"error": "Request exceeds the endpoint size limit."})
                return
            if route not in {
                "/api/model",
                "/api/export/step",
                "/api/export/stl",
                "/api/drawing/dxf",
                "/api/drawing/svg",
                "/api/drawing/cam",
                "/api/drawing/extrude",
                "/api/drawing/import-dxf",
                "/api/drawing/lint",
                "/api/drawing/state",
                "/api/drawing/exec",
                "/api/drawing/synthesize",
            }:
                self._json(404, {"error": "Unknown endpoint."})
                return
            if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
                self._json(415, {"error": "Send an application/json project."})
                return
            if route == "/api/drawing/dxf":
                query = urlsplit(self.path).query
                cut_only = "cut_only=1" in query or "cut_only=true" in query.lower()
                self._send(
                    200,
                    drawing_to_dxf(raw.decode("utf-8"), cut_only=cut_only),
                    "application/dxf",
                    "drawing.dxf",
                )
                return
            if route == "/api/drawing/svg":
                self._send(
                    200,
                    drawing_to_svg_blueprint(raw.decode("utf-8")),
                    "image/svg+xml; charset=utf-8",
                    "blueprint.svg",
                )
                return
            if route == "/api/drawing/cam":
                try:
                    payload = _parse_bounded_json(raw.decode("utf-8"))
                except (ValueError, RecursionError) as exc:
                    raise ProjectError("Invalid CAM request payload.") from exc
                doc = payload.get("drawing") if "drawing" in payload else payload
                thickness = float(payload.get("thickness", 3.0)) if "drawing" in payload else 3.0
                self._json(200, compute_cam_metrics(doc, thickness_mm=thickness))
                return
            if route == "/api/drawing/extrude":
                try:
                    payload = _parse_bounded_json(raw.decode("utf-8"))
                except (ValueError, RecursionError) as exc:
                    raise ProjectError("Invalid extrude request payload.") from exc
                if not isinstance(payload, dict) or "drawing" not in payload:
                    raise ProjectError("Extrude payload requires 'drawing'.")
                thickness = float(payload.get("thickness", 5.0))
                fmt = str(payload.get("format", "step")).lower().strip()
                if fmt not in {"mesh", "step", "stl"}:
                    raise ProjectError("Extrude format must be 'mesh', 'step', or 'stl'.")
                if not self.server.geometry_slots.acquire(timeout=5.0):
                    self._json(429, {"error": "Geometry kernel queue is busy; retry shortly."})
                    return
                try:
                    with self.server.geometry_lock:
                        if fmt == "mesh":
                            part, telemetry = extrude_drawing_to_part(
                                payload["drawing"], thickness_mm=thickness
                            )
                            mesh_payload = {"telemetry": telemetry, "mesh": mesh_data(part)}
                        else:
                            out_bytes, _tel, _mesh = export_extruded_drawing(
                                payload["drawing"], thickness_mm=thickness, file_format=fmt
                            )
                finally:
                    self.server.geometry_slots.release()
                if fmt == "mesh":
                    self._json(200, mesh_payload)
                else:
                    self._send(
                        200,
                        out_bytes,
                        "application/octet-stream",
                        EXTRUDE_EXPORT_FILENAMES[fmt],
                    )
                return
            if route == "/api/drawing/lint":
                self._json(200, lint_drawing(raw.decode("utf-8")))
                return
            if route == "/api/drawing/state":
                try:
                    payload = _parse_bounded_json(raw.decode("utf-8"))
                except (ValueError, RecursionError) as exc:
                    raise ProjectError("Invalid drawing state payload.") from exc
                req_id = payload.get("request_id") if isinstance(payload, dict) else None
                doc = (
                    payload.get("drawing")
                    if isinstance(payload, dict) and "drawing" in payload
                    else payload
                )
                if not isinstance(doc, dict):
                    raise ProjectError("Drawing state must be a JSON object.")
                # Validate schema, segment budget, and pair-complexity budget on an isolated
                # candidate BEFORE mutating the active session or incrementing its revision.
                candidate = DrawingSession()
                candidate.replace_document(doc)
                validated_doc = candidate.document
                lint_res = lint_drawing(validated_doc)
                with self.server.session_lock:
                    cached = self.server.get_cached_mutation(route, req_id)
                    if cached is not None:
                        self._json(200, cached)
                        return
                    self._check_expected_revision(payload)
                    self.server.session.replace_document(validated_doc)
                    current = self.server.session.document
                    rev = self.server.session.revision
                    resp_data = {"revision": rev, "drawing": current, "lint": lint_res}
                    self.server.put_cached_mutation(route, req_id, resp_data)
                self._json(200, resp_data)
                return
            if route == "/api/drawing/exec":
                try:
                    payload = _parse_bounded_json(raw.decode("utf-8"))
                except (ValueError, RecursionError) as exc:
                    raise ProjectError("Invalid command execution payload.") from exc
                if not isinstance(payload, dict):
                    raise ProjectError("Execution payload must be a JSON object.")
                req_id = payload.get("request_id")
                logs = []
                with self.server.session_lock:
                    cached = self.server.get_cached_mutation(route, req_id)
                    if cached is not None:
                        self._json(200, cached)
                        return
                    self._check_expected_revision(payload)
                    candidate = self.server.session.clone()
                    if "commands" in payload:
                        logs = candidate.execute_batch(payload["commands"])
                    elif "modify" in payload:
                        mod = payload["modify"]
                        if not isinstance(mod, dict) or "id" not in mod:
                            raise ProjectError("Modify payload requires an entity 'id'.")
                        changes = {k: v for k, v in mod.items() if k != "id"}
                        updated = candidate.modify_entity(mod["id"], **changes)
                        note = getattr(candidate, "last_modify_note", None)
                        logs = [
                            f"MODIFY · Updated '{updated['id']}'" + (f" ({note})." if note else ".")
                        ]
                    else:
                        raise ProjectError("Specify 'commands' or 'modify'.")
                    cand_doc = candidate.document
                    lint_res = lint_drawing(cand_doc)
                    self.server.session.adopt_from(candidate)
                    current = self.server.session.document
                    rev = self.server.session.revision
                    resp_data = {
                        "revision": rev,
                        "log": logs,
                        "drawing": current,
                        "lint": lint_res,
                    }
                    self.server.put_cached_mutation(route, req_id, resp_data)
                self._json(200, resp_data)
                return
            if route == "/api/drawing/synthesize":
                try:
                    payload = _parse_bounded_json(raw.decode("utf-8"))
                except (ValueError, RecursionError) as exc:
                    raise ProjectError("Invalid synthesis payload.") from exc
                if not isinstance(payload, dict) or "spec" not in payload:
                    raise ProjectError("Synthesis payload requires a 'spec' string.")
                req_id = payload.get("request_id")
                with self.server.session_lock:
                    cached = self.server.get_cached_mutation(route, req_id)
                    if cached is not None:
                        self._json(200, cached)
                        return
                    self._check_expected_revision(payload)
                    worker = self.server.session.clone()
                    start_rev = self.server.session.revision
                result = synthesize_drawing(
                    worker,
                    payload["spec"],
                    runtime_id=payload.get("runtime"),
                    max_repairs=payload.get("max_repairs", 3),
                )
                with self.server.session_lock:
                    if self.server.session.revision != start_rev:
                        raise RevisionConflictError(
                            start_rev,
                            self.server.session.revision,
                            self.server.session.document,
                        )
                    self.server.session.adopt_from(worker)
                    result["revision"] = self.server.session.revision
                    self.server.put_cached_mutation(route, req_id, result)
                self._json(200, result)
                return
            if route == "/api/drawing/import-dxf":
                try:
                    data = _parse_bounded_json(raw.decode("utf-8"))
                except (ValueError, RecursionError) as exc:
                    raise ProjectError("Invalid DXF request.") from exc
                if not isinstance(data, dict) or set(data) != {"dxf"}:
                    raise ProjectError("Send the DXF content only.")
                self._json(200, drawing_from_dxf(data["dxf"]))
                return
            project = Project.from_json(raw.decode("utf-8"))
            # Serve browser assets concurrently while serializing all OCCT operations.
            if not self.server.geometry_slots.acquire(timeout=5.0):
                self._json(429, {"error": "Geometry kernel queue is busy; retry shortly."})
                return
            try:
                with self.server.geometry_lock:
                    part = build_plate(project.parameters)
                    if route == "/api/model":
                        result = {"project": project.to_dict(), "mesh": mesh_data(part)}
                    else:
                        file_format, export_filename = PLATE_EXPORT_FORMATS[route]
                        with tempfile.TemporaryDirectory(prefix="cadlab-") as directory:
                            path = Path(directory) / export_filename
                            export_part(part, path, file_format)
                            payload = path.read_bytes()
            finally:
                self.server.geometry_slots.release()
            if route == "/api/model":
                self._json(200, result)
                return
            self._send(200, payload, "application/octet-stream", export_filename)
        except RevisionConflictError as exc:
            self._json(
                409,
                {
                    "error": str(exc),
                    "revision": exc.actual,
                    "drawing": exc.drawing,
                },
            )
        except (ProjectError, UnicodeError) as exc:
            self._json(422, {"error": str(exc)})
        except (TimeoutError, OSError):
            self._json(400, {"error": "Could not read this request or produce the export."})
        except Exception:
            self._json(
                500, {"error": "The geometry operation failed. The last valid model is kept."}
            )


def main():
    parser = argparse.ArgumentParser(description="Serve the Chamfer local workbench")
    parser.add_argument("--port", type=int, default=4310)
    parser.add_argument("--web-root", type=Path, default=Path("web/dist"))
    args = parser.parse_args()
    if not (args.web_root / "index.html").is_file():
        parser.error("Build the frontend first: npm --prefix web ci && npm --prefix web run build")
    with LocalCADServer(("127.0.0.1", args.port), args.web_root) as server:
        print(f"Chamfer: http://127.0.0.1:{server.server_port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
