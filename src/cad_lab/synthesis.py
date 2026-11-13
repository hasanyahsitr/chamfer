"""Local runtime discovery and closed-loop DRC + spec-verified CAD synthesis."""

import copy
import json
import math
import os
import re
import socket
import urllib.error
import urllib.request

from cad_lab.commands import DrawingSession
from cad_lab.linter import lint_drawing
from cad_lab.project import ProjectError
from cad_lab.topology import analyze_drawing_topology

ISO_CLEARANCE_DIAMETER_MM = {
    3: 3.4,
    4: 4.5,
    5: 5.5,
    6: 6.6,
    8: 9.0,
    10: 11.0,
    12: 13.5,
    14: 15.5,
    16: 17.5,
}

WORD_COUNTS = {
    "one": 1,
    "single": 1,
    "bir": 1,
    "two": 2,
    "pair": 2,
    "iki": 2,
    "three": 3,
    "üç": 3,
    "uc": 3,
    "four": 4,
    "dört": 4,
    "dort": 4,
    "five": 5,
    "beş": 5,
    "bes": 5,
    "six": 6,
    "altı": 6,
    "alti": 6,
    "seven": 7,
    "yedi": 7,
    "eight": 8,
    "sekiz": 8,
    "nine": 9,
    "dokuz": 9,
    "ten": 10,
    "on": 10,
    "twelve": 12,
    "oniki": 12,
}

MODEL_PRIORITY_TOKENS = (
    "coder",
    "qwen",
    "deepseek",
    "codestral",
    "gemma",
    "llama",
    "mistral",
    "phi",
)

SYSTEM_SPEC_PROMPT = """You are a deterministic millimeter 2D CAD command generator for Chamfer.
Output ONLY executable Chamfer command lines—one command per line, no prose, no markdown.
Coordinates are millimeters (X,Y) with '.' decimal point.

Supported commands:
NEW <drawing_name>
LAYER <layer_name> [#rrggbb] [CONSTRUCTION]
RECTANG <x1,y1> <x2,y2> [id=name]
PLINE <x1,y1> <x2,y2> <x3,y3> ... [C] [id=name]
LINE <x1,y1> <x2,y2> [id=name]
CIRCLE <cx,cy> <radius> [id=name]
CIRCLE <cx,cy> D <diameter> [id=name]
ARC <x1,y1> <x2,y2> <x3,y3> [id=name]
ARC C <cx,cy> <radius> <start_deg> <end_deg> [id=name]
OFFSET <entity_id> <distance_mm> <side_x,y> [id=name]
CHAMFER <polyline_id> <d1> [d2]
FILLET <polyline_id> <radius>
TRIM <line_id> <pick_x,y>
ROTATE <base_x,y> <angle_deg>
MIRROR <axis_p1> <axis_p2> [ERASE]
ARRAY POLAR <entity_id> <cx,cy> <count> [fill_deg]
ARRAY RECT <entity_id> <cols> <rows> <dx> <dy>
TEXT <x,y> <height> <content> [id=name]
DIM <x1,y1> <x2,y2> <dim_line_x,y> [id=name]
SELECT <entity_id>
MOVE <base_x,y> <target_x,y>
ERASE <entity_id>

Manufacturing & DRC rules:
1. Outer part profile must be a single closed loop (RECTANG or closed PLINE with C) starting at 0,0.
2. All internal holes and slots must lie strictly inside the outer profile with >= 3.0 mm clearance
   between hole rim and part boundary, and >= 3.0 mm between adjacent holes.
3. ISO metric clearance diameters: M3=3.4, M4=4.5, M5=5.5, M6=6.6, M8=9.0, M10=11.0, M12=13.5 mm.
4. Place dimensions on a separate 'DIMENSIONS #e09b24' layer using DIM, and place non-cutting
   reference lines on a CONSTRUCTION layer.
"""

ALLOWED_VERBS = {
    "NEW",
    "LAYER",
    "RECTANG",
    "REC",
    "PLINE",
    "PL",
    "LINE",
    "L",
    "CIRCLE",
    "C",
    "ARC",
    "A",
    "OFFSET",
    "O",
    "CHAMFER",
    "CHA",
    "FILLET",
    "F",
    "TRIM",
    "TR",
    "ROTATE",
    "RO",
    "MIRROR",
    "MI",
    "ARRAY",
    "AR",
    "TEXT",
    "T",
    "DIM",
    "DLI",
    "DIMLINEAR",
    "SELECT",
    "MOVE",
    "M",
    "COPY",
    "CO",
    "ERASE",
    "E",
}


def _rank_model(name):
    lowered = name.lower()
    for idx, token in enumerate(MODEL_PRIORITY_TOKENS):
        if token in lowered:
            return (idx, name)
    return (len(MODEL_PRIORITY_TOKENS), name)


def _http_json(url, payload=None, timeout_s=0.35, headers=None):
    req_headers = {"Accept": "application/json"}
    if headers:
        req_headers.update(headers)
    data = None
    method = "GET"
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        req_headers["Content-Type"] = "application/json"
        method = "POST"
    req = urllib.request.Request(url, data=data, headers=req_headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _default_probe_targets():
    targets = []
    custom_url = os.environ.get("CHAMFER_RUNTIME_URL", "").strip().rstrip("/")
    custom_kind = os.environ.get("CHAMFER_RUNTIME_KIND", "v1").strip().lower()
    if custom_url:
        targets.append(
            {
                "provider": "custom-local",
                "label": "Custom Runtime",
                "kind": "ollama" if custom_kind == "ollama" else "v1",
                "base_url": custom_url,
            }
        )
    targets.extend(
        [
            {
                "provider": "ollama",
                "label": "Ollama",
                "kind": "ollama",
                "base_url": os.environ.get("CHAMFER_OLLAMA_URL", "http://127.0.0.1:11434").rstrip(
                    "/"
                ),
            },
            {
                "provider": "lmstudio",
                "label": "LM Studio",
                "kind": "v1",
                "base_url": os.environ.get("CHAMFER_LMSTUDIO_URL", "http://127.0.0.1:1234").rstrip(
                    "/"
                ),
            },
            {
                "provider": "llamacpp",
                "label": "llama.cpp",
                "kind": "v1",
                "base_url": os.environ.get("CHAMFER_LLAMACPP_URL", "http://127.0.0.1:8080").rstrip(
                    "/"
                ),
            },
        ]
    )
    return targets


def _port_listening(base_url, timeout_s=0.05):
    try:
        from urllib.parse import urlsplit

        parsed = urlsplit(base_url)
        host = parsed.hostname or "127.0.0.1"
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        with socket.create_connection((host, port), timeout=timeout_s):
            return True
    except OSError:
        return False


def discover_runtimes(timeout_s=0.25, targets=None):
    """Probe local loopback inference servers and return available synthesis runtimes."""
    available = []
    probe_list = targets if targets is not None else _default_probe_targets()

    for item in probe_list:
        base_url = item["base_url"]
        kind = item["kind"]
        if not _port_listening(base_url, timeout_s=min(timeout_s, 0.06)):
            continue
        try:
            if kind == "ollama":
                res = _http_json(f"{base_url}/api/tags", timeout_s=timeout_s)
                models = sorted(
                    [
                        m["name"]
                        for m in res.get("models", [])
                        if isinstance(m, dict) and isinstance(m.get("name"), str)
                    ],
                    key=_rank_model,
                )
            else:
                res = _http_json(f"{base_url}/v1/models", timeout_s=timeout_s)
                models = sorted(
                    [
                        m["id"]
                        for m in res.get("data", [])
                        if isinstance(m, dict) and isinstance(m.get("id"), str)
                    ],
                    key=_rank_model,
                )
            for model_name in models:
                available.append(
                    {
                        "id": f"{item['provider']}:{model_name}",
                        "provider": item["provider"],
                        "label": f"{item['label']} · {model_name}",
                        "kind": kind,
                        "model": model_name,
                        "base_url": base_url,
                        "local": True,
                    }
                )
        except (OSError, ValueError, KeyError, urllib.error.URLError):
            continue

    parametric_entry = {
        "id": "parametric:chamfer-rule-v1",
        "provider": "parametric",
        "label": "Rule Compiler (Offline)",
        "kind": "parametric",
        "model": "chamfer-rule-v1",
        "base_url": "builtin://parametric",
        "local": True,
    }
    available.append(parametric_entry)
    return {
        "active": available[0],
        "available": available,
        "external_detected": len(available) > 1,
    }


def extract_command_lines(raw_text):
    """Extract clean Chamfer command lines from raw runtime output."""
    if not isinstance(raw_text, str):
        return []
    cleaned = []
    in_fence = False
    for raw_line in raw_text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("```"):
            in_fence = not in_fence
            continue
        if line.startswith(("#", "//", ";")):
            continue
        line = re.sub(r"^(?:[-*]\s+|\d+[.)]\s+|>\s+)", "", line).strip()
        if not line:
            continue
        first_token = line.split()[0].upper()
        if first_token in ALLOWED_VERBS:
            cleaned.append(line)
        elif in_fence:
            cleaned.append(line)
    return cleaned


def _call_external_runtime(runtime, messages, timeout_s=30.0):
    base_url = runtime["base_url"]
    model = runtime["model"]
    if runtime["kind"] == "ollama":
        payload = {
            "model": model,
            "messages": messages,
            "stream": False,
            "options": {"temperature": 0.1},
        }
        res = _http_json(f"{base_url}/api/chat", payload=payload, timeout_s=timeout_s)
        msg = res.get("message", {})
        return msg.get("content", "")

    payload = {
        "model": model,
        "messages": messages,
        "temperature": 0.1,
        "stream": False,
    }
    res = _http_json(f"{base_url}/v1/chat/completions", payload=payload, timeout_s=timeout_s)
    choices = res.get("choices", [])
    if not choices:
        raise ProjectError("Local runtime returned no completion choices.")
    return choices[0].get("message", {}).get("content", "")


def _format_drc_feedback(lint_report, exec_error=None, spec_errors=None):
    lines = []
    if exec_error:
        lines.append(f"COMMAND EXECUTION ERROR: {exec_error}")
    for spec_err in spec_errors or []:
        lines.append(f"SPECIFICATION MISMATCH: {spec_err}")
    for issue in lint_report.get("issues", []):
        if issue["severity"] == "error":
            loc = issue.get("point") or issue.get("location")
            loc_str = f" at ({loc[0]:.3f}, {loc[1]:.3f}) mm" if loc else ""
            lines.append(
                f"- [{issue['code']}]{loc_str}: {issue['message']} Hint: {issue['fix_hint']}"
            )
    lines.append(
        "Re-emit the complete corrected Chamfer command script starting with NEW so all "
        "specification and DRC errors above are resolved."
    )
    return "\n".join(lines)


_UFLOAT = r"[0-9]{1,12}(?:\.[0-9]{1,16})?"
_SEP = r" ?[:=]? ?"


def _normalize_number_words(lowered_text):
    collapsed = " ".join(lowered_text.split())
    word_pat = "|".join(sorted(WORD_COUNTS, key=len, reverse=True))
    return re.sub(
        rf"\b({word_pat})\b(?= (?:x ?|adet ?)?"
        r"(?:m[0-9]{1,2}\b|corner\b|bolt\b|mounting\b|delik|hole|holes))",
        lambda m: str(WORD_COUNTS[m.group(1)]),
        collapsed,
    )


def _parse_parametric_spec(spec_text):
    """Parse common TR/EN mechanical & architectural specs into structured parameters."""
    text = spec_text.strip()
    lowered = _normalize_number_words(text.lower())

    dims = re.findall(
        rf"(?<![0-9.])({_UFLOAT}) ?[x×*] ?({_UFLOAT}) ?(?:(mm|cm|m)\b)?",
        lowered,
    )
    scale_map = {"": 1.0, "mm": 1.0, "cm": 10.0, "m": 1000.0}
    explicit_dims = False
    if dims:
        w_raw, h_raw, unit = dims[0]
        factor = scale_map.get(unit, 1.0)
        width = round(float(w_raw) * factor, 4)
        height = round(float(h_raw) * factor, 4)
        explicit_dims = True
    else:
        w_match = re.search(rf"(?:en|genişlik|width|w){_SEP}({_UFLOAT})", lowered)
        h_match = re.search(rf"(?:boy|yükseklik|height|h){_SEP}({_UFLOAT})", lowered)
        width = float(w_match.group(1)) if w_match else 120.0
        height = float(h_match.group(1)) if h_match else 80.0
        explicit_dims = bool(w_match or h_match)

    if width < 10 or height < 10:
        raise ProjectError("Parametric dimensions must be at least 10 x 10 mm.")

    unsupported_hits = re.findall(
        r"\b(threads?|tapped|kılavuz|kilavuz|countersink|countersunk|havşa|havsa|"
        r"counterbore|pocket|pockets|blind ?hole|kör ?delik|gears?|dişli|disli|"
        r"splines?|bends?|büküm|bukum)\b",
        lowered,
    )
    unsupported_features = sorted({h.strip() for h in unsupported_hits})

    is_flange = any(
        tok in lowered
        for tok in (
            "circular flange",
            "pipe flange",
            "yuvarlak flanş",
            "yuvarlak flans",
            "boru flanş",
        )
    ) or ("pcd" in lowered and re.search(rf"\bod{_SEP}[0-9]", lowered))
    if is_flange:
        od_m = re.search(rf"(?:\bod|dış ?çap|dis ?cap){_SEP}({_UFLOAT})", lowered)
        id_m = re.search(rf"(?:\bid|iç ?çap|ic ?cap|bore){_SEP}({_UFLOAT})", lowered)
        pcd_m = re.search(rf"\bpcd{_SEP}({_UFLOAT})", lowered)
        od_mm = float(od_m.group(1)) if od_m else 150.0
        id_mm = float(id_m.group(1)) if id_m else round(od_mm * 0.34, 2)
        pcd_mm = float(pcd_m.group(1)) if pcd_m else round((od_mm + id_mm) * 0.5, 2)
        metric_m = re.search(
            r"(?:(?<![0-9])([0-9]{1,4}) ?(?:x|×|adet|\*)? ?|\b)m(3|4|5|6|8|10|12|14|16)\b",
            lowered,
        )
        if metric_m:
            h_cnt = int(metric_m.group(1) or 4)
            m_sz = int(metric_m.group(2))
            h_dia = ISO_CLEARANCE_DIAMETER_MM.get(m_sz, float(m_sz) + 0.6)
            exp_holes = metric_m.group(1) is not None
            exp_hdia = True
        else:
            h_cnt = 4
            h_dia = 9.0
            exp_holes = False
            exp_hdia = False
        return {
            "kind": "circular_flange",
            "width": od_mm,
            "height": od_mm,
            "od_mm": od_mm,
            "id_mm": id_mm,
            "pcd_mm": pcd_mm,
            "explicit_pcd": bool(pcd_m),
            "explicit_id": bool(id_m),
            "explicit_dims": bool(od_m),
            "hole_count": h_cnt,
            "explicit_holes": exp_holes,
            "hole_dia": h_dia,
            "explicit_hole_dia": exp_hdia,
            "center_bore": id_mm if id_mm > 0 else None,
            "slot": None,
            "flange_mm": None,
            "unsupported_features": unsupported_features,
            "add_dims": not any(tok in lowered for tok in ("ölçüsüz", "no dim")),
        }

    is_room = any(tok in lowered for tok in ("oda", "ofis", "room", "kat plan", "floor", "duvar"))
    if is_room:
        wall_match = re.search(
            rf"(?:duvar|wall|et|kalınlık){_SEP}({_UFLOAT})",
            lowered,
        )
        wall_mm = float(wall_match.group(1)) if wall_match else 200.0
        door_match = re.search(rf"(?:kapı|kapi|door){_SEP}({_UFLOAT})", lowered)
        door_mm = float(door_match.group(1)) if door_match else min(900.0, width * 0.25)
        return {
            "kind": "room",
            "width": width,
            "height": height,
            "explicit_dims": explicit_dims,
            "wall_mm": wall_mm,
            "door_mm": door_mm,
            "add_dims": not any(tok in lowered for tok in ("ölçüsüz", "no dim")),
        }

    # Bolt pattern detection (e.g., "3xM6", "5xM6", "8xM6", "4 adet M8", "4 holes d=6.5")
    metric_match = re.search(
        r"(?:(?<![0-9])([0-9]{1,4}) ?(?:x|×|adet|\*)? ?|\b)m(3|4|5|6|8|10|12|14|16)\b",
        lowered,
    )
    hole_count = 0
    hole_dia = 0.0
    explicit_holes = False
    explicit_hole_dia = False
    if metric_match:
        hole_count = int(metric_match.group(1) or 4)
        explicit_holes = metric_match.group(1) is not None
        m_size = int(metric_match.group(2))
        hole_dia = ISO_CLEARANCE_DIAMETER_MM.get(m_size, float(m_size) + 0.6)
        explicit_hole_dia = True
    else:
        generic_holes = re.search(
            r"(?<![0-9])([0-9]{1,4}) ?(?:adet )?(?:(?:corner|bolt|mounting) )?"
            r"(?:delik|hole|holes)"
            rf"(?: ?(?:çap|cap|d|ø){_SEP}({_UFLOAT}))?",
            lowered,
        )
        if generic_holes:
            hole_count = int(generic_holes.group(1))
            explicit_holes = True
            if generic_holes.group(2):
                hole_dia = float(generic_holes.group(2))
                explicit_hole_dia = True
            else:
                hole_dia = 6.6

    if hole_count > 64:
        raise ProjectError("Parametric bolt count exceeds 64 holes.")

    inset_match = re.search(
        rf"(?:kenardan|kenar|pay|inset|margin|offset ?in){_SEP}({_UFLOAT})"
        rf"|(?:kenardan|inset|margin) ({_UFLOAT}) ?(?:mm)? ?(?:pay)?",
        lowered,
    )
    if inset_match:
        inset_mm = float(inset_match.group(1) or inset_match.group(2))
        explicit_inset = True
    else:
        inset_mm = max(10.0, round(hole_dia * 1.6, 2)) if hole_count else 12.0
        explicit_inset = False

    # Slot detection
    slot = None
    slot_match = re.search(
        rf"(?:(?<![0-9.])({_UFLOAT}) ?[x×*] ?({_UFLOAT}) ?(?:mm ?)?(?:kanal|slot|yuva)|"
        rf"(?:kanal|slot|yuva){_SEP}({_UFLOAT}) ?[x×*] ?({_UFLOAT}))",
        lowered,
    )
    if slot_match:
        sw = float(slot_match.group(1) or slot_match.group(3))
        sh = float(slot_match.group(2) or slot_match.group(4))
        slot = (sw, sh)
    elif any(tok in lowered for tok in ("kanal", "slot", "obround", "yuva")):
        slot = (round(width * 0.35, 2), round(min(height * 0.24, 16.0), 2))

    # Center bore detection
    center_bore = None
    explicit_bore_dia = False
    bore_match = re.search(
        rf"(?:merkez|orta|center|bore)[^0-9]{{0,18}}({_UFLOAT})",
        lowered,
    )
    if bore_match and slot is None:
        center_bore = float(bore_match.group(1))
        explicit_bore_dia = True
    elif (
        any(tok in lowered for tok in ("center bore", "merkez delik", "pilot bore"))
        and slot is None
    ):
        center_bore = round(min(width, height) * 0.32, 2)

    # Flange / outer offset detection
    flange_mm = None
    flange_after = re.search(
        rf"(?:flanş|flans|flange|dış ?ofset|outward ?offset){_SEP}({_UFLOAT})",
        lowered,
    )
    flange_before = re.search(
        rf"(?<![a-z0-9.])({_UFLOAT}) ?(?:mm ?)?(?:flanş|flans|flange)\b(?!{_SEP}[0-9])",
        lowered,
    )
    if flange_after:
        flange_mm = float(flange_after.group(1))
    elif flange_before:
        flange_mm = float(flange_before.group(1))

    chamfer_mm = None
    chamfer_after = re.search(rf"(?:pah|chamfer){_SEP}({_UFLOAT})", lowered)
    chamfer_before = re.search(
        rf"(?<![a-z0-9.])({_UFLOAT}) ?(?:mm ?)?(?:pah|pahlı|chamfer)\b(?!{_SEP}[0-9])",
        lowered,
    )
    if chamfer_after:
        chamfer_mm = float(chamfer_after.group(1))
    elif chamfer_before:
        chamfer_mm = float(chamfer_before.group(1))

    fillet_mm = None
    fillet_after = re.search(rf"(?:radyüs|radyus|fillet){_SEP}({_UFLOAT})", lowered)
    fillet_before = re.search(
        rf"(?<![a-z0-9.])({_UFLOAT}) ?(?:mm ?)?"
        rf"(?:köşe ?radyüs|radyüs|radyus|fillet)\b(?!{_SEP}[0-9])",
        lowered,
    )
    if chamfer_mm is None:
        if fillet_after:
            fillet_mm = float(fillet_after.group(1))
        elif fillet_before:
            fillet_mm = float(fillet_before.group(1))

    add_dims = not any(tok in lowered for tok in ("ölçüsüz", "no dim"))
    return {
        "kind": "plate",
        "width": width,
        "height": height,
        "explicit_dims": explicit_dims,
        "hole_count": hole_count,
        "explicit_holes": explicit_holes,
        "hole_dia": hole_dia,
        "explicit_hole_dia": explicit_hole_dia,
        "inset_mm": inset_mm,
        "explicit_inset": explicit_inset,
        "slot": slot,
        "center_bore": center_bore,
        "explicit_bore_dia": explicit_bore_dia,
        "flange_mm": flange_mm,
        "chamfer_mm": chamfer_mm,
        "fillet_mm": fillet_mm,
        "unsupported_features": unsupported_features,
        "add_dims": add_dims,
    }


def _bolt_coordinates(w, h, count, inset, avoid_center=False):
    """Generate exact perimeter/pattern coordinates for any integer hole count >= 1."""
    if count <= 0:
        return []
    x_l, x_r = round(inset, 4), round(w - inset, 4)
    y_b, y_t = round(inset, 4), round(h - inset, 4)
    if x_r <= x_l or y_t <= y_b:
        raise ProjectError("Plate dimensions cannot fit requested hole inset.")

    if count == 1:
        if avoid_center:
            return [(x_l, round(h / 2.0, 4))]
        return [(round(w / 2.0, 4), round(h / 2.0, 4))]
    if count == 2:
        mid_y = round(h / 2.0, 4)
        return [(x_l, mid_y), (x_r, mid_y)]
    if count == 3:
        return [(x_l, y_b), (x_r, y_b), (round(w / 2.0, 4), y_t)]
    if count == 4:
        return [(x_l, y_b), (x_r, y_b), (x_r, y_t), (x_l, y_t)]

    # For count >= 5, distribute across the two longer opposite rails
    top_n = (count + 1) // 2
    bot_n = count - top_n
    pts = []
    if w >= h:
        for i in range(bot_n):
            t = i / (bot_n - 1) if bot_n > 1 else 0.5
            pts.append((round(x_l + t * (x_r - x_l), 4), y_b))
        for i in range(top_n):
            t = i / (top_n - 1) if top_n > 1 else 0.5
            pts.append((round(x_l + t * (x_r - x_l), 4), y_t))
    else:
        for i in range(bot_n):
            t = i / (bot_n - 1) if bot_n > 1 else 0.5
            pts.append((x_l, round(y_b + t * (y_t - y_b), 4)))
        for i in range(top_n):
            t = i / (top_n - 1) if top_n > 1 else 0.5
            pts.append((x_r, round(y_b + t * (y_t - y_b), 4)))
    return pts


def _build_parametric_commands(params):
    w = params["width"]
    h = params["height"]
    if params["kind"] == "circular_flange":
        od_r = round(params["od_mm"] / 2.0, 4)
        id_r = round(params["id_mm"] / 2.0, 4)
        pcd_r = round(params["pcd_mm"] / 2.0, 4)
        bolt_r = round(params["hole_dia"] / 2.0, 4)
        cnt = params["hole_count"]
        cmds = [
            f"NEW FLANGE-OD{int(params['od_mm'])}",
            "LAYER 0-PROFILE #dce2ea",
            f"CIRCLE 0,0 {od_r} id=flange-od",
        ]
        if id_r > 0:
            cmds.extend(
                [
                    "LAYER BORE-CUT #5aa9e6",
                    f"CIRCLE 0,0 {id_r} id=center-bore",
                ]
            )
        if cnt >= 1 and bolt_r > 0:
            cmds.extend(
                [
                    "LAYER BOLTS #5aa9e6",
                    f"CIRCLE {pcd_r},0 {bolt_r} id=bolt-1",
                ]
            )
            if cnt >= 2:
                cmds.append(f"ARRAY POLAR bolt-1 0,0 {cnt}")
        if params["add_dims"]:
            cmds.extend(
                [
                    "LAYER DIMENSIONS #e09b24",
                    f"DIM {-od_r},0 {od_r},0 0,{round(-od_r - 14.0, 2)} id=dim-od",
                ]
            )
        return cmds

    if params["kind"] == "room":
        wall = params["wall_mm"]
        door = params["door_mm"]
        door_x0 = round(max(wall + 200.0, w * 0.2), 3)
        door_x1 = round(min(w - wall - 200.0, door_x0 + door), 3)
        actual_door = round(door_x1 - door_x0, 3)
        cmds = [
            f"NEW ROOM-{int(w)}X{int(h)}",
            "LAYER 0-WALLS #dce2ea",
            f"RECTANG 0,0 {w},{h} id=outer-wall",
            f"OFFSET outer-wall {wall} {round(w / 2, 2)},{round(h / 2, 2)} id=inner-wall",
            "LAYER DOOR-SWING #5aa9e6 CONSTRUCTION",
            f"LINE {door_x0},{wall} {door_x0},{round(wall + actual_door, 3)} id=door-leaf",
            f"ARC C {door_x0},{wall} {actual_door} 0 90 id=door-arc",
        ]
        if params["add_dims"]:
            cmds.extend(
                [
                    "LAYER DIMENSIONS #e09b24",
                    f"DIM 0,0 {w},0 {round(w / 2, 2)},{round(-h * 0.09, 2)} id=dim-w",
                    f"DIM {w},0 {w},{h} {round(w + w * 0.09, 2)},{round(h / 2, 2)} id=dim-h",
                ]
            )
        return cmds

    cmds = [f"NEW PART-{int(w)}X{int(h)}"]
    flange = params["flange_mm"]
    if flange and flange > 0:
        cmds.append("LAYER SEAT-REF #6c7a89 CONSTRUCTION")
        cmds.append(f"RECTANG 0,0 {w},{h} id=inner-seat")
        cmds.append("LAYER 0-PROFILE #dce2ea")
        cmds.append(f"OFFSET inner-seat {flange} {-flange},{-flange} id=outer")
    else:
        cmds.append("LAYER 0-PROFILE #dce2ea")
        cmds.append(f"RECTANG 0,0 {w},{h} id=outer")

    if params.get("chamfer_mm") and params["chamfer_mm"] > 0:
        cmds.append(f"CHAMFER outer {params['chamfer_mm']}")
    elif params.get("fillet_mm") and params["fillet_mm"] > 0:
        cmds.append(f"FILLET outer {params['fillet_mm']}")

    hole_count = params["hole_count"]
    hole_dia = params["hole_dia"]
    inset = params["inset_mm"]
    rad = round(hole_dia / 2.0, 4)

    if hole_count >= 1 and rad > 0:
        avoid_center = bool(params["slot"] or params["center_bore"])
        bolt_pts = _bolt_coordinates(w, h, hole_count, inset, avoid_center=avoid_center)
        for idx, (bx, by) in enumerate(bolt_pts, start=1):
            cmds.append(f"CIRCLE {bx},{by} {rad} id=bolt-{idx}")

    if params["slot"]:
        sw, sh = params["slot"]
        sr = round(sh / 2.0, 4)
        straight = max(round(sw - sh, 4), 4.0)
        cx, cy = round(w / 2.0, 4), round(h / 2.0, 4)
        lx = round(cx - straight / 2.0, 4)
        rx = round(cx + straight / 2.0, 4)
        cmds.extend(
            [
                "LAYER SLOT-CUT #5aa9e6",
                f"LINE {lx},{round(cy + sr, 4)} {rx},{round(cy + sr, 4)} id=slot-top",
                f"LINE {lx},{round(cy - sr, 4)} {rx},{round(cy - sr, 4)} id=slot-bot",
                f"ARC C {lx},{cy} {sr} 90 270 id=slot-arc-l",
                f"ARC C {rx},{cy} {sr} 270 90 id=slot-arc-r",
            ]
        )
    elif params["center_bore"]:
        cr = round(params["center_bore"] / 2.0, 4)
        cmds.extend(
            [
                "LAYER BORE-CUT #5aa9e6",
                f"CIRCLE {round(w / 2.0, 4)},{round(h / 2.0, 4)} {cr} id=center-bore",
            ]
        )

    if params["add_dims"]:
        dim_off_y = round(-max(10.0, h * 0.16), 2)
        dim_off_x = round(w + max(12.0, w * 0.12), 2)
        cmds.append("LAYER DIMENSIONS #e09b24")
        cmds.append(f"DIM 0,0 {w},0 {round(w / 2.0, 2)},{dim_off_y} id=dim-width")
        cmds.append(f"DIM {w},0 {w},{h} {dim_off_x},{round(h / 2.0, 2)} id=dim-height")
        if hole_count >= 4 and rad > 0:
            x_l, x_r = round(inset, 4), round(w - inset, 4)
            y_t = round(h - inset, 4)
            top_dim_y = round(h + max(10.0, h * 0.15) + (flange or 0.0), 2)
            cmds.append(
                f"DIM {x_l},{y_t} {x_r},{y_t} {round(w / 2.0, 2)},{top_dim_y} id=dim-pitch-x"
            )
        if flange and flange > 0:
            fx0, fx1 = round(-flange, 4), round(w + flange, 4)
            fy = round(-flange, 4)
            outer_dim_y = round(dim_off_y - flange - 9.0, 2)
            cmds.append(f"DIM {fx0},{fy} {fx1},{fy} {round(w / 2.0, 2)},{outer_dim_y} id=dim-outer")

    return cmds


def _repair_parametric_params(params, lint_report):
    updated = copy.deepcopy(params)
    codes = {i["code"] for i in lint_report.get("issues", []) if i["severity"] == "error"}
    if not codes or updated["kind"] != "plate":
        return updated, None

    rad = updated["hole_dia"] / 2.0
    flange = updated.get("flange_mm") or 0.0
    min_safe_inset = round(max(0.0, rad + 3.5 - flange), 3)
    notes = []
    if updated["hole_count"] > 0 and updated["inset_mm"] < min_safe_inset:
        old_inset = updated["inset_mm"]
        updated["inset_mm"] = min_safe_inset
        notes.append(f"Adjusted bolt edge inset {old_inset} -> {min_safe_inset} mm for DRC safety")

    return updated, "; ".join(notes) if notes else None


def _is_valid_obround_slot_loop(loop, req_len, req_w):
    """Verify loop is a true 2-line + 2-semicircle obround capsule of span req_len x req_w."""
    bx0, by0, bx1, by1 = loop["bbox"]
    span_a = bx1 - bx0
    span_b = by1 - by0
    actual_len = max(span_a, span_b)
    actual_w = min(span_a, span_b)
    if not (
        math.isclose(actual_len, req_len, abs_tol=0.25)
        and math.isclose(actual_w, req_w, abs_tol=0.25)
    ):
        return False
    edges = loop.get("edges", [])
    arc_edges = [e for e in edges if e["kind"] == "arc"]
    line_edges = [e for e in edges if e["kind"] == "line"]
    if len(edges) != 4 or len(arc_edges) != 2 or len(line_edges) != 2:
        return False
    exp_r = req_w * 0.5
    exp_straight = req_len - req_w
    for ae in arc_edges:
        ent = ae["entity"]
        sweep = (float(ent["end_angle"]) - float(ent["start_angle"])) % 360.0
        if not math.isclose(float(ent["radius"]), exp_r, abs_tol=0.2):
            return False
        if not math.isclose(sweep, 180.0, abs_tol=2.0):
            return False
    for le in line_edges:
        if not math.isclose(math.dist(le["start"], le["end"]), exp_straight, abs_tol=0.25):
            return False
    return True


def verify_synthesized_spec(document, spec_text, parsed_params=None):
    """Independently verify that a candidate drawing satisfies typed specification features."""
    errors = []
    entities = document.get("entities", [])
    if not entities:
        return ["Drawing contains zero entities; requested geometry was not generated."]

    try:
        params = parsed_params if parsed_params is not None else _parse_parametric_spec(spec_text)
    except ProjectError:
        params = None

    if params and params.get("unsupported_features"):
        feats = ", ".join(params["unsupported_features"])
        errors.append(
            f"Requested feature(s) [{feats}] are outside 2D planar through-cut specification scope."
        )

    topo = analyze_drawing_topology(document)
    if params and params["kind"] == "room":
        if len(topo["loops"]) < 1:
            errors.append("Room layout lacks closed wall contours.")
        return errors

    # Single-part mechanical verification
    if not topo["outer_loops"]:
        errors.append("No closed outer cutting profile found in synthesized drawing.")
        return errors
    if len(topo["outer_loops"]) > 1:
        errors.append(
            f"Expected 1 outer part profile, found {len(topo['outer_loops'])} disjoint profiles."
        )
    if topo["branched_components"]:
        errors.append("Synthesized drawing has ambiguous or self-intersecting contour junctions.")
    if topo["open_components"]:
        errors.append("Synthesized drawing has unclosed cutting geometry.")
    if topo["crossing_loops"]:
        errors.append("Synthesized drawing has intersecting or touching closed contours.")
    if topo["island_loops"]:
        errors.append("Synthesized drawing has unsupported nested islands inside cutouts.")

    if params is None:
        return errors

    outer_loop = topo["outer_loops"][0]
    outer_bbox = outer_loop["bbox"]
    actual_w = outer_bbox[2] - outer_bbox[0]
    actual_h = outer_bbox[3] - outer_bbox[1]
    circle_holes = [lp for lp in topo["hole_loops"] if lp["source"] == "circle"]
    non_circle_holes = [lp for lp in topo["hole_loops"] if lp["source"] != "circle"]

    if params["kind"] == "circular_flange":
        if outer_loop["source"] != "circle" or not math.isclose(
            outer_loop["radius"] * 2.0, params["od_mm"], abs_tol=0.3
        ):
            errors.append(
                f"Circular flange outer profile must be a circle of OD {params['od_mm']:.2f} mm."
            )
            return errors
        fc = outer_loop["center"]
        id_mm = params.get("id_mm") or 0.0
        bore_holes = [lp for lp in circle_holes if math.dist(lp["center"], fc) <= 0.3]
        bolt_holes = [lp for lp in circle_holes if math.dist(lp["center"], fc) > 0.3]
        if id_mm > 0:
            if len(bore_holes) != 1 or not math.isclose(
                bore_holes[0]["radius"] * 2.0, id_mm, abs_tol=0.3
            ):
                errors.append(f"Circular flange requires a concentric bore of ID {id_mm:.2f} mm.")
        if len(bolt_holes) != params["hole_count"]:
            errors.append(
                f"Expected {params['hole_count']} flange bolt hole(s), found {len(bolt_holes)}."
            )
        else:
            exp_pcd_r = params["pcd_mm"] * 0.5
            for bh in bolt_holes:
                if not math.isclose(bh["radius"] * 2.0, params["hole_dia"], abs_tol=0.35):
                    errors.append(
                        f"Flange bolt hole diameter {bh['radius'] * 2.0:.2f} mm does not match "
                        f"requested {params['hole_dia']:.2f} mm."
                    )
                    break
                r_dist = math.dist(bh["center"], fc)
                if not math.isclose(r_dist, exp_pcd_r, abs_tol=0.25):
                    errors.append(
                        f"Flange bolt radial center {r_dist * 2.0:.2f} mm PCD does not match "
                        f"requested PCD {params['pcd_mm']:.2f} mm."
                    )
                    break
            if len(bolt_holes) >= 2 and not errors:
                angs = sorted(
                    math.degrees(math.atan2(bh["center"][1] - fc[1], bh["center"][0] - fc[0]))
                    % 360.0
                    for bh in bolt_holes
                )
                exp_step = 360.0 / len(bolt_holes)
                for k in range(len(angs)):
                    step = (angs[(k + 1) % len(angs)] - angs[k]) % 360.0
                    if not math.isclose(step, exp_step, abs_tol=1.5):
                        errors.append(
                            f"Flange bolt angular spacing {step:.1f}° deviates from uniform "
                            f"{exp_step:.1f}° polar pattern."
                        )
                        break
        return errors

    flange = params.get("flange_mm") or 0.0
    expected_w = params["width"] + 2.0 * flange
    expected_h = params["height"] + 2.0 * flange

    if params.get("explicit_dims"):
        direct_ok = math.isclose(actual_w, expected_w, abs_tol=0.6) and math.isclose(
            actual_h, expected_h, abs_tol=0.6
        )
        rotated_ok = math.isclose(actual_w, expected_h, abs_tol=0.6) and math.isclose(
            actual_h, expected_w, abs_tol=0.6
        )
        if not (direct_ok or rotated_ok):
            errors.append(
                f"Outer envelope {actual_w:.2f}x{actual_h:.2f} mm does not match "
                f"requested {expected_w:.2f}x{expected_h:.2f} mm."
            )

    if params.get("chamfer_mm"):
        ch_d = params["chamfer_mm"]
        exp_bevel = math.sqrt(2.0) * ch_d
        bevel_edges = [
            e
            for e in outer_loop["edges"]
            if e["kind"] == "line"
            and math.isclose(math.dist(e["start"], e["end"]), exp_bevel, abs_tol=0.4)
        ]
        if len(outer_loop["edges"]) < 8 or len(bevel_edges) < 4:
            errors.append(f"Outer profile lacks requested {ch_d:.2f} mm corner chamfers.")

    if params.get("fillet_mm"):
        fl_r = params["fillet_mm"]
        fillet_arcs = [
            e
            for e in outer_loop["edges"]
            if e["kind"] == "arc" and math.isclose(float(e["entity"]["radius"]), fl_r, abs_tol=0.25)
        ]
        if len(fillet_arcs) < 4:
            errors.append(f"Outer profile lacks requested R{fl_r:.2f} mm corner fillets.")

    if params.get("slot") is not None:
        req_len = max(params["slot"])
        req_w = min(params["slot"])
        if abs(req_len - req_w) <= 0.05:
            has_circle_slot = any(
                math.isclose(lp["radius"] * 2.0, req_w, abs_tol=0.25) for lp in circle_holes
            )
            if not has_circle_slot:
                errors.append(f"Requested {req_len:.2f}x{req_w:.2f} mm slot is missing.")
        else:
            matching_slots = [
                lp for lp in non_circle_holes if _is_valid_obround_slot_loop(lp, req_len, req_w)
            ]
            if not matching_slots:
                errors.append(
                    f"Requested {req_len:.2f}x{req_w:.2f} mm obround slot capsule "
                    "(2 parallel lines + 2 semicircular arcs) is missing or has wrong geometry."
                )

    plate_cx = 0.5 * (outer_bbox[0] + outer_bbox[2])
    plate_cy = 0.5 * (outer_bbox[1] + outer_bbox[3])
    if params.get("center_bore"):
        bore_d = params["center_bore"]
        bore_matches = [
            lp
            for lp in circle_holes
            if math.dist(lp["center"], (plate_cx, plate_cy)) <= 1.0
            and math.isclose(lp["radius"] * 2.0, bore_d, abs_tol=0.35)
        ]
        if not bore_matches:
            errors.append(
                f"Requested centered bore of diameter {bore_d:.2f} mm is missing or off-center."
            )

    expected_total_circles = params["hole_count"] + (1 if params.get("center_bore") else 0)
    if params.get("explicit_holes") or params.get("center_bore"):
        if len(circle_holes) != expected_total_circles:
            errors.append(
                f"Expected {expected_total_circles} circular hole(s), found {len(circle_holes)}."
            )
        elif (
            params.get("explicit_holes")
            and params.get("explicit_hole_dia")
            and params["hole_count"] > 0
        ):
            matching_dia = [
                lp
                for lp in circle_holes
                if math.isclose(lp["radius"] * 2.0, params["hole_dia"], abs_tol=0.35)
            ]
            if len(matching_dia) < params["hole_count"]:
                errors.append(
                    f"Expected {params['hole_count']} hole(s) of diameter "
                    f"{params['hole_dia']:.2f} mm, found {len(matching_dia)}."
                )

    return errors


def synthesize_drawing(
    session,
    spec_text,
    runtime_id=None,
    max_repairs=3,
    targets=None,
    timeout_s=30.0,
):
    """Synthesize a verified 2D drawing from a specification with transactional DRC + spec gate."""
    if not isinstance(spec_text, str) or not spec_text.strip():
        raise ProjectError("Enter a non-empty specification after '?'.")
    if len(spec_text) > 2000:
        raise ProjectError("Specification exceeds 2000 characters.")

    discovery = discover_runtimes(targets=targets)
    selected = discovery["active"]
    if runtime_id and runtime_id != "auto":
        match = next(
            (
                r
                for r in discovery["available"]
                if r["id"] == runtime_id or r["provider"] == runtime_id
            ),
            None,
        )
        if match is None:
            raise ProjectError(f"Requested runtime '{runtime_id}' is not available.")
        selected = match

    max_passes = max(1, min(int(max_repairs) + 1, 5))
    passes = []

    if selected["kind"] == "parametric":
        params = _parse_parametric_spec(spec_text)
        best_candidate = None
        spec_adjustments = []
        for pass_idx in range(1, max_passes + 1):
            cmds = _build_parametric_commands(params)
            sandbox = DrawingSession(session.document)
            logs = sandbox.execute_batch(cmds)
            is_plate = params["kind"] == "plate"
            report = lint_drawing(sandbox.document, manufacturing=is_plate)
            spec_errs = verify_synthesized_spec(sandbox.document, spec_text, parsed_params=params)
            drc_err_count = report["summary"]["errors"]
            total_errs = drc_err_count + len(spec_errs)
            issue_codes = [i["code"] for i in report["issues"] if i["severity"] == "error"]
            if spec_errs:
                issue_codes.extend(["SPEC_MISMATCH"] * len(spec_errs))

            passes.append(
                {
                    "pass": pass_idx,
                    "commands": cmds,
                    "errors": total_errs,
                    "drc_errors": drc_err_count,
                    "spec_errors": spec_errs,
                    "issues": issue_codes,
                }
            )
            if best_candidate is None or total_errs < best_candidate["total_errs"]:
                best_candidate = {
                    "total_errs": total_errs,
                    "doc": sandbox.document,
                    "lint": report,
                    "spec_errors": spec_errs,
                    "cmds": cmds,
                    "logs": logs,
                }
            if total_errs == 0:
                break
            params, note = _repair_parametric_params(params, report)
            if not note:
                break
            passes[-1]["repair_note"] = note
            spec_adjustments.append(note)

        if best_candidate is None or best_candidate["total_errs"] > 0:
            reasons = []
            if best_candidate:
                reasons.extend(best_candidate["spec_errors"])
                reasons.extend(
                    i["message"]
                    for i in best_candidate["lint"]["issues"]
                    if i["severity"] == "error"
                )
            detail = "; ".join(reasons[:3]) or "Verification failed."
            raise ProjectError(f"Synthesis rejected without modifying active drawing: {detail}")

        session.replace_document(best_candidate["doc"])
        return {
            "runtime": selected,
            "passes": passes,
            "spec_adjustments": spec_adjustments,
            "commands": best_candidate["cmds"],
            "log": best_candidate["logs"],
            "revision": session.revision,
            "drawing": session.document,
            "lint": best_candidate["lint"],
        }

    # External local inference server (Ollama / LM Studio / llama.cpp / custom v1)
    try:
        parsed_hint = _parse_parametric_spec(spec_text)
    except ProjectError:
        parsed_hint = None

    entity_count = len(session.document.get("entities", []))
    context_note = f"Current workspace has {entity_count} entities."
    messages = [
        {"role": "system", "content": SYSTEM_SPEC_PROMPT},
        {"role": "user", "content": f"{context_note}\nSpecification: {spec_text.strip()}"},
    ]

    best_candidate = None

    for pass_idx in range(1, max_passes + 1):
        raw_reply = _call_external_runtime(selected, messages, timeout_s=timeout_s)
        cmds = extract_command_lines(raw_reply)
        if not cmds:
            exec_err = "No valid Chamfer CAD commands found in runtime output."
            empty_report = {"summary": {"errors": 1, "warnings": 0}, "issues": []}
            passes.append(
                {
                    "pass": pass_idx,
                    "commands": [],
                    "errors": 1,
                    "drc_errors": 0,
                    "spec_errors": [exec_err],
                    "issues": ["EMPTY_SCRIPT"],
                    "repair_note": exec_err,
                }
            )
            messages.append({"role": "assistant", "content": raw_reply})
            messages.append(
                {
                    "role": "user",
                    "content": _format_drc_feedback(empty_report, exec_error=exec_err),
                }
            )
            continue

        sandbox = DrawingSession(session.document)
        try:
            logs = sandbox.execute_batch(cmds)
            exec_err = None
        except ProjectError as exc:
            logs = []
            exec_err = str(exc)

        if exec_err is not None:
            err_report = {"summary": {"errors": 1, "warnings": 0}, "issues": []}
            passes.append(
                {
                    "pass": pass_idx,
                    "commands": cmds,
                    "errors": 1,
                    "drc_errors": 0,
                    "spec_errors": [exec_err],
                    "issues": ["COMMAND_SYNTAX_ERROR"],
                    "repair_note": exec_err,
                }
            )
            messages.append({"role": "assistant", "content": "\n".join(cmds)})
            messages.append(
                {
                    "role": "user",
                    "content": _format_drc_feedback(err_report, exec_error=exec_err),
                }
            )
            continue

        is_plate = parsed_hint is None or parsed_hint.get("kind") == "plate"
        report = lint_drawing(sandbox.document, manufacturing=is_plate)
        spec_errs = verify_synthesized_spec(sandbox.document, spec_text, parsed_params=parsed_hint)
        drc_err_count = report["summary"]["errors"]
        total_errs = drc_err_count + len(spec_errs)
        issue_codes = [i["code"] for i in report["issues"] if i["severity"] == "error"]
        if spec_errs:
            issue_codes.extend(["SPEC_MISMATCH"] * len(spec_errs))

        passes.append(
            {
                "pass": pass_idx,
                "commands": cmds,
                "errors": total_errs,
                "drc_errors": drc_err_count,
                "spec_errors": spec_errs,
                "issues": issue_codes,
            }
        )
        if best_candidate is None or total_errs < best_candidate["total_errs"]:
            best_candidate = {
                "total_errs": total_errs,
                "doc": sandbox.document,
                "lint": report,
                "spec_errors": spec_errs,
                "cmds": cmds,
                "logs": logs,
            }

        if total_errs == 0:
            break

        feedback = _format_drc_feedback(report, spec_errors=spec_errs)
        passes[-1]["repair_note"] = "Sent millimeter DRC and spec diagnostics for self-repair."
        messages.append({"role": "assistant", "content": "\n".join(cmds)})
        messages.append({"role": "user", "content": feedback})

    if best_candidate is None:
        raise ProjectError(
            "Local runtime did not produce an executable CAD script within repair budget."
        )
    if best_candidate["total_errs"] > 0:
        reasons = list(best_candidate["spec_errors"])
        reasons.extend(
            i["message"] for i in best_candidate["lint"]["issues"] if i["severity"] == "error"
        )
        detail = "; ".join(reasons[:3]) or "Unresolved DRC or specification errors."
        raise ProjectError(
            "Synthesis failed verification within repair budget; "
            f"active drawing kept unchanged: {detail}"
        )

    session.replace_document(best_candidate["doc"])
    return {
        "runtime": selected,
        "passes": passes,
        "spec_adjustments": [],
        "commands": best_candidate["cmds"],
        "log": best_candidate["logs"],
        "revision": session.revision,
        "drawing": session.document,
        "lint": best_candidate["lint"],
    }
