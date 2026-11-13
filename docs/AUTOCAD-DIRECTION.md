# Product direction: Chamfer 2D drafting & verification

A parametric plate generator is an engineering experiment, not the whole product.
**Chamfer** focuses on an independent, exact millimeter implementation of AutoCAD-style
2D drafting workflows combined with deterministic manufacturing verification and
programmatic tool control.

## Core drafting and verification scope

- A drawing-first workspace with tool groups, model space, command input/history,
  coordinates, object selection, layers, and an entity properties inspector.
- Exact coordinate entry and mouse input for `LINE`, `PLINE`, `CIRCLE`, and `RECTANG`.
- `MOVE`, `COPY`, `ERASE`, `DIST`, `LINT`, undo/redo, zoom/pan/fit, and
  endpoint/center/midpoint/quadrant snapping.
- Deterministic geometry verification (`OPEN_CONTOUR_GAP`, `SELF_INTERSECTION`,
  `MICRO_SEGMENT`, `DUPLICATE_GEOMETRY`, `SHARED_EDGE_OVERLAP`, `CIRCLE_COLLISION`,
  `MIN_CLEARANCE`, `OUTSIDE_OUTER_PROFILE`) identically implemented in browser JS and
  Python CLI/server runtimes.
- Programmatic execution via `DrawingSession` and `chamfer-mcp` over standard `stdio`
  JSON-RPC 2.0, synchronized with the local loopback workbench.
- Editable JSON save/open and verified ASCII R2010 millimeter DXF interchange.
- `ARC`, `OFFSET`, dimensions, blocks, layouts, plotting, broader 3D tools, and DWG
  interoperability remain tracked as separate engineering milestones.

The interface and implementation use original code and assets. Compatibility with
familiar CAD command aliases and coordinate notation does not imply copied proprietary
code or complete AutoCAD feature parity.

## Honest progress reporting

Publish small, verifiable milestones with automated Python and JavaScript regression
tests. Keep implemented capabilities strictly separated from planned work.
