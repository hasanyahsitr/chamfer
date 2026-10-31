# Product direction: an AutoCAD-class drafting application

A plate generator is an
engineering experiment, not the requested product. The product direction is a
comprehensive, independent implementation of AutoCAD-style CAD workflows.
Existing geometry work remains reusable, but must not define the whole product.

## Application shell and first drafting milestone

- A drawing-first workspace with tool groups, model space, command input/history,
  coordinates, object selection, layers, and an entity properties inspector.
- Exact coordinate entry and mouse input for LINE, PLINE, CIRCLE, and RECTANG.
- MOVE, COPY, ERASE, undo/redo, zoom/pan/fit, and endpoint/center/midpoint snapping.
- Layer colors, visibility and locking, object layer changes, orthogonal drawing,
  grid display and grid snapping.
- Editable drawing save/open and real DXF interchange for the supported entity subset.
- Dimensions, additional modification commands, blocks, layouts, plotting, 3D tools
  and DWG interoperability remain separately tracked work until actually implemented.

The interface and implementation use original code and assets. Compatibility with
familiar commands and workflows does not imply copied proprietary code or branding.
Neither a familiar interface nor a handful of working commands establishes complete
AutoCAD equivalence. Feature coverage and real-file interoperability must be measured.

## Honest progress reporting

Publish meaningful commits and verification results to the existing repository.
Keep completed capabilities separate from proposed ones. The product name is still open.
