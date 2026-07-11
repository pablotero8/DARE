import PDFDocument from 'pdfkit';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
// Same print-ready wordmark used by the coaching agreement (contract.js).
const LOGO_PATH = join(__dir, '..', 'images', 'dare-logo-print.png');
const LOGO_ASPECT = 875 / 447;

// DARE print palette — matches contract.js so both documents feel like one brand.
const GOLD  = '#8a6d2e';
const GREEN = '#6f8f37';
const INK   = '#1a1712';
const MUTED = '#5c564a';
const CREAM = '#b7b0a1';

// Macro colours — the darker, print-friendly cousins of the portal's on-screen
// gold/olive/cream so the PDF bars read the same as client.html.
const MACRO_COLORS = { protein: GREEN, carbs: GOLD, fat: CREAM };

const DAY_NAMES = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' };

const SHOP_CAT_ORDER = ['protein', 'carbs', 'vegetables & fruit', 'dairy', 'fats & oils', 'other'];
const SHOP_CAT_LABEL = {
  protein: 'Protein', carbs: 'Carbohydrates', 'vegetables & fruit': 'Vegetables & fruit',
  dairy: 'Dairy', 'fats & oils': 'Fats & oils', other: 'Other',
};

const round0 = (n) => Math.round(Number(n) || 0);

function weekRange(weekOf) {
  try {
    const mon = new Date(weekOf + 'T12:00:00Z');
    const sun = new Date(mon); sun.setUTCDate(sun.getUTCDate() + 6);
    const opts = { day: 'numeric', month: 'long', timeZone: 'UTC' };
    return `${mon.toLocaleDateString('en-GB', opts)} – ${sun.toLocaleDateString('en-GB', { ...opts, year: 'numeric' })}`;
  } catch { return weekOf || ''; }
}

// Returns a PDFDocument already fully written; caller pipes it to the response.
export function generatePlanPdf(plan, client) {
  const doc = new PDFDocument({
    size: 'A4',
    bufferPages: true,     // needed for the page-numbered footer pass
    margins: { top: 56, bottom: 56, left: 54, right: 54 },
    info: {
      Title: `DARE Weekly Plan — ${client?.name || ''}`,
      Author: 'DARE',
      Subject: `Weekly training & nutrition plan (${plan?.weekOf || ''})`,
    },
  });

  const L = doc.page.margins.left;
  const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const bottomLimit = () => doc.page.height - doc.page.margins.bottom;

  // ── Cover ──
  if (existsSync(LOGO_PATH)) {
    const logoW = 110;
    doc.image(LOGO_PATH, L, doc.y, { width: logoW });
    doc.y += logoW / LOGO_ASPECT + 26;
  }
  doc.font('Helvetica-Bold').fontSize(24).fillColor(INK)
     .text('WEEKLY PLAN', { characterSpacing: 1.4 });
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(12).fillColor(INK).text(client?.name || '');
  doc.moveDown(0.15);
  doc.font('Helvetica').fontSize(10).fillColor(MUTED).text(`Week of ${weekRange(plan?.weekOf)}`);
  if (client?.goal) doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(client.goal);
  doc.moveDown(0.5);
  doc.moveTo(L, doc.y).lineTo(L + W, doc.y).lineWidth(1).strokeColor(GOLD).stroke();
  doc.moveDown(0.4);
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
     .text('Training — Erika Silva, Head of Performance   ·   Nutrition — Daniel Otero, Head of Nutrition');

  const week = Array.isArray(plan?.week) ? plan.week : [];

  // ── One page per day ──
  week.forEach((day) => {
    doc.addPage();
    drawDay(doc, day, L, W, bottomLimit);
  });

  // ── Shopping list ──
  const list = plan?.shoppingList;
  if (list && Array.isArray(list.items) && list.items.length) {
    doc.addPage();
    drawShoppingList(doc, list, L, W, bottomLimit);
  }

  drawFooter(doc, client, L, W);
  doc.end();
  return doc;
}

function ensureSpace(doc, needed, bottomLimit) {
  if (doc.y + needed > bottomLimit()) doc.addPage();
}

function drawDay(doc, day, L, W, bottomLimit) {
  const label = DAY_NAMES[day?.label] || day?.label || '';
  const date = day?.fullDate || '';
  const type = (day?.type || 'rest').toUpperCase();

  doc.font('Helvetica-Bold').fontSize(15).fillColor(INK).text(label, { continued: false });
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(`${date}${date ? '   ·   ' : ''}${type}`);
  doc.moveDown(0.3);
  doc.moveTo(L, doc.y).lineTo(L + W, doc.y).lineWidth(0.8).strokeColor(GOLD).stroke();
  doc.moveDown(0.6);

  // ── Training ──
  const t = day?.training || {};
  doc.font('Helvetica-Bold').fontSize(10).fillColor(GOLD).text('TRAINING', { characterSpacing: 0.8 });
  doc.moveDown(0.2);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(t.session || 'Rest');
  doc.moveDown(0.2);

  const items = Array.isArray(t.items) ? t.items : [];
  const activities = Array.isArray(t.activities) ? t.activities : [];
  if (items.length) {
    items.forEach((ex) => {
      ensureSpace(doc, 34, bottomLimit);
      const badge = ex.badge ? `   [${ex.badge}]` : '';
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK).text(`${ex.name || ''}${badge}`);
      if (ex.detail) doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(ex.detail, { lineGap: 1.5 });
      doc.moveDown(0.25);
    });
  } else if (activities.length) {
    activities.forEach((a) => {
      ensureSpace(doc, 26, bottomLimit);
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK).text(a.name || '');
      if (a.detail) doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(a.detail, { lineGap: 1.5 });
      doc.moveDown(0.2);
    });
  }
  if (t.note) {
    ensureSpace(doc, 30, bottomLimit);
    doc.moveDown(0.15);
    doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(MUTED).text(`Erika: ${t.note}`, { lineGap: 1.5 });
  }
  doc.moveDown(0.6);

  // ── Nutrition ──
  const n = day?.nutrition || {};
  ensureSpace(doc, 90, bottomLimit);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(GREEN).text('NUTRITION', { characterSpacing: 0.8 });
  doc.moveDown(0.2);
  const kcal = round0(n.kcal), P = round0(n.protein), C = round0(n.carbs), F = round0(n.fat);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(INK)
     .text(`${kcal.toLocaleString('en-GB')} kcal target`, { continued: true })
     .font('Helvetica').fontSize(9).fillColor(MUTED)
     .text(`     P ${P}g · C ${C}g · F ${F}g`);
  doc.moveDown(0.35);
  drawMacroBar(doc, P, C, F, L, W);
  doc.moveDown(0.5);

  const meals = Array.isArray(n.meals) ? n.meals : [];
  meals.forEach((m) => {
    ensureSpace(doc, 40, bottomLimit);
    const time = m.time ? `${m.time}  ` : '';
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK)
       .text(`${time}${m.name || ''}`, { continued: true })
       .font('Helvetica').fontSize(8.5).fillColor(MUTED).text(`     ${round0(m.kcal)} kcal`);
    if (m.desc) doc.font('Helvetica').fontSize(8.5).fillColor(INK).text(m.desc, { lineGap: 1.5 });
    const mp = round0(m.protein), mc = round0(m.carbs), mf = round0(m.fat);
    if (mp || mc || mf) doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(`P ${mp}g · C ${mc}g · F ${mf}g`);
    doc.moveDown(0.35);
  });

  if (n.note) {
    ensureSpace(doc, 30, bottomLimit);
    doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(MUTED).text(`Daniel: ${n.note}`, { lineGap: 1.5 });
  }
}

// Draw the 3-segment macro proportion bar (by energy share), matching the portal.
function drawMacroBar(doc, P, C, F, L, W) {
  const eP = P * 4, eC = C * 4, eF = F * 9;
  const total = eP + eC + eF;
  const h = 5, y = doc.y;
  if (total <= 0) { doc.moveDown(0.3); return; }
  let x = L;
  const segs = [[eP, MACRO_COLORS.protein], [eC, MACRO_COLORS.carbs], [eF, MACRO_COLORS.fat]];
  segs.forEach(([val, color]) => {
    const w = (val / total) * W;
    if (w > 0) { doc.rect(x, y, w, h).fillColor(color).fill(); x += w; }
  });
  doc.y = y + h;
}

function drawShoppingList(doc, list, L, W, bottomLimit) {
  doc.font('Helvetica-Bold').fontSize(15).fillColor(INK).text('SHOPPING LIST');
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(`${list.count} items for the week`);
  doc.moveDown(0.3);
  doc.moveTo(L, doc.y).lineTo(L + W, doc.y).lineWidth(0.8).strokeColor(GOLD).stroke();
  doc.moveDown(0.6);

  const groups = {};
  list.items.forEach((it) => { const c = it.category || 'other'; (groups[c] = groups[c] || []).push(it); });
  const cats = Object.keys(groups).sort((a, b) => {
    const ia = SHOP_CAT_ORDER.indexOf(a), ib = SHOP_CAT_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  cats.forEach((cat) => {
    ensureSpace(doc, 40, bottomLimit);
    doc.moveDown(0.3);
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(GOLD).text((SHOP_CAT_LABEL[cat] || cat).toUpperCase(), { characterSpacing: 0.6 });
    doc.moveDown(0.15);
    groups[cat].forEach((it) => {
      ensureSpace(doc, 16, bottomLimit);
      const y = doc.y;
      doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(it.name || '', L, y, { width: W * 0.7 });
      if (it.display) doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(it.display, L + W * 0.7, y, { width: W * 0.3, align: 'right' });
      doc.moveDown(0.15);
    });
  });
}

function drawFooter(doc, client, L, W) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const y = doc.page.height - doc.page.margins.bottom + 22;
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED)
       .text('DARE · Private Health OS · Dubai, UAE · darehabits.com', L, y, { width: W, align: 'center', lineBreak: false });
    doc.page.margins.bottom = savedBottom;
  }
}
