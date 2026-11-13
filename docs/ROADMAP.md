# Roadmap

Progress is recorded as implemented work is verified. This is not a release-date promise.

## Current direction — Chamfer 2D CAD, deterministic DRC & 2D-to-3D solid bridge

The default workspace is a drawing-first millimeter CAD application backed by a
deterministic geometry verifier, live CAM telemetry, a 2D-to-3D Open CASCADE solid
extrusion bridge, and a headless command/MCP runtime; the standalone 3D plate experiment
remains at `/index.html`.

- [x] Exact 2D line, polyline, rectangle and circle entities, independent of the UI.
- [x] Command/prompt engine, Cartesian/relative/polar coordinates, local vertex undo and close options.
- [x] Pick/Shift selection, MOVE/COPY/ERASE, layer visibility/locking/color.
- [x] Grid, orthogonal input and endpoint/midpoint/center/quadrant/intersection/perpendicular snapping.
- [x] Bounded drawing history, editable JSON save/open and R2010 millimeter DXF export.
- [x] Command semantics and geometry edge-case audit with regression tests.
- [x] Supported planar/mm ASCII DXF import (`LINE`, `LWPOLYLINE`, `CIRCLE`, `ARC`, `DIMENSION`, `TEXT`), explicit rejection of unsupported geometry and an import report.
- [x] Analytical window/crossing selection, including hollow-circle, arc, and closing-edge tests.
- [x] Original layered office-layout example and standard mechanical part presets (`NEMA-17`, `ISO DN50`, `EIA 19" 1U`).
- [x] Adaptive grid for small-part and building-scale drawings; 320/390/1280 px layout checks.
- [x] Deterministic 2D geometry & manufacturing linter (`LINT` command, CLI `--lint-drawing`, visual fault markers, 12-scenario `benchmarks/drc_benchmark.py`).
- [x] Headless deterministic command session (`DrawingSession`), 8-tool `chamfer-mcp` stdio server, and live loopback browser canvas sync.
- [x] `ARC`, `OFFSET`, `CHAMFER`, `FILLET`, `TRIM`, `ROTATE`, `MIRROR`, `ARRAY` (`POLAR`/`RECT`), linear `DIM`, and `TEXT` entities plus English/Turkish UI toggle.
- [x] Live CAM/laser telemetry (cut path length, pierce count, net area, scrap ratio, Al 6061 / Steel S235 mass) and ISO `.svg` technical blueprint export.
- [x] General 2D-to-3D Open CASCADE (`build123d`) solid extrusion bridge (`STEP` / `STL` export + orthographic 3D turntable viewer).
- [x] Zero-config local runtime discovery (`Ollama`, `LM Studio`, `llama.cpp`) and offline parametric specification compiler with closed-loop DRC self-repair (`? <spec>`).
- [ ] `EXTEND` command, DXF `LWPOLYLINE` bulge round-trip, spatial R-tree indexing for 10k+ entities, and delta history.
- [ ] Laser kerf compensation / G-code export, sheet-metal bend allowance, blocks, paper-space layouts, DWG interoperability, multi-feature 3D modeling, and desktop packaging.

The milestones below record the initial Open CASCADE geometry foundation.

## Milestone 0 — independent foundation

- [x] Separate repository, original-code MIT license, and upstream attribution.
- [x] English and Turkish project documentation.
- [x] Distinguish product direction from implemented capabilities.

## Milestone 1 — exact geometry and round-trip files

- [x] Validated plate parameters in millimeters.
- [x] Four through-holes with edge-relative positions after dimensional changes.
- [x] Exact solid geometry and analytical volume checks.
- [x] Versioned project save/load, without executing project-provided code.
- [x] STEP and STL export; STEP reimport checks.
- [x] Automated geometry, project, drawing-interchange, linter, MCP, 2D-to-3D extrusion, and local HTTP tests.
- [x] GitHub CI execution on Windows and Linux, plus frontend tests/build.

## Milestone 2 — local interactive experiment

- [x] Real 3D visualization generated from the CAD model.
- [x] Editable dimensions and clear errors while preserving the last valid model.
- [x] Project download/reopen and model exports.
- [x] Keyboard controls, labels, and narrow-screen layout (390 px checked).
- [x] Local operation without accounts, analytics, or cloud geometry processing.

## Evidence before claims

- Compare real tasks with FreeCAD; compare commercial products only when legitimately available.
- Test exported DXF/STEP models in separate CAD/CAM tools beyond internal round-trip checks.
- Observe real engineering workflows before claiming productivity gains.
- Do not promise lossless DWG support until a verified interoperability path exists.
