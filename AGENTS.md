# Chamfer — Repository Guidelines

Chamfer is an open-source, local-first millimeter 2D CAD workbench, analytical manufacturing Design Rule Check (DRC) engine, and Open CASCADE (`build123d`) 2D-to-3D solid bridge.

## Scope & Architecture

- **Current target (`0.3.0a1`):** Single-part planar XY 2D profiles in exact millimeters (`mm`) extruded into prismatic 3D B-Rep solids (`STEP` / `STL`).
- **Twin Python / JS Parity:** Planar drafting, entity snapping, DXF import/export, and core geometry verification in `src/cad_lab/` (Python 3.12) and `web/src/` (Node 24 ES modules) must remain behaviorally aligned.
- **Standalone Static Mode:** `web/dist/` runs 2D drafting, DRC inspection & preview repair, CAM telemetry, ASCII R2010 DXF round-trip, and ISO `.svg` blueprint export purely client-side without a backend.
- **Local Bridge Mode:** `chamfer-serve` (`127.0.0.1:4310`) and `chamfer-mcp` (`stdio` JSON-RPC 2.0) add live canvas sync, local runtime synthesis, and Open CASCADE 3D extrusion.

## Engineering Invariants

Do not weaken or approximate these guarantees:
- **Exact analytical geometry:** Loop chaining (`LINE + ARC`, `1e-4 mm` shared tolerance), Green's theorem contour areas, curve-aware ray-casting containment, and quadratic/circle-circle intersections must remain analytical — never replace DRC curve intersections with polygon chord sampling.
- **Explicit rejections over silent approximations:** Multi-outer-profile sheets (`MULTIPLE_OUTER_PROFILES`), nested islands (`NESTED_ISLAND_UNSUPPORTED`), and unsupported DXF entities (`LWPOLYLINE` bulge/widths, `SPLINE`, `ELLIPSE`, `BLOCK/INSERT`, paper-space entities, non-millimeter units) must fail cleanly.
- **Transactional state mutations:** `/api/drawing/state` and `/api/drawing/exec` validate candidates before mutating the active document or bumping revision, enforce `max_depth=64` JSON nesting limits, and support `expected_revision` optimistic concurrency (`HTTP 409`) plus `request_id` idempotency.
- **Safe exports & MCP transport:** File exports (`DXF`, `STEP`, `STL`) default to `overwrite=false`. Post-connect `stdio` MCP bridge transport failures must surface explicit errors instead of falling back silently to an isolated in-memory session.

## Verification Commands

Run all checks after modifying source, web, or geometry modules.

Windows PowerShell:

```powershell
.\.venv\Scripts\python.exe -m ruff check .
.\.venv\Scripts\python.exe -m ruff format --check .
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe benchmarks/spatial_eval.py
.\.venv\Scripts\python.exe benchmarks/drc_benchmark.py
npm --prefix web test
npm --prefix web run format:check
npm --prefix web run build
```

Linux / macOS:

```bash
.venv/bin/python -m ruff check .
.venv/bin/python -m ruff format --check .
.venv/bin/python -m pytest -q
.venv/bin/python benchmarks/spatial_eval.py
.venv/bin/python benchmarks/drc_benchmark.py
npm --prefix web test
npm --prefix web run format:check
npm --prefix web run build
```
