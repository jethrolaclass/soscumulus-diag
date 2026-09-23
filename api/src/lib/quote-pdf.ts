/**
 * The quote as a PDF, drawn directly rather than filled from a template.
 *
 * The intervention sheet goes through a Docs template because a designer drew
 * it and a technician reads it. The quote is one page a client signs on a
 * phone: a header, five lines, a total, a box. Drawing it here keeps it out of
 * Apps Script — no round trip, no manual paste to keep in sync — and the site's
 * two colours do the branding.
 *
 * Standard Helvetica, not the site's Montserrat: pdf-lib ships it, it needs no
 * font file, and the WinAnsi set covers every character a French quote uses,
 * "œ" and "€" included.
 */

import { PDFDocument, StandardFonts, rgb, type PDFPage, type PDFFont } from 'pdf-lib';
import type { Quote } from './pricing';
import type { SignatureBox } from './youtrust';

const NAVY = rgb(0x1b / 255, 0x3a / 255, 0x5c / 255);
const ORANGE = rgb(0xff / 255, 0x5b / 255, 0x29 / 255);
const INK = rgb(0x1b / 255, 0x24 / 255, 0x30 / 255);
const GRAY = rgb(0x6b / 255, 0x7a / 255, 0x8f / 255);
const RULE = rgb(0xe3 / 255, 0xe9 / 255, 0xf2 / 255);

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 48;

export interface QuoteDocument {
  ref: string;
  date: Date;
  client: { firstName: string; lastName: string; address?: string; phone: string; email: string };
  summary: string;
  quote: Quote;
}

/** Where the client signs: bottom right of the page, in Youtrust's top-left points. */
export const SIGNATURE_BOX: SignatureBox = { page: 1, x: 345, y: 660, width: 200, height: 70 };

const euros = (n: number) =>
  n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';

export async function renderQuotePdf(doc: QuoteDocument): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Devis ${doc.ref} — SOS Cumulus`);
  pdf.setAuthor('SOS Cumulus');
  const page = pdf.addPage([A4.w, A4.h]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  // pdf-lib counts from the bottom; everything here is written from the top.
  const top = (y: number) => A4.h - y;
  const text = (s: string, x: number, y: number, size: number, font: PDFFont, color = INK) =>
    page.drawText(s, { x, y: top(y), size, font, color });
  const right = (s: string, xRight: number, y: number, size: number, font: PDFFont, color = INK) =>
    page.drawText(s, { x: xRight - font.widthOfTextAtSize(s, size), y: top(y), size, font, color });

  // ── Header band ──
  page.drawRectangle({ x: 0, y: top(96), width: A4.w, height: 96, color: NAVY });
  text('SOS Cumulus', MARGIN, 44, 22, bold, rgb(1, 1, 1));
  text('Dépannage et remplacement de chauffe-eau — région lyonnaise', MARGIN, 64, 9.5, regular, rgb(0.73, 0.78, 0.85));
  right('DEVIS', A4.w - MARGIN, 44, 22, bold, rgb(1, 1, 1));
  right(`N° ${doc.ref}`, A4.w - MARGIN, 64, 10, regular, rgb(0.73, 0.78, 0.85));
  page.drawRectangle({ x: 0, y: top(100), width: A4.w, height: 4, color: ORANGE });

  // ── Demo watermark — before the content so it sits behind it ──
  if (doc.quote.demo) {
    page.drawText('DÉMONSTRATION', {
      x: 70, y: 300, size: 64, font: bold,
      color: rgb(1, 0.36, 0.16), opacity: 0.13, rotate: { type: 'degrees', angle: 35 } as never,
    });
  }

  // ── Client and date ──
  let y = 140;
  text('CLIENT', MARGIN, y, 8.5, bold, GRAY);
  text('DATE', 360, y, 8.5, bold, GRAY);
  y += 16;
  text(`${doc.client.firstName} ${doc.client.lastName}`, MARGIN, y, 11.5, bold);
  text(doc.date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }), 360, y, 11, regular);
  y += 15;
  for (const line of [doc.client.address, doc.client.phone, doc.client.email].filter(Boolean) as string[]) {
    text(line, MARGIN, y, 10, regular, GRAY);
    y += 13;
  }

  // ── Object ──
  y = Math.max(y + 12, 230);
  text('OBJET', MARGIN, y, 8.5, bold, GRAY);
  y += 15;
  for (const line of wrap(doc.summary, regular, 10.5, A4.w - 2 * MARGIN)) {
    text(line, MARGIN, y, 10.5, regular);
    y += 14;
  }

  // ── Lines ──
  y += 14;
  page.drawRectangle({ x: MARGIN, y: top(y + 18), width: A4.w - 2 * MARGIN, height: 22, color: NAVY });
  text('DÉSIGNATION', MARGIN + 10, y + 13, 8.5, bold, rgb(1, 1, 1));
  right('MONTANT TTC', A4.w - MARGIN - 10, y + 13, 8.5, bold, rgb(1, 1, 1));
  y += 34;
  for (const line of doc.quote.lines) {
    text(line.label, MARGIN + 10, y, 10.5, regular);
    right(euros(line.amount), A4.w - MARGIN - 10, y, 10.5, regular);
    y += 8;
    page.drawLine({ start: { x: MARGIN, y: top(y) }, end: { x: A4.w - MARGIN, y: top(y) }, thickness: 0.6, color: RULE });
    y += 14;
  }
  y += 6;
  page.drawRectangle({ x: 330, y: top(y + 20), width: A4.w - MARGIN - 330, height: 28, color: rgb(1, 0.95, 0.93) });
  text('TOTAL TTC', 342, y + 14, 10, bold, NAVY);
  right(euros(doc.quote.total ?? 0), A4.w - MARGIN - 10, y + 14, 13, bold, ORANGE);
  y += 40;
  if (doc.quote.reason) {
    for (const line of wrap(doc.quote.reason, regular, 9, A4.w - 2 * MARGIN)) {
      text(line, MARGIN, y, 9, regular, GRAY);
      y += 12;
    }
  }

  // ── Conditions ──
  y = 560;
  text('CONDITIONS', MARGIN, y, 8.5, bold, GRAY);
  y += 14;
  const conditions = doc.quote.demo
    ? 'Document de démonstration : les montants sont fictifs et ce devis n’a aucune valeur contractuelle.'
    : 'Devis valable 30 jours. Intervention sous réserve de l’accès à l’appareil. Pièces et main-d’œuvre garanties. Paiement à l’issue de l’intervention.';
  for (const line of wrap(conditions, regular, 9, 280)) {
    text(line, MARGIN, y, 9, regular, GRAY);
    y += 12;
  }

  // ── Signature box, where Youtrust will place the signature ──
  drawSignatureBox(page, regular, SIGNATURE_BOX);

  // ── Footer ──
  page.drawLine({ start: { x: MARGIN, y: 52 }, end: { x: A4.w - MARGIN, y: 52 }, thickness: 0.6, color: RULE });
  page.drawText('SOS Cumulus · soscumulus.fr · devis établi à distance à partir des photos transmises par le client', {
    x: MARGIN, y: 38, size: 7.5, font: regular, color: GRAY,
  });

  return pdf.save();
}

function drawSignatureBox(page: PDFPage, font: PDFFont, box: SignatureBox): void {
  const yBottom = A4.h - box.y - box.height;
  page.drawRectangle({
    x: box.x, y: yBottom, width: box.width, height: box.height,
    borderColor: NAVY, borderWidth: 1, borderDashArray: [4, 3],
  });
  page.drawText('Bon pour accord — signature du client', {
    x: box.x, y: yBottom + box.height + 6, size: 8.5, font, color: NAVY,
  });
}

/** Greedy word wrap on measured width. */
function wrap(s: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = s.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) line = candidate;
    else {
      if (line) lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}
