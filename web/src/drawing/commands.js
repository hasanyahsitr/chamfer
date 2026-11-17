import { arcFromThreePoints, distance, parseIntScalar, parsePoint, parseScalar } from './model.js';
import { lintDrawing } from './linter.js';

const ALIASES = {
  L: 'LINE',
  PL: 'PLINE',
  C: 'CIRCLE',
  A: 'ARC',
  O: 'OFFSET',
  CHA: 'CHAMFER',
  F: 'FILLET',
  TR: 'TRIM',
  RO: 'ROTATE',
  MI: 'MIRROR',
  AR: 'ARRAY',
  T: 'TEXT',
  DLI: 'DIM',
  DIMLINEAR: 'DIM',
  REC: 'RECTANG',
  RECTANGLE: 'RECTANG',
  M: 'MOVE',
  CO: 'COPY',
  CP: 'COPY',
  E: 'ERASE',
  U: 'UNDO',
  DI: 'DIST',
  LA: 'LAYER',
  Z: 'ZOOM',
  DENETLE: 'LINT',
  AUDIT: 'LINT',
  DRC: 'LINT',
};
const TOOLS = new Set([
  'LINE',
  'PLINE',
  'CIRCLE',
  'ARC',
  'OFFSET',
  'CHAMFER',
  'FILLET',
  'TRIM',
  'ROTATE',
  'MIRROR',
  'TEXT',
  'DIM',
  'RECTANG',
  'MOVE',
  'COPY',
  'DIST',
]);
const CREATION_TOOLS = new Set([
  'LINE',
  'PLINE',
  'RECTANG',
  'CIRCLE',
  'ARC',
  'OFFSET',
  'CHAMFER',
  'FILLET',
  'TEXT',
  'DIM',
]);

export class CommandEngine {
  constructor(store, changed, log, fit, onLint = null, getLintOptions = null) {
    this.store = store;
    this.changed = changed;
    this.log = log;
    this.fit = fit;
    this.onLint = onLint;
    this.getLintOptions = getLintOptions;
    this.tool = null;
    this.points = [];
    this.lastTool = 'LINE';
    this.diameter = false;
    this.arcCenterMode = false;
    this.arcScalars = [];
    this.offsetDistance = null;
    this.pendingId = null;
    this.lastOffsetDistance = 10;
    this.lastChamferDistance = 3;
    this.lastFilletRadius = 4;
    this.lastTextHeight = 3.5;
  }
  get prompt() {
    if (!this.tool) return 'READY';
    if (this.tool === 'CIRCLE' && this.points.length)
      return this.diameter ? 'CIRCLE: Specify diameter' : 'CIRCLE: Specify radius or [D]iameter';
    if (this.tool === 'ARC') {
      if (this.arcCenterMode) {
        if (!this.points.length) return 'ARC [Center]: Specify center point';
        if (this.arcScalars.length === 0) return 'ARC [Center]: Specify radius (mm)';
        if (this.arcScalars.length === 1) return 'ARC [Center]: Specify start angle (deg)';
        return 'ARC [Center]: Specify end angle (deg)';
      }
      if (this.points.length === 0) return 'ARC: Specify start point or [C]enter';
      if (this.points.length === 1) return 'ARC: Specify second point on arc';
      return 'ARC: Specify end point';
    }
    if (this.tool === 'OFFSET') {
      return this.offsetDistance === null
        ? `OFFSET: Enter distance in mm <${this.lastOffsetDistance}>`
        : `OFFSET (${this.offsetDistance} mm): Click side to offset`;
    }
    if (this.tool === 'CHAMFER') {
      return `CHAMFER: Enter bevel distance mm <${this.lastChamferDistance}> [d1 or d1 d2]`;
    }
    if (this.tool === 'FILLET') {
      return `FILLET: Enter fillet radius mm <${this.lastFilletRadius}>`;
    }
    if (this.tool === 'TRIM') {
      return 'TRIM: Click intersecting line segment to trim';
    }
    if (this.tool === 'ROTATE') {
      return this.points.length === 0
        ? 'ROTATE: Specify base pivot point'
        : 'ROTATE: Enter CCW angle (deg) or click reference direction';
    }
    if (this.tool === 'MIRROR') {
      return this.points.length === 0
        ? 'MIRROR: Specify first point on mirror axis'
        : 'MIRROR: Specify second point on mirror axis';
    }
    if (this.tool === 'TEXT') {
      return this.points.length === 0
        ? 'TEXT: Click insertion point'
        : `TEXT: Enter [height] and note <${this.lastTextHeight} mm>`;
    }
    if (this.tool === 'DIM') {
      if (this.points.length === 0) return 'DIM: Specify first extension origin';
      if (this.points.length === 1) return 'DIM: Specify second extension origin';
      return 'DIM: Specify dimension line position';
    }
    if (['MOVE', 'COPY'].includes(this.tool))
      return `${this.tool}: Specify ${this.points.length ? 'target' : 'base'} point`;
    return `${this.tool}: Specify ${this.points.length ? 'next' : 'first'} point${['LINE', 'PLINE'].includes(this.tool) ? ' [Enter/C]' : ''}`;
  }
  start(tool) {
    this.end();
    if (
      CREATION_TOOLS.has(tool) &&
      (this.store.currentLayer.locked || !this.store.currentLayer.visible)
    )
      throw new Error('Active layer is locked or hidden.');
    if (
      ['MOVE', 'COPY', 'ROTATE', 'MIRROR'].includes(tool) &&
      !this.store.selectedEditable().length
    ) {
      throw new Error(`Select editable objects before running ${tool}.`);
    }
    if (tool === 'OFFSET' && this.store.selectedEditable().length !== 1) {
      throw new Error('Select a single editable object before running OFFSET.');
    }
    if (
      ['CHAMFER', 'FILLET'].includes(tool) &&
      ![1, 2].includes(this.store.selectedEditable().length)
    ) {
      throw new Error(`Select a polyline or two intersecting lines before ${tool}.`);
    }
    this.tool = tool;
    this.points = [];
    this.lastTool = tool;
    this.diameter = false;
    this.arcCenterMode = false;
    this.arcScalars = [];
    this.offsetDistance = null;
    this.pendingId = null;
    this.log(this.prompt);
    this.changed();
  }
  execute(text) {
    const input = text.trim();
    if (!input) {
      if (this.tool === 'OFFSET' && this.offsetDistance === null) {
        this.offsetDistance = this.lastOffsetDistance;
        this.log(this.prompt);
        this.changed();
        return;
      }
      if (this.tool === 'CHAMFER') {
        this.store.chamfer(this.lastChamferDistance, this.lastChamferDistance);
        this.done();
        this.changed();
        return;
      }
      if (this.tool === 'FILLET') {
        this.store.fillet(this.lastFilletRadius);
        this.done();
        this.changed();
        return;
      }
      if (this.tool) this.finish();
      else this.start(this.lastTool);
      return;
    }

    // Interactive TEXT note entry once insertion point has been clicked
    if (this.tool === 'TEXT' && this.points.length === 1) {
      const parts = input.split(/\s+/);
      let height = this.lastTextHeight;
      let content = input;
      if (parts.length >= 2) {
        try {
          const maybeH = parseScalar(parts[0]);
          if (maybeH >= 0.2 && maybeH <= 1e4) {
            height = maybeH;
            this.lastTextHeight = height;
            content = parts.slice(1).join(' ');
          }
        } catch {
          // Treat entire input as note string using default height
        }
      }
      this.store.add({
        type: 'text',
        position: this.points[0],
        height,
        rotation: 0,
        text: content,
      });
      this.done();
      this.changed();
      return;
    }

    const tokens = input.split(/\s+/),
      first = tokens[0].toUpperCase(),
      command = ALIASES[first] || first;

    if (['LINE', 'PLINE'].includes(this.tool) && ['C', 'CLOSE', 'KAPAT'].includes(first)) {
      this.finish(true);
      return;
    }
    if (command === 'UNDO' && ['LINE', 'PLINE'].includes(this.tool) && this.points.length) {
      this.points.pop();
      this.log('Removed last pending vertex.');
      this.changed();
      return;
    }
    if (command === 'UNDO' || command === 'REDO') {
      this.cancel();
      this.store[command.toLowerCase()]();
      this.changed();
      return;
    }
    if (command === 'ERASE') {
      this.cancel();
      this.store.erase();
      this.log('ERASE: Selected entities removed.');
      this.changed();
      return;
    }
    if (command === 'ZOOM') {
      this.fit();
      this.changed();
      return;
    }
    if (command === 'LINT') {
      this.cancel();
      const opts = { ...(this.getLintOptions ? this.getLintOptions() : {}) };
      if (tokens.length >= 2) {
        const rawTok = tokens[1].toLowerCase().startsWith('t=') ? tokens[1].slice(2) : tokens[1];
        const tVal = parseScalar(rawTok);
        if (!(tVal > 0)) {
          throw new Error('LINT sheet thickness (mm) must be > 0.');
        }
        opts.thicknessMm = tVal;
      }
      const report = lintDrawing(this.store.document, opts);
      this.onLint?.(report);
      this.log(
        `LINT · ${report.summary.errors} error(s), ${report.summary.warnings} warning(s) (${report.summary.checked_entities} entities, clearance >= ${report.min_clearance_mm.toFixed(2)} mm).`,
        report.summary.errors > 0,
      );
      this.changed();
      return;
    }
    if (command === 'NEW') {
      this.cancel();
      const nextName = tokens.slice(1).join(' ').trim() || 'Untitled';
      this.store.reset(nextName);
      this.log(`NEW: '${nextName}'.`);
      this.changed();
      return;
    }
    if (command === 'LAYER') {
      this.store.activateOrAddLayer(tokens.slice(1).join(' '));
      this.log(`LAYER: '${this.store.currentLayer.name}' active.`);
      this.changed();
      return;
    }

    // One-line CLI commands for ARRAY, CHAMFER, FILLET, TRIM, TEXT
    if (command === 'ARRAY') {
      this.cancel();
      const args = tokens.slice(1);
      if (args.length < 3)
        throw new Error(
          'Usage: ARRAY POLAR [id] <cx,cy> <count> [deg] | ARRAY RECT [id] <cols> <rows> <dx> <dy>',
        );
      const mode = args[0].toUpperCase();
      const byId = new Set(this.store.document.entities.map((e) => e.id));
      let explicitId = null,
        rest = args.slice(1);
      if (byId.has(rest[0])) {
        explicitId = rest[0];
        rest = rest.slice(1);
      }
      if (mode === 'POLAR') {
        const center = parsePoint(rest[0]);
        const count = parseIntScalar(rest[1]);
        const fillDeg = rest[2] !== undefined ? parseScalar(rest[2]) : 360;
        this.store.arrayPolar(center, count, fillDeg, explicitId);
      } else if (mode === 'RECT') {
        const cols = parseIntScalar(rest[0]);
        const rows = parseIntScalar(rest[1]);
        const dx = parseScalar(rest[2]);
        const dy = parseScalar(rest[3]);
        this.store.arrayRect(cols, rows, dx, dy, explicitId);
      } else {
        throw new Error('ARRAY mode must be POLAR or RECT.');
      }
      this.log('ARRAY: OK.');
      this.changed();
      return;
    }

    if (command === 'TEXT' && tokens.length >= 4) {
      this.cancel();
      if (this.store.currentLayer.locked || !this.store.currentLayer.visible)
        throw new Error('Active layer is locked or hidden.');
      const args = tokens.slice(1);
      let rot = 0;
      let explicitId = null;
      const clean = [];
      for (const tok of args) {
        if (tok.toLowerCase().startsWith('rot=')) rot = parseScalar(tok.slice(4));
        else if (tok.toLowerCase().startsWith('id=') && tok.length > 3) explicitId = tok.slice(3);
        else clean.push(tok);
      }
      const pos = parsePoint(clean[0]);
      const height = parseScalar(clean[1]);
      const label = clean.slice(2).join(' ').trim();
      this.store.add({
        ...(explicitId ? { id: explicitId } : {}),
        type: 'text',
        position: pos,
        height,
        rotation: rot,
        text: label,
      });
      this.log('TEXT: OK.');
      this.changed();
      return;
    }

    if (command === 'CHAMFER' && tokens.length >= 2) {
      const rawArgs = tokens.slice(1);
      let kp1 = null,
        kp2 = null;
      const args = [];
      for (const tok of rawArgs) {
        if (tok.toLowerCase().startsWith('keep1=')) kp1 = parsePoint(tok.slice(6));
        else if (tok.toLowerCase().startsWith('keep2=')) kp2 = parsePoint(tok.slice(6));
        else args.push(tok);
      }
      const byId = new Set(this.store.document.entities.map((e) => e.id));
      let explicitIds = null,
        numTokens = args;
      if (args.length >= 3 && byId.has(args[0]) && byId.has(args[1])) {
        explicitIds = [args[0], args[1]];
        numTokens = args.slice(2);
      } else if (args.length >= 2 && byId.has(args[0])) {
        explicitIds = [args[0]];
        numTokens = args.slice(1);
      }
      this.cancel();
      const d1 = parseScalar(numTokens[0]);
      const d2 = numTokens[1] !== undefined ? parseScalar(numTokens[1]) : d1;
      this.lastChamferDistance = d1;
      const keepPts = kp1 || kp2 ? [kp1, kp2] : null;
      this.store.chamfer(d1, d2, explicitIds, keepPts);
      this.log(`CHAMFER: ${d1}x${d2} mm OK.`);
      this.changed();
      return;
    }

    if (command === 'FILLET' && tokens.length >= 2) {
      const rawArgs = tokens.slice(1);
      let kp1 = null,
        kp2 = null;
      const args = [];
      for (const tok of rawArgs) {
        if (tok.toLowerCase().startsWith('keep1=')) kp1 = parsePoint(tok.slice(6));
        else if (tok.toLowerCase().startsWith('keep2=')) kp2 = parsePoint(tok.slice(6));
        else args.push(tok);
      }
      const byId = new Set(this.store.document.entities.map((e) => e.id));
      let explicitIds = null,
        numTokens = args;
      if (args.length >= 3 && byId.has(args[0]) && byId.has(args[1])) {
        explicitIds = [args[0], args[1]];
        numTokens = args.slice(2);
      } else if (args.length >= 2 && byId.has(args[0])) {
        explicitIds = [args[0]];
        numTokens = args.slice(1);
      }
      this.cancel();
      const radius = parseScalar(numTokens[0]);
      this.lastFilletRadius = radius;
      const keepPts = kp1 || kp2 ? [kp1, kp2] : null;
      this.store.fillet(radius, explicitIds, keepPts);
      this.log(`FILLET: R${radius} mm OK.`);
      this.changed();
      return;
    }

    if (command === 'TRIM' && tokens.length >= 2) {
      const args = tokens.slice(1);
      const byId = new Set(this.store.document.entities.map((e) => e.id));
      this.cancel();
      if (args.length === 2 && byId.has(args[0])) {
        this.store.trim(parsePoint(args[1]), args[0]);
      } else {
        this.store.trim(parsePoint(args[0]));
      }
      this.log('TRIM: OK.');
      this.changed();
      return;
    }

    if (TOOLS.has(command) && !(this.tool === 'ARC' && !this.points.length && first === 'C')) {
      this.start(command);
      tokens.shift();
    } else if (!this.tool)
      throw new Error(
        `Unknown command: ${first}. Supported: LINE, PLINE, RECTANG, CIRCLE, ARC, OFFSET, CHAMFER, FILLET, TRIM, ROTATE, MIRROR, ARRAY, TEXT, DIM, MOVE, COPY, ERASE, DIST, LINT, UNDO, REDO.`,
      );

    for (let idx = tokens.length - 1; idx >= 0; idx--) {
      if (tokens[idx].toLowerCase().startsWith('id=') && tokens[idx].length > 3) {
        this.pendingId = tokens[idx].slice(3);
        tokens.splice(idx, 1);
      }
    }

    if (this.tool === 'CHAMFER' && tokens.length) {
      const d1 = parseScalar(tokens[0]);
      const d2 = tokens[1] !== undefined ? parseScalar(tokens[1]) : d1;
      this.lastChamferDistance = d1;
      this.store.chamfer(d1, d2);
      this.done();
      this.changed();
      return;
    }
    if (this.tool === 'FILLET' && tokens.length) {
      const rad = parseScalar(tokens[0]);
      this.lastFilletRadius = rad;
      this.store.fillet(rad);
      this.done();
      this.changed();
      return;
    }

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (!this.tool) throw new Error('Command already completed; enter a new command.');
      if (
        ['LINE', 'PLINE'].includes(this.tool) &&
        ['C', 'CLOSE', 'KAPAT'].includes(token.toUpperCase())
      ) {
        this.finish(true);
        continue;
      }
      if (
        this.tool === 'ARC' &&
        !this.arcCenterMode &&
        !this.points.length &&
        token.toUpperCase() === 'C'
      ) {
        this.arcCenterMode = true;
        this.changed();
        continue;
      }
      if (this.tool === 'ARC' && this.arcCenterMode && this.points.length === 1) {
        const val = parseScalar(token);
        if (this.arcScalars.length === 0 && val <= 1e-6)
          throw new Error('Arc radius must be positive.');
        this.arcScalars.push(val);
        if (this.arcScalars.length === 3) {
          const [radius, sa, ea] = this.arcScalars;
          this.store.add({
            ...(this.pendingId ? { id: this.pendingId } : {}),
            type: 'arc',
            center: this.points[0],
            radius,
            start_angle: ((sa % 360) + 360) % 360,
            end_angle: ((ea % 360) + 360) % 360,
          });
          this.done();
        } else {
          this.changed();
        }
        continue;
      }
      if (this.tool === 'OFFSET' && this.offsetDistance === null) {
        const distVal = parseScalar(token);
        if (distVal <= 1e-6) throw new Error('Offset distance must be positive.');
        this.offsetDistance = distVal;
        this.lastOffsetDistance = distVal;
        this.changed();
        continue;
      }
      if (
        this.tool === 'ROTATE' &&
        this.points.length === 1 &&
        !token.includes(',') &&
        !token.includes('<') &&
        !token.startsWith('@')
      ) {
        const angle = parseScalar(token);
        this.store.rotate(this.points[0], angle);
        this.done();
        this.changed();
        continue;
      }
      if (
        this.tool === 'MIRROR' &&
        this.points.length === 1 &&
        tokens[i + 1] &&
        ['ERASE', 'Y', 'YES'].includes(tokens[i + 1].toUpperCase())
      ) {
        const p2 = parsePoint(token, this.points[0]);
        this.store.mirror(this.points[0], p2, true);
        this.done();
        this.changed();
        i++;
        continue;
      }
      if (this.tool === 'CIRCLE' && this.points.length && token.toUpperCase() === 'D') {
        this.diameter = true;
        this.changed();
        continue;
      }
      if (
        this.tool === 'CIRCLE' &&
        this.points.length &&
        !token.includes(',') &&
        !token.includes('<') &&
        !token.startsWith('@')
      ) {
        const radius = parseScalar(token);
        if (radius <= 1e-6) throw new Error('Radius must be positive.');
        this.store.add({
          ...(this.pendingId ? { id: this.pendingId } : {}),
          type: 'circle',
          center: this.points[0],
          radius: this.diameter ? radius / 2 : radius,
        });
        this.done();
        continue;
      }
      this.point(parsePoint(token, this.points.at(-1) || null));
    }
  }
  point(point) {
    if (!this.tool) return;
    if (this.tool === 'OFFSET') {
      if (this.offsetDistance === null) this.offsetDistance = this.lastOffsetDistance;
      this.store.offset(this.offsetDistance, point);
      this.done();
      this.changed();
      return;
    }
    if (this.tool === 'TRIM') {
      this.store.trim(point);
      this.done();
      this.changed();
      return;
    }
    if (this.points.length && distance(point, this.points.at(-1)) < 1e-6)
      throw new Error('Specify a distinct point.');
    const previous = this.points;
    this.points = [...previous, [...point]];
    try {
      const [a, b, c] = this.points;
      if (this.tool === 'RECTANG' && b) {
        if (Math.abs(a[0] - b[0]) < 1e-6 || Math.abs(a[1] - b[1]) < 1e-6)
          throw new Error('Rectangle width and height must be non-zero.');
        this.store.add({
          ...(this.pendingId ? { id: this.pendingId } : {}),
          type: 'polyline',
          points: [a, [b[0], a[1]], b, [a[0], b[1]]],
          closed: true,
        });
        this.done();
      } else if (this.tool === 'CIRCLE' && b) {
        this.store.add({
          ...(this.pendingId ? { id: this.pendingId } : {}),
          type: 'circle',
          center: a,
          radius: this.circleRadiusAt(b),
        });
        this.done();
      } else if (this.tool === 'ARC' && !this.arcCenterMode && c) {
        this.store.add({
          ...(this.pendingId ? { id: this.pendingId } : {}),
          type: 'arc',
          ...arcFromThreePoints(a, b, c),
        });
        this.done();
      } else if (this.tool === 'DIM' && c) {
        if (distance(a, b) <= 1e-6) throw new Error('Dimension origins must be distinct.');
        this.store.add({
          ...(this.pendingId ? { id: this.pendingId } : {}),
          type: 'dim',
          p1: a,
          p2: b,
          dim_point: c,
        });
        this.done();
      } else if (['MOVE', 'COPY'].includes(this.tool) && b) {
        this.store.move([b[0] - a[0], b[1] - a[1]], this.tool === 'COPY');
        this.done();
      } else if (this.tool === 'ROTATE' && b) {
        const angle = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
        this.store.rotate(a, angle);
        this.done();
      } else if (this.tool === 'MIRROR' && b) {
        this.store.mirror(a, b, false);
        this.done();
      } else if (this.tool === 'DIST' && b) {
        this.log(
          `DIST: ${distance(a, b).toFixed(4)} mm  (dX ${(b[0] - a[0]).toFixed(4)}, dY ${(b[1] - a[1]).toFixed(4)})`,
        );
        this.tool = null;
        this.points = [];
      }
    } catch (error) {
      this.points = previous;
      throw error;
    }
    this.changed();
  }
  circleRadiusAt(point) {
    return distance(this.points[0], point) / (this.diameter ? 2 : 1);
  }
  end() {
    try {
      this.finish();
    } catch (error) {
      this.cancel();
      throw error;
    }
  }
  finish(close = false) {
    if (close && ['LINE', 'PLINE'].includes(this.tool) && this.points.length < 3)
      throw new Error('Closed contour requires at least 3 vertices.');
    if (['LINE', 'PLINE'].includes(this.tool) && this.points.length >= 2) {
      const next = structuredClone(this.store.document);
      if (this.store.currentLayer.locked || !this.store.currentLayer.visible)
        throw new Error('Active layer is locked or hidden.');
      const points = [...this.points];
      if (close && distance(points[0], points.at(-1)) < 1e-6) points.pop();
      if (close && points.length < 3)
        throw new Error('Closed contour requires at least 3 vertices.');
      if (this.tool === 'LINE') {
        const linePoints = close ? [...points, points[0]] : points;
        for (let i = 1; i < linePoints.length; i++)
          next.entities.push({
            id: linePoints.length === 2 && this.pendingId ? this.pendingId : crypto.randomUUID(),
            layer: this.store.layer,
            type: 'line',
            points: [linePoints[i - 1], linePoints[i]],
          });
      } else
        next.entities.push({
          id: this.pendingId || crypto.randomUUID(),
          layer: this.store.layer,
          type: 'polyline',
          points,
          closed: close,
        });
      this.store.commit(next);
      this.log(`${this.tool}: Committed.`);
    }
    this.tool = null;
    this.points = [];
    this.arcCenterMode = false;
    this.arcScalars = [];
    this.offsetDistance = null;
    this.pendingId = null;
    this.changed();
  }
  cancel() {
    this.tool = null;
    this.points = [];
    this.arcCenterMode = false;
    this.arcScalars = [];
    this.offsetDistance = null;
    this.pendingId = null;
    this.changed();
  }
  executeBatch(commands) {
    if (!Array.isArray(commands) || commands.length > 500)
      throw new Error('Batch requires 0–500 command strings.');
    const snapDoc = structuredClone(this.store.document);
    const snapHist = structuredClone(this.store.history);
    const snapIdx = this.store.index;
    const snapSel = new Set(this.store.selection);
    const snapLayer = this.store.layer;
    try {
      for (const raw of commands) {
        if (typeof raw !== 'string') throw new Error('Each batch command must be a string.');
        const clean = raw.trim();
        if (!clean || clean.startsWith('#')) continue;
        this.execute(clean);
        if (this.tool && ['LINE', 'PLINE'].includes(this.tool)) {
          this.finish(false);
        }
      }
    } catch (err) {
      this.store.document = snapDoc;
      this.store.history = snapHist;
      this.store.index = snapIdx;
      this.store.selection = snapSel;
      this.store.layer = snapLayer;
      this.cancel();
      throw err;
    }
  }
  done() {
    this.log(`${this.tool}: OK.`);
    this.tool = null;
    this.points = [];
    this.arcCenterMode = false;
    this.arcScalars = [];
    this.offsetDistance = null;
    this.pendingId = null;
  }
}
