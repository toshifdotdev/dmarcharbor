/**
 * The layout vocabulary shared by the signed compliance pack and the monthly
 * evidence report.
 *
 * It lives here rather than in either document because the two have to look
 * like they came from the same organisation. Copying these helpers would let a
 * spacing fix land in one document and not the other, and a reader comparing
 * two PDFs from the same agency would see the difference before they read a
 * word of either.
 *
 * The pack's bytes are load bearing: its SHA-256 is published and an auditor
 * may already hold a copy. Everything here is the same code that produced that
 * document, moved, not rewritten. The monthly report passes an accent colour;
 * leaving it out gives the pack exactly the values it always had.
 */

export const INK = '#0f172a';
export const MUTED = '#64748b';
export const RULE = '#e2e8f0';
export const ACCENT = '#0f766e';

export const PAGE_MARGIN = 56;
export const PAGE_WIDTH = 595.28;
export const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;

/** A cursor over one PDF page, with the page break rule in one place. */
export class Page {
  y = 0;

  constructor(private doc: PDFKit.PDFDocument) {
    this.y = PAGE_MARGIN;
  }

  ensure(height: number): void {
    if (this.y + height > this.doc.page.height - PAGE_MARGIN - 24) {
      this.doc.addPage();
      this.y = PAGE_MARGIN;
    }
  }

  move(height: number): void {
    this.ensure(height);
    this.y += height;
  }
}

/**
 * Measures a string at a specific font and size.
 *
 * PDFKit's `heightOfString` measures using whatever font is currently active, so
 * calling it before setting the font measures the previous element's font instead
 * of this one's. After a 12pt heading that over-reserves and leaves a gap; after an
 * 8.5pt table cell it under-reserves and the next element is drawn on top of this
 * one. Both happened in the shipped document. The font is therefore set before the
 * measurement, every time, and the caller's intent is passed in rather than
 * inherited.
 */
export function measure(
  doc: PDFKit.PDFDocument,
  text: string,
  width: number,
  options: { font: string; size: number; bold?: boolean },
): number {
  doc.font(options.bold === true ? `${options.font}-Bold` : options.font);
  doc.fontSize(options.size);
  return doc.heightOfString(text, { width });
}

/**
 * A numbered section, described once and both measured and rendered from the same
 * description.
 *
 * Describing the shape twice is how a section ends up half on one page and half on
 * the next: the measurement pass and the render pass drift apart, and the document
 * changes with no code change. One description, one set of numbers.
 */
export interface SectionBlock {
  kind: 'body' | 'labelled' | 'table' | 'note';
  text?: string;
  label?: string;
  value?: string;
  columns?: { label: string; width: number }[];
  rows?: string[][];
  size?: number;
}

export interface Section {
  title: string;
  blocks: SectionBlock[];
  /** Monthly reports pass the agency colour; the pack keeps the default. */
  accent?: string;
}

/**
 * Height a section will occupy, using the same measurement and the same spacing
 * constants the render path uses. An accent is a colour only and changes no
 * measurement.
 */
export function sectionHeight(doc: PDFKit.PDFDocument, section: Section): number {
  const headingSize = 12;
  const headingText = measure(doc, section.title, CONTENT_WIDTH, {
    font: 'Helvetica',
    size: headingSize,
    bold: true,
  });

  let total = headingText + 4 + 1 + 14;

  for (const block of section.blocks) {
    if (block.kind === 'body' || block.kind === 'note') {
      const size = block.size ?? (block.kind === 'note' ? 8.5 : 9.5);
      total += measure(doc, block.text ?? '', CONTENT_WIDTH, { font: 'Helvetica', size }) + 8;
      continue;
    }

    if (block.kind === 'labelled') {
      const value = measure(doc, block.value ?? '', CONTENT_WIDTH - 130, { font: 'Helvetica', size: 9.5 });
      const label = measure(doc, block.label ?? '', CONTENT_WIDTH - 130, { font: 'Helvetica', size: 9, bold: true });
      total += Math.max(value, label) + 8;
      continue;
    }

    for (const row of block.rows ?? []) {
      const cellHeights = row.map((cell, column) =>
        measure(doc, cell, (block.columns?.[column]?.width ?? 100) - 8, { font: 'Helvetica', size: 8.5 }),
      );
      // Same arithmetic as the render path: measured cells, five points of padding
      // above and below, six between rows.
      total += Math.max(11, ...cellHeights) + 5 * 2 + 6;
    }
  }

  return total;
}

/** Draws a section, having first moved it whole to the next page if it would split. */
export function section(doc: PDFKit.PDFDocument, page: Page, spec: Section): void {
  page.ensure(sectionHeight(doc, spec));
  heading(doc, page, spec.title, spec.accent ?? ACCENT);

  for (const block of spec.blocks) {
    if (block.kind === 'body') {
      body(doc, page, block.text ?? '');
      continue;
    }
    if (block.kind === 'note') {
      body(doc, page, block.text ?? '', block.size ?? 8.5);
      continue;
    }
    if (block.kind === 'labelled') {
      labelled(doc, page, block.label ?? '', block.value ?? '');
      continue;
    }
    table(doc, page, block.columns ?? [], block.rows ?? []);
  }
}

/**
 * Reserves height that is known up front, rather than measured from a string.
 *
 * Used where there is no text to measure, so there is nothing that can disagree
 * with what is drawn.
 */
export function ensure(page: Page, points: number): void {
  page.ensure(points);
}

export function heading(doc: PDFKit.PDFDocument, page: Page, text: string, accent = ACCENT): void {
  const height = measure(doc, text, CONTENT_WIDTH, { font: 'Helvetica', size: 12, bold: true });
  ensure(page, height + 20 + 2);

  const top = page.y;
  doc.font('Helvetica-Bold').fontSize(12).fillColor(accent).text(text, PAGE_MARGIN, top, { width: CONTENT_WIDTH });
  page.y = top + height + 4;

  doc.moveTo(PAGE_MARGIN, page.y).lineTo(PAGE_WIDTH - PAGE_MARGIN, page.y).lineWidth(0.75).strokeColor(RULE).stroke();
  page.move(14);
}

export function body(doc: PDFKit.PDFDocument, page: Page, text: string, size = 9.5): void {
  // Measured at the size it will actually be drawn at. Measuring before setting the
  // font is what produced overlapping paragraphs in the first issued pack.
  const height = measure(doc, text, CONTENT_WIDTH, { font: 'Helvetica', size });
  ensure(page, height + 8);

  const top = page.y;
  doc.font('Helvetica').fontSize(size).fillColor(INK).text(text, PAGE_MARGIN, top, { width: CONTENT_WIDTH });
  page.y = top + height;
  page.move(8);
}

export function labelled(doc: PDFKit.PDFDocument, page: Page, label: string, value: string): void {
  const valueHeight = measure(doc, value, CONTENT_WIDTH - 130, { font: 'Helvetica', size: 9.5 });
  // The label is a single short word on its own line, but it is measured rather
  // than assumed so a longer label cannot overlap the value.
  const labelHeight = measure(doc, label, CONTENT_WIDTH - 130, { font: 'Helvetica', size: 9, bold: true });
  const height = Math.max(valueHeight, labelHeight);
  ensure(page, height + 10);

  const top = page.y;
  doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text(label, PAGE_MARGIN, top, { width: 126 });
  doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(value, PAGE_MARGIN + 130, top, {
    width: CONTENT_WIDTH - 130,
  });
  page.y = top + height;
  page.move(8);
}

export function table(
  doc: PDFKit.PDFDocument,
  page: Page,
  columns: { label: string; width: number }[],
  rows: string[][],
): void {
  if (rows.length === 0) {
    body(doc, page, 'None recorded.');
    return;
  }

  const cellFont = { font: 'Helvetica', size: 8.5 } as const;
  const paddingY = 5;
  const gap = 6;

  for (const [index, row] of rows.entries()) {
    // Measured per cell at the size it will actually be drawn at.
    //
    // The first issued pack estimated the row height from the cell's character
    // count, which reserved roughly 80 to 95 points for a single line of 8.5pt
    // text and produced pages that were mostly empty grey bands. A string's
    // length says nothing about how tall it renders, because wrapping decides
    // that, and only the renderer knows where it wrapped.
    const heights = row.map((cell, column) =>
      measure(doc, cell, (columns[column]?.width ?? 100) - 8, cellFont),
    );
    const height = Math.max(11, ...heights);
    ensure(page, height + paddingY * 2);

    const top = page.y;

    if (index % 2 === 0) {
      doc.rect(PAGE_MARGIN, top, CONTENT_WIDTH, height + paddingY * 2).fillColor('#f8fafc').fill();
    }

    let x = PAGE_MARGIN;
    row.forEach((cell, column) => {
      const width = columns[column]?.width ?? 100;
      doc.font(cellFont.font).fontSize(cellFont.size).fillColor(INK).text(cell, x + 4, top + paddingY, {
        width: width - 8,
        // lineBreak rather than ellipsis: ellipsis alone does not clip a block that
        // has wrapped, so a long cell overflowed its column and ran into the next.
        lineBreak: true,
        height,
        ellipsis: true,
      });
      x += width;
    });

    page.y = top + height + paddingY * 2;
    page.move(gap);
  }
}
