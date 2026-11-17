import './quotegate.css';
import { arcPointAt, arcSweepDeg } from '../drawing/model.js';
import { exportDrawingToDxf } from '../drawing/dxf.js';
import {
  DEFAULT_TARIFF,
  DEMO_DXF_PRESETS,
  MATERIALS,
  autoRepairPartDrawing,
  calculateSheetQuote,
  createDemoDxf,
  entityBbox,
  ingestIndustrialDxf,
  splitDrawingIntoParts,
} from './engine.js';

const TARIFF_STORAGE_KEY = 'chamfer_quotegate_tariff_v1';

const I18N = {
  tr: {
    subtitle: 'Chamfer QuoteGate · Milimetrik DXF Analizi & Anında Teklif',
    cadLink: '2D CAD Editörü',
    openTariff: 'Atölye Ayarları & Sitene Göm',
    dropTitle: 'DXF Dosyanızı Sürükleyin veya Seçin',
    dropDesc:
      'AutoCAD / SolidWorks R2000–R2018 ASCII DXF dosyalarını (yaylı LWPOLYLINE, çoklu parça, blok) saniyeler içinde milimetrik olarak analiz edip fiyatlandırır.',
    demoLbl: 'Hemen Dene:',
    partsHeading: 'Parçalar & Üretim Doğrulama (DRC)',
    partsSub:
      'Her parça kapalı kontur, delik çakışması ve kenar payı açısından analitik olarak kontrol edilir.',
    quoteKicker: 'ANINDA KESİM TEKLİFİ',
    quoteHeading: 'Maliyet Özeti',
    lblMaterial: 'Malzeme Türü',
    lblThickness: 'Sac Kalınlığı (mm)',
    lblCurrency: 'Para Birimi',
    lblExpress: '24 Saat Ekspres Üretim (+%35)',
    lblGrandTotal: 'KDV Dahil Toplam',
    btnWhatsapp: 'WhatsApp ile Sipariş Gönder',
    btnPrint: 'Teklif Formu Yazdır / PDF',
    passBadge: 'Üretilebilir (PASS)',
    failBadge: 'Üretim Hatası',
    warnBadge: 'Uyarı Mevcut',
    cutLength: 'Kesim Boyu',
    pierces: 'Patlatma',
    mass: 'Net Ağırlık',
    repairBtn: 'Otomatik Tamir Et (DRC)',
    dlCleanBtn: 'Temiz DXF İndir',
    qtyLabel: 'Adet',
    matCost: 'Malzeme + Fire',
    cutCost: 'Lazer Kesim',
    pierceCost: 'Patlatma / Delik',
    setupCost: 'Makine Hazırlık',
    discountCost: 'Adet İndirimi',
    expressCost: 'Ekspres Üretim',
    vatCost: 'KDV',
    totalWeight: 'Toplam Ağırlık',
    totalCut: 'Toplam Kesim',
    totalPierces: 'Toplam Patlatma',
    floorNote: 'Minimum sipariş tabanı uygulandı.',
  },
  en: {
    subtitle: 'Chamfer QuoteGate · Millimeter DXF Analysis & Instant Quoting',
    cadLink: '2D CAD Workbench',
    openTariff: 'Workshop Rates & Embed',
    dropTitle: 'Drop or Select Your DXF File',
    dropDesc:
      'Analyzes AutoCAD / SolidWorks R2000–R2018 ASCII DXF files (bulge LWPOLYLINE arcs, multi-part sheets, blocks) analytically in milliseconds.',
    demoLbl: 'Try Preset:',
    partsHeading: 'Parts & Manufacturing Verification (DRC)',
    partsSub:
      'Every part is checked analytically for loop closure, hole collisions, and web clearances.',
    quoteKicker: 'INSTANT CUTTING QUOTE',
    quoteHeading: 'Cost Breakdown',
    lblMaterial: 'Material Grade',
    lblThickness: 'Thickness (mm)',
    lblCurrency: 'Currency',
    lblExpress: '24h Express Production (+35%)',
    lblGrandTotal: 'Total incl. VAT',
    btnWhatsapp: 'Send Order via WhatsApp',
    btnPrint: 'Print Quote / Save PDF',
    passBadge: 'Machinable (PASS)',
    failBadge: 'DRC Blocked',
    warnBadge: 'Has Warnings',
    cutLength: 'Cut Length',
    pierces: 'Pierces',
    mass: 'Net Mass',
    repairBtn: 'Auto-Repair (DRC)',
    dlCleanBtn: 'Clean DXF',
    qtyLabel: 'Qty',
    matCost: 'Material + Scrap',
    cutCost: 'Laser Cutting',
    pierceCost: 'Piercing',
    setupCost: 'Machine Setup',
    discountCost: 'Volume Discount',
    expressCost: 'Express Surcharge',
    vatCost: 'VAT',
    totalWeight: 'Total Mass',
    totalCut: 'Total Cut',
    totalPierces: 'Total Pierces',
    floorNote: 'Minimum order floor applied.',
  },
};

function loadSavedTariff() {
  try {
    const raw = localStorage.getItem(TARIFF_STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_TARIFF);
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_TARIFF,
      ...parsed,
      materialRateOverrides: {
        ...DEFAULT_TARIFF.materialRateOverrides,
        ...(parsed?.materialRateOverrides || {}),
      },
    };
  } catch {
    return structuredClone(DEFAULT_TARIFF);
  }
}

function saveTariff(tariff) {
  try {
    localStorage.setItem(TARIFF_STORAGE_KEY, JSON.stringify(tariff));
  } catch {
    // ignore quota restrictions
  }
}

function buildPartSvg(drawing) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const ents = drawing.entities.filter((e) => e.type !== 'dim' && e.type !== 'text');
  if (!ents.length) return svg;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const e of ents) {
    const [x0, y0, x1, y1] = entityBbox(e);
    if (x0 < minX) minX = x0;
    if (y0 < minY) minY = y0;
    if (x1 > maxX) maxX = x1;
    if (y1 > maxY) maxY = y1;
  }

  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const pad = Math.max(w, h) * 0.1;
  svg.setAttribute('viewBox', `${minX - pad} ${-(maxY + pad)} ${w + 2 * pad} ${h + 2 * pad}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  const strokeW = Math.max(w, h) * 0.015;
  for (const e of ents) {
    if (e.type === 'line') {
      const el = document.createElementNS(ns, 'line');
      el.setAttribute('x1', String(e.points[0][0]));
      el.setAttribute('y1', String(-e.points[0][1]));
      el.setAttribute('x2', String(e.points[1][0]));
      el.setAttribute('y2', String(-e.points[1][1]));
      el.setAttribute('stroke', '#38bdf8');
      el.setAttribute('stroke-width', String(strokeW));
      el.setAttribute('stroke-linecap', 'round');
      svg.appendChild(el);
    } else if (e.type === 'polyline') {
      const el = document.createElementNS(ns, e.closed ? 'polygon' : 'polyline');
      el.setAttribute('points', e.points.map((p) => `${p[0]},${-p[1]}`).join(' '));
      el.setAttribute('fill', 'none');
      el.setAttribute('stroke', '#38bdf8');
      el.setAttribute('stroke-width', String(strokeW));
      el.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(el);
    } else if (e.type === 'circle') {
      const el = document.createElementNS(ns, 'circle');
      el.setAttribute('cx', String(e.center[0]));
      el.setAttribute('cy', String(-e.center[1]));
      el.setAttribute('r', String(e.radius));
      el.setAttribute('fill', 'none');
      el.setAttribute('stroke', '#34d399');
      el.setAttribute('stroke-width', String(strokeW));
      svg.appendChild(el);
    } else if (e.type === 'arc') {
      const p1 = arcPointAt(e, e.start_angle);
      const p2 = arcPointAt(e, e.end_angle);
      const sweep = arcSweepDeg(e.start_angle, e.end_angle);
      const largeArc = sweep > 180 ? 1 : 0;
      const el = document.createElementNS(ns, 'path');
      el.setAttribute(
        'd',
        `M ${p1[0]} ${-p1[1]} A ${e.radius} ${e.radius} 0 ${largeArc} 0 ${p2[0]} ${-p2[1]}`,
      );
      el.setAttribute('fill', 'none');
      el.setAttribute('stroke', '#38bdf8');
      el.setAttribute('stroke-width', String(strokeW));
      el.setAttribute('stroke-linecap', 'round');
      svg.appendChild(el);
    }
  }
  return svg;
}

const els = {
  shopName: document.getElementById('qg-shop-name'),
  subtitle: document.getElementById('qg-subtitle'),
  linkCad: document.getElementById('link-cad-editor'),
  btnLangTr: document.getElementById('btn-lang-tr'),
  btnLangEn: document.getElementById('btn-lang-en'),
  btnOpenTariff: document.getElementById('btn-open-tariff'),
  dropZone: document.getElementById('drop-zone'),
  fileInput: document.getElementById('file-input'),
  dropTitle: document.getElementById('drop-title'),
  dropDesc: document.getElementById('drop-desc'),
  demoLbl: document.getElementById('demo-lbl'),
  errorBanner: document.getElementById('error-banner'),
  intakeBanner: document.getElementById('intake-banner'),
  partsHeading: document.getElementById('parts-heading'),
  partsSub: document.getElementById('parts-sub'),
  partsCountPill: document.getElementById('parts-count-pill'),
  partsList: document.getElementById('parts-list'),
  quoteKicker: document.getElementById('quote-kicker'),
  quoteHeading: document.getElementById('quote-heading'),
  quoteValidBadge: document.getElementById('quote-valid-badge'),
  lblMaterial: document.getElementById('lbl-material'),
  selMaterial: document.getElementById('sel-material'),
  lblThickness: document.getElementById('lbl-thickness'),
  selThickness: document.getElementById('sel-thickness'),
  lblCurrency: document.getElementById('lbl-currency'),
  selCurrency: document.getElementById('sel-currency'),
  chkExpress: document.getElementById('chk-express'),
  lblExpress: document.getElementById('lbl-express'),
  quoteTelemetry: document.getElementById('quote-telemetry'),
  quoteBreakdown: document.getElementById('quote-breakdown'),
  lblGrandTotal: document.getElementById('lbl-grand-total'),
  valGrandTotal: document.getElementById('val-grand-total'),
  lblFloorNote: document.getElementById('lbl-floor-note'),
  btnWhatsapp: document.getElementById('btn-whatsapp'),
  btnPrintQuote: document.getElementById('btn-print-quote'),
  tariffBackdrop: document.getElementById('tariff-backdrop'),
  btnCloseTariff: document.getElementById('btn-close-tariff'),
  tariffForm: document.getElementById('tariff-form'),
  tfShopName: document.getElementById('tf-shop-name'),
  tfWhatsapp: document.getElementById('tf-whatsapp'),
  tfCutRate: document.getElementById('tf-cut-rate'),
  tfPierce: document.getElementById('tf-pierce'),
  tfSetup: document.getElementById('tf-setup'),
  tfMinOrder: document.getElementById('tf-min-order'),
  tfScrap: document.getElementById('tf-scrap'),
  tfVat: document.getElementById('tf-vat'),
  tfMatSteel: document.getElementById('tf-mat-steel'),
  tfMatSs: document.getElementById('tf-mat-ss'),
  tfMatAl: document.getElementById('tf-mat-al'),
  tfEmbedCode: document.getElementById('tf-embed-code'),
  btnCopyEmbed: document.getElementById('btn-copy-embed'),
  btnResetTariff: document.getElementById('btn-reset-tariff'),
};

const state = {
  lang: 'tr',
  fileName: '',
  intakeReport: null,
  parts: [],
  tariff: loadSavedTariff(),
  materialId: 'steel_s235',
  thicknessMm: 2.0,
  currency: 'TRY',
  express: false,
  lastQuote: null,
};

function fmtMoney(val, sym) {
  return `${sym}${Number(val || 0).toLocaleString(state.lang === 'tr' ? 'tr-TR' : 'en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function populateMaterialOptions() {
  const prev = state.materialId;
  els.selMaterial.replaceChildren();
  for (const m of Object.values(MATERIALS)) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = state.lang === 'tr' ? m.nameTr : m.nameEn;
    els.selMaterial.appendChild(opt);
  }
  els.selMaterial.value = prev;
}

function applyLanguage() {
  const t = I18N[state.lang];
  els.shopName.textContent = state.tariff.shopName || DEFAULT_TARIFF.shopName;
  els.subtitle.textContent = t.subtitle;
  els.linkCad.textContent = t.cadLink;
  els.btnOpenTariff.textContent = t.openTariff;
  els.dropTitle.textContent = t.dropTitle;
  els.dropDesc.textContent = t.dropDesc;
  els.demoLbl.textContent = t.demoLbl;
  els.partsHeading.textContent = t.partsHeading;
  els.partsSub.textContent = t.partsSub;
  els.quoteKicker.textContent = t.quoteKicker;
  els.quoteHeading.textContent = t.quoteHeading;
  els.lblMaterial.textContent = t.lblMaterial;
  els.lblThickness.textContent = t.lblThickness;
  els.lblCurrency.textContent = t.lblCurrency;
  els.lblExpress.textContent = t.lblExpress;
  els.lblGrandTotal.textContent = t.lblGrandTotal;
  els.btnWhatsapp.textContent = t.btnWhatsapp;
  els.btnPrintQuote.textContent = t.btnPrint;
  els.btnLangTr.classList.toggle('active', state.lang === 'tr');
  els.btnLangEn.classList.toggle('active', state.lang === 'en');
  populateMaterialOptions();
}

function loadDxfContent(dxfText, fileName) {
  els.errorBanner.hidden = true;
  els.intakeBanner.hidden = true;
  try {
    const { drawing, intakeReport } = ingestIndustrialDxf(dxfText, fileName);
    const split = splitDrawingIntoParts(drawing).map((p) => ({
      ...p,
      qty: 1,
      appliedFixes: [],
    }));
    state.fileName = fileName;
    state.intakeReport = intakeReport;
    state.parts = split;

    els.intakeBanner.hidden = false;
    els.intakeBanner.textContent =
      state.lang === 'tr'
        ? `${fileName} yüklendi · ${split.length} parça ayrıştırıldı · Birim: ${intakeReport.detectedUnits} (×${intakeReport.scaleToMm}) · ${intakeReport.convertedBulgeArcs} kavisli LWPOLYLINE yayına dönüştürüldü${intakeReport.ignoredAnnotations ? ` · ${intakeReport.ignoredAnnotations} ölçü/metin notu ayıklandı` : ''}.`
        : `Loaded ${fileName} · ${split.length} parts split · Units: ${intakeReport.detectedUnits} (×${intakeReport.scaleToMm}) · ${intakeReport.convertedBulgeArcs} bulge arcs converted.`;

    renderAll();
  } catch (err) {
    els.errorBanner.hidden = false;
    els.errorBanner.textContent = err.message;
  }
}

function downloadCleanPartDxf(part) {
  const dxfOut = exportDrawingToDxf(part.drawing, { cutOnly: true });
  const blob = new Blob([dxfOut], { type: 'application/dxf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(part.drawing.name || 'parca').replace(/[^a-z0-9_-]+/gi, '-')}-temiz.dxf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function renderAll() {
  const t = I18N[state.lang];
  applyLanguage();

  const quote = calculateSheetQuote(
    state.parts,
    {
      materialId: state.materialId,
      thicknessMm: state.thicknessMm,
      currency: state.currency,
      express: state.express,
    },
    state.tariff,
  );
  state.lastQuote = quote;

  els.partsCountPill.textContent = `${quote.parts.length} ${state.lang === 'tr' ? 'Parça' : 'Parts'}`;
  els.partsList.replaceChildren();

  for (let i = 0; i < quote.parts.length; i++) {
    const p = quote.parts[i];
    const card = document.createElement('article');
    card.className = 'qg-part-card';

    const preview = document.createElement('div');
    preview.className = 'qg-part-preview';
    preview.appendChild(buildPartSvg(p.drawing));
    const dimsTag = document.createElement('span');
    dimsTag.className = 'qg-part-dims';
    dimsTag.textContent = `${p.cam.bbox_mm[0].toFixed(1)} × ${p.cam.bbox_mm[1].toFixed(1)} mm`;
    preview.appendChild(dimsTag);
    card.appendChild(preview);

    const body = document.createElement('div');
    body.className = 'qg-part-body';

    const top = document.createElement('div');
    top.className = 'qg-part-top';
    const title = document.createElement('div');
    title.className = 'qg-part-title';
    title.textContent = p.name;

    const pill = document.createElement('span');
    if (p.lint.valid && p.lint.summary.warnings === 0) {
      pill.className = 'qg-status-pill pass';
      pill.textContent = t.passBadge;
    } else if (p.lint.valid) {
      pill.className = 'qg-status-pill warn';
      pill.textContent = `${t.warnBadge} (${p.lint.summary.warnings})`;
    } else {
      pill.className = 'qg-status-pill fail';
      pill.textContent = `${t.failBadge} (${p.lint.summary.errors})`;
    }
    top.append(title, pill);
    body.appendChild(top);

    const metrics = document.createElement('div');
    metrics.className = 'qg-part-metrics';
    for (const [lbl, val] of [
      [t.cutLength, `${p.cam.cut_length_mm.toFixed(1)} mm`],
      [t.pierces, `${p.cam.pierce_count}`],
      [t.mass, `${(p.unitMassKg * 1000).toFixed(1)} g`],
    ]) {
      const m = document.createElement('div');
      m.className = 'qg-mini-stat';
      const sp = document.createElement('span');
      sp.textContent = lbl;
      const st = document.createElement('strong');
      st.textContent = val;
      m.append(sp, st);
      metrics.appendChild(m);
    }
    body.appendChild(metrics);

    if (p.lint.issues.length > 0) {
      const box = document.createElement('div');
      box.className = 'qg-issues-box';
      const head = document.createElement('strong');
      head.textContent =
        state.lang === 'tr' ? 'Tespit Edilen DRC Bulguları:' : 'Detected DRC Issues:';
      const ul = document.createElement('ul');
      for (const iss of p.lint.issues.slice(0, 4)) {
        const li = document.createElement('li');
        li.textContent = `${iss.code}: ${iss.message}`;
        ul.appendChild(li);
      }
      box.append(head, ul);
      body.appendChild(box);
    }

    if (Array.isArray(p.appliedFixes) && p.appliedFixes.length > 0) {
      const fx = document.createElement('div');
      fx.className = 'qg-fix-note';
      fx.textContent = `${state.lang === 'tr' ? 'Onarıldı' : 'Fixed'}: ${p.appliedFixes.map((f) => f.summary).join(' · ')}`;
      body.appendChild(fx);
    }

    const foot = document.createElement('div');
    foot.className = 'qg-part-foot';

    const qtyWrap = document.createElement('div');
    qtyWrap.className = 'qg-qty-wrap';
    const btnDec = document.createElement('button');
    btnDec.type = 'button';
    btnDec.textContent = '−';
    btnDec.addEventListener('click', () => {
      state.parts[i].qty = Math.max(1, (state.parts[i].qty || 1) - 1);
      renderAll();
    });
    const qtyInp = document.createElement('input');
    qtyInp.type = 'number';
    qtyInp.min = '1';
    qtyInp.max = '10000';
    qtyInp.value = String(p.qty);
    qtyInp.setAttribute('aria-label', t.qtyLabel);
    qtyInp.addEventListener('change', () => {
      const val = Math.max(1, Math.min(10000, Math.round(Number(qtyInp.value) || 1)));
      state.parts[i].qty = val;
      renderAll();
    });
    const btnInc = document.createElement('button');
    btnInc.type = 'button';
    btnInc.textContent = '+';
    btnInc.addEventListener('click', () => {
      state.parts[i].qty = (state.parts[i].qty || 1) + 1;
      renderAll();
    });
    qtyWrap.append(btnDec, qtyInp, btnInc);

    const acts = document.createElement('div');
    acts.className = 'qg-part-actions';
    if (!p.lint.valid || p.lint.summary.warnings > 0) {
      const fixBtn = document.createElement('button');
      fixBtn.type = 'button';
      fixBtn.className = 'qg-btn-repair no-print';
      fixBtn.textContent = t.repairBtn;
      fixBtn.addEventListener('click', () => {
        const res = autoRepairPartDrawing(state.parts[i].drawing, state.thicknessMm);
        state.parts[i].drawing = res.drawing;
        state.parts[i].appliedFixes = [...(state.parts[i].appliedFixes || []), ...res.appliedFixes];
        renderAll();
      });
      acts.appendChild(fixBtn);
    }

    const dlBtn = document.createElement('button');
    dlBtn.type = 'button';
    dlBtn.className = 'qg-btn-soft no-print';
    dlBtn.textContent = t.dlCleanBtn;
    dlBtn.addEventListener('click', () => downloadCleanPartDxf(p));

    const priceEl = document.createElement('span');
    priceEl.className = 'qg-part-price';
    priceEl.textContent = fmtMoney(p.lineTotalDisplay, quote.currencySymbol);
    acts.append(dlBtn, priceEl);

    foot.append(qtyWrap, acts);
    body.appendChild(foot);
    card.appendChild(body);
    els.partsList.appendChild(card);
  }

  // Quote sidebar rendering
  const s = quote.summary;
  els.quoteValidBadge.className = `qg-status-pill ${s.allPartsValid ? 'pass' : 'warn'}`;
  els.quoteValidBadge.textContent = s.allPartsValid ? t.passBadge : `${s.errorCount} DRC`;

  els.quoteTelemetry.replaceChildren();
  for (const [lbl, val] of [
    [t.totalWeight, `${s.totalMassKg.toFixed(2)} kg`],
    [t.totalCut, `${s.totalCutMeters.toFixed(2)} m`],
    [t.totalPierces, `${s.totalPierces}`],
  ]) {
    const cell = document.createElement('div');
    cell.className = 'qg-telemetry-cell';
    const sp = document.createElement('span');
    sp.textContent = lbl;
    const st = document.createElement('strong');
    st.className = 'qg-telemetry-val';
    st.textContent = val;
    cell.append(sp, st);
    els.quoteTelemetry.appendChild(cell);
  }

  els.quoteBreakdown.replaceChildren();
  const rows = [
    [t.matCost, fmtMoney(s.materialCost, quote.currencySymbol)],
    [t.cutCost, fmtMoney(s.cuttingCost, quote.currencySymbol)],
    [t.pierceCost, fmtMoney(s.pierceCost, quote.currencySymbol)],
    [t.setupCost, fmtMoney(s.setupFee, quote.currencySymbol)],
  ];
  if (s.discountPct > 0) {
    rows.push([
      `${t.discountCost} (-%${s.discountPct})`,
      `-${fmtMoney(s.discountAmount, quote.currencySymbol)}`,
    ]);
  }
  if (s.expressSurcharge > 0) {
    rows.push([t.expressCost, fmtMoney(s.expressSurcharge, quote.currencySymbol)]);
  }
  rows.push([`${t.vatCost} (%${s.vatPct})`, fmtMoney(s.vatAmount, quote.currencySymbol)]);

  for (const [lbl, val] of rows) {
    const r = document.createElement('div');
    r.className = 'qg-breakdown-row';
    const sp = document.createElement('span');
    sp.textContent = lbl;
    const st = document.createElement('strong');
    st.textContent = val;
    r.append(sp, st);
    els.quoteBreakdown.appendChild(r);
  }

  els.valGrandTotal.textContent = fmtMoney(s.grandTotal, quote.currencySymbol);
  els.lblFloorNote.hidden = !s.minFloorApplied;
  if (s.minFloorApplied) {
    els.lblFloorNote.textContent = `${t.floorNote} (${fmtMoney(
      state.tariff.minOrderTry /
        (quote.currency === 'USD'
          ? state.tariff.usdTry
          : quote.currency === 'EUR'
            ? state.tariff.eurTry
            : 1),
      quote.currencySymbol,
    )})`;
  }
}

function openTariffModal() {
  const tf = state.tariff;
  els.tfShopName.value = tf.shopName;
  els.tfWhatsapp.value = tf.whatsappPhone || '';
  els.tfCutRate.value = String(tf.cutRateTryPerMeter);
  els.tfPierce.value = String(tf.pierceTry);
  els.tfSetup.value = String(tf.setupFeeTry);
  els.tfMinOrder.value = String(tf.minOrderTry);
  els.tfScrap.value = String(tf.scrapMarkupPct);
  els.tfVat.value = String(tf.vatPct);
  els.tfMatSteel.value = String(
    tf.materialRateOverrides?.steel_s235 ?? MATERIALS.steel_s235.rateTryPerKg,
  );
  els.tfMatSs.value = String(
    tf.materialRateOverrides?.stainless_304 ?? MATERIALS.stainless_304.rateTryPerKg,
  );
  els.tfMatAl.value = String(
    tf.materialRateOverrides?.aluminum_6061 ?? MATERIALS.aluminum_6061.rateTryPerKg,
  );
  const pageUrl = window.location.href.split('#')[0];
  els.tfEmbedCode.value = `<iframe src="${pageUrl}" width="100%" height="780" style="border:0;border-radius:16px;" loading="lazy"></iframe>`;
  els.tariffBackdrop.hidden = false;
}

// Event Bindings
els.btnLangTr.addEventListener('click', () => {
  state.lang = 'tr';
  renderAll();
});
els.btnLangEn.addEventListener('click', () => {
  state.lang = 'en';
  renderAll();
});

els.dropZone.addEventListener('click', (e) => {
  if (e.target.closest('button')) return;
  els.fileInput.click();
});
els.dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  els.dropZone.classList.add('is-drag');
});
els.dropZone.addEventListener('dragleave', () => {
  els.dropZone.classList.remove('is-drag');
});
els.dropZone.addEventListener('drop', async (e) => {
  e.preventDefault();
  els.dropZone.classList.remove('is-drag');
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  loadDxfContent(await file.text(), file.name);
});
els.fileInput.addEventListener('change', async () => {
  const file = els.fileInput.files?.[0];
  if (!file) return;
  loadDxfContent(await file.text(), file.name);
  els.fileInput.value = '';
});

document.querySelectorAll('.qg-demo-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const id = btn.dataset.preset;
    const preset = DEMO_DXF_PRESETS[id] || DEMO_DXF_PRESETS.multi_part_bulge;
    loadDxfContent(createDemoDxf(id), preset.fileName);
  });
});

els.selMaterial.addEventListener('change', () => {
  state.materialId = els.selMaterial.value;
  renderAll();
});
els.selThickness.addEventListener('change', () => {
  state.thicknessMm = Number(els.selThickness.value) || 2.0;
  renderAll();
});
els.selCurrency.addEventListener('change', () => {
  state.currency = els.selCurrency.value;
  renderAll();
});
els.chkExpress.addEventListener('change', () => {
  state.express = els.chkExpress.checked;
  renderAll();
});

els.btnWhatsapp.addEventListener('click', () => {
  const q = state.lastQuote;
  if (!q) return;
  const partLines = q.parts.map(
    (p) =>
      `• ${p.name} (${p.cam.bbox_mm[0].toFixed(1)}×${p.cam.bbox_mm[1].toFixed(1)} mm) × ${p.qty} adet -> ${fmtMoney(p.lineTotalDisplay, q.currencySymbol)}`,
  );
  const msg = [
    `*${state.tariff.shopName} — Lazer Kesim Teklifi*`,
    `Dosya: ${state.fileName || 'siparis.dxf'}`,
    `Malzeme: ${q.material.nameTr} · ${q.thicknessMm} mm${q.express ? ' · EKSPRES 24s' : ''}`,
    ...partLines,
    `*Toplam (KDV Dahil): ${fmtMoney(q.summary.grandTotal, q.currencySymbol)}*`,
  ].join('\n');
  const digits = String(state.tariff.whatsappPhone || '').replace(/[^\d]/g, '');
  const waUrl = digits
    ? `https://wa.me/${digits}?text=${encodeURIComponent(msg)}`
    : `https://wa.me/?text=${encodeURIComponent(msg)}`;
  window.open(waUrl, '_blank', 'noopener,noreferrer');
});

els.btnPrintQuote.addEventListener('click', () => window.print());

els.btnOpenTariff.addEventListener('click', openTariffModal);
els.btnCloseTariff.addEventListener('click', () => {
  els.tariffBackdrop.hidden = true;
});
els.tariffBackdrop.addEventListener('click', (e) => {
  if (e.target === els.tariffBackdrop) els.tariffBackdrop.hidden = true;
});

els.btnResetTariff.addEventListener('click', () => {
  state.tariff = structuredClone(DEFAULT_TARIFF);
  saveTariff(state.tariff);
  openTariffModal();
  renderAll();
});

els.btnCopyEmbed.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(els.tfEmbedCode.value);
    els.btnCopyEmbed.textContent = 'Kopyalandı ✓';
    setTimeout(() => {
      els.btnCopyEmbed.textContent = 'Embed Kodunu Kopyala';
    }, 1800);
  } catch {
    els.tfEmbedCode.select();
  }
});

els.tariffForm.addEventListener('submit', (e) => {
  e.preventDefault();
  state.tariff = {
    ...state.tariff,
    shopName: els.tfShopName.value.trim() || DEFAULT_TARIFF.shopName,
    whatsappPhone: els.tfWhatsapp.value.trim(),
    cutRateTryPerMeter: Number(els.tfCutRate.value) || DEFAULT_TARIFF.cutRateTryPerMeter,
    pierceTry: Number(els.tfPierce.value) ?? DEFAULT_TARIFF.pierceTry,
    setupFeeTry: Number(els.tfSetup.value) ?? DEFAULT_TARIFF.setupFeeTry,
    minOrderTry: Number(els.tfMinOrder.value) ?? DEFAULT_TARIFF.minOrderTry,
    scrapMarkupPct: Number(els.tfScrap.value) ?? DEFAULT_TARIFF.scrapMarkupPct,
    vatPct: Number(els.tfVat.value) ?? DEFAULT_TARIFF.vatPct,
    materialRateOverrides: {
      ...state.tariff.materialRateOverrides,
      steel_s235: Number(els.tfMatSteel.value) || MATERIALS.steel_s235.rateTryPerKg,
      stainless_304: Number(els.tfMatSs.value) || MATERIALS.stainless_304.rateTryPerKg,
      aluminum_6061: Number(els.tfMatAl.value) || MATERIALS.aluminum_6061.rateTryPerKg,
    },
  };
  saveTariff(state.tariff);
  els.tariffBackdrop.hidden = true;
  renderAll();
});

// Boot immediately with the multi-part bulge laser demo so storefront is live out-of-the-box.
loadDxfContent(createDemoDxf('multi_part_bulge'), DEMO_DXF_PRESETS.multi_part_bulge.fileName);
