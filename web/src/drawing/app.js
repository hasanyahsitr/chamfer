import './drafting.css';
import {
  DrawingStore,
  arcFromThreePoints,
  arcPointAt,
  arcSweepDeg,
  computeCamMetrics,
  dimGeometry,
  distance,
  drawingBounds,
  emptyDrawing,
  mirrorEntity,
  offsetEntityGeometry,
  rotateEntity,
  snapPointDetailed,
  textBoundsPoints,
  translated,
  validateDrawing,
} from './model.js';
import { CommandEngine } from './commands.js';
import { lintDrawing, previewDrcFix } from './linter.js';
import { exportDrawingToDxf, importDrawingFromDxf } from './dxf.js';
import { exportDrawingToSvgBlueprint } from './svg.js';
import { entitiesInBox } from './selection.js';
import { gridSpacing } from './grid.js';
import { STRINGS } from './i18n.js';
import { getPresetBuilder } from './presets.js';
import { createSolidViewer } from './solid_viewer.js';

const $ = (id) => document.getElementById(id),
  NS = 'http://www.w3.org/2000/svg';
const store = new DrawingStore();
const view = { center: [45, 25], scale: 5 };
const settings = { grid: true, snap: false, ortho: false, osnap: true };
let lang = localStorage.getItem('chamfer.lang') || 'tr';
if (!STRINGS[lang]) lang = 'tr';

let worldCursor = null,
  snapped = null,
  panning = null,
  selectBox = null,
  lintReport = lintDrawing(store.document),
  saved = JSON.stringify(store.document),
  lastSyncedJson = saved,
  serverRevision = 0,
  pendingSyncJson = null,
  bridgeConnected = false,
  requestBusy = false,
  runtimeCatalog = [],
  lastExternalRuntimeId = null,
  repairGhost = null,
  currentBatchRepair = null;

const canvas = $('drawing-canvas');
const solidViewer = createSolidViewer($('extrude-canvas'));
const engine = new CommandEngine(store, render, log, fit, (report) => {
  lintReport = report;
});

const t = () => STRINGS[lang];

function node(type, attributes = {}, parent = null) {
  const item = document.createElementNS(NS, type);
  for (const [key, value] of Object.entries(attributes)) item.setAttribute(key, String(value));
  if (parent) parent.append(item);
  return item;
}

function log(text, error = false) {
  const line = document.createElement('div');
  line.textContent = text;
  if (error) line.className = 'error';
  $('command-log').append(line);
  while ($('command-log').children.length > 100) $('command-log').firstChild.remove();
  $('command-log').scrollTop = $('command-log').scrollHeight;
}

function attempt(action) {
  try {
    action();
  } catch (error) {
    log(error.message, true);
    render();
  }
}

function bounds() {
  const rect = canvas.getBoundingClientRect();
  return {
    width: rect.width / view.scale,
    height: rect.height / view.scale,
    x: view.center[0] - rect.width / view.scale / 2,
    y: -view.center[1] - rect.height / view.scale / 2,
  };
}

function pointAt(event) {
  const rect = canvas.getBoundingClientRect(),
    box = bounds();
  return [
    box.x + (event.clientX - rect.left) / view.scale,
    -box.y - (event.clientY - rect.top) / view.scale,
  ];
}

function constrained(point) {
  const base = engine.points.at(-1) || null;
  snapped = settings.osnap ? snapPointDetailed(point, store.document, 10 / view.scale, base) : null;
  if (snapped) return snapped.point;
  const spacing = gridSpacing(view.scale);
  const result = settings.snap ? point.map((v) => Math.round(v / spacing) * spacing) : point;
  if (settings.ortho && base && !['OFFSET', 'TRIM'].includes(engine.tool)) {
    if (Math.abs(result[0] - base[0]) >= Math.abs(result[1] - base[1])) return [result[0], base[1]];
    return [base[0], result[1]];
  }
  return result;
}

function arcSvgPath(entity) {
  const sweep = arcSweepDeg(entity.start_angle, entity.end_angle);
  const s = arcPointAt(entity, entity.start_angle);
  const e = arcPointAt(entity, entity.end_angle);
  const largeArc = sweep > 180 ? 1 : 0;
  return `M ${s[0]} ${s[1]} A ${entity.radius} ${entity.radius} 0 ${largeArc} 1 ${e[0]} ${e[1]}`;
}

function drawDimension(entity, parent, color, extraClass = '') {
  const g = dimGeometry(entity);
  const px = 1 / view.scale;
  const gap = 1.6 * px * 4;
  const over = 2.0 * px * 4;
  const sign = g.signedOffset >= 0 ? 1 : -1;
  const e1Start = [g.p1[0] + sign * gap * g.nx, g.p1[1] + sign * gap * g.ny];
  const e1End = [g.d1[0] + sign * over * g.nx, g.d1[1] + sign * over * g.ny];
  const e2Start = [g.p2[0] + sign * gap * g.nx, g.p2[1] + sign * gap * g.ny];
  const e2End = [g.d2[0] + sign * over * g.nx, g.d2[1] + sign * over * g.ny];

  const dimGroup = node('g', {}, parent);
  const strokeColor = extraClass.includes('selected') ? '#4da6ff' : color;
  const lineAttrs = {
    class: `entity ${extraClass}`,
    stroke: strokeColor,
    'stroke-width': 0.95,
  };
  node(
    'path',
    {
      ...lineAttrs,
      d: `M ${e1Start[0]} ${e1Start[1]} L ${e1End[0]} ${e1End[1]} M ${e2Start[0]} ${e2Start[1]} L ${e2End[0]} ${e2End[1]} M ${g.d1[0]} ${g.d1[1]} L ${g.d2[0]} ${g.d2[1]}`,
    },
    dimGroup,
  );

  const arrowLen = Math.min(g.span * 0.22, 8 * px);
  const arrowHalfW = arrowLen * 0.32;
  if (arrowLen > 1e-4) {
    const a1 = [
      g.d1,
      [
        g.d1[0] + arrowLen * g.ux + arrowHalfW * g.nx,
        g.d1[1] + arrowLen * g.uy + arrowHalfW * g.ny,
      ],
      [
        g.d1[0] + arrowLen * g.ux - arrowHalfW * g.nx,
        g.d1[1] + arrowLen * g.uy - arrowHalfW * g.ny,
      ],
    ];
    const a2 = [
      g.d2,
      [
        g.d2[0] - arrowLen * g.ux + arrowHalfW * g.nx,
        g.d2[1] - arrowLen * g.uy + arrowHalfW * g.ny,
      ],
      [
        g.d2[0] - arrowLen * g.ux - arrowHalfW * g.nx,
        g.d2[1] - arrowLen * g.uy - arrowHalfW * g.ny,
      ],
    ];
    for (const tri of [a1, a2]) {
      node(
        'polygon',
        { points: tri.map((p) => p.join(',')).join(' '), fill: strokeColor },
        dimGroup,
      );
    }
  }

  const label = g.span.toFixed(2);
  const fontWorld = 10.5 * px;
  const padW = (label.length * 6.4 + 8) * px;
  const padH = 13 * px;
  const textAnchorGroup = node(
    'g',
    {
      transform: `translate(${g.mid[0]}, ${g.mid[1]}) scale(1,-1) rotate(${-g.angleDeg})`,
    },
    dimGroup,
  );
  node(
    'rect',
    {
      x: -padW / 2,
      y: -padH / 2,
      width: padW,
      height: padH,
      fill: '#0b0d10',
    },
    textAnchorGroup,
  );
  const textNode = node(
    'text',
    {
      x: 0,
      y: fontWorld * 0.34,
      'text-anchor': 'middle',
      fill: strokeColor,
      'font-size': fontWorld,
      class: 'dim-text',
    },
    textAnchorGroup,
  );
  textNode.textContent = label;
  return dimGroup;
}

function drawTextEntity(entity, parent, color, extraClass = '') {
  if (extraClass === 'hit') {
    const corners = textBoundsPoints(entity);
    return node(
      'polygon',
      {
        points: corners.map((p) => p.join(',')).join(' '),
        fill: 'transparent',
        stroke: 'transparent',
        'stroke-width': 6,
        'vector-effect': 'non-scaling-stroke',
        'pointer-events': 'all',
      },
      parent,
    );
  }
  const [px, py] = entity.position;
  const rot = entity.rotation || 0;
  const grp = node(
    'g',
    { transform: `translate(${px}, ${py}) scale(1,-1) rotate(${-rot})` },
    parent,
  );
  const txt = node(
    'text',
    {
      x: 0,
      y: 0,
      fill: extraClass.includes('selected') ? '#4da6ff' : color,
      'font-size': entity.height,
      class: `cad-text ${extraClass}`,
    },
    grp,
  );
  txt.textContent = entity.text;
  return grp;
}

function drawEntity(entity, parent, color, extraClass = '') {
  const attributes = { class: `entity ${extraClass}`, stroke: color };
  if (entity.type === 'circle') {
    return node(
      'circle',
      { ...attributes, cx: entity.center[0], cy: entity.center[1], r: entity.radius },
      parent,
    );
  }
  if (entity.type === 'arc') {
    return node('path', { ...attributes, d: arcSvgPath(entity) }, parent);
  }
  if (entity.type === 'dim') {
    if (extraClass === 'hit') {
      const g = dimGeometry(entity);
      return node(
        'path',
        {
          class: 'hit',
          d: `M ${g.p1[0]} ${g.p1[1]} L ${g.d1[0]} ${g.d1[1]} L ${g.d2[0]} ${g.d2[1]} L ${g.p2[0]} ${g.p2[1]}`,
        },
        parent,
      );
    }
    return drawDimension(entity, parent, color, extraClass);
  }
  if (entity.type === 'text') {
    return drawTextEntity(entity, parent, color, extraClass);
  }
  return node(
    'polyline',
    {
      ...attributes,
      points: (entity.closed ? [...entity.points, entity.points[0]] : entity.points)
        .map((p) => p.join(','))
        .join(' '),
    },
    parent,
  );
}

function drawOsnapGlyph(snapInfo, parent) {
  const [sx, sy] = snapInfo.point;
  const s = 4.6 / view.scale;
  const common = {
    fill: 'none',
    stroke: '#e09b24',
    'stroke-width': 1.5,
    'vector-effect': 'non-scaling-stroke',
  };
  if (snapInfo.kind === 'INT') {
    node(
      'path',
      {
        ...common,
        d: `M ${sx - s} ${sy - s} L ${sx + s} ${sy + s} M ${sx - s} ${sy + s} L ${sx + s} ${sy - s}`,
      },
      parent,
    );
  } else if (snapInfo.kind === 'PER') {
    node(
      'path',
      {
        ...common,
        d: `M ${sx - s} ${sy + s} V ${sy - s} H ${sx + s} M ${sx - s} ${sy} H ${sx} V ${sy - s}`,
      },
      parent,
    );
  } else if (snapInfo.kind === 'CEN') {
    node('circle', { ...common, cx: sx, cy: sy, r: s }, parent);
  } else if (snapInfo.kind === 'MID') {
    node(
      'polygon',
      {
        ...common,
        points: `${sx},${sy + s * 1.1} ${sx - s},${sy - s * 0.85} ${sx + s},${sy - s * 0.85}`,
      },
      parent,
    );
  } else if (snapInfo.kind === 'QUAD') {
    node(
      'polygon',
      {
        ...common,
        points: `${sx},${sy + s * 1.15} ${sx + s * 1.15},${sy} ${sx},${sy - s * 1.15} ${sx - s * 1.15},${sy}`,
      },
      parent,
    );
  } else {
    node('rect', { ...common, x: sx - s, y: sy - s, width: s * 2, height: s * 2 }, parent);
  }
}

function renderGeometry() {
  const box = bounds();
  canvas.setAttribute('viewBox', `${box.x} ${box.y} ${box.width} ${box.height}`);
  const grid = $('grid-surface');
  const spacing = gridSpacing(view.scale);
  const major = spacing * 5;
  $('drawing-grid').setAttribute('width', spacing);
  $('drawing-grid').setAttribute('height', spacing);
  $('drawing-grid-lines').setAttribute('d', `M ${spacing} 0 L 0 0 0 ${spacing}`);
  $('drawing-grid-major').setAttribute('width', major);
  $('drawing-grid-major').setAttribute('height', major);
  $('drawing-grid-subrect').setAttribute('width', major);
  $('drawing-grid-subrect').setAttribute('height', major);
  $('drawing-grid-major-lines').setAttribute('d', `M ${major} 0 L 0 0 0 ${major}`);

  for (const [key, value] of Object.entries(box)) grid.setAttribute(key, value);
  grid.setAttribute('visibility', settings.grid ? 'visible' : 'hidden');

  $('drawing-axes').replaceChildren();
  node(
    'path',
    {
      d: `M ${Math.min(box.x, 0)} 0 L 0 0 M 0 ${Math.max(box.y + box.height, 0)} L 0 0`,
      stroke: '#262d37',
      'stroke-width': 0.8,
      'vector-effect': 'non-scaling-stroke',
    },
    $('drawing-axes'),
  );
  if (box.x + box.width > 0) {
    node(
      'line',
      {
        x1: Math.max(0, box.x),
        y1: 0,
        x2: box.x + box.width,
        y2: 0,
        stroke: '#703030',
        'stroke-width': 0.9,
        'vector-effect': 'non-scaling-stroke',
      },
      $('drawing-axes'),
    );
  }
  if (box.y < 0) {
    node(
      'line',
      {
        x1: 0,
        y1: Math.min(0, box.y + box.height),
        x2: 0,
        y2: box.y,
        stroke: '#2d6840',
        'stroke-width': 0.9,
        'vector-effect': 'non-scaling-stroke',
      },
      $('drawing-axes'),
    );
  }

  $('entities').replaceChildren();
  const layers = new Map(store.document.layers.map((layer) => [layer.id, layer]));
  for (const entity of store.document.entities) {
    const layer = layers.get(entity.layer);
    if (!layer || !layer.visible) continue;
    const group = node('g', { 'data-entity': entity.id, class: 'entity-group' }, $('entities'));
    drawEntity(entity, group, layer.color, store.selection.has(entity.id) ? 'selected' : '');
    const hit = drawEntity(entity, group, 'transparent', 'hit');
    if (hit.classList) hit.classList.remove('entity');
  }

  $('lint-markers').replaceChildren();
  for (const issue of lintReport.issues) {
    const r = 8 / view.scale;
    const stroke = issue.severity === 'error' ? '#e05a5a' : '#d99b26';
    node(
      'circle',
      {
        cx: issue.point[0],
        cy: issue.point[1],
        r,
        fill: 'none',
        stroke,
        'stroke-width': 1.4,
        'stroke-dasharray': issue.severity === 'error' ? 'none' : '3 2',
        'vector-effect': 'non-scaling-stroke',
      },
      $('lint-markers'),
    );
    node(
      'path',
      {
        d: `M ${issue.point[0] - r * 1.4} ${issue.point[1]} H ${issue.point[0] + r * 1.4} M ${issue.point[0]} ${issue.point[1] - r * 1.4} V ${issue.point[1] + r * 1.4}`,
        stroke,
        'stroke-width': 0.8,
        'vector-effect': 'non-scaling-stroke',
      },
      $('lint-markers'),
    );
  }

  $('preview').replaceChildren();
  if (repairGhost && Array.isArray(repairGhost.previewEntities)) {
    for (const ghostEnt of repairGhost.previewEntities) {
      drawEntity(ghostEnt, $('preview'), '#3fb950', 'repair-ghost');
    }
  }
  if (worldCursor && engine.tool) {
    const pts = engine.points;
    const ghostStyle = '#e09b24';
    if (['LINE', 'PLINE'].includes(engine.tool) && pts.length) {
      drawEntity(
        { type: 'polyline', points: [...pts, worldCursor], closed: false },
        $('preview'),
        ghostStyle,
      );
    } else if (engine.tool === 'RECTANG' && pts.length === 1) {
      const a = pts[0],
        b = worldCursor;
      drawEntity(
        {
          type: 'polyline',
          points: [a, [b[0], a[1]], b, [a[0], b[1]]],
          closed: true,
        },
        $('preview'),
        ghostStyle,
      );
    } else if (engine.tool === 'CIRCLE' && pts.length === 1) {
      const r = engine.circleRadiusAt(worldCursor);
      if (r > 1e-6)
        drawEntity({ type: 'circle', center: pts[0], radius: r }, $('preview'), ghostStyle);
    } else if (engine.tool === 'ARC' && !engine.arcCenterMode) {
      if (pts.length === 1) {
        drawEntity({ type: 'line', points: [pts[0], worldCursor] }, $('preview'), ghostStyle);
      } else if (pts.length === 2) {
        try {
          const arcSpec = arcFromThreePoints(pts[0], pts[1], worldCursor);
          drawEntity({ type: 'arc', ...arcSpec }, $('preview'), ghostStyle);
        } catch {
          drawEntity({ type: 'line', points: [pts[0], worldCursor] }, $('preview'), ghostStyle);
        }
      }
    } else if (engine.tool === 'DIM') {
      if (pts.length === 1) {
        drawEntity({ type: 'line', points: [pts[0], worldCursor] }, $('preview'), ghostStyle);
      } else if (pts.length === 2 && distance(pts[0], pts[1]) > 1e-6) {
        drawDimension(
          { type: 'dim', p1: pts[0], p2: pts[1], dim_point: worldCursor },
          $('preview'),
          ghostStyle,
        );
      }
    } else if (engine.tool === 'OFFSET') {
      const distVal = engine.offsetDistance ?? engine.lastOffsetDistance;
      const sel = store.selectedEditable();
      if (sel.length === 1 && distVal > 1e-6) {
        try {
          const ghost = offsetEntityGeometry(sel[0], distVal, worldCursor);
          drawEntity(ghost, $('preview'), ghostStyle);
        } catch {
          // Ignore invalid inner radius preview
        }
      }
    } else if (['MOVE', 'COPY'].includes(engine.tool) && pts.length === 1) {
      const delta = [worldCursor[0] - pts[0][0], worldCursor[1] - pts[0][1]];
      for (const ent of store.selectedEditable()) {
        drawEntity(translated(ent, delta), $('preview'), ghostStyle);
      }
    } else if (engine.tool === 'ROTATE' && pts.length === 1) {
      drawEntity({ type: 'line', points: [pts[0], worldCursor] }, $('preview'), ghostStyle);
      if (distance(pts[0], worldCursor) > 1e-4) {
        const ang =
          (Math.atan2(worldCursor[1] - pts[0][1], worldCursor[0] - pts[0][0]) * 180) / Math.PI;
        for (const ent of store.selectedEditable()) {
          drawEntity(rotateEntity(ent, pts[0], ang), $('preview'), ghostStyle);
        }
      }
    } else if (engine.tool === 'MIRROR' && pts.length === 1) {
      drawEntity({ type: 'line', points: [pts[0], worldCursor] }, $('preview'), ghostStyle);
      if (distance(pts[0], worldCursor) > 1e-4) {
        for (const ent of store.selectedEditable()) {
          drawEntity(mirrorEntity(ent, pts[0], worldCursor), $('preview'), ghostStyle);
        }
      }
    } else if (engine.tool === 'DIST' && pts.length === 1) {
      drawEntity({ type: 'line', points: [pts[0], worldCursor] }, $('preview'), ghostStyle);
    }
  }

  if (selectBox) {
    const { start: a, end: b } = selectBox;
    const crossing = a[0] > b[0];
    node(
      'rect',
      {
        x: Math.min(a[0], b[0]),
        y: Math.min(a[1], b[1]),
        width: Math.abs(a[0] - b[0]),
        height: Math.abs(a[1] - b[1]),
        fill: crossing ? '#3a7a4c22' : '#3a6ea522',
        stroke: crossing ? '#57b872' : '#5aa9e6',
        'stroke-width': 1,
        'stroke-dasharray': crossing ? '4 3' : 'none',
        'vector-effect': 'non-scaling-stroke',
      },
      $('preview'),
    );
  }

  $('cursor').replaceChildren();
  if (worldCursor) {
    const [cx, cy] = worldCursor;
    const pick = 3.5 / view.scale;
    const arm = 22 / view.scale;
    node(
      'path',
      {
        d: `M ${cx - arm} ${cy} H ${cx - pick} M ${cx + pick} ${cy} H ${cx + arm} M ${cx} ${cy - arm} V ${cy - pick} M ${cx} ${cy + pick} V ${cy + arm}`,
        stroke: '#8a95a5',
        'stroke-width': 0.9,
        'vector-effect': 'non-scaling-stroke',
      },
      $('cursor'),
    );
    if (!engine.tool) {
      node(
        'rect',
        {
          x: cx - pick,
          y: cy - pick,
          width: pick * 2,
          height: pick * 2,
          fill: 'none',
          stroke: '#8a95a5',
          'stroke-width': 0.9,
          'vector-effect': 'non-scaling-stroke',
        },
        $('cursor'),
      );
    }
    if (snapped) {
      drawOsnapGlyph(snapped, $('cursor'));
    }
  }
  $('empty-guide').hidden = Boolean(store.document.entities.length || engine.tool);
}

function makeRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function setRepairGhost(ghost) {
  repairGhost = ghost;
  const banner = $('lint-diff-banner');
  if (banner) {
    if (ghost && ghost.diffSummary) {
      banner.replaceChildren();
      const label = document.createElement('strong');
      label.textContent = t().fixPreviewLabel;
      const body = document.createElement('span');
      body.textContent = ghost.diffSummary;
      banner.append(label, body);
      banner.hidden = false;
    } else {
      banner.hidden = true;
      banner.replaceChildren();
    }
  }
  renderGeometry();
}

function computeBatchRepairs(doc) {
  let working = structuredClone(doc);
  const applied = [];
  const previewEntities = [];
  for (let step = 0; step < 16; step++) {
    const report = lintDrawing(working);
    let fixedOne = false;
    for (const issue of report.issues) {
      const fix = previewDrcFix(working, issue);
      if (fix) {
        working = fix.nextDoc;
        applied.push({ code: issue.code, diffSummary: fix.diffSummary });
        for (const pe of fix.previewEntities) {
          const idx = previewEntities.findIndex((x) => x.id === pe.id);
          if (idx >= 0) previewEntities[idx] = pe;
          else previewEntities.push(pe);
        }
        fixedOne = true;
        break;
      }
    }
    if (!fixedOne) break;
  }
  if (!applied.length) return null;
  return {
    nextDoc: working,
    applied,
    previewEntities,
    diffSummary: applied.map((a) => a.diffSummary).join(' · '),
  };
}

function pushWorkspaceState(forceReconcile = false) {
  if (!bridgeConnected) return;
  const currentJson = JSON.stringify(store.document);
  if (lastObservedLocalJson !== null && currentJson !== lastObservedLocalJson) {
    localEditEpoch += 1;
  }
  lastObservedLocalJson = currentJson;
  if (currentJson === lastSyncedJson) {
    syncConflictRevision = 0;
    return;
  }
  if (!forceReconcile && (syncConflictRevision > 0 || currentJson === lastRejectedSyncJson)) {
    return;
  }
  if (pendingSyncJson !== null) {
    if (forceReconcile) queuedForcePush = true;
    return;
  }
  queuedForcePush = false;
  pendingSyncJson = currentJson;
  const payload = {
    drawing: JSON.parse(currentJson),
    request_id: makeRequestId(),
  };
  if (serverRevision > 0) payload.expected_revision = serverRevision;
  fetch('/api/drawing/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
    .then(async (res) => {
      let shouldFollowUpPush = false;
      let shouldFollowUpCleanPull = false;
      try {
        if (res.status === 404) {
          markBridgeDisconnected();
        } else if (res.status === 409) {
          const conflictData = await res.json().catch(() => null);
          const remoteRev = conflictData?.revision || serverRevision + 1;
          knownServerRevision = Math.max(knownServerRevision, serverRevision, remoteRev);
          if (queuedForcePush) {
            serverRevision = Math.max(serverRevision, remoteRev);
            syncConflictRevision = 0;
            lastRejectedSyncJson = null;
            shouldFollowUpPush = true;
          } else if (JSON.stringify(store.document) === lastSyncedJson) {
            syncConflictRevision = 0;
            shouldFollowUpCleanPull = true;
          } else {
            syncConflictRevision = Math.max(syncConflictRevision, remoteRev);
            log(
              `SYNC: Sunucu revizyon uyuşmazlığı (#${remoteRev}) — yerel değişiklikler korundu ('SYNC PUSH' veya 'SYNC PULL').`,
              true,
            );
          }
        } else if (!res.ok) {
          await res.json().catch(() => null);
          lastRejectedSyncJson = currentJson;
        } else {
          const data = await res.json();
          const ackRev = data.revision || 0;
          lastRejectedSyncJson = null;
          syncConflictRevision = 0;
          lastSyncedJson = currentJson;
          serverRevision = Math.max(serverRevision, ackRev);
          knownServerRevision = Math.max(knownServerRevision, serverRevision);
          if (JSON.stringify(store.document) !== lastSyncedJson) {
            shouldFollowUpPush = true;
          }
        }
      } finally {
        pendingSyncJson = null;
      }
      if (!bridgeConnected) {
        return;
      }
      if (queuedPullSnapshotJson !== null) {
        const snap = queuedPullSnapshotJson;
        const snapEpoch = queuedPullEditEpoch;
        queuedPullSnapshotJson = null;
        const nowJson = JSON.stringify(store.document);
        if (lastObservedLocalJson !== null && nowJson !== lastObservedLocalJson) {
          localEditEpoch += 1;
        }
        lastObservedLocalJson = nowJson;
        if (localEditEpoch === snapEpoch && nowJson === snap) {
          pollWorkspaceState(true, snap);
          return;
        }
        pollWorkspaceState(true, null);
        return;
      }
      if (shouldFollowUpCleanPull) {
        pollWorkspaceState(true, null);
        return;
      }
      if (shouldFollowUpPush || queuedForcePush) {
        const forceNext = queuedForcePush;
        queuedForcePush = false;
        pushWorkspaceState(forceNext);
      }
    })
    .catch(() => {
      pendingSyncJson = null;
      markBridgeDisconnected();
    });
}

let syncConflictRevision = 0;
let knownServerRevision = 0;
let lastRejectedSyncJson = null;
let queuedForcePush = false;
let queuedPullSnapshotJson = null;
let queuedPullEditEpoch = 0;
let lastObservedLocalJson = null;
let localEditEpoch = 0;

function markBridgeDisconnected() {
  const wasConnected = bridgeConnected;
  bridgeConnected = false;
  knownServerRevision = 0;
  syncConflictRevision = 0;
  lastRejectedSyncJson = null;
  queuedForcePush = false;
  queuedPullSnapshotJson = null;
  if (wasConnected) {
    renderRuntimeSelect();
  }
}

function reconcileSyncConflict(mode) {
  if (mode === 'push') {
    const targetRev = Math.max(serverRevision, knownServerRevision, syncConflictRevision);
    if (targetRev > serverRevision) {
      serverRevision = targetRev;
    }
    knownServerRevision = Math.max(knownServerRevision, serverRevision);
    syncConflictRevision = 0;
    lastRejectedSyncJson = null;
    if (pendingSyncJson !== null) {
      queuedForcePush = true;
      return;
    }
    pushWorkspaceState(true);
    return;
  }
  if (mode === 'pull') {
    knownServerRevision = Math.max(knownServerRevision, serverRevision, syncConflictRevision);
    syncConflictRevision = 0;
    lastRejectedSyncJson = null;
    const targetLocalJson = JSON.stringify(store.document);
    if (lastObservedLocalJson !== null && targetLocalJson !== lastObservedLocalJson) {
      localEditEpoch += 1;
    }
    lastObservedLocalJson = targetLocalJson;
    if (pendingSyncJson !== null) {
      queuedPullSnapshotJson = targetLocalJson;
      queuedPullEditEpoch = localEditEpoch;
      return;
    }
    return pollWorkspaceState(true, targetLocalJson);
  }
}

async function pollWorkspaceState(force = false, overwriteLocalSnapshot = null) {
  if (!force && (document.hidden || engine.tool || panning || selectBox || requestBusy)) {
    return;
  }
  const hasExplicitPullSnapshot = typeof overwriteLocalSnapshot === 'string';
  if (!hasExplicitPullSnapshot && pendingSyncJson !== null) {
    return;
  }
  const localBeforeFetch = JSON.stringify(store.document);
  if (lastObservedLocalJson !== null && localBeforeFetch !== lastObservedLocalJson) {
    localEditEpoch += 1;
  }
  lastObservedLocalJson = localBeforeFetch;
  const dispatchEditEpoch = localEditEpoch;
  try {
    const res = await fetch('/api/drawing/state');
    const isJson = (res.headers.get('content-type') || '').includes('application/json');
    if (!res.ok || !isJson) {
      markBridgeDisconnected();
      return;
    }
    const data = await res.json();
    if (!data || !data.drawing || !Array.isArray(data.drawing.entities)) {
      markBridgeDisconnected();
      return;
    }
    const firstConnect = !bridgeConnected;
    bridgeConnected = true;
    if (firstConnect) {
      serverRevision = 0;
      knownServerRevision = 0;
      syncConflictRevision = 0;
      renderRuntimeSelect();
      refreshRuntimes(false);
      if (store.document.entities.length > 0 && data.drawing.entities.length === 0) {
        serverRevision = data.revision || 0;
        knownServerRevision = serverRevision;
        lastSyncedJson = '';
        pushWorkspaceState(true);
        return;
      }
    }
    const remoteRev = data.revision || 0;
    const highestKnownRev = Math.max(knownServerRevision, serverRevision, syncConflictRevision);
    if (!firstConnect && remoteRev < highestKnownRev) {
      return;
    }
    if (!hasExplicitPullSnapshot && remoteRev <= serverRevision) {
      return;
    }
    knownServerRevision = Math.max(highestKnownRev, remoteRev);
    const remoteJson = JSON.stringify(data.drawing);
    const localJsonNow = JSON.stringify(store.document);
    if (lastObservedLocalJson !== null && localJsonNow !== lastObservedLocalJson) {
      localEditEpoch += 1;
    }
    lastObservedLocalJson = localJsonNow;
    const localUnchangedSinceDispatch =
      localEditEpoch === dispatchEditEpoch && localJsonNow === localBeforeFetch;
    const allowExplicitPull =
      hasExplicitPullSnapshot &&
      localUnchangedSinceDispatch &&
      localJsonNow === overwriteLocalSnapshot &&
      pendingSyncJson === null;
    const hasUnsyncedLocal = pendingSyncJson !== null || localJsonNow !== lastSyncedJson;
    if (!allowExplicitPull && hasUnsyncedLocal) {
      if (
        pendingSyncJson === null &&
        remoteRev > serverRevision &&
        syncConflictRevision !== remoteRev
      ) {
        syncConflictRevision = Math.max(syncConflictRevision, remoteRev);
        log(
          `SYNC: Uzak revizyon #${remoteRev} algılandı — yerel değişiklikler korundu ('SYNC PUSH' veya 'SYNC PULL').`,
          true,
        );
      }
      return;
    }
    if (!allowExplicitPull && remoteJson === localJsonNow && pendingSyncJson === null) {
      serverRevision = Math.max(serverRevision, remoteRev);
      lastSyncedJson = remoteJson;
      syncConflictRevision = 0;
      return;
    }
    serverRevision = Math.max(serverRevision, remoteRev);
    if (
      serverRevision <= 1 &&
      data.drawing.entities.length === 0 &&
      store.document.entities.length === 0
    ) {
      return;
    }
    const wasEmpty = store.document.entities.length === 0;
    syncConflictRevision = 0;
    lastRejectedSyncJson = null;
    lastSyncedJson = remoteJson;
    store.commit(data.drawing);
    saved = JSON.stringify(store.document);
    lastSyncedJson = saved;
    lastObservedLocalJson = saved;
    render();
    if (wasEmpty && store.document.entities.length > 0) fit();
    log(`SYNC: Workspace updated (rev #${serverRevision}).`);
  } catch {
    markBridgeDisconnected();
  }
}

function renderRuntimeSelect() {
  const sel = $('runtime-select');
  if (!sel) return;
  const previous = sel.value;
  sel.replaceChildren();
  if (!bridgeConnected) {
    const opt = document.createElement('option');
    opt.value = 'browser:standalone';
    opt.textContent = t().bridgeStandalone;
    sel.append(opt);
    $('runtime-led').classList.remove('external');
    return;
  }
  if (!runtimeCatalog.length) {
    const opt = document.createElement('option');
    opt.value = 'parametric:chamfer-rule-v1';
    opt.textContent = t().runtimeOffline;
    sel.append(opt);
    $('runtime-led').classList.remove('external');
    return;
  }
  for (const item of runtimeCatalog) {
    const opt = document.createElement('option');
    opt.value = item.id;
    opt.textContent = item.kind === 'parametric' ? t().runtimeOffline : item.label.toUpperCase();
    sel.append(opt);
  }
  if ([...sel.options].some((o) => o.value === previous)) {
    sel.value = previous;
  } else {
    sel.value = runtimeCatalog[0].id;
  }
  const activeObj = runtimeCatalog.find((r) => r.id === sel.value) || runtimeCatalog[0];
  $('runtime-led').classList.toggle('external', activeObj.kind !== 'parametric');
}

async function refreshRuntimes(manual = false) {
  try {
    const res = await fetch('/api/drawing/runtime');
    const isJson = (res.headers.get('content-type') || '').includes('application/json');
    if (!res.ok || !isJson) {
      bridgeConnected = false;
      renderRuntimeSelect();
      if (manual) log(t().bridgeStandalone);
      return;
    }
    bridgeConnected = true;
    const data = await res.json();
    runtimeCatalog = Array.isArray(data.available) ? data.available : [];
    const topExternal = runtimeCatalog.find((r) => r.kind !== 'parametric') || null;
    renderRuntimeSelect();
    if (topExternal && topExternal.id !== lastExternalRuntimeId) {
      lastExternalRuntimeId = topExternal.id;
      $('runtime-select').value = topExternal.id;
      renderRuntimeSelect();
      log(`RUNTIME: Connected -> ${topExternal.label} (${topExternal.base_url})`);
    } else if (!topExternal) {
      lastExternalRuntimeId = null;
      if (manual) log(`RUNTIME: ${t().runtimeOffline}`);
    } else if (manual) {
      log(`RUNTIME: Active -> ${topExternal.label}`);
    }
  } catch {
    bridgeConnected = false;
    renderRuntimeSelect();
    if (manual) log(t().bridgeStandalone);
  }
}

async function runSynthesis(specText) {
  if (requestBusy) return;
  if (!bridgeConnected) {
    log(t().bridgeRequiredSynth, true);
    return;
  }
  requestBusy = true;
  $('command-prompt').textContent = t().synthBusy;
  try {
    engine.cancel();
    const runtime = $('runtime-select').value;
    const res = await fetch('/api/drawing/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec: specText, runtime, max_repairs: 3 }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Synthesis failed.');
    const totalPasses = data.passes.length;
    for (const step of data.passes) {
      if (step.errors > 0) {
        const codes = step.issues.join(', ');
        const note = step.repair_note ? ` · ${step.repair_note}` : '';
        log(`SYNTH [${step.pass}/${totalPasses}] · ${step.errors} DRC ERR (${codes})${note}`, true);
      } else {
        log(
          `SYNTH [${step.pass}/${totalPasses}] · ${data.runtime.label} · ${data.drawing.entities.length} ENTITIES · 0 DRC ERRORS`,
        );
      }
    }
    serverRevision = Math.max(serverRevision, data.revision || 0);
    knownServerRevision = Math.max(knownServerRevision, serverRevision);
    syncConflictRevision = 0;
    lastRejectedSyncJson = null;
    lastSyncedJson = JSON.stringify(data.drawing);
    store.commit(data.drawing);
    saved = lastSyncedJson;
    lastObservedLocalJson = saved;
    render();
    fit();
  } catch (error) {
    log(error.message, true);
    render();
  } finally {
    requestBusy = false;
    $('command-prompt').textContent = engine.prompt;
  }
}

function renderPresetSelect() {
  const s = t();
  const sel = $('preset-select');
  sel.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = s.presetPlaceholder;
  sel.append(placeholder);
  for (const [key, label] of Object.entries(s.presets)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = label;
    sel.append(opt);
  }
}

function applyLocaleLabels() {
  const s = t();
  document.documentElement.lang = lang;
  $('new-drawing').textContent = s.newBtn;
  $('open-drawing').textContent = s.openBtn;
  $('save-drawing').textContent = s.saveBtn;
  $('export-dxf').textContent = s.exportDxf;
  $('export-svg').textContent = s.exportSvg;
  $('open-extrude').textContent = s.extrude3dBtn;
  renderPresetSelect();
  $('link-3d').textContent = s.solid3d;
  $('lbl-active-layer').textContent = s.activeLayer;
  $('btn-undo').textContent = s.undo;
  $('btn-redo').textContent = s.redo;
  $('zoom-fit').textContent = s.fit;
  $('btn-drc').textContent = s.runDrc;
  $('view-label').textContent = s.viewTop;
  $('empty-title').textContent = s.emptyTitle;
  $('empty-hint').textContent = s.emptyHint;
  $('sec-props').textContent = s.secProps;
  $('sec-cam').textContent = s.secCam;
  $('sec-drc').textContent = s.secDrc;
  $('sec-layers').textContent = s.secLayers;
  $('layer-name').placeholder = s.newLayerPh;
  $('lbl-cmd').textContent = s.cmdLabel;
  $('command-input').placeholder = s.cmdPh;
  $('cancel-command').textContent = s.escBtn;
  $('toggle-grid').textContent = s.grid;
  $('toggle-snap').textContent = s.snap;
  $('toggle-ortho').textContent = s.ortho;
  $('toggle-osnap').textContent = s.osnap;
  $('lbl-runtime').textContent = s.runtimeTag;
  $('runtime-scan').textContent = s.runtimeScan;
  $('extrude-modal-title').textContent = s.modalTitle;
  $('close-extrude').textContent = s.modalClose;
  $('extrude-hint').textContent = s.modalHint;
  $('lbl-thickness').textContent = s.lblThickness;
  $('rebuild-extrude').textContent = s.btnRebuild3d;
  $('iso-extrude').textContent = s.btnIso3d;
  $('download-step').textContent = s.btnDownloadStep;
  $('download-stl').textContent = s.btnDownloadStl;
  renderRuntimeSelect();
  $('lang-tr').classList.toggle('active', lang === 'tr');
  $('lang-en').classList.toggle('active', lang === 'en');
  for (const button of document.querySelectorAll('.tool-dock [data-tool]')) {
    const key = button.dataset.tool;
    if (s.toolNames[key]) button.title = s.toolNames[key];
  }
  const eraseBtn = document.querySelector('.tool-dock [data-command="ERASE"]');
  if (eraseBtn) eraseBtn.title = s.toolNames.ERASE;
}

function eyeSvg(visible) {
  return visible
    ? '<svg viewBox="0 0 16 16"><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>'
    : '<svg viewBox="0 0 16 16"><line x1="2" y1="2" x2="14" y2="14"/><path d="M4 5.5C2.5 6.7 1.5 8 1.5 8s2.5 4.5 6.5 4.5c1.5 0 2.8-.5 3.9-1.2"/></svg>';
}

function lockSvg(locked) {
  return locked
    ? '<svg viewBox="0 0 16 16"><rect x="3.5" y="7.5" width="9" height="6.5"/><path d="M5.5 7.5V5a2.5 2.5 0 0 1 5 0v2.5"/></svg>'
    : '<svg viewBox="0 0 16 16"><rect x="3.5" y="7.5" width="9" height="6.5"/><path d="M5.5 7.5V5a2.5 2.5 0 0 1 4.7-1.1"/></svg>';
}

function renderCamTelemetry() {
  const s = t();
  const thickness = Math.max(0.2, Number($('extrude-thickness')?.value) || 4.0);
  const cam = computeCamMetrics(store.document, thickness);
  const camDl = $('cam-properties');
  camDl.replaceChildren();
  const rows = [
    [s.camCut, `${cam.cut_length_mm.toFixed(2)} mm`],
    [s.camPierces, `${cam.pierce_count}`],
    [s.camArea, `${cam.net_area_mm2.toFixed(1)} mm²`],
    [
      s.camMass(thickness),
      `${cam.mass_al6061_g.toFixed(1)}g Al · ${cam.mass_steel_s235_g.toFixed(1)}g Fe`,
    ],
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'),
      dd = document.createElement('dd');
    dt.textContent = k;
    dd.textContent = v;
    camDl.append(dt, dd);
  }
}

function render() {
  const s = t();
  repairGhost = null;
  const diffBanner = $('lint-diff-banner');
  if (diffBanner) {
    diffBanner.hidden = true;
    diffBanner.replaceChildren();
  }
  applyLocaleLabels();
  lintReport = lintDrawing(store.document);
  pushWorkspaceState();
  renderGeometry();
  renderCamTelemetry();

  const summaryEl = $('lint-summary');
  const listEl = $('lint-list');
  const fixAllBtn = $('fix-all-drc');
  summaryEl.className = `lint-badge ${lintReport.status === 'passed' ? 'clean' : lintReport.status}`;
  if (!store.document.entities.length) {
    summaryEl.textContent = s.drcEmpty;
  } else if (lintReport.status === 'passed') {
    summaryEl.textContent = s.drcPass(lintReport.summary.checked_entities);
  } else if (lintReport.status === 'warnings') {
    summaryEl.textContent = s.drcWarn(lintReport.summary.warnings);
  } else {
    summaryEl.textContent = s.drcFail(lintReport.summary.errors, lintReport.summary.warnings);
  }

  currentBatchRepair = lintReport.issues.length ? computeBatchRepairs(store.document) : null;
  if (fixAllBtn) {
    if (currentBatchRepair) {
      fixAllBtn.textContent = s.fixAllBtn(currentBatchRepair.applied.length);
      fixAllBtn.hidden = false;
    } else {
      fixAllBtn.hidden = true;
    }
  }

  listEl.replaceChildren();
  for (const issue of lintReport.issues) {
    const card = document.createElement('div');
    card.className = `lint-card ${issue.severity}`;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lint-item';
    btn.textContent = `[${issue.code}] ${issue.message}`;
    const hint = document.createElement('small');
    hint.textContent = `@(${issue.point[0]}, ${issue.point[1]}) · ${issue.fix_hint}`;
    btn.append(hint);
    btn.addEventListener('click', () => {
      store.selection.clear();
      for (const id of issue.entities) store.selection.add(id);
      view.center = [...issue.point];
      render();
    });
    card.append(btn);

    const fix = previewDrcFix(store.document, issue);
    if (fix) {
      const fixBtn = document.createElement('button');
      fixBtn.type = 'button';
      fixBtn.className = 'lint-fix-btn';
      fixBtn.dataset.fixIssue = issue.code;
      fixBtn.textContent = s.fixBtn;
      fixBtn.addEventListener('pointerenter', () => setRepairGhost(fix));
      fixBtn.addEventListener('focus', () => setRepairGhost(fix));
      fixBtn.addEventListener('pointerleave', () => setRepairGhost(null));
      fixBtn.addEventListener('blur', () => setRepairGhost(null));
      fixBtn.addEventListener('click', () =>
        attempt(() => {
          engine.cancel();
          store.commit(fix.nextDoc);
          log(t().repairAppliedLog(issue.code, fix.diffSummary));
          render();
        }),
      );
      card.append(fixBtn);
    }

    listEl.append(card);
  }

  $('command-prompt').textContent = engine.prompt;
  $('drawing-name').textContent = store.document.name;
  $('tab-name').textContent = store.document.name;
  $('dirty-indicator').hidden = saved === JSON.stringify(store.document);
  $('entity-count').textContent = s.entitiesCount(store.document.entities.length);

  for (const button of document.querySelectorAll('[data-tool]'))
    button.classList.toggle('active', button.dataset.tool === engine.tool);
  $('btn-undo').disabled = !store.canUndo;
  $('btn-redo').disabled = !store.canRedo;

  $('current-layer').replaceChildren();
  $('layer-list').replaceChildren();
  const activeLayerObj = store.currentLayer;
  if (activeLayerObj) {
    const swatchEl = $('active-layer-swatch');
    swatchEl.replaceChildren(node('svg', { width: 10, height: 10, viewBox: '0 0 10 10' }, null));
    node('rect', { width: 10, height: 10, fill: activeLayerObj.color }, swatchEl.firstElementChild);
  }

  for (const layer of store.document.layers) {
    const option = document.createElement('option');
    option.value = layer.id;
    option.textContent = layer.name;
    $('current-layer').append(option);

    const row = document.createElement('div');
    row.className = 'layer-row';

    const visBtn = document.createElement('button');
    visBtn.type = 'button';
    visBtn.className = 'layer-icon-btn';
    visBtn.innerHTML = eyeSvg(layer.visible);
    visBtn.setAttribute('aria-pressed', String(layer.visible));
    visBtn.title = layer.visible ? 'Visible' : 'Hidden';
    visBtn.addEventListener('click', () =>
      attempt(() => {
        store.updateLayer(layer.id, { visible: !layer.visible });
        render();
      }),
    );

    const lockBtn = document.createElement('button');
    lockBtn.type = 'button';
    lockBtn.className = 'layer-icon-btn lock-btn';
    lockBtn.innerHTML = lockSvg(layer.locked);
    lockBtn.setAttribute('aria-pressed', String(layer.locked));
    lockBtn.title = layer.locked ? 'Locked' : 'Unlocked';
    lockBtn.addEventListener('click', () =>
      attempt(() => {
        store.updateLayer(layer.id, { locked: !layer.locked });
        render();
      }),
    );

    const color = document.createElement('input');
    color.type = 'color';
    color.value = layer.color;
    color.setAttribute('aria-label', `${layer.name} color`);
    color.addEventListener('change', () =>
      attempt(() => {
        store.updateLayer(layer.id, { color: color.value });
        render();
      }),
    );

    const label = document.createElement('button');
    label.type = 'button';
    label.className = `layer-name ${store.layer === layer.id ? 'active' : ''}`;
    label.textContent = layer.name;
    label.addEventListener('click', () => {
      store.layer = layer.id;
      render();
    });

    row.append(visBtn, lockBtn, color, label);
    $('layer-list').append(row);
  }
  $('current-layer').value = store.layer;

  const selected = store.selectedEditable();
  const propsEl = $('selection-properties');
  propsEl.replaceChildren();
  if (!selected.length) {
    propsEl.className = 'prop-empty';
    propsEl.textContent = s.noSelection;
  } else {
    propsEl.className = '';
    const dl = document.createElement('dl');
    const first = selected[0],
      layer = store.document.layers.find((l) => l.id === first.layer);
    const pairs = [
      [s.propSelection, `${selected.length}`],
      [s.propType, first.type.toUpperCase()],
      [s.propLayer, layer ? layer.name : first.layer],
    ];
    if (first.type === 'circle') {
      pairs.push(
        [s.propCenter, first.center.map((n) => n.toFixed(3)).join(', ')],
        [s.propRadius, `${first.radius.toFixed(3)} mm`],
      );
    } else if (first.type === 'arc') {
      const sweep = arcSweepDeg(first.start_angle, first.end_angle);
      pairs.push(
        [s.propCenter, first.center.map((n) => n.toFixed(3)).join(', ')],
        [s.propRadius, `${first.radius.toFixed(3)} mm`],
        [s.propSweep, `${sweep.toFixed(2)}°`],
      );
    } else if (first.type === 'dim') {
      pairs.push([s.propMeasurement, `${distance(first.p1, first.p2).toFixed(3)} mm`]);
    } else if (first.type === 'text') {
      pairs.push([s.propHeight, `${first.height.toFixed(2)} mm`], [s.propText, first.text]);
    } else {
      pairs.push(
        [s.propVertices, String(first.points.length)],
        [
          s.propLength,
          `${first.points
            .slice(1)
            .reduce(
              (sum, p, i) => sum + distance(p, first.points[i]),
              first.closed ? distance(first.points[0], first.points.at(-1)) : 0,
            )
            .toFixed(3)} mm`,
        ],
      );
    }
    for (const [key, value] of pairs) {
      const dt = document.createElement('dt'),
        dd = document.createElement('dd');
      dt.textContent = key;
      dd.textContent = value;
      dl.append(dt, dd);
    }
    propsEl.append(dl);
  }
}

function fit() {
  const box = drawingBounds(store.document);
  view.center = [(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2];
  const rect = canvas.getBoundingClientRect();
  view.scale =
    Math.min(
      rect.width / Math.max(box.maxX - box.minX, 20),
      rect.height / Math.max(box.maxY - box.minY, 20),
    ) * 0.76;
  renderGeometry();
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function download(text, filename, type = 'application/json') {
  downloadBlob(new Blob([text], { type }), filename);
}

function toggle(key) {
  settings[key] = !settings[key];
  $('toggle-' + key).setAttribute('aria-pressed', String(settings[key]));
  renderGeometry();
}

function setLanguage(nextLang) {
  lang = nextLang;
  localStorage.setItem('chamfer.lang', lang);
  render();
}

$('lang-tr').addEventListener('click', () => setLanguage('tr'));
$('lang-en').addEventListener('click', () => setLanguage('en'));

for (const button of document.querySelectorAll('[data-tool]'))
  button.addEventListener('click', () =>
    attempt(() => {
      engine.start(button.dataset.tool);
      $('command-input').focus();
    }),
  );
for (const button of document.querySelectorAll('[data-command]'))
  button.addEventListener('click', () => attempt(() => engine.execute(button.dataset.command)));

$('command-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = $('command-input').value;
  const trimmed = text.trim();
  $('command-input').value = '';
  if (trimmed.startsWith('?')) {
    log(`> ${trimmed}`);
    runSynthesis(trimmed.slice(1).trim());
    return;
  }
  if (/^synth\s+/i.test(trimmed)) {
    log(`> ${trimmed}`);
    runSynthesis(trimmed.replace(/^synth\s+/i, '').trim());
    return;
  }
  if (/^sync\s+(push|pull)$/i.test(trimmed)) {
    const mode = trimmed.split(/\s+/)[1].toLowerCase();
    log(`> ${trimmed}`);
    reconcileSyncConflict(mode);
    return;
  }
  log(`> ${text}`);
  attempt(() => engine.execute(text));
  render();
});
$('runtime-scan').addEventListener('click', () => refreshRuntimes(true));
$('runtime-select').addEventListener('change', () => renderRuntimeSelect());
$('cancel-command').addEventListener('click', () => attempt(() => engine.end()));
$('zoom-fit').addEventListener('click', fit);
$('current-layer').addEventListener('change', (event) => {
  store.layer = event.target.value;
  render();
});
$('layer-form').addEventListener('submit', (event) => {
  event.preventDefault();
  attempt(() => {
    store.addLayer($('layer-name').value.trim());
    $('layer-name').value = '';
    render();
  });
});
for (const key of Object.keys(settings))
  $('toggle-' + key).addEventListener('click', () => toggle(key));

canvas.addEventListener('pointerdown', (event) => {
  if (event.button === 1) {
    event.preventDefault();
    panning = { x: event.clientX, y: event.clientY, center: [...view.center] };
    canvas.setPointerCapture(event.pointerId);
    return;
  }
  if (event.button !== 0) return;
  if (engine.tool) {
    attempt(() => engine.point(constrained(pointAt(event))));
    if (engine.tool === 'TEXT' && engine.points.length === 1) {
      $('command-input').focus();
    }
    return;
  }
  const target = event.target.closest('[data-entity]');
  if (target) {
    store.select(target.dataset.entity, event.shiftKey);
    render();
  } else {
    const point = pointAt(event);
    selectBox = { start: point, end: point, additive: event.shiftKey };
    canvas.setPointerCapture(event.pointerId);
  }
});

canvas.addEventListener('pointermove', (event) => {
  if (panning) {
    view.center = [
      panning.center[0] - (event.clientX - panning.x) / view.scale,
      panning.center[1] + (event.clientY - panning.y) / view.scale,
    ];
    renderGeometry();
    return;
  }
  if (selectBox) {
    selectBox.end = pointAt(event);
    renderGeometry();
    return;
  }
  worldCursor = constrained(pointAt(event));
  $('coordinates').textContent =
    `X: ${worldCursor[0].toFixed(4)}   Y: ${worldCursor[1].toFixed(4)}   mm`;
  renderGeometry();
});

canvas.addEventListener('pointerup', () => {
  panning = null;
  if (selectBox) {
    const box = selectBox;
    selectBox = null;
    if (!box.additive) store.selection.clear();
    if (distance(box.start, box.end) * view.scale > 3)
      for (const id of entitiesInBox(store.document, box.start, box.end)) store.selection.add(id);
    render();
  }
});
canvas.addEventListener('pointercancel', () => {
  panning = null;
  selectBox = null;
  renderGeometry();
});
canvas.addEventListener('pointerleave', () => {
  worldCursor = null;
  snapped = null;
  renderGeometry();
});
canvas.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    const before = pointAt(event);
    view.scale = Math.max(0.0001, Math.min(10000, view.scale * Math.exp(-event.deltaY * 0.001)));
    const after = pointAt(event);
    view.center = view.center.map((v, i) => v + before[i] - after[i]);
    renderGeometry();
  },
  { passive: false },
);

document.addEventListener('keydown', (event) => {
  if (!$('extrude-modal').hidden) {
    if (event.key === 'Escape') {
      event.preventDefault();
      $('extrude-modal').hidden = true;
    }
    return;
  }
  const editing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);
  if (event.key === 'Escape') {
    event.preventDefault();
    attempt(() => engine.end());
    if (!editing) store.selection.clear();
    render();
    return;
  }
  const keys = { F3: 'osnap', F7: 'grid', F8: 'ortho', F9: 'snap' };
  if (keys[event.key]) {
    event.preventDefault();
    toggle(keys[event.key]);
    return;
  }
  if (editing) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    attempt(() => engine.execute(event.shiftKey ? 'REDO' : 'UNDO'));
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
    event.preventDefault();
    attempt(() => engine.execute('REDO'));
  } else if (event.key === 'Delete') {
    event.preventDefault();
    attempt(() => engine.execute('ERASE'));
  } else if (event.key === 'Enter') {
    event.preventDefault();
    attempt(() => engine.execute(''));
    $('command-input').focus();
  } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    $('command-input').value += event.key;
    $('command-input').focus();
  }
});

$('save-drawing').addEventListener('click', () =>
  attempt(() => {
    engine.finish();
    const text = JSON.stringify(store.document, null, 2) + '\n';
    download(text, `${store.document.name || 'drawing'}.cadlab.json`);
    saved = JSON.stringify(store.document);
    log(t().savedLog);
    render();
  }),
);
$('open-drawing').addEventListener('click', () => $('drawing-file').click());
$('drawing-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file || requestBusy) return;
  try {
    if (file.size > 1024 * 1024) throw new Error('Max file size is 1 MiB.');
    const text = await file.text();
    let data;
    requestBusy = true;
    $('open-drawing').disabled = true;
    if (file.name.toLowerCase().endsWith('.dxf')) {
      const baseName = file.name.replace(/\.dxf$/i, '') || 'Imported';
      if (bridgeConnected) {
        let response = null;
        try {
          response = await fetch('/api/drawing/import-dxf', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dxf: text }),
          });
        } catch {
          bridgeConnected = false;
          renderRuntimeSelect();
        }
        if (response) {
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || 'DXF import failed.');
          data = result.drawing;
          log(`DXF: ${result.report.entities} entities (mm).`);
        } else {
          const result = importDrawingFromDxf(text, baseName);
          data = result.drawing;
          log(`DXF: ${result.report.entities} entities (mm).`);
        }
      } else {
        const result = importDrawingFromDxf(text, baseName);
        data = result.drawing;
        log(`DXF: ${result.report.entities} entities (mm).`);
      }
    } else data = JSON.parse(text);
    const next = validateDrawing(data);
    engine.cancel();
    store.commit(next);
    saved = JSON.stringify(store.document);
    log(t().openedLog);
    render();
    fit();
  } catch (error) {
    log(error.message, true);
  } finally {
    event.target.value = '';
    requestBusy = false;
    $('open-drawing').disabled = false;
  }
});

$('new-drawing').addEventListener('click', () => {
  if (saved !== JSON.stringify(store.document)) {
    log(t().saveBeforeNew, true);
    return;
  }
  engine.cancel();
  store.commit(emptyDrawing());
  saved = JSON.stringify(store.document);
  store.layer = '0';
  render();
  fit();
});

$('preset-select').addEventListener('change', (event) => {
  const key = event.target.value;
  event.target.value = '';
  const buildPreset = getPresetBuilder(key);
  if (!buildPreset) return;
  if (store.document.entities.length && saved !== JSON.stringify(store.document)) {
    log(t().clearBeforeSample, true);
    return;
  }
  engine.cancel();
  const doc = buildPreset();
  store.commit(doc);
  saved = JSON.stringify(store.document);
  render();
  fit();
  if (key === 'fault') {
    log(t().drcLoadedLog(lintReport.summary.errors, lintReport.summary.warnings), true);
  } else {
    log(t().presetLoadedLog(doc.name));
  }
});

$('export-dxf').addEventListener('click', async () => {
  if (requestBusy) return;
  try {
    engine.finish();
    requestBusy = true;
    $('export-dxf').disabled = true;
    let dxfText = null;
    if (bridgeConnected) {
      let response = null;
      try {
        response = await fetch('/api/drawing/dxf', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(store.document),
        });
      } catch {
        bridgeConnected = false;
        renderRuntimeSelect();
      }
      if (response) {
        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || 'DXF export failed.');
        }
        dxfText = await response.text();
      }
    }
    if (dxfText === null) {
      dxfText = exportDrawingToDxf(store.document);
    }
    download(dxfText, `${store.document.name || 'drawing'}.dxf`, 'application/dxf');
    log(t().dxfExportLog);
  } catch (error) {
    log(error.message, true);
  } finally {
    requestBusy = false;
    $('export-dxf').disabled = false;
  }
});

$('export-svg').addEventListener('click', async () => {
  if (requestBusy) return;
  try {
    engine.finish();
    requestBusy = true;
    $('export-svg').disabled = true;
    const thickness = Math.max(0.2, Math.min(500, Number($('extrude-thickness')?.value) || 4.0));
    let svgText = null;
    if (bridgeConnected) {
      let response = null;
      try {
        response = await fetch('/api/drawing/svg', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(store.document),
        });
      } catch {
        bridgeConnected = false;
        renderRuntimeSelect();
      }
      if (response) {
        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || 'SVG export failed.');
        }
        svgText = await response.text();
      }
    }
    if (svgText === null) {
      svgText = exportDrawingToSvgBlueprint(store.document, thickness);
    }
    download(svgText, `${store.document.name || 'blueprint'}.svg`, 'image/svg+xml;charset=utf-8');
    log(t().svgExportLog);
  } catch (error) {
    log(error.message, true);
  } finally {
    requestBusy = false;
    $('export-svg').disabled = false;
  }
});

async function refreshExtrudePreview() {
  const errEl = $('extrude-error');
  const telEl = $('extrude-telemetry');
  errEl.hidden = true;
  telEl.replaceChildren();
  const thickness = Math.max(0.2, Math.min(500, Number($('extrude-thickness').value) || 4.0));
  renderCamTelemetry();
  if (!bridgeConnected) {
    solidViewer.setMesh(null);
    errEl.hidden = false;
    errEl.textContent = t().bridgeRequired3d;
    return;
  }
  try {
    const res = await fetch('/api/drawing/extrude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ drawing: store.document, thickness, format: 'mesh' }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '3D extrusion failed.');
    solidViewer.setMesh(data.mesh);
    const s = t();
    const tel = data.telemetry;
    const rows = [
      [s.telStatus, s.telValid(data.mesh.solid_count)],
      [s.telVolume, `${tel.volume_mm3.toFixed(1)} mm³`],
      [s.telLoops, `${tel.closed_loops ?? 1}`],
      [s.telCutouts, `${tel.hole_count ?? 0}`],
      [s.telAl6061, `${tel.mass_g.aluminum_6061.toFixed(2)} g`],
      [s.telSteel, `${tel.mass_g.steel_s235.toFixed(2)} g`],
    ];
    for (const [k, v] of rows) {
      const dt = document.createElement('dt'),
        dd = document.createElement('dd');
      dt.textContent = k;
      dd.textContent = v;
      telEl.append(dt, dd);
    }
  } catch (error) {
    solidViewer.setMesh(null);
    errEl.hidden = false;
    errEl.textContent = error.message;
  }
}

async function exportExtrudedFile(fmt) {
  if (requestBusy) return;
  if (!bridgeConnected) {
    $('extrude-error').hidden = false;
    $('extrude-error').textContent = t().bridgeRequired3d;
    log(t().bridgeRequired3d, true);
    return;
  }
  const thickness = Math.max(0.2, Math.min(500, Number($('extrude-thickness').value) || 4.0));
  try {
    requestBusy = true;
    const res = await fetch('/api/drawing/extrude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ drawing: store.document, thickness, format: fmt }),
    });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || `${fmt.toUpperCase()} export failed.`);
    }
    const blob = await res.blob();
    downloadBlob(blob, `${store.document.name || 'part'}.${fmt}`);
    log(t().stepExportLog(fmt, thickness));
  } catch (error) {
    $('extrude-error').hidden = false;
    $('extrude-error').textContent = error.message;
    log(error.message, true);
  } finally {
    requestBusy = false;
  }
}

$('fix-all-drc').addEventListener('pointerenter', () => {
  if (currentBatchRepair) setRepairGhost(currentBatchRepair);
});
$('fix-all-drc').addEventListener('focus', () => {
  if (currentBatchRepair) setRepairGhost(currentBatchRepair);
});
$('fix-all-drc').addEventListener('pointerleave', () => setRepairGhost(null));
$('fix-all-drc').addEventListener('blur', () => setRepairGhost(null));
$('fix-all-drc').addEventListener('click', () =>
  attempt(() => {
    if (!currentBatchRepair) return;
    const batch = currentBatchRepair;
    engine.cancel();
    store.commit(batch.nextDoc);
    for (const item of batch.applied) {
      log(t().repairAppliedLog(item.code, item.diffSummary));
    }
    log(t().repairBatchLog(batch.applied.length));
    render();
  }),
);

$('open-extrude').addEventListener('click', () => {
  engine.finish();
  $('extrude-modal').hidden = false;
  requestAnimationFrame(() => refreshExtrudePreview());
});
$('close-extrude').addEventListener('click', () => {
  $('extrude-modal').hidden = true;
});
$('extrude-modal').addEventListener('click', (event) => {
  if (event.target === $('extrude-modal')) $('extrude-modal').hidden = true;
});
$('rebuild-extrude').addEventListener('click', () => refreshExtrudePreview());
$('iso-extrude').addEventListener('click', () => solidViewer.resetView());
$('download-step').addEventListener('click', () => exportExtrudedFile('step'));
$('download-stl').addEventListener('click', () => exportExtrudedFile('stl'));

window.addEventListener('beforeunload', (event) => {
  if (saved !== JSON.stringify(store.document)) {
    event.preventDefault();
    event.returnValue = '';
  }
});

new ResizeObserver(() => renderGeometry()).observe(canvas);
log(t().bootLog);
const bootPreset = new URLSearchParams(window.location.search).get('preset');
const buildBootPreset = getPresetBuilder(bootPreset);
if (buildBootPreset) {
  const doc = buildBootPreset();
  store.commit(doc);
  saved = JSON.stringify(store.document);
}
render();
fit();
if (buildBootPreset) {
  if (bootPreset === 'fault') {
    log(t().drcLoadedLog(lintReport.summary.errors, lintReport.summary.warnings), true);
  } else {
    log(t().presetLoadedLog(store.document.name));
  }
}
pollWorkspaceState(true);
setInterval(() => pollWorkspaceState(false), 1200);
setInterval(() => {
  if (bridgeConnected) refreshRuntimes(false);
}, 8000);
