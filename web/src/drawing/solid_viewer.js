// Orthographic CAD B-Rep mesh inspector with turntable orbit and feature-crease highlighting.

export function createSolidViewer(canvasEl) {
  let mesh = null;
  let creaseEdges = [];
  let center = [0, 0, 0];
  let radius = 50;
  let yaw = -Math.PI * 0.28;
  let pitch = Math.PI * 0.22;
  let zoom = 1.0;
  let dragging = null;

  function computeBoundsAndCreases(nextMesh) {
    const verts = nextMesh.vertices || [];
    const tris = nextMesh.triangles || [];
    if (!verts.length || !tris.length) {
      creaseEdges = [];
      center = [0, 0, 0];
      radius = 50;
      return;
    }
    let minX = Infinity,
      minY = Infinity,
      minZ = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity,
      maxZ = -Infinity;
    for (const [x, y, z] of verts) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    center = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
    radius = Math.max(10, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) * 0.52);

    const edgeNormals = new Map();
    for (const [i0, i1, i2] of tris) {
      const a = verts[i0],
        b = verts[i1],
        c = verts[i2];
      const ux = b[0] - a[0],
        uy = b[1] - a[1],
        uz = b[2] - a[2];
      const vx = c[0] - a[0],
        vy = c[1] - a[1],
        vz = c[2] - a[2];
      const nx = uy * vz - uz * vy,
        ny = uz * vx - ux * vz,
        nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      const nrm = [nx / len, ny / len, nz / len];
      for (const [u, v] of [
        [i0, i1],
        [i1, i2],
        [i2, i0],
      ]) {
        const key = u < v ? `${u}:${v}` : `${v}:${u}`;
        if (!edgeNormals.has(key)) edgeNormals.set(key, { u, v, normals: [] });
        edgeNormals.get(key).normals.push(nrm);
      }
    }
    creaseEdges = [];
    for (const entry of edgeNormals.values()) {
      if (entry.normals.length === 1) {
        creaseEdges.push(entry);
      } else if (entry.normals.length >= 2) {
        const [n1, n2] = entry.normals;
        const dot = n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2];
        if (dot < 0.86) creaseEdges.push(entry);
      }
    }
  }

  function projectPoint([x, y, z], w, h, scale) {
    const dx = x - center[0],
      dy = y - center[1],
      dz = z - center[2];
    const cy = Math.cos(yaw),
      sy = Math.sin(yaw);
    const cp = Math.cos(pitch),
      sp = Math.sin(pitch);
    // Z-up CAD turntable: rotate around Z by yaw, then tilt around X by pitch
    const x1 = dx * cy - dy * sy;
    const y1 = dx * sy + dy * cy;
    const z1 = dz;
    const sx = x1;
    const syScreen = y1 * sp - z1 * cp;
    const depth = y1 * cp + z1 * sp;
    return [w * 0.5 + sx * scale, h * 0.5 + syScreen * scale, depth];
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvasEl.getBoundingClientRect();
    const w = Math.max(320, Math.floor(rect.width || 560));
    const h = Math.max(220, Math.floor(rect.height || 340));
    if (canvasEl.width !== w * dpr || canvasEl.height !== h * dpr) {
      canvasEl.width = w * dpr;
      canvasEl.height = h * dpr;
    }
    const ctx = canvasEl.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0b0d10';
    ctx.fillRect(0, 0, w, h);

    // Technical subtle grid lines in viewport background
    ctx.strokeStyle = '#151920';
    ctx.lineWidth = 1;
    for (let gx = 0; gx < w; gx += 32) {
      ctx.beginPath();
      ctx.moveTo(gx + 0.5, 0);
      ctx.lineTo(gx + 0.5, h);
      ctx.stroke();
    }
    for (let gy = 0; gy < h; gy += 32) {
      ctx.beginPath();
      ctx.moveTo(0, gy + 0.5);
      ctx.lineTo(w, gy + 0.5);
      ctx.stroke();
    }

    if (!mesh || !mesh.vertices?.length || !mesh.triangles?.length) return;

    const scale = (Math.min(w, h) * 0.42 * zoom) / radius;
    const projected = mesh.vertices.map((v) => projectPoint(v, w, h, scale));
    const cy = Math.cos(yaw),
      sy = Math.sin(yaw);
    const cp = Math.cos(pitch),
      sp = Math.sin(pitch);

    const lightA = [-0.35, 0.52, 0.78];
    const lightB = [0.65, -0.25, 0.35];

    const faces = [];
    for (const [i0, i1, i2] of mesh.triangles) {
      const p0 = projected[i0],
        p1 = projected[i1],
        p2 = projected[i2];
      const v0 = mesh.vertices[i0],
        v1 = mesh.vertices[i1],
        v2 = mesh.vertices[i2];
      const ux = v1[0] - v0[0],
        uy = v1[1] - v0[1],
        uz = v1[2] - v0[2];
      const vx = v2[0] - v0[0],
        vy = v2[1] - v0[1],
        vz = v2[2] - v0[2];
      const nx = uy * vz - uz * vy,
        ny = uz * vx - ux * vz,
        nz = ux * vy - uy * vx;
      const nLen = Math.hypot(nx, ny, nz) || 1;
      const unx = nx / nLen,
        uny = ny / nLen,
        unz = nz / nLen;
      const ny1 = unx * sy + uny * cy;
      const viewDot = ny1 * cp + unz * sp;
      if (viewDot < -0.02) continue;
      const nx1 = unx * cy - uny * sy;
      const diffA = Math.max(0, nx1 * lightA[0] + ny1 * lightA[1] + unz * lightA[2]);
      const diffB = Math.max(0, nx1 * lightB[0] + ny1 * lightB[1] + unz * lightB[2]) * 0.3;
      const shade = Math.min(1, 0.28 + diffA * 0.62 + diffB);
      const r = Math.round(54 + shade * 124);
      const g = Math.round(64 + shade * 132);
      const b = Math.round(78 + shade * 144);
      faces.push({
        p0,
        p1,
        p2,
        depth: (p0[2] + p1[2] + p2[2]) / 3,
        color: `rgb(${r},${g},${b})`,
      });
    }

    // Painter's sort back-to-front (smaller camera depth = farther away, drawn first)
    faces.sort((a, b) => a.depth - b.depth);

    for (const f of faces) {
      ctx.fillStyle = f.color;
      ctx.strokeStyle = f.color;
      ctx.lineWidth = 0.65;
      ctx.beginPath();
      ctx.moveTo(f.p0[0], f.p0[1]);
      ctx.lineTo(f.p1[0], f.p1[1]);
      ctx.lineTo(f.p2[0], f.p2[1]);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    // Front-facing feature crease edges
    ctx.strokeStyle = '#dce5f0';
    ctx.lineWidth = 1.1;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    for (const edge of creaseEdges) {
      const visibleEdge = edge.normals.some((nrm) => {
        const ny1 = nrm[0] * sy + nrm[1] * cy;
        return ny1 * cp + nrm[2] * sp > -0.01;
      });
      if (!visibleEdge) continue;
      const a = projected[edge.u],
        b = projected[edge.v];
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
    }
    ctx.stroke();
    ctx.globalAlpha = 1.0;

    // 3D UCS Triad (bottom-left)
    const ox = 34,
      oy = h - 30,
      axisLen = 20;
    const axes = [
      { vec: [1, 0, 0], color: '#c24d4d', label: 'X' },
      { vec: [0, 1, 0], color: '#459d5b', label: 'Y' },
      { vec: [0, 0, 1], color: '#4da6ff', label: 'Z' },
    ];
    ctx.font = '10px Consolas, monospace';
    for (const ax of axes) {
      const cy = Math.cos(yaw),
        sy = Math.sin(yaw);
      const cp = Math.cos(pitch),
        sp = Math.sin(pitch);
      const x1 = ax.vec[0] * cy - ax.vec[1] * sy;
      const y1 = ax.vec[0] * sy + ax.vec[1] * cy;
      const ex = ox + x1 * axisLen;
      const ey = oy + (y1 * sp - ax.vec[2] * cp) * axisLen;
      ctx.strokeStyle = ax.color;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(ox, oy);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      ctx.fillStyle = ax.color;
      ctx.fillText(ax.label, ex + 3, ey + 3);
    }
  }

  canvasEl.addEventListener('pointerdown', (e) => {
    dragging = { x: e.clientX, y: e.clientY, yaw, pitch };
    canvasEl.setPointerCapture(e.pointerId);
  });
  canvasEl.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    yaw = dragging.yaw + (e.clientX - dragging.x) * 0.01;
    pitch = Math.max(
      -Math.PI * 0.48,
      Math.min(Math.PI * 0.48, dragging.pitch + (e.clientY - dragging.y) * 0.01),
    );
    draw();
  });
  canvasEl.addEventListener('pointerup', () => {
    dragging = null;
  });
  canvasEl.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      zoom = Math.max(0.35, Math.min(4.5, zoom * Math.exp(-e.deltaY * 0.001)));
      draw();
    },
    { passive: false },
  );

  return {
    setMesh(nextMesh) {
      mesh = nextMesh;
      computeBoundsAndCreases(nextMesh);
      draw();
    },
    resetView() {
      yaw = -Math.PI * 0.28;
      pitch = Math.PI * 0.22;
      zoom = 1.0;
      draw();
    },
    redraw: draw,
  };
}
