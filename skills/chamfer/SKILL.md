---
name: chamfer
description: >-
  Draft exact millimeter 2D mechanical parts, run analytical CNC/laser Design Rule Checks (DRC),
  repair geometry defects, export ASCII R2010 DXF, and extrude verified profiles into Open CASCADE
  STEP/STL 3D solids using Chamfer CLI and MCP tools.
---

# Chamfer Millimeter CAD & Verification Workflow

Use this skill when creating, inspecting, repairing, or exporting mechanical 2D parts (`mm`) and single-thickness 3D solids (`STEP` / `STL`) through Chamfer.

## 1. Environment & Tooling Modes

- **Interactive workstation (`chamfer-serve`):** Start with `chamfer-serve --port 4310` when live browser canvas visualization (`http://127.0.0.1:4310`) or HTTP bridge endpoints are needed.
- **MCP server (`chamfer-mcp`):** Runs over `stdio` JSON-RPC 2.0 (`chamfer-mcp --port 4310`), exposing:
  `chamfer_get_drawing`, `chamfer_execute`, `chamfer_modify_entity`, `chamfer_lint`, `chamfer_cam_report`, `chamfer_extrude_3d`, `chamfer_export_dxf`, and `chamfer_import_dxf`.
- **Offline CLI verification:** Validate `.cadlab.json` drawings directly with:
  `chamfer --lint-drawing <path/to/drawing.cadlab.json>`

## 2. Millimeter Drafting (`chamfer_execute`)

Always work in exact **millimeters (`mm`)**. Keep non-cut reference geometry (bolt circles, centerlines, construction guides) on a `CONSTRUCTION` layer so DRC and 3D extrusion ignore it.

Common atomic commands for `chamfer_execute`:
- `NEW [name]` — start a clean drawing
- `LAYER <name> [#hex] [CONSTRUCTION]` — switch/create layer (add `CONSTRUCTION` for non-plotting reference layers)
- `RECTANG <x1,y1> <x2,y2> [id=...]` — axis-aligned closed rectangle
- `PLINE <x1,y1> <x2,y2> [... C] [id=...]` — polyline (append `C` to close)
- `LINE <x1,y1> <x2,y2> [...] [id=...]` — open line segment(s)
- `CIRCLE <cx,cy> [D] <r_or_d> [id=...]` — circle by radius, or diameter with `D`
- `ARC <p1> <p2> <p3> [id=...]` or `ARC C <cx,cy> <r> <start_deg> <end_deg>`
- `OFFSET`, `CHAMFER`, `FILLET`, `TRIM`, `ROTATE`, `MIRROR`, `ARRAY`, `DIM`, `TEXT`
- `SELECT <ALL|NONE|ids>`, `MOVE <base> <target>`, `COPY <base> <target>`, `ERASE [ids]`, `UNDO`, `REDO`

Always inspect current state with `chamfer_get_drawing` before modifying an existing drawing so IDs and layers match.

## 3. Mandatory Verification & Repair Loop (`chamfer_lint` -> `chamfer_modify_entity`)

Before exporting any manufacturing file, verify geometry deterministically:

1. Run `chamfer_lint` with `manufacturing: true` (and `thickness_mm` when known so default `min_clearance_mm` automatically scales to `max(1.5, thickness_mm)`; other defaults: `max_gap_mm: 2.0`, `min_segment_mm: 0.5`).
2. Confirm:
   - `valid == true`
   - Zero open contour gaps, zero self-intersections, zero duplicate cuts, and zero hole-edge or cross-layer collisions.
   - Single-part invariant holds (`MULTIPLE_OUTER_PROFILES` and `NESTED_ISLAND_UNSUPPORTED` are explicitly rejected for single-part manufacturing and 3D extrusion).
3. If defects are reported, fix entities surgically by ID using `chamfer_modify_entity` (`id`, `center`, `radius`, `points`, `closed`, `snap_gap_mm`, `layer`) rather than rebuilding the whole drawing, then re-run `chamfer_lint` until `valid == true`.

## 4. CAM Telemetry & Manufacturing Exports

Once `chamfer_lint` passes:
- Run `chamfer_cam_report` (`thickness_mm`) to inspect net part area (`mm^2`), total cutting path length (`mm`), pierce count, scrap percentage, and sheet mass.
- Export 2D CAD via `chamfer_export_dxf` (`output_path`, `overwrite: false` by default).
- Extrude verified single-part profiles into Open CASCADE B-Rep 3D solids via `chamfer_extrude_3d` (`thickness_mm`, `format: "step"` or `"stl"`, `output_path`, `overwrite: false` by default). Never pass `overwrite: true` without explicit user intent.
