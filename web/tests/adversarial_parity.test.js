import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { DrawingStore, validateDrawing } from '../src/drawing/model.js';
import { analyzeDrawingTopology, computeCamMetrics, trimLineEntity } from '../src/drawing/ops.js';
import { CommandEngine } from '../src/drawing/commands.js';
import { flawedCncBracketExample, lintDrawing, previewDrcFix } from '../src/drawing/linter.js';
import { exportDrawingToDxf, importDrawingFromDxf } from '../src/drawing/dxf.js';
import { exportDrawingToSvgBlueprint } from '../src/drawing/svg.js';

function makeEngine() {
  const store = new DrawingStore();
  const logs = [];
  const engine = new CommandEngine(
    store,
    () => {},
    (msg) => logs.push(msg),
    () => {},
    () => {},
  );
  return { store, engine, logs };
}

test('disjoint outer loops and nested islands compute exact even-odd net area and fail manufacturing DRC', () => {
  const { store, engine } = makeEngine();
  engine.executeBatch(['NEW DISJOINT', 'RECTANG 0,0 100,60 id=a', 'RECTANG 200,0 240,20 id=b']);
  const camDisjoint = computeCamMetrics(store.document, 5);
  assert.equal(camDisjoint.closed_loops, 2);
  assert.ok(Math.abs(camDisjoint.net_area_mm2 - 6800) < 1e-3);
  const drcDisjoint = lintDrawing(store.document, { manufacturing: true });
  assert.equal(drcDisjoint.valid, false);
  assert.ok(drcDisjoint.issues.some((i) => i.code === 'MULTIPLE_OUTER_PROFILES'));

  engine.executeBatch([
    'NEW ISLAND',
    'RECTANG 0,0 100,100 id=outer',
    'RECTANG 20,20 80,80 id=hole',
    'RECTANG 40,40 60,60 id=island',
  ]);
  const camIsland = computeCamMetrics(store.document, 4);
  assert.ok(Math.abs(camIsland.net_area_mm2 - 6800) < 1e-3);
  const drcIsland = lintDrawing(store.document, { manufacturing: true });
  assert.equal(drcIsland.valid, false);
  assert.ok(drcIsland.issues.some((i) => i.code === 'NESTED_ISLAND_UNSUPPORTED'));
});

test('graph chaining is order-independent on T-branches and rejects 0.005 mm near-gaps', () => {
  const edges = [
    'LINE 0,0 50,0 id=e1',
    'LINE 50,0 50,50 id=e2',
    'LINE 50,50 0,50 id=e3',
    'LINE 0,50 0,0 id=e4',
  ];
  const spur = 'LINE 50,0 80,0 id=spur';

  const a = makeEngine();
  a.engine.executeBatch(['NEW FIRST', spur, ...edges]);
  const b = makeEngine();
  b.engine.executeBatch(['NEW LAST', ...edges, spur]);

  assert.equal(computeCamMetrics(a.store.document).closed_loops, 0);
  assert.equal(computeCamMetrics(b.store.document).closed_loops, 0);
  assert.ok(
    lintDrawing(a.store.document).issues.some((i) => i.code === 'BRANCHED_CONTOUR_JUNCTION'),
  );
  assert.ok(
    lintDrawing(b.store.document).issues.some((i) => i.code === 'BRANCHED_CONTOUR_JUNCTION'),
  );

  const g = makeEngine();
  g.engine.executeBatch([
    'NEW GAP',
    'LINE 0,0 100,0 id=l1',
    'LINE 100,0 100,60 id=l2',
    'LINE 100,60 0,60 id=l3',
    'LINE 0,60 0,0.005 id=l4',
  ]);
  assert.equal(computeCamMetrics(g.store.document).closed_loops, 0);
  assert.ok(lintDrawing(g.store.document).issues.some((i) => i.code === 'OPEN_CONTOUR_GAP'));
});

test('cross-layer collisions on locked cutting layers and twin overlapping arcs are caught', () => {
  const { store, engine } = makeEngine();
  engine.executeBatch([
    'NEW CROSS',
    'LAYER 0-OUTER #dce2ea',
    'RECTANG 0,0 100,60 id=outer',
    'LAYER CUTS #5aa9e6',
    'CIRCLE 99,30 4 id=edge-crash',
  ]);
  store.updateLayer('0-outer', { locked: true });
  const rep = lintDrawing(store.document);
  assert.equal(rep.valid, false);
  assert.ok(rep.issues.some((i) => i.code === 'CIRCLE_COLLISION'));

  const twin = makeEngine();
  twin.engine.executeBatch(['NEW TWIN', 'ARC C 0,0 25 0 180 id=a1', 'ARC C 0,0 25 0 180 id=a2']);
  const repTwin = lintDrawing(twin.store.document);
  assert.equal(repTwin.valid, false);
  assert.ok(repTwin.issues.some((i) => i.code === 'DUPLICATE_GEOMETRY'));
});

test('executeBatch is transactional, ARRAY rejects non-integers, and physical TRIM / X-CHAMFER work', () => {
  const { store, engine } = makeEngine();
  engine.execute('RECTANG 0,0 40,30 id=seed');
  const before = structuredClone(store.document);
  assert.throws(() => engine.executeBatch(['CIRCLE 20,15 4 id=tmp', 'INVALID_CMD 1,2']));
  assert.deepEqual(store.document, before);

  engine.execute('CIRCLE 10,10 2 id=h1');
  assert.throws(() => engine.execute('ARRAY RECT h1 2.5 2 10 10'));
  assert.throws(() => engine.execute('ARRAY POLAR h1 20,15 3.7'));

  // 1,000,000 mm physical-distance TRIM
  const longLine = {
    id: 'long',
    layer: '0',
    type: 'line',
    points: [
      [-1, 0],
      [999999, 0],
    ],
  };
  const cutter = {
    id: 'cut',
    layer: '0',
    type: 'line',
    points: [
      [0, -50],
      [0, 50],
    ],
  };
  const trimmed = trimLineEntity(longLine, [-0.5, 0], [longLine, cutter]);
  assert.equal(trimmed.length, 1);
  assert.ok(Math.abs(trimmed[0].points[0][0] - 0) < 1e-6);
  assert.throws(() => trimLineEntity(longLine, [0, 0], [longLine, cutter]));

  // Duplicate closure point in closed polyline is rejected
  assert.throws(() =>
    validateDrawing({
      format: 'cad-lab.drawing',
      schema_version: 1,
      units: 'mm',
      name: 'DupClosure',
      layers: [{ id: '0', name: '0', color: '#ffffff', visible: true, locked: false }],
      entities: [
        {
          id: 'p',
          layer: '0',
          type: 'polyline',
          points: [
            [0, 0],
            [20, 0],
            [20, 20],
            [0, 20],
            [0, 0],
          ],
          closed: true,
        },
      ],
    }),
  );

  // X-crossing chamfer requires keep1=/keep2= and matches regardless of endpoint direction
  const c1 = makeEngine();
  c1.engine.executeBatch(['LINE -20,0 20,0 id=h', 'LINE 0,-20 0,20 id=v']);
  assert.throws(() => c1.engine.execute('CHAMFER h v 4'));
  c1.engine.execute('CHAMFER h v 4 keep1=15,0 keep2=0,15');

  const c2 = makeEngine();
  c2.engine.executeBatch([
    'LINE 20,0 -20,0 id=h',
    'LINE 0,20 0,-20 id=v',
    'CHAMFER h v 4 keep1=15,0 keep2=0,15',
  ]);
  const b1 = [...c1.store.document.entities.at(-1).points].sort((p, q) => p[0] - q[0]);
  const b2 = [...c2.store.document.entities.at(-1).points].sort((p, q) => p[0] - q[0]);
  assert.deepEqual(b1, [
    [0, 4],
    [4, 0],
  ]);
  assert.deepEqual(b2, [
    [0, 4],
    [4, 0],
  ]);
});

test('previewDrcFix repairs flawedCncBracketExample to 0 issues while preserving exact hole diameters', () => {
  let doc = flawedCncBracketExample();
  const initialRadii = doc.entities
    .filter((e) => e.type === 'circle')
    .map((e) => e.radius)
    .sort((a, b) => a - b);

  for (let i = 0; i < 10; i++) {
    const rep = lintDrawing(doc, { manufacturing: true });
    const nextFix = rep.issues.map((iss) => previewDrcFix(doc, iss)).find(Boolean);
    if (!nextFix) break;
    doc = nextFix.nextDoc;
  }

  const finalReport = lintDrawing(doc, { manufacturing: true });
  assert.equal(finalReport.valid, true);
  assert.equal(finalReport.summary.errors, 0);
  assert.equal(finalReport.summary.warnings, 0);

  const afterRadii = doc.entities
    .filter((e) => e.type === 'circle')
    .map((e) => e.radius)
    .sort((a, b) => a - b);
  assert.deepEqual(afterRadii, initialRadii);
});

test('standalone browser DXF and SVG exporters round-trip geometry and reject rotated dimensions', () => {
  const { store, engine } = makeEngine();
  engine.executeBatch([
    'NEW STANDALONE-PART',
    'LAYER 0-PROFILE #dce2ea',
    'RECTANG 0,0 100,60 id=outer',
    'CHAMFER outer 5',
    'LAYER CUTS #5aa9e6',
    'CIRCLE 20,20 3.3 id=h1',
    'ARC C 65,30 12 30 330 id=a1',
    'LINE 75.392305,24 75.392305,36 id=chord',
    'LAYER DIMS #e09b24',
    'DIM 0,0 100,0 50,-12 id=d1',
    'TEXT 10,-22 3.0 STANDALONE R2010 DXF id=t1',
  ]);

  const dxf = exportDrawingToDxf(store.document);
  assert.match(dxf, /AC1024/);
  const reimported = importDrawingFromDxf(dxf, 'Reimported');
  assert.equal(reimported.report.entities, store.document.entities.length);
  const camBefore = computeCamMetrics(store.document, 4);
  const camAfter = computeCamMetrics(reimported.drawing, 4);
  assert.ok(Math.abs(camBefore.net_area_mm2 - camAfter.net_area_mm2) < 1e-2);

  const svg = exportDrawingToSvgBlueprint(store.document, 4);
  assert.match(svg, /<svg /);
  assert.match(svg, /STANDALONE-PART/);

  // Corrupt DIMENSION group 42 (actual measurement = 10.0 on a 100.0 mm span) -> must throw!
  const distorted = dxf.replace(/\n\s*42\n100(?:\.0+)?\n/, '\n 42\n10.0\n');
  assert.notEqual(distorted, dxf);
  assert.throws(() => importDrawingFromDxf(distorted));
});

test('non-concentric large arc 0.2 mm pierce is caught and R=1000 interior ray-cast is exact', () => {
  const ang = (7.5 * Math.PI) / 180;
  const d = 900.2;
  const cx = (d * Math.cos(ang)).toFixed(6);
  const cy = (d * Math.sin(ang)).toFixed(6);
  const { store, engine } = makeEngine();
  engine.executeBatch([
    'NEW R01-ARC-PIERCE',
    'ARC C 0,0 1000 0 180 id=o1',
    'ARC C 0,0 1000 180 360 id=o2',
    `ARC C ${cx},${cy} 100 0 180 id=i1`,
    `ARC C ${cx},${cy} 100 180 360 id=i2`,
  ]);
  const mfg = lintDrawing(store.document, { manufacturing: true });
  assert.equal(mfg.valid, false);
  assert.ok(mfg.issues.some((i) => i.code === 'INTERSECTING_CONTOURS'));

  // Near-clearance (1.0 mm < 1.5 mm) between non-concentric arcs emits MIN_CLEARANCE warning
  const cNear = makeEngine();
  cNear.engine.executeBatch([
    'NEW R01-ARC-NEAR',
    'ARC C 0,0 1000 0 180 id=o1',
    'ARC C 0,0 1000 180 360 id=o2',
    `ARC C ${(899.0 * Math.cos(ang)).toFixed(6)},${(899.0 * Math.sin(ang)).toFixed(6)} 100 0 180 id=i1`,
    `ARC C ${(899.0 * Math.cos(ang)).toFixed(6)},${(899.0 * Math.sin(ang)).toFixed(6)} 100 180 360 id=i2`,
  ]);
  const nearRep = lintDrawing(cNear.store.document, { manufacturing: true });
  assert.equal(nearRep.valid, true);
  assert.ok(nearRep.issues.some((i) => i.code === 'MIN_CLEARANCE'));
  const topo = analyzeDrawingTopology(cNear.store.document);
  assert.equal(topo.outer_loops.length, 1);
  assert.equal(topo.hole_loops.length, 1);
});

test('construction layer survives DXF round-trip, SVG uses manufacturing DRC, and self-poly budget holds', () => {
  const { store, engine } = makeEngine();
  engine.executeBatch([
    'NEW R05-CONSTRUCTION',
    'RECTANG 0,0 100,60 id=outer',
    'LAYER GUIDE #888888 CONSTRUCTION',
    'CIRCLE 50,30 10 id=guide-circle',
  ]);
  const dxf = exportDrawingToDxf(store.document);
  const reimported = importDrawingFromDxf(dxf, 'Reimported');
  const guideLayer = reimported.drawing.layers.find((l) => l.name === 'GUIDE');
  assert.equal(guideLayer.construction, true);
  const camAfter = computeCamMetrics(reimported.drawing, 5);
  assert.ok(Math.abs(camAfter.net_area_mm2 - 6000) < 1e-3);

  const cutOnlyDxf = exportDrawingToDxf(store.document, { cutOnly: true });
  const cutReimported = importDrawingFromDxf(cutOnlyDxf, 'CutOnly');
  assert.equal(cutReimported.drawing.entities.length, 1);

  // R07: Two disjoint circles must stamp MFG DRC: FAILED in SVG blueprint
  const two = makeEngine();
  two.engine.executeBatch(['NEW TWO-CIRCLES', 'CIRCLE 0,0 20 id=c1', 'CIRCLE 100,0 20 id=c2']);
  const svg = exportDrawingToSvgBlueprint(two.store.document, 4);
  assert.match(svg, /MFG DRC: FAILED/);
  assert.doesNotMatch(svg, /VERIFIED|PASSED/);

  // R03: Single 800-vertex polyline (> 250,000 self-pair checks) throws complexity budget error
  const densePts = Array.from({ length: 800 }, (_, k) => [
    Math.cos((2 * Math.PI * k) / 800) * 100,
    Math.sin((2 * Math.PI * k) / 800) * 100,
  ]);
  assert.throws(
    () =>
      lintDrawing({
        format: 'cad-lab.drawing',
        schema_version: 1,
        units: 'mm',
        name: 'DensePoly',
        layers: [{ id: '0', name: '0', color: '#ffffff', visible: true, locked: false }],
        entities: [{ id: 'p800', layer: '0', type: 'polyline', points: densePts, closed: true }],
      }),
    /complexity budget/,
  );
});

test('R09: closed polyline non-adjacent self-touch, backtrack, and split arc loops are rejected', () => {
  const cases = [
    ['NEW SELF-TOUCH', 'PLINE 0,0 50,0 50,50 25,25 50,0 100,0 100,100 0,100 C id=outer'],
    ['NEW BACKTRACK', 'PLINE 0,0 100,0 80,0 100,0 100,60 0,60 C id=outer'],
    [
      'NEW SPLIT-ARC-PINCH',
      'LINE 0,0 50,0 id=l1',
      'LINE 50,0 50,50 id=l2',
      'ARC C 50,25 25 90 270 id=a1',
      'LINE 50,0 100,0 id=l3',
      'LINE 100,0 100,100 id=l4',
      'LINE 100,100 0,100 id=l5',
      'LINE 0,100 0,0 id=l6',
    ],
    [
      'NEW SPLIT-ARC-TANGENT',
      'LINE 0,0 100,0 id=bot',
      'LINE 100,0 100,50 id=right',
      'ARC C 50,50 50 180 0 id=bow',
      'LINE 0,50 0,0 id=left',
    ],
  ];
  for (const cmds of cases) {
    const { store, engine } = makeEngine();
    engine.executeBatch(cmds);
    const mfg = lintDrawing(store.document, { manufacturing: true });
    const draft = lintDrawing(store.document, { manufacturing: false });
    assert.equal(mfg.valid, false, `Expected mfg DRC failure for ${cmds[0]}`);
    assert.equal(draft.valid, false, `Expected drafting DRC failure for ${cmds[0]}`);
    const topo = analyzeDrawingTopology(store.document);
    assert.equal(topo.loops.length, 0);
    assert.ok(topo.branched_components.length >= 1);
    const svg = exportDrawingToSvgBlueprint(store.document, 4);
    assert.match(svg, /MFG DRC: FAILED/);
    assert.doesNotMatch(svg, /PASSED/);
  }
});

test('R11: single-flight workspace sync preserves rapid local edits across poll and conflict permutations', async () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const appPath = path.resolve(__dirname, '../src/drawing/app.js');
  const source = fs.readFileSync(appPath, 'utf8');
  const start = source.indexOf('function pushWorkspaceState(');
  const end = source.indexOf('function renderRuntimeSelect()', start);
  assert.ok(start >= 0 && end > start);
  const syncSlice = source.slice(start, end);

  const original = {
    format: 'cad-lab.drawing',
    schema_version: 1,
    units: 'mm',
    name: 'Race',
    layers: [{ id: '0', name: '0', color: '#ffffff', visible: true, locked: false }],
    entities: [
      {
        id: 'outer',
        layer: '0',
        type: 'polyline',
        closed: true,
        points: [
          [0, 0],
          [100, 0],
          [100, 60],
          [0, 60],
        ],
      },
    ],
  };
  const first = structuredClone(original);
  first.entities.push({
    id: 'first-hole',
    layer: '0',
    type: 'circle',
    center: [25, 30],
    radius: 3,
  });
  const latest = structuredClone(first);
  latest.entities.push({
    id: 'second-hole',
    layer: '0',
    type: 'circle',
    center: [75, 30],
    radius: 3,
  });

  const makeResponse = (status, data) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => 'application/json' },
    json: async () => structuredClone(data),
  });

  const buildHarness = (getResponder) => {
    const posts = [];
    const commits = [];
    const logs = [];
    const ctx = {
      bridgeConnected: true,
      serverRevision: 2,
      lastSyncedJson: JSON.stringify(original),
      pendingSyncJson: null,
      saved: JSON.stringify(original),
      document: { hidden: false },
      engine: { tool: false },
      panning: false,
      selectBox: false,
      requestBusy: false,
      store: {
        document: structuredClone(original),
        commit(doc) {
          this.document = structuredClone(doc);
          commits.push(this.document.entities.map((e) => e.id));
        },
      },
      makeRequestId: () => `req-${posts.length + 1}`,
      renderRuntimeSelect() {},
      refreshRuntimes() {},
      render() {},
      fit() {},
      log: (...args) => logs.push(args),
      fetch: (_url, options) => {
        if (options?.method === 'POST') {
          return new Promise((resolve) => posts.push({ body: JSON.parse(options.body), resolve }));
        }
        return getResponder();
      },
    };
    vm.createContext(ctx);
    vm.runInContext(syncSlice, ctx);
    return { ctx, posts, commits, logs };
  };

  // Permutation 1: Rapid A -> B edits, mid-flight poll returning A, then A ACK, then B ACK
  {
    const { ctx, posts, commits } = buildHarness(() =>
      Promise.resolve(makeResponse(200, { revision: 3, drawing: first })),
    );
    ctx.store.document = structuredClone(first);
    ctx.pushWorkspaceState();
    ctx.store.document = structuredClone(latest);
    ctx.pushWorkspaceState();

    // Single-flight: only A is in-flight while B waits for A's ACK
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.expected_revision, 2);

    // Mid-flight timer poll arrives before A's ACK: must NOT overwrite B
    await ctx.pollWorkspaceState(false);
    assert.deepEqual(
      ctx.store.document.entities.map((e) => e.id),
      ['outer', 'first-hole', 'second-hole'],
    );
    assert.equal(commits.length, 0);

    // A settles -> B dispatches automatically with updated expected_revision = 3
    posts[0].resolve(makeResponse(200, { revision: 3, drawing: first }));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(posts.length, 2);
    assert.equal(posts[1].body.expected_revision, 3);
    assert.deepEqual(
      posts[1].body.drawing.entities.map((e) => e.id),
      ['outer', 'first-hole', 'second-hole'],
    );

    posts[1].resolve(makeResponse(200, { revision: 4, drawing: latest }));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(ctx.serverRevision, 4);
    assert.deepEqual(
      ctx.store.document.entities.map((e) => e.id),
      ['outer', 'first-hole', 'second-hole'],
    );
  }

  // Permutation 2: Slow GET initiated BEFORE local edits resolves AFTER local edits exist
  {
    let resolveSlowGet;
    const { ctx, commits } = buildHarness(
      () => new Promise((resolve) => (resolveSlowGet = resolve)),
    );
    const pollPromise = ctx.pollWorkspaceState(false);
    // User edits locally while GET is in transit
    ctx.store.document = structuredClone(latest);
    ctx.saved = JSON.stringify(latest); // Even if saved to disk locally, still unsynced with server!
    resolveSlowGet(makeResponse(200, { revision: 3, drawing: first }));
    await pollPromise;
    assert.equal(commits.length, 0);
    assert.deepEqual(
      ctx.store.document.entities.map((e) => e.id),
      ['outer', 'first-hole', 'second-hole'],
    );
  }

  // Permutation 3: Genuine 409 conflict preserves local candidate and supports explicit SYNC PUSH / PULL
  {
    const remoteOther = structuredClone(original);
    remoteOther.entities.push({
      id: 'mcp-hole',
      layer: '0',
      type: 'circle',
      center: [50, 30],
      radius: 4,
    });
    let remoteState = { revision: 5, drawing: remoteOther };
    const { ctx, posts, logs } = buildHarness(() =>
      Promise.resolve(makeResponse(200, remoteState)),
    );
    ctx.store.document = structuredClone(latest);
    ctx.saved = JSON.stringify(latest);
    ctx.pushWorkspaceState();
    assert.equal(posts.length, 1);

    posts[0].resolve(makeResponse(409, { revision: 5, drawing: remoteOther, error: 'conflict' }));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Local candidate is preserved; conflict logged; periodic poll does not clobber it
    assert.deepEqual(
      ctx.store.document.entities.map((e) => e.id),
      ['outer', 'first-hole', 'second-hole'],
    );
    assert.ok(logs.some((entry) => String(entry[0]).includes('SYNC PUSH')));
    await ctx.pollWorkspaceState(false);
    assert.deepEqual(
      ctx.store.document.entities.map((e) => e.id),
      ['outer', 'first-hole', 'second-hole'],
    );

    // Explicit SYNC PUSH advances expected_revision to 5 and pushes local candidate
    ctx.reconcileSyncConflict('push');
    assert.equal(posts.length, 2);
    assert.equal(posts[1].body.expected_revision, 5);
    posts[1].resolve(makeResponse(200, { revision: 6, drawing: latest }));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(ctx.serverRevision, 6);

    // Stale GET (< serverRevision 6) is ignored even on explicit SYNC PULL
    await ctx.reconcileSyncConflict('pull');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(
      ctx.store.document.entities.map((e) => e.id),
      ['outer', 'first-hole', 'second-hole'],
    );

    // Explicit SYNC PULL overwrites when requested with a fresh server revision
    remoteState = { revision: 7, drawing: remoteOther };
    await ctx.reconcileSyncConflict('pull');
    await new Promise((r) => setImmediate(r));
    assert.equal(ctx.serverRevision, 7);
    assert.deepEqual(
      ctx.store.document.entities.map((e) => e.id),
      ['outer', 'mcp-hole'],
    );
  }

  // Permutation 4 (R11-a): Automatic 409 clean-state GET must NEVER overwrite a new edit made while GET is pending
  {
    const remoteOther = structuredClone(original);
    remoteOther.entities.push({
      id: 'mcp-hole',
      layer: '0',
      type: 'circle',
      center: [50, 30],
      radius: 4,
    });
    const gets = [];
    const { ctx, posts, commits, logs } = buildHarness(
      () => new Promise((resolve) => gets.push({ resolve })),
    );

    // 1. User makes edit A, then UNDOs back to original before 409 arrives
    ctx.store.document = structuredClone(first);
    ctx.pushWorkspaceState();
    ctx.store.document = structuredClone(original);
    ctx.pushWorkspaceState();

    // 2. Edit A receives 409 -> starts automatic clean-state GET
    posts[0].resolve(makeResponse(409, { revision: 3, drawing: remoteOther, error: 'conflict' }));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(gets.length, 1);

    // 3. While automatic GET is pending, user creates a new unsynced hole (saved remains original!)
    const newLocal = structuredClone(original);
    newLocal.entities.push({
      id: 'new-unsynced-hole',
      layer: '0',
      type: 'circle',
      center: [75, 30],
      radius: 3,
    });
    ctx.store.document = structuredClone(newLocal);
    ctx.pushWorkspaceState();
    assert.equal(posts.length, 2);

    // 4. Automatic GET resolves: must preserve newLocal and must NOT mark saved as clean
    gets[0].resolve(makeResponse(200, { revision: 3, drawing: remoteOther }));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(commits.length, 0);
    assert.deepEqual(
      ctx.store.document.entities.map((e) => e.id),
      ['outer', 'new-unsynced-hole'],
    );
    assert.notEqual(ctx.saved, JSON.stringify(ctx.store.document));

    // 5. Subsequent 409 on posts[1] also preserves newLocal and offers explicit SYNC PUSH / SYNC PULL
    posts[1].resolve(makeResponse(409, { revision: 3, drawing: remoteOther, error: 'conflict' }));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(gets.length, 1);
    assert.deepEqual(
      ctx.store.document.entities.map((e) => e.id),
      ['outer', 'new-unsynced-hole'],
    );
    assert.notEqual(ctx.saved, JSON.stringify(ctx.store.document));
    assert.ok(logs.some((entry) => String(entry[0]).includes('SYNC PUSH')));
  }

  // Permutation 5 (R11-b): Single-flight lock stays held until response JSON body finishes decoding
  {
    const { ctx, posts } = buildHarness(() =>
      Promise.resolve(makeResponse(200, { revision: 3, drawing: first })),
    );
    let resolveAckBody;
    const delayedBody = new Promise((resolve) => (resolveAckBody = resolve));

    ctx.store.document = structuredClone(first);
    ctx.pushWorkspaceState();
    assert.equal(posts.length, 1);

    // Response headers arrive, but res.json() body is still streaming
    posts[0].resolve({
      status: 200,
      ok: true,
      headers: { get: () => 'application/json' },
      json: () => delayedBody,
    });
    await new Promise((r) => setImmediate(r));

    // User makes second edit before first ACK body resolves: must NOT dispatch stale expected_revision=2
    ctx.store.document = structuredClone(latest);
    ctx.pushWorkspaceState();
    assert.equal(posts.length, 1);

    // Once first ACK body resolves, queued second edit dispatches with updated expected_revision=3
    resolveAckBody({ revision: 3, drawing: first });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(posts.length, 2);
    assert.equal(posts[1].body.expected_revision, 3);
    posts[1].resolve(makeResponse(200, { revision: 4, drawing: latest }));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(ctx.serverRevision, 4);
    assert.deepEqual(
      ctx.store.document.entities.map((e) => e.id),
      ['outer', 'first-hole', 'second-hole'],
    );
  }
});

test('R11-c: stale GET never falsely acknowledges unsynced UNDO or clears newer conflict state', async () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const appPath = path.resolve(__dirname, '../src/drawing/app.js');
  const source = fs.readFileSync(appPath, 'utf8');
  const start = source.indexOf('function pushWorkspaceState(');
  const end = source.indexOf('function renderRuntimeSelect()', start);
  assert.ok(start >= 0 && end > start);
  const syncSlice = source.slice(start, end);

  const original = {
    format: 'cad-lab.drawing',
    schema_version: 1,
    units: 'mm',
    name: 'StaleGet',
    layers: [{ id: '0', name: '0', color: '#ffffff', visible: true, locked: false }],
    entities: [
      {
        id: 'outer',
        layer: '0',
        type: 'polyline',
        closed: true,
        points: [
          [0, 0],
          [100, 0],
          [100, 60],
          [0, 60],
        ],
      },
    ],
  };
  const withHole = (id, x) => {
    const doc = structuredClone(original);
    doc.entities.push({ id, layer: '0', type: 'circle', center: [x, 30], radius: 3 });
    return doc;
  };
  const first = withHole('temporary-X', 15);
  const acknowledgedA = withHole('acknowledged-A', 25);
  const remoteOther = withHole('moved-A', 50);
  const latest = withHole('latest-hole', 75);

  const makeResponse = (status, data) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => 'application/json' },
    json: async () => structuredClone(data),
  });

  const buildHarness = () => {
    const posts = [];
    const gets = [];
    const commits = [];
    const logs = [];
    const ctx = {
      bridgeConnected: true,
      serverRevision: 2,
      lastSyncedJson: JSON.stringify(original),
      pendingSyncJson: null,
      saved: JSON.stringify(original),
      document: { hidden: false },
      engine: { tool: false },
      panning: false,
      selectBox: false,
      requestBusy: false,
      store: {
        document: structuredClone(original),
        commit(doc) {
          this.document = structuredClone(doc);
          commits.push(this.document.entities.map((e) => e.id));
        },
      },
      makeRequestId: () => `req-${posts.length + 1}`,
      renderRuntimeSelect() {},
      refreshRuntimes() {},
      render() {},
      fit() {},
      log: (...args) => logs.push(args),
      fetch: (_url, options) =>
        new Promise((resolve, reject) => {
          if (options?.method === 'POST') {
            posts.push({ body: JSON.parse(options.body), resolve, reject });
          } else {
            gets.push({ resolve, reject });
          }
        }),
    };
    vm.createContext(ctx);
    vm.runInContext(syncSlice, ctx);
    return { ctx, posts, gets, commits, logs };
  };

  // Sub-scenario A: Exact R11-c sequence without SYNC PULL
  {
    const { ctx, posts, gets, commits } = buildHarness();

    // 1. User edits first, pushes, then locally UNDOs back to original
    ctx.store.document = structuredClone(first);
    ctx.pushWorkspaceState();
    ctx.store.document = structuredClone(original);
    ctx.pushWorkspaceState();
    assert.equal(posts.length, 1);

    // 2. posts[0] gets 409 (rev 4 / original) -> automatic clean-state GET starts
    posts[0].resolve(makeResponse(409, { revision: 4, drawing: original, error: 'conflict' }));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(gets.length, 1);

    // 3. User creates acknowledgedA, saves locally, pushes via SYNC PUSH -> ACK at rev 5
    ctx.store.document = structuredClone(acknowledgedA);
    ctx.saved = JSON.stringify(acknowledgedA);
    ctx.pushWorkspaceState();
    assert.equal(posts.length, 2);
    posts[1].resolve(makeResponse(409, { revision: 4, drawing: original, error: 'conflict' }));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    ctx.reconcileSyncConflict('push');
    assert.equal(posts.length, 3);
    assert.equal(posts[2].body.expected_revision, 4);
    posts[2].resolve(makeResponse(200, { revision: 5, drawing: acknowledgedA }));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(ctx.serverRevision, 5);
    assert.equal(ctx.lastSyncedJson, JSON.stringify(acknowledgedA));

    // 4. User locally UNDOs back to original (ctx.saved remains acknowledgedA) -> 409 at rev 6
    ctx.store.document = structuredClone(original);
    ctx.pushWorkspaceState();
    assert.equal(posts.length, 4);
    assert.equal(posts[3].body.expected_revision, 5);
    posts[3].resolve(makeResponse(409, { revision: 6, drawing: remoteOther, error: 'conflict' }));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(vm.runInContext('syncConflictRevision', ctx), 6);

    // 5. Delayed rev 4 / original GET arrives: must NOT falsely ACK UNDO or clear conflict
    gets[0].resolve(makeResponse(200, { revision: 4, drawing: original }));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(ctx.lastSyncedJson, JSON.stringify(acknowledgedA));
    assert.equal(vm.runInContext('syncConflictRevision', ctx), 6);
    assert.equal(ctx.serverRevision, 5);

    // 6. Ordinary timer poll at rev 6 must NOT overwrite local UNDO or mark saved clean
    const pollPromise = ctx.pollWorkspaceState(false);
    assert.equal(gets.length, 2);
    gets[1].resolve(makeResponse(200, { revision: 6, drawing: remoteOther }));
    await pollPromise;
    assert.equal(commits.length, 0);
    assert.deepEqual(
      ctx.store.document.entities.map((e) => e.id),
      ['outer'],
    );
    assert.notEqual(ctx.saved, JSON.stringify(ctx.store.document));

    // 7. Subsequent explicit SYNC PUSH uses expected_revision = 6 and local original
    ctx.reconcileSyncConflict('push');
    assert.equal(posts.length, 5);
    assert.equal(posts[4].body.expected_revision, 6);
    assert.deepEqual(
      posts[4].body.drawing.entities.map((e) => e.id),
      ['outer'],
    );
  }

  // Sub-scenario B: Coincidental JSON match at remoteRev >= highestKnownRev while local is unsynced
  {
    const { ctx, posts, gets, commits } = buildHarness();
    ctx.lastSyncedJson = JSON.stringify(first);
    ctx.saved = JSON.stringify(first);
    ctx.store.document = structuredClone(first);

    // 2. Edit to latest -> 409 at rev 3 (syncConflictRevision = 3)
    ctx.store.document = structuredClone(latest);
    ctx.pushWorkspaceState();
    assert.equal(posts.length, 1);
    posts[0].resolve(makeResponse(409, { revision: 3, drawing: original, error: 'conflict' }));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(vm.runInContext('syncConflictRevision', ctx), 3);

    // 3. Start periodic poll while syncConflictRevision = 3
    const poll1 = ctx.pollWorkspaceState(false);
    assert.equal(gets.length, 1);

    // 4. Locally edit to original (!== lastSyncedJson); pushWorkspaceState returns due to conflict
    ctx.store.document = structuredClone(original);
    ctx.pushWorkspaceState();
    assert.equal(posts.length, 1);

    // 5. Deliver rev 3 / original matching local: read must NEVER ACK unacknowledged local edit
    gets[0].resolve(makeResponse(200, { revision: 3, drawing: original }));
    await poll1;
    assert.equal(ctx.lastSyncedJson, JSON.stringify(first));
    assert.equal(vm.runInContext('syncConflictRevision', ctx), 3);

    // 6. Next poll at rev 4 preserves local original, keeps saved=first, bumps conflict to 4
    const poll2 = ctx.pollWorkspaceState(false);
    assert.equal(gets.length, 2);
    gets[1].resolve(makeResponse(200, { revision: 4, drawing: remoteOther }));
    await poll2;
    assert.equal(commits.length, 0);
    assert.deepEqual(
      ctx.store.document.entities.map((e) => e.id),
      ['outer'],
    );
    assert.equal(vm.runInContext('syncConflictRevision', ctx), 4);
    assert.equal(ctx.saved, JSON.stringify(first));
  }
});
