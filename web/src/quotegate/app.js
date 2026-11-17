import './quotegate.css';
import { arcPointAt, arcSweepDeg } from '../drawing/model.js';
import { cuttingLayerIds } from '../drawing/ops.js';
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
  sanitizeTariff,
  splitDrawingIntoParts,
} from './engine.js';

const TARIFF_STORAGE_KEY = 'chamfer_quotegate_tariff_v1';
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

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
    drcCheckoutBlock:
      'Üretim hatası (DRC) içeren parçalar onarılmadan WhatsApp siparişi oluşturulamaz. Sol taraftaki "Otomatik Tamir Et (DRC)" düğmesini kullanın.',
    drcCheckoutTooltip: 'Sipariş göndermek için önce DRC üretim hatalarını onarın.',
    massEstNote: 'Açık konturlu parçalarda ağırlık dış zarf üzerinden tahmini hesaplandı.',
    fileTooBig: 'DXF dosyası 2 MiB sınırını aşıyor; parçaları bölerek yükleyin.',
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
    btnPrintQuote: 'Print Quote / Save PDF',
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
    drcCheckoutBlock:
      'Parts with manufacturing DRC errors must be repaired before placing a WhatsApp order. Click "Auto-Repair (DRC)" on the blocked part(s).',
    drcCheckoutTooltip: 'Repair DRC manufacturing errors before ordering.',
    massEstNote: 'Open-contour mass is estimated from the part envelope.',
    fileTooBig: 'DXF file exceeds the 2 MiB limit; please split parts before uploading.',
  },
};

function parseEmbedConfig() {
  const params = new URLSearchParams(window.location.search);
  const isEmbed = params.get('embed') === '1';
  const rawLang = (params.get('lang') || '').toLowerCase();
  const urlLang = rawLang === 'en' || rawLang === 'tr' ? rawLang : null;
  const rawCur = (params.get('cur') || '').toUpperCase();
  const urlCurrency = ['TRY', 'USD', 'EUR'].includes(rawCur) ? rawCur : null;
  const paramKeys = [
    'shop',
    'wa',
    'cut',
    'pierce',
    'setup',
    'min',
    'scrap',
    'vat',
    's235',
    'ss304',
    'al',
    'galv',
    'usd',
    'eur',
  ];
  const hasUrlOverrides = isEmbed || paramKeys.some((k) => params.has(k));
  if (!hasUrlOverrides) {
    return { isEmbed: false, urlTariff: null, urlLang, urlCurrency };
  }
  const urlTariff = sanitizeTariff({
    shopName: params.get('shop') ?? DEFAULT_TARIFF.shopName,
    whatsappPhone: params.get('wa') ?? '',
    cutRateTryPerMeter: params.get('cut'),
    pierceTry: params.get('pierce'),
    setupFeeTry: params.get('setup'),
    minOrderTry: params.get('min'),
    scrapMarkupPct: params.get('scrap'),
    vatPct: params.get('vat'),
    usdTry: params.get('usd'),
    eurTry: params.get('eur'),
    materialRateOverrides: {
      steel_s235: params.get('s235'),
      stainless_304: params.get('ss304'),
      aluminum_6061: params.get('al'),
      galvanized: params.get('galv'),
    },
  });
  return { isEmbed, urlTariff, urlLang, urlCurrency };
}

function escapeHtmlAttr(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function buildEmbedIframeCode(tariff) {
  const u = new URL(window.location.href.split('#')[0]);
  u.search = '';
  u.searchParams.set('embed', '1');
  u.searchParams.set('lang', state.lang);
  u.searchParams.set('cur', state.currency);
  u.searchParams.set('shop', tariff.shopName);
  if (tariff.whatsappPhone) u.searchParams.set('wa', tariff.whatsappPhone);
  u.searchParams.set('cut', String(tariff.cutRateTryPerMeter));
  u.searchParams.set('pierce', String(tariff.pierceTry));
  u.searchParams.set('setup', String(tariff.setupFeeTry));
  u.searchParams.set('min', String(tariff.minOrderTry));
  u.searchParams.set('scrap', String(tariff.scrapMarkupPct));
  u.searchParams.set('vat', String(tariff.vatPct));
  u.searchParams.set('usd', String(tariff.usdTry));
  u.searchParams.set('eur', String(tariff.eurTry));
  u.searchParams.set('s235', String(tariff.materialRateOverrides.steel_s235));
  u.searchParams.set('ss304', String(tariff.materialRateOverrides.stainless_304));
  u.searchParams.set('al', String(tariff.materialRateOverrides.aluminum_6061));
  u.searchParams.set('galv', String(tariff.materialRateOverrides.galvanized));
  const safeSrc = escapeHtmlAttr(u.toString());
  return `<iframe src="${safeSrc}" width="100%" height="780" style="border:0;border-radius:16px;" loading="lazy"></iframe>`;
}

function loadSavedTariff() {
  try {
    const raw = localStorage.getItem(TARIFF_STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_TARIFF);
    const parsed = JSON.parse(raw);
    return sanitizeTariff(parsed);
  } catch {
    return structuredClone(DEFAULT_TARIFF);
  }
}

function saveTariff(tariff) {
  try {
    localStorage.setItem(TARIFF_STORAGE_KEY, JSON.stringify(sanitizeTariff(tariff)));
  } catch {
    // ignore quota restrictions
  }
}

function buildPartSvg(drawing) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const cutLayers = cuttingLayerIds(drawing);
  const ents = drawing.entities.filter(
    (e) => cutLayers.has(e.layer) && e.type !== 'dim' && e.type !== 'text',
  );
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
  quoteDrcWarning: document.getElementById('quote-drc-warning'),
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
  tfMatGalv: document.getElementById('tf-mat-galv'),
  tfUsd: document.getElementById('tf-usd'),
  tfEur: document.getElementById('tf-eur'),
  tfEmbedCode: document.getElementById('tf-embed-code'),
  btnCopyEmbed: document.getElementById('btn-copy-embed'),
  btnResetTariff: document.getElementById('btn-reset-tariff'),
};

const { isEmbed, urlTariff, urlLang, urlCurrency } = parseEmbedConfig();
if (isEmbed) {
  if (els.btnOpenTariff) els.btnOpenTariff.hidden = true;
  if (els.linkCad) els.linkCad.hidden = true;
}

const state = {
  lang: urlLang || 'tr',
  isEmbed,
  fileName: '',
  intakeReport: null,
  parts: [],
  tariff: urlTariff || loadSavedTariff(),
  materialId: 'steel_s235',
  thicknessMm: 2.0,
  currency: urlCurrency || 'TRY',
  express: false,
  lastQuote: null,
};
if (els.selCurrency) els.selCurrency.value = state.currency;

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
  document.documentElement.lang = state.lang;
  const brand = state.tariff.shopName || DEFAULT_TARIFF.shopName;
  document.title =
    state.lang === 'en'
      ? `${brand} — Instant Laser & CNC Quote`
      : `${brand} — Anında Lazer & CNC Fiyat Teklifi`;
  els.shopName.textContent = brand;
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
  try {
    const { drawing, intakeReport } = ingestIndustrialDxf(dxfText, fileName);
    const split = splitDrawingIntoParts(drawing).map((p) => ({
      ...p,
      qty: 1,
      appliedFixes: [],
    }));
    // Pre-validate full sheet complexity & quote transactionally before mutating active UI state.
    calculateSheetQuote(
      split,
      {
        materialId: state.materialId,
        thicknessMm: state.thicknessMm,
        currency: state.currency,
        express: state.express,
      },
      state.tariff,
    );

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
  try {
    const dxfOut = exportDrawingToDxf(part.drawing, { cutOnly: true });
    const blob = new Blob([dxfOut], { type: 'application/dxf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(part.drawing.name || 'parca').replace(/[^a-z0-9_-]+/gi, '-')}-temiz.dxf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    els.errorBanner.hidden = false;
    els.errorBanner.textContent = err.message;
  }
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
        const prevPart = state.parts[i];
        const prevQty = prevPart.qty || 1;
        const prevFixes = prevPart.appliedFixes || [];
        const res = autoRepairPartDrawing(prevPart.drawing, state.thicknessMm);
        const reSplit = splitDrawingIntoParts(res.drawing);
        const updatedParts = reSplit.map((sp, idx) => ({
          ...sp,
          qty: prevQty,
          appliedFixes: idx === 0 ? [...prevFixes, ...res.appliedFixes] : [...res.appliedFixes],
        }));
        state.parts.splice(i, 1, ...updatedParts);
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

  // Quote sidebar rendering & DRC checkout gate
  const s = quote.summary;
  els.quoteValidBadge.className = `qg-status-pill ${s.allPartsValid ? 'pass' : 'fail'}`;
  els.quoteValidBadge.textContent = s.allPartsValid ? t.passBadge : `${s.errorCount} DRC`;

  els.btnWhatsapp.disabled = !s.allPartsValid || quote.parts.length === 0;
  if (!s.allPartsValid) {
    els.btnWhatsapp.title = t.drcCheckoutTooltip;
    els.quoteDrcWarning.hidden = false;
    const hasMassEst = quote.parts.some((p) => p.massEstimated);
    els.quoteDrcWarning.textContent = hasMassEst
      ? `${t.drcCheckoutBlock} ${t.massEstNote}`
      : t.drcCheckoutBlock;
  } else {
    els.btnWhatsapp.removeAttribute('title');
    els.quoteDrcWarning.hidden = true;
    els.quoteDrcWarning.textContent = '';
  }

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
    const fx =
      quote.currency === 'USD'
        ? Math.max(1, Number(state.tariff.usdTry) || 35)
        : quote.currency === 'EUR'
          ? Math.max(1, Number(state.tariff.eurTry) || 38)
          : 1;
    els.lblFloorNote.textContent = `${t.floorNote} (${fmtMoney(
      state.tariff.minOrderTry / fx,
      quote.currencySymbol,
    )})`;
  }
}

function openTariffModal() {
  const tf = sanitizeTariff(state.tariff);
  els.tfShopName.value = tf.shopName;
  els.tfWhatsapp.value = tf.whatsappPhone || '';
  els.tfCutRate.value = String(tf.cutRateTryPerMeter);
  els.tfPierce.value = String(tf.pierceTry);
  els.tfSetup.value = String(tf.setupFeeTry);
  els.tfMinOrder.value = String(tf.minOrderTry);
  els.tfScrap.value = String(tf.scrapMarkupPct);
  els.tfVat.value = String(tf.vatPct);
  els.tfMatSteel.value = String(tf.materialRateOverrides.steel_s235);
  els.tfMatSs.value = String(tf.materialRateOverrides.stainless_304);
  els.tfMatAl.value = String(tf.materialRateOverrides.aluminum_6061);
  els.tfMatGalv.value = String(tf.materialRateOverrides.galvanized);
  els.tfUsd.value = String(tf.usdTry);
  els.tfEur.value = String(tf.eurTry);
  els.tfEmbedCode.value = buildEmbedIframeCode(tf);
  els.tariffBackdrop.hidden = false;
}

async function handleUploadedFile(file) {
  if (!file) return;
  const t = I18N[state.lang];
  if (Number(file.size) > MAX_UPLOAD_BYTES) {
    els.errorBanner.hidden = false;
    els.errorBanner.textContent = t.fileTooBig;
    return;
  }
  loadDxfContent(await file.text(), file.name);
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
  await handleUploadedFile(e.dataTransfer?.files?.[0]);
});
els.fileInput.addEventListener('change', async () => {
  await handleUploadedFile(els.fileInput.files?.[0]);
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
  if (!q || !q.summary.allPartsValid) return;
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
  state.tariff = sanitizeTariff({
    ...state.tariff,
    shopName: els.tfShopName.value,
    whatsappPhone: els.tfWhatsapp.value,
    cutRateTryPerMeter: els.tfCutRate.value,
    pierceTry: els.tfPierce.value,
    setupFeeTry: els.tfSetup.value,
    minOrderTry: els.tfMinOrder.value,
    scrapMarkupPct: els.tfScrap.value,
    vatPct: els.tfVat.value,
    usdTry: els.tfUsd.value,
    eurTry: els.tfEur.value,
    materialRateOverrides: {
      steel_s235: els.tfMatSteel.value,
      stainless_304: els.tfMatSs.value,
      aluminum_6061: els.tfMatAl.value,
      galvanized: els.tfMatGalv.value,
    },
  });
  saveTariff(state.tariff);
  els.tfEmbedCode.value = buildEmbedIframeCode(state.tariff);
  els.tariffBackdrop.hidden = true;
  renderAll();
});

// Boot immediately with the multi-part bulge laser demo so storefront is live out-of-the-box.
loadDxfContent(createDemoDxf('multi_part_bulge'), DEMO_DXF_PRESETS.multi_part_bulge.fileName);
