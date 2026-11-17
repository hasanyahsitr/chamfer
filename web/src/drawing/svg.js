// Pure client-side ISO technical blueprint SVG sheet exporter.
import { computeCamMetrics, dimGeometry, validateDrawing } from './model.js';
import { lintDrawing } from './linter.js';
import { arcGeometry } from './ops.js';

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function exportDrawingToSvgBlueprint(
  drawing,
  thicknessMm = 4.0,
  { manufacturing = true } = {},
) {
  const data = validateDrawing(drawing);
  const cam = computeCamMetrics(data, thicknessMm);
  const lint = lintDrawing(data, { manufacturing, thicknessMm });

  const visibleLayers = new Map(
    data.layers.filter((l) => l.visible !== false).map((l) => [l.id, l]),
  );
  const visEntities = data.entities.filter((e) => visibleLayers.has(e.layer));

  const xs = [],
    ys = [];
  for (const ent of visEntities) {
    if (ent.type === 'line' || ent.type === 'polyline') {
      for (const [x, y] of ent.points) {
        xs.push(x);
        ys.push(y);
      }
    } else if (ent.type === 'circle' || ent.type === 'arc') {
      const [cx, cy] = ent.center;
      const r = ent.radius;
      xs.push(cx - r, cx + r);
      ys.push(cy - r, cy + r);
    } else if (ent.type === 'dim') {
      for (const [x, y] of [ent.p1, ent.p2, ent.dim_point]) {
        xs.push(x);
        ys.push(y);
      }
    } else if (ent.type === 'text') {
      xs.push(ent.position[0]);
      ys.push(ent.position[1]);
    }
  }
  if (!xs.length) {
    xs.push(0, 100);
    ys.push(0, 60);
  }

  const minX = Math.min(...xs),
    maxX = Math.max(...xs);
  const minY = Math.min(...ys),
    maxY = Math.max(...ys);
  const spanX = Math.max(maxX - minX, 20);
  const spanY = Math.max(maxY - minY, 20);
  const pad = Math.max(spanX, spanY) * 0.14;

  const vx = minX - pad;
  const vw = spanX + 2 * pad;
  const titleH = Math.max(spanY * 0.18, 14);
  const vy = -maxY - pad;
  const vh = spanY + 2 * pad + titleH;
  const strokeBase = Math.max(spanX, spanY) * 0.0035;

  const lines = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vx.toFixed(3)} ${vy.toFixed(3)} ${vw.toFixed(3)} ${vh.toFixed(3)}" width="1200" height="850" style="background:#0b0d10;font-family:Consolas,monospace">`,
    `<rect x="${vx.toFixed(3)}" y="${vy.toFixed(3)}" width="${vw.toFixed(3)}" height="${vh.toFixed(3)}" fill="#0b0d10"/>`,
    `<rect x="${(vx + pad * 0.25).toFixed(3)}" y="${(vy + pad * 0.25).toFixed(3)}" width="${(vw - pad * 0.5).toFixed(3)}" height="${(vh - pad * 0.5).toFixed(3)}" fill="none" stroke="#323a46" stroke-width="${(strokeBase * 0.9).toFixed(3)}"/>`,
    '<g transform="scale(1,-1)">',
  ];

  for (const ent of visEntities) {
    const color = visibleLayers.get(ent.layer).color;
    if (ent.type === 'line') {
      const [[x1, y1], [x2, y2]] = ent.points;
      lines.push(
        `<line x1="${x1.toFixed(4)}" y1="${y1.toFixed(4)}" x2="${x2.toFixed(4)}" y2="${y2.toFixed(4)}" stroke="${color}" stroke-width="${strokeBase.toFixed(4)}" fill="none"/>`,
      );
    } else if (ent.type === 'polyline') {
      const ptsAttr = ent.points.map(([x, y]) => `${x.toFixed(4)},${y.toFixed(4)}`).join(' ');
      const tag = ent.closed ? 'polygon' : 'polyline';
      lines.push(
        `<${tag} points="${ptsAttr}" stroke="${color}" stroke-width="${strokeBase.toFixed(4)}" fill="none"/>`,
      );
    } else if (ent.type === 'circle') {
      const [cx, cy] = ent.center;
      lines.push(
        `<circle cx="${cx.toFixed(4)}" cy="${cy.toFixed(4)}" r="${ent.radius.toFixed(4)}" stroke="${color}" stroke-width="${strokeBase.toFixed(4)}" fill="none"/>`,
      );
    } else if (ent.type === 'arc') {
      const { pStart, pEnd, sweep } = arcGeometry(ent);
      const largeArc = sweep > 180 ? 1 : 0;
      const r = ent.radius;
      lines.push(
        `<path d="M ${pStart[0].toFixed(4)} ${pStart[1].toFixed(4)} A ${r.toFixed(4)} ${r.toFixed(4)} 0 ${largeArc} 1 ${pEnd[0].toFixed(4)} ${pEnd[1].toFixed(4)}" stroke="${color}" stroke-width="${strokeBase.toFixed(4)}" fill="none"/>`,
      );
    } else if (ent.type === 'dim') {
      const g = dimGeometry(ent);
      if (g.span > 1e-6) {
        lines.push(
          `<line x1="${g.p1[0].toFixed(3)}" y1="${g.p1[1].toFixed(3)}" x2="${g.d1[0].toFixed(3)}" y2="${g.d1[1].toFixed(3)}" stroke="${color}" stroke-width="${(strokeBase * 0.7).toFixed(4)}"/>`,
          `<line x1="${g.p2[0].toFixed(3)}" y1="${g.p2[1].toFixed(3)}" x2="${g.d2[0].toFixed(3)}" y2="${g.d2[1].toFixed(3)}" stroke="${color}" stroke-width="${(strokeBase * 0.7).toFixed(4)}"/>`,
          `<line x1="${g.d1[0].toFixed(3)}" y1="${g.d1[1].toFixed(3)}" x2="${g.d2[0].toFixed(3)}" y2="${g.d2[1].toFixed(3)}" stroke="${color}" stroke-width="${(strokeBase * 0.8).toFixed(4)}"/>`,
        );
        const fs = strokeBase * 7.5;
        lines.push(
          `<text x="${g.mid[0].toFixed(3)}" y="${(-g.mid[1]).toFixed(3)}" transform="scale(1,-1)" fill="${color}" font-size="${fs.toFixed(3)}" text-anchor="middle" dominant-baseline="central">${g.span.toFixed(2)}</text>`,
        );
      }
    } else if (ent.type === 'text') {
      const [tx, ty] = ent.position;
      const th = ent.height;
      const rot = ent.rotation || 0;
      lines.push(
        `<text x="${tx.toFixed(3)}" y="${(-ty).toFixed(3)}" transform="scale(1,-1) rotate(${(-rot).toFixed(2)} ${tx.toFixed(3)} ${(-ty).toFixed(3)})" fill="${color}" font-size="${th.toFixed(3)}">${escapeXml(ent.text)}</text>`,
      );
    }
  }
  lines.push('</g>');

  const tbY = vy + vh - pad * 0.25 - titleH * 0.82;
  const tbX = vx + pad * 0.25;
  const tbW = vw - pad * 0.5;
  const tbH = titleH * 0.82;
  const fsTitle = tbH * 0.28;
  const fsMeta = tbH * 0.2;
  const errs = lint.summary.errors;
  const warns = lint.summary.warnings;
  const profileTag = manufacturing ? 'MFG DRC' : 'DRAFT DRC';
  let drcStr, drcCol;
  if (lint.summary.checked_entities === 0) {
    drcStr = `${profileTag}: NO CUT PROFILE`;
    drcCol = '#e5534b';
  } else if (errs === 0 && warns === 0) {
    drcStr = `${profileTag}: PASSED (0 ERR / 0 WARN)`;
    drcCol = '#3fb950';
  } else if (errs === 0) {
    drcStr = `${profileTag}: WARNINGS (0 ERR / ${warns} WARN)`;
    drcCol = '#d29922';
  } else {
    drcStr = `${profileTag}: FAILED (${errs} ERR / ${warns} WARN)`;
    drcCol = '#e5534b';
  }
  const partTitle = escapeXml(data.name || 'UNTITLED');

  lines.push(
    `<rect x="${tbX.toFixed(3)}" y="${tbY.toFixed(3)}" width="${tbW.toFixed(3)}" height="${tbH.toFixed(3)}" fill="#12151a" stroke="#323a46" stroke-width="${(strokeBase * 0.9).toFixed(3)}"/>`,
    `<text x="${(tbX + tbH * 0.35).toFixed(3)}" y="${(tbY + tbH * 0.44).toFixed(3)}" fill="#e6ebf2" font-size="${fsTitle.toFixed(3)}" font-weight="bold">CHAMFER // ${partTitle}</text>`,
    `<text x="${(tbX + tbH * 0.35).toFixed(3)}" y="${(tbY + tbH * 0.78).toFixed(3)}" fill="#939da8" font-size="${fsMeta.toFixed(3)}">UNITS: MM  |  CUT: ${cam.cut_length_mm.toFixed(1)} MM  |  PIERCES: ${cam.pierce_count}  |  AREA: ${cam.net_area_mm2.toFixed(1)} MM²</text>`,
    `<text x="${(tbX + tbW - tbH * 0.35).toFixed(3)}" y="${(tbY + tbH * 0.62).toFixed(3)}" fill="${drcCol}" font-size="${(fsMeta * 1.05).toFixed(3)}" font-weight="bold" text-anchor="end">${drcStr}</text>`,
    '</svg>',
  );
  return lines.join('\n') + '\n';
}
