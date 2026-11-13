# Engineering decisions

## Product identity and architecture

The project is named **Chamfer** (developed under **Aeonavis**). The Python package
retains the internal module path `cad_lab` and JSON format tag `cad-lab.drawing` /
`cad-lab.project` for backward compatibility with existing project files, while exposing
`chamfer`, `chamfer-serve`, and `chamfer-mcp` entry points.

The default UI is the 2D millimeter drafting workbench (`drafting.html`), paired with:
1. A deterministic planar geometry and manufacturing linter (`linter.py` and `linter.js`)
   that verifies closed contours, minimum web clearances, duplicate cuts, and hole placement.
2. A headless command processor (`commands.py`) and standard `stdio` MCP server
   (`mcp_server.py`) capable of driving and verifying drawings programmatically and
   mirroring state live to the local browser workspace.

The initial 3D parametric plate experiment remains accessible at `/index.html`. See
`AUTOCAD-DIRECTION.md` and `REVIEW-RESULTS.md` for scope and verification details.

## Initial scope history

The project began as an independent open-source CAD foundation published incrementally on
GitHub, starting with a reproducible 3D parametric-part milestone (`80 × 50 × 6 mm` plate
with four `5 mm` through-holes at `10 mm` edge margins) using Python 3.12 and
`build123d 0.13.0` over Open CASCADE. Versioned JSON stores editable parameters; STEP and
DXF serve as verified interchange formats.

## Local security and dependencies

- The HTTP server binds exclusively to loopback (`127.0.0.1`) and enforces `Host`,
  `Origin`, `Content-Security-Policy`, and strict request payload byte limits.
- Dependencies live in a project-local virtual environment (`.venv`) and `web/node_modules`.
- Original code is MIT-licensed with explicit upstream license attribution in `THIRD_PARTY.md`.
