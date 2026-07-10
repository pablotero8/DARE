import db from './db.js';
import PDFDocument from 'pdfkit';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const LOGO_PATH = join(__dir, '..', 'images', 'dare-logo.jpg');

// Bump when the agreement text changes so every stored contract records the
// wording the client actually signed. Matches the versioning style of the
// public legal pages (privacy.html / legal.html).
export const CONTRACT_VERSION = '1.0 (2026-07-10)';

const GOLD = '#8a6d2e';   // print-friendly darker gold
const INK  = '#1a1712';
const MUTED = '#5c564a';

// ── Storage ───────────────────────────────────────────────────

// Snapshot the client's intake data so the agreement keeps showing what was
// signed even if the profile (weight, goal, weeks…) changes later.
export function createContractForClient(client) {
  const data = {
    name: client.name,
    email: client.email,
    phone: client.phone ?? null,
    birthDate: client.birthDate ?? null,
    heightCm: client.height ?? null,
    weightKg: client.weight ?? null,
    bodyFatPct: client.bodyFat ?? null,
    goal: client.goal,
    totalWeeks: client.totalWeeks,
    startWeek: client.currentWeek,
  };
  const result = db.prepare(
    'INSERT INTO contracts (client_id, version, data_json) VALUES (?, ?, ?)'
  ).run(client.id, CONTRACT_VERSION, JSON.stringify(data));
  return getContractById(result.lastInsertRowid);
}

export function getContractById(id) {
  return toContract(db.prepare('SELECT * FROM contracts WHERE id = ?').get(id));
}

export function getLatestContractForClient(clientId) {
  return toContract(
    db.prepare('SELECT * FROM contracts WHERE client_id = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(clientId)
  );
}

function toContract(row) {
  if (!row) return null;
  return {
    id: row.id,
    clientId: row.client_id,
    version: row.version,
    data: JSON.parse(row.data_json),
    createdAt: row.created_at,
    signedAt: row.signed_at,
  };
}

// ── PDF generation ────────────────────────────────────────────

function fmtDate(iso) {
  if (!iso) return '____________________';
  const d = new Date(iso.includes('T') ? iso : iso + 'T00:00:00Z');
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function field(value, suffix = '') {
  return value == null || value === '' ? '____________________' : `${value}${suffix}`;
}

// Returns a PDFDocument already fully written; caller pipes it to the response.
export function generateContractPdf(contract) {
  const d = contract.data;
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 64, bottom: 64, left: 60, right: 60 },
    info: {
      Title: `DARE Private Coaching Agreement — ${d.name}`,
      Author: 'DARE',
      Subject: `Coaching agreement v${contract.version}`,
    },
  });

  const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  const heading = (n, title) => {
    doc.moveDown(1.1);
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(GOLD)
       .text(`${n}. ${title.toUpperCase()}`, { characterSpacing: 0.8 });
    doc.moveDown(0.35);
    doc.font('Helvetica').fontSize(9.5).fillColor(INK);
  };
  const para = (text, opts = {}) => {
    doc.font('Helvetica').fontSize(9.5).fillColor(INK)
       .text(text, { align: 'justify', lineGap: 2.2, ...opts });
    doc.moveDown(0.3);
  };
  const bullet = (text) => {
    doc.font('Helvetica').fontSize(9.5).fillColor(INK)
       .text(`•  ${text}`, { align: 'justify', lineGap: 2.2, indent: 0, paragraphGap: 2 });
  };

  // ── Header: logo + title ──
  if (existsSync(LOGO_PATH)) {
    doc.image(LOGO_PATH, doc.page.margins.left, doc.y, { width: 130 });
    doc.moveDown(0.2);
    doc.y = doc.page.margins.top + 44;
  }
  doc.font('Helvetica-Bold').fontSize(17).fillColor(INK)
     .text('PRIVATE COACHING AGREEMENT', { characterSpacing: 1.2 });
  doc.moveDown(0.15);
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
     .text(`Agreement ref. DARE-${contract.clientId}-${String(contract.id).padStart(4, '0')}   ·   Version ${contract.version}   ·   Issued ${fmtDate(contract.createdAt)}`);
  doc.moveDown(0.4);
  doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.margins.left + W, doc.y)
     .lineWidth(1).strokeColor(GOLD).stroke();

  // ── Parties ──
  heading(1, 'Parties');
  para('This Private Coaching Agreement (the "Agreement") is entered into between:');
  bullet('DARE, a company in formation in Dubai, United Arab Emirates (the registered name, licence number and address will be incorporated into this Agreement upon incorporation), contact hello@darehabits.com ("DARE", "we"); and');
  bullet(`${d.name} (the "Client"), date of birth ${field(d.birthDate && fmtDate(d.birthDate))}, email ${field(d.email)}, phone ${field(d.phone)}.`);
  doc.moveDown(0.3);
  para('The Client confirms that they are at least 18 years of age and have full legal capacity to enter into this Agreement.');

  // ── Service ──
  heading(2, 'The service');
  para('DARE will provide the Client with personalised training and nutrition coaching, delivered through a private client portal, with plans prepared and reviewed by human coaches ("the Service"). Access to the portal is personal and by invitation only.');
  para('DARE coaching is not medical advice, diagnosis or treatment, and does not replace the care of a physician or other healthcare professional.');

  // ── Programme ──
  heading(3, 'Programme and intake data');
  para('The engagement starts under the following programme, as recorded at intake:');
  bullet(`Programme / goal: ${field(d.goal)}`);
  bullet(`Duration: ${field(d.totalWeeks)} weeks${d.startWeek && d.startWeek > 1 ? ` (starting at week ${d.startWeek})` : ''}`);
  bullet(`Height: ${field(d.heightCm, ' cm')}    ·    Weight: ${field(d.weightKg, ' kg')}${d.bodyFatPct != null ? `    ·    Body fat: ${d.bodyFatPct}%` : ''}`);
  doc.moveDown(0.3);
  para('The programme may be adjusted by the coaches during the engagement based on the Client\'s progress, recovery and adherence. Individual results depend on adherence, starting point and personal factors; DARE does not guarantee specific results.');

  // ── Health declarations ──
  heading(4, 'Health declarations of the Client');
  para('By signing this Agreement the Client declares and accepts that:');
  bullet('They have disclosed to their coaches every relevant medical condition, injury, allergy, intolerance and medication, and will keep this information up to date during the engagement.');
  bullet('DARE cannot be held responsible for adverse effects arising from pathologies, conditions or treatments that the Client did not communicate to their coaches before or during the engagement.');
  bullet('They will consult a physician before starting any training or nutrition plan if they have (or suspect) any medical condition, and will stop and seek medical advice if they experience adverse symptoms.');

  // ── Fees ──
  heading(5, 'Fees and payment');
  para('The fees, payment schedule and engagement model (Online Protocol or In-Home Presence) are those agreed between the parties in the engagement schedule attached to or communicated with this Agreement. Fees are due in advance for each agreed period unless otherwise stated in the engagement schedule.');

  // ── Data protection ──
  heading(6, 'Personal data and health data');
  para('DARE processes the Client\'s personal data as data controller, governed first by the UAE Personal Data Protection Law (Federal Decree-Law No. 45 of 2021, "PDPL") and additionally by the EU General Data Protection Regulation ("GDPR") where the Client resides in the European Union. Full details are set out in the Privacy Policy at darehabits.com/privacy.html, which forms part of this Agreement.');
  para('To deliver the Service, DARE needs to process health-related data (weight, height, body composition, training and nutrition logs, dietary restrictions and any medical conditions the Client chooses to share). This is sensitive data under the PDPL and special-category data under art. 9 GDPR, and is processed only with the Client\'s explicit consent, given by signing section 11 below and confirmed on first access to the client portal.');
  para('Data is hosted with a small number of service providers under data-processing agreements (application and database hosting, transactional email, and AI-assisted plan drafting that never receives the Client\'s medical history). DARE never sells the Client\'s data and never shares it for advertising. Access to the Client\'s data is limited to their two coaches.');
  para('When the engagement ends, personal and health data is deleted within 30 days, except for the minimum data DARE must keep to comply with legal obligations. The Client may exercise their rights of access, rectification, erasure, portability, restriction and objection, and may withdraw consent at any time, by writing to privacy@darehabits.com. Complaints may be addressed to the UAE Data Office and, for EU residents, to their national data-protection authority.');

  // ── Photos ──
  heading(7, 'Progress photos and testimonials');
  para('DARE will only publish "before & after" photos or testimonials of the Client with the Client\'s prior, specific, written authorization, which may be refused or withdrawn at any time without affecting the coaching. This Agreement does not grant that authorization.');

  // ── IP ──
  heading(8, 'Intellectual property');
  para('All plans, methodology, texts and materials provided through the Service belong to DARE or its licensors. Plans are prepared for the personal use of the Client only and may not be redistributed, published or resold.');

  // ── Portal ──
  heading(9, 'Portal credentials');
  para('The Client\'s portal credentials are personal and non-transferable. The Client must keep their password confidential and notify DARE of any suspected unauthorised access. DARE may suspend accounts that compromise the security of the Service.');

  // ── Term / law ──
  heading(10, 'Term, termination and governing law');
  para('This Agreement enters into force on the date of signature and remains in force for the duration of the programme described in section 3, and any renewal agreed by the parties. Either party may terminate for material breach by the other that is not remedied within 14 days of written notice.');
  para('This Agreement is governed by the laws of the Emirate of Dubai and the applicable federal laws of the United Arab Emirates. If the Client contracts as a consumer residing in the European Union, they also keep the protection of the mandatory provisions of the law of their country of residence.');

  // ── Consent + signatures ──
  heading(11, 'Explicit consent and signatures');
  para('By signing below, the Client (i) accepts the terms of this Agreement, and (ii) gives their explicit consent to the processing of their health-related data by DARE for the sole purpose of delivering the Service, as described in section 6 and in the Privacy Policy.');

  // Keep the signature block on one page.
  if (doc.y > doc.page.height - doc.page.margins.bottom - 170) doc.addPage();
  doc.moveDown(1.6);

  const colW = (W - 40) / 2;
  const leftX = doc.page.margins.left;
  const rightX = leftX + colW + 40;
  const topY = doc.y;

  const signBlock = (x, title, nameLine) => {
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(title, x, topY, { width: colW });
    const lineY = topY + 58;
    doc.moveTo(x, lineY).lineTo(x + colW, lineY).lineWidth(0.8).strokeColor(MUTED).stroke();
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
       .text(nameLine, x, lineY + 5, { width: colW })
       .text('Date: ____________________', x, lineY + 20, { width: colW });
  };

  signBlock(leftX, 'THE CLIENT', `Name: ${d.name}`);
  signBlock(rightX, 'FOR DARE', 'Name: ____________________');

  // ── Footer ──
  // Writing inside the bottom margin makes pdfkit auto-add a page; zero the
  // margin first (the document ends right after, so nothing else flows).
  const footY = doc.page.height - doc.page.margins.bottom + 18;
  doc.page.margins.bottom = 0;
  doc.font('Helvetica').fontSize(7.5).fillColor(MUTED)
     .text(
       `DARE · Private Health OS · Dubai, UAE · darehabits.com · Agreement ref. DARE-${contract.clientId}-${String(contract.id).padStart(4, '0')}`,
       doc.page.margins.left,
       footY,
       { width: W, align: 'center', lineBreak: false }
     );

  doc.end();
  return doc;
}
