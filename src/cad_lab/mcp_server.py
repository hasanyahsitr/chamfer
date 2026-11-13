"""Model Context Protocol (MCP) stdio server for Chamfer 2D CAD & DXF verification."""

import argparse
import http.client
import json
import sys
import uuid
from pathlib import Path

from cad_lab import __version__
from cad_lab.commands import DrawingSession
from cad_lab.drawing import drawing_from_dxf, drawing_to_dxf
from cad_lab.extrude import compute_cam_metrics, export_extruded_drawing
from cad_lab.linter import lint_drawing
from cad_lab.project import ProjectError

SUPPORTED_PROTOCOLS = ("2025-03-26", "2024-11-05")
MAX_RPC_LINE_BYTES = 2 * 1024 * 1024

TOOLS = [
    {
        "name": "chamfer_get_drawing",
        "description": (
            "Read the active millimeter 2D CAD drawing state (layers, entities, revision) "
            "and its deterministic geometry verification summary."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
    },
    {
        "name": "chamfer_execute",
        "description": (
            "Execute deterministic 2D CAD drafting commands in millimeters atomically and run "
            "manufacturing/geometry verification. Supported commands: NEW [name], "
            "LAYER <name> [#hex] [CONSTRUCTION], RECTANG <x1,y1> <x2,y2> [id=...], "
            "PLINE <p1> <p2> [... C] [id=...], LINE <p1> <p2> [...] [id=...], "
            "CIRCLE <cx,cy> [D] <r_or_d> [id=...], ARC <p1> <p2> <p3> [id=...] (or ARC C "
            "<cx,cy> <r> <start_deg> <end_deg>), OFFSET [entity_id] <dist> <side_x,y> [id=...], "
            "CHAMFER, FILLET, TRIM, ROTATE, MIRROR, ARRAY, TEXT, "
            "DIM <p1> <p2> <dim_pt> [id=...], SELECT <ALL|NONE|ids>, "
            "MOVE <base> <target>, COPY <base> <target>, ERASE [ids], UNDO, REDO."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "commands": {
                    "type": "array",
                    "items": {"type": "string"},
                    "minItems": 1,
                    "maxItems": 500,
                    "description": "Ordered CAD commands to execute atomically.",
                }
            },
            "required": ["commands"],
            "additionalProperties": False,
        },
    },
    {
        "name": "chamfer_modify_entity",
        "description": (
            "Update an existing entity's properties by ID (center, radius, points, closed, layer) "
            "and re-verify geometry. Use this to fix open contours or clearance collisions."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "Target entity ID."},
                "center": {
                    "type": "array",
                    "items": {"type": "number"},
                    "minItems": 2,
                    "maxItems": 2,
                },
                "radius": {"type": "number", "exclusiveMinimum": 0},
                "points": {
                    "type": "array",
                    "items": {
                        "type": "array",
                        "items": {"type": "number"},
                        "minItems": 2,
                        "maxItems": 2,
                    },
                },
                "closed": {"type": "boolean"},
                "snap_gap_mm": {"type": "number", "minimum": 0, "default": 0.5},
                "layer": {"type": "string"},
            },
            "required": ["id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "chamfer_lint",
        "description": (
            "Run deterministic 2D geometry and CNC/manufacturing checks (open contour gaps, "
            "self-intersections, duplicate cuts, hole-edge collisions, thin webs, stray holes)."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "max_gap_mm": {"type": "number", "default": 2.0, "minimum": 0},
                "min_clearance_mm": {"type": "number", "default": 1.5, "minimum": 0},
                "min_segment_mm": {"type": "number", "default": 0.5, "minimum": 0},
                "manufacturing": {"type": "boolean", "default": False},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "chamfer_export_dxf",
        "description": (
            "Export the verified 2D drawing to ASCII R2010 millimeter DXF. Optionally write "
            "the output to a local .dxf file path (refuses to overwrite unless overwrite=true)."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "output_path": {
                    "type": "string",
                    "description": "Optional .dxf file path where the file will be saved.",
                },
                "overwrite": {
                    "type": "boolean",
                    "default": False,
                    "description": "Allow replacing an existing file at output_path.",
                },
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "chamfer_import_dxf",
        "description": "Import planar millimeter ASCII DXF text into the active workspace.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "dxf": {"type": "string", "description": "ASCII DXF content in millimeter units."}
            },
            "required": ["dxf"],
            "additionalProperties": False,
        },
    },
    {
        "name": "chamfer_cam_report",
        "description": (
            "Compute laser/CNC manufacturing telemetry for the active 2D drawing: total cutting "
            "path length (mm), pierce count, net part area (mm2), scrap percentage, and sheet mass."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "thickness_mm": {"type": "number", "default": 3.0, "exclusiveMinimum": 0}
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "chamfer_extrude_3d",
        "description": (
            "Extrude the active single-part planar 2D drawing into an exact Open CASCADE 3D "
            "B-Rep solid and optionally save STEP or STL to disk."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "thickness_mm": {"type": "number", "default": 5.0, "exclusiveMinimum": 0},
                "format": {"type": "string", "enum": ["step", "stl"], "default": "step"},
                "output_path": {
                    "type": "string",
                    "description": "Optional path to save the exported .step/.stp or .stl file.",
                },
                "overwrite": {
                    "type": "boolean",
                    "default": False,
                    "description": "Allow replacing an existing file at output_path.",
                },
            },
            "additionalProperties": False,
        },
    },
]


def check_json_depth(text, max_depth=64):
    """Verify JSON nesting depth in a single linear pass before json.loads."""
    depth = 0
    in_str = False
    escape = False
    for ch in text:
        if in_str:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_str = False
        else:
            if ch == '"':
                in_str = True
            elif ch in "[{":
                depth += 1
                if depth > max_depth:
                    raise ValueError(f"JSON nesting depth exceeds limit ({max_depth}).")
            elif ch in "]}":
                depth = max(0, depth - 1)


def _resolve_export_path(out_path, allowed_exts, overwrite=False):
    if not isinstance(out_path, str) or not out_path.strip():
        raise ProjectError("output_path must be a non-empty file path string.")
    if not isinstance(overwrite, bool):
        raise ProjectError("overwrite must be a boolean.")
    target = Path(out_path).resolve()
    if target.suffix.lower() not in allowed_exts:
        expected = ", ".join(sorted(allowed_exts))
        raise ProjectError(f"Export output_path must end with {expected}.")
    if target.exists() and not overwrite:
        raise ProjectError(
            f"Output file '{target.name}' already exists; pass overwrite=true to replace it."
        )
    return target


class ChamferMCPBridge:
    """Executes MCP tool calls locally and mirrors state to a running loopback server if active."""

    def __init__(self, port=4310):
        self.port = port
        self.session = DrawingSession()
        self.remote_revision = None

    def _bridge_request(self, method, path, payload=None):
        if not self.port:
            return None
        host = f"127.0.0.1:{self.port}"
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=1.5)
        try:
            try:
                conn.connect()
            except OSError:
                return None

            headers = {"Host": host}
            body = None
            if payload is not None:
                req_payload = dict(payload) if isinstance(payload, dict) else payload
                if method == "POST" and isinstance(req_payload, dict):
                    req_payload.setdefault("request_id", str(uuid.uuid4()))
                    if self.remote_revision is not None:
                        req_payload.setdefault("expected_revision", self.remote_revision)
                body = json.dumps(req_payload).encode("utf-8")
                headers["Content-Type"] = "application/json"

            try:
                conn.request(method, path, body=body, headers=headers)
                resp = conn.getresponse()
                raw = resp.read()
            except (TimeoutError, OSError, http.client.HTTPException) as exc:
                if method != "GET":
                    raise ProjectError(
                        "Loopback server connection dropped during mutation; "
                        "remote commit state is uncertain, refusing local fallback."
                    ) from exc
                return None
        finally:
            conn.close()

        try:
            check_json_depth(raw.decode("utf-8"))
            parsed = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, ValueError, RecursionError) as exc:
            if resp.status == 200:
                raise ProjectError("Invalid JSON response from loopback server.") from exc
            parsed = {}

        if resp.status == 200:
            if isinstance(parsed, dict) and isinstance(parsed.get("revision"), int):
                self.remote_revision = parsed["revision"]
            return parsed
        if resp.status == 409 and isinstance(parsed, dict):
            if isinstance(parsed.get("revision"), int):
                self.remote_revision = parsed["revision"]
        err_msg = (
            parsed.get("error")
            if isinstance(parsed, dict) and isinstance(parsed.get("error"), str)
            else f"Loopback server rejected request (HTTP {resp.status})."
        )
        raise ProjectError(err_msg)

    def _current_state(self):
        remote = self._bridge_request("GET", "/api/drawing/state")
        if remote is not None:
            self.session.replace_document(remote["drawing"])
            return remote
        doc = self.session.document
        return {
            "revision": self.session.revision,
            "drawing": doc,
            "lint": lint_drawing(doc),
        }

    def call_tool(self, name, arguments):
        if not isinstance(arguments, dict):
            raise ValueError("Tool arguments must be a JSON object.")
        args = arguments
        if name == "chamfer_get_drawing":
            return self._current_state()

        if name == "chamfer_execute":
            commands = args.get("commands")
            remote = self._bridge_request("POST", "/api/drawing/exec", {"commands": commands})
            if remote is not None:
                self.session.replace_document(remote["drawing"])
                return remote
            logs = self.session.execute_batch(commands)
            doc = self.session.document
            return {
                "revision": self.session.revision,
                "log": logs,
                "drawing": doc,
                "lint": lint_drawing(doc),
            }

        if name == "chamfer_modify_entity":
            remote = self._bridge_request("POST", "/api/drawing/exec", {"modify": args})
            if remote is not None:
                self.session.replace_document(remote["drawing"])
                return remote
            if "id" not in args:
                raise ProjectError("Entity 'id' is required.")
            changes = {k: v for k, v in args.items() if k != "id"}
            updated = self.session.modify_entity(args["id"], **changes)
            note = getattr(self.session, "last_modify_note", None)
            msg = f"MODIFY · Updated '{updated['id']}'" + (f" ({note})." if note else ".")
            doc = self.session.document
            return {
                "revision": self.session.revision,
                "log": [msg],
                "drawing": doc,
                "lint": lint_drawing(doc),
            }

        if name == "chamfer_lint":
            state = self._current_state()
            return lint_drawing(
                state["drawing"],
                max_gap_mm=float(args.get("max_gap_mm", 2.0)),
                min_clearance_mm=float(args.get("min_clearance_mm", 1.5)),
                min_segment_mm=float(args.get("min_segment_mm", 0.5)),
                manufacturing=bool(args.get("manufacturing", False)),
            )

        if name == "chamfer_export_dxf":
            state = self._current_state()
            lint_report = state["lint"]
            dxf_bytes = drawing_to_dxf(json.dumps(state["drawing"]))
            out_path = args.get("output_path")
            saved_to = None
            if out_path is not None:
                target = _resolve_export_path(
                    out_path, {".dxf"}, overwrite=args.get("overwrite", False)
                )
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(dxf_bytes)
                saved_to = str(target)
            return {
                "bytes": len(dxf_bytes),
                "saved_to": saved_to,
                "lint": lint_report,
                "dxf": None if saved_to else dxf_bytes.decode("utf-8"),
            }

        if name == "chamfer_import_dxf":
            imported = drawing_from_dxf(args.get("dxf", ""))
            doc = imported["drawing"]
            remote = self._bridge_request("POST", "/api/drawing/state", {"drawing": doc})
            if remote is not None:
                self.session.replace_document(remote["drawing"])
                return {"import_report": imported["report"], **remote}
            self.session.replace_document(doc)
            return {
                "revision": self.session.revision,
                "import_report": imported["report"],
                "drawing": doc,
                "lint": lint_drawing(doc),
            }

        if name == "chamfer_cam_report":
            state = self._current_state()
            return compute_cam_metrics(
                state["drawing"], thickness_mm=float(args.get("thickness_mm", 3.0))
            )

        if name == "chamfer_extrude_3d":
            state = self._current_state()
            thickness = float(args.get("thickness_mm", 5.0))
            fmt = str(args.get("format", "step")).lower()
            raw_bytes, telemetry, _mesh = export_extruded_drawing(
                state["drawing"], thickness_mm=thickness, file_format=fmt
            )
            out_path = args.get("output_path")
            saved_to = None
            if out_path is not None:
                allowed_exts = {".step", ".stp"} if fmt == "step" else {".stl"}
                target = _resolve_export_path(
                    out_path, allowed_exts, overwrite=args.get("overwrite", False)
                )
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(raw_bytes)
                saved_to = str(target)
            return {
                "bytes": len(raw_bytes),
                "format": fmt,
                "saved_to": saved_to,
                "telemetry": telemetry,
            }

        raise ValueError(f"Unknown tool: {name}")


def handle_rpc_message(bridge, message):
    """Process one JSON-RPC 2.0 message dict; return response dict or None for notifications."""
    if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
        return {
            "jsonrpc": "2.0",
            "id": message.get("id") if isinstance(message, dict) else None,
            "error": {"code": -32600, "message": "Invalid JSON-RPC 2.0 request."},
        }

    msg_id = message.get("id")
    method = message.get("method")
    if not isinstance(method, str) or not method:
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "error": {"code": -32600, "message": "JSON-RPC 'method' must be a non-empty string."},
        }

    raw_params = message.get("params", {})
    if raw_params is None:
        params = {}
    elif isinstance(raw_params, dict):
        params = raw_params
    else:
        if msg_id is None:
            return None
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "error": {"code": -32602, "message": "JSON-RPC 'params' must be an object."},
        }

    if msg_id is None:
        return None

    if method == "initialize":
        requested = params.get("protocolVersion", SUPPORTED_PROTOCOLS[0])
        version = requested if requested in SUPPORTED_PROTOCOLS else SUPPORTED_PROTOCOLS[0]
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "protocolVersion": version,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "chamfer", "version": __version__},
            },
        }

    if method == "ping":
        return {"jsonrpc": "2.0", "id": msg_id, "result": {}}

    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": msg_id, "result": {"tools": TOOLS}}

    if method == "tools/call":
        tool_name = params.get("name")
        if not isinstance(tool_name, str) or not tool_name:
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "error": {"code": -32602, "message": "Tool 'name' must be a non-empty string."},
            }
        raw_args = params.get("arguments", {})
        if raw_args is None:
            arguments = {}
        elif isinstance(raw_args, dict):
            arguments = raw_args
        else:
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "error": {"code": -32602, "message": "Tool 'arguments' must be an object."},
            }
        try:
            payload = bridge.call_tool(tool_name, arguments)
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "content": [{"type": "text", "text": json.dumps(payload, indent=2)}],
                    "isError": False,
                },
            }
        except ProjectError as exc:
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "content": [{"type": "text", "text": json.dumps({"error": str(exc)})}],
                    "isError": True,
                },
            }
        except (ValueError, TypeError, KeyError) as exc:
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "error": {"code": -32602, "message": str(exc)},
            }

    return {
        "jsonrpc": "2.0",
        "id": msg_id,
        "error": {"code": -32601, "message": f"Method not found: {method}"},
    }


def main():
    parser = argparse.ArgumentParser(description="Chamfer MCP stdio server")
    parser.add_argument(
        "--port",
        type=int,
        default=4310,
        help="Loopback port of a running chamfer-serve instance for live sync (0 disables).",
    )
    args = parser.parse_args()
    bridge = ChamferMCPBridge(port=args.port)

    stdin_buf = sys.stdin.buffer
    while True:
        raw_line = stdin_buf.readline(MAX_RPC_LINE_BYTES + 1)
        if not raw_line:
            break
        if len(raw_line) > MAX_RPC_LINE_BYTES:
            # Drain remainder of oversized line so stream stays aligned
            while raw_line and not raw_line.endswith(b"\n"):
                raw_line = stdin_buf.readline(MAX_RPC_LINE_BYTES)
            resp = {
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32600, "message": "RPC line exceeds 2 MiB limit."},
            }
            sys.stdout.write(json.dumps(resp) + "\n")
            sys.stdout.flush()
            continue
        line = raw_line.decode("utf-8", errors="replace").strip()
        if not line:
            continue
        try:
            check_json_depth(line)
            msg = json.loads(line)
        except (ValueError, RecursionError):
            resp = {
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32700, "message": "Parse error."},
            }
        else:
            resp = handle_rpc_message(bridge, msg)
        if resp is not None:
            sys.stdout.write(json.dumps(resp) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
