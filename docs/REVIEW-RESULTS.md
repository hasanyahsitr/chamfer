# Geometry and command verification notes

This document records command-semantics edge cases, DXF interchange invariants, and
regression checks verified across the browser workbench and Python backend.

## Core drafting invariants verified

| Verification point | Implementation / evidence |
| --- | --- |
| Separate 2D entity/document state from OCCT part generation and transient previews. | `web/src/drawing/model.js`, `web/src/drawing/commands.js`, and `src/cad_lab/commands.py` manage planar state independently from the `/index.html` 3D experiment. |
| A chained `LINE` or `PLINE` undoes as a single command transaction. | Vertices remain transient until command completion; one document snapshot commits the resulting segments. Automated `LINE`/`PLINE` undo tests pass. |
| Closed polylines preserve the closing edge for snapping and selection. | `entityPoints` includes the final-to-first midpoint, and crossing selection tests the closing segment. Covered by regression tests on locked visible layers. |
| Locale-independent coordinate grammar. | Decimal point, Cartesian comma separator, relative `@x,y`, and polar `@distance<angle`; hex, malformed, and non-finite inputs are rejected. |
| Command-local undo and close semantics. | `U` removes the last transient `LINE`/`PLINE` vertex; `C` closes an active path command with >= 3 points rather than starting `CIRCLE`. |
| Radius and diameter agreement. | `CIRCLE` accepts `D` plus scalar diameter or boundary point; regression tests verify radius parity against direct-radius input. |
| Document size budgets. | Drawing JSON and DXF payloads are capped at 1 MiB; parametric plate projects retain a 64 KiB cap. |
| Explicit DXF subset validation. | Only planar millimeter `LINE`, `LWPOLYLINE` (without bulge/width), and `CIRCLE` entities in model space are accepted; unsupported DXF entities fail loudly without mutating the open drawing. |

## Edge-case audit and regression checks

- **Rejected command recovery:** Failed `MOVE`/`COPY` or two-point creation restores prior
  pending points instead of trapping rejected targets, allowing boundary-overflow moves or
  locked-layer blocks to recover cleanly.
- **Escape behavior on `LINE`/`PLINE`:** Pressing Escape ends the active chain while
  retaining already committed segments, matching standard CAD line-chaining behavior;
  `UNDO` removes the entire command transaction.
- **Windows CRLF DXF import:** Universal newline normalization preserves `$INSUNITS`
  header parsing on CRLF-encoded ASCII DXF files.
- **Analytical window vs. crossing selection:** Left-to-right window selection requires
  full containment; right-to-left crossing selection tests segment and circumference
  intersections so dragging inside an empty circle interior does not falsely select the circle.
- **Deterministic manufacturing linter parity:** Both Python (`src/cad_lab/linter.py`) and
  browser JS (`web/src/drawing/linter.js`) verify `examples/office-layout.cadlab.json` with
  zero false-positive errors while catching open gaps, self-intersections, duplicate cuts,
  thin webs, and stray holes on CNC bracket test cases.
