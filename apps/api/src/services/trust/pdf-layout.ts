/**
 * pdf-layout.ts — the monthly evidence report's page, in the Routes language.
 *
 * The report and the compliance pack come from the same agency and have to
 * look like it: the same white page, the same two faces, the same palette and
 * the same timetable tables. So nothing visual is defined here. The palette is
 * the pack's `C`, the faces are the pack's (pdf-fonts.ts), and every word is
 * measured and set by the pack's own primitives (PackWriter's measure, textAt,
 * rule and mark). A size or a colour cannot drift between the two documents,
 * because there is only one of each.
 *
 * What is the report's own is how it breaks pages. A section that would split
 * moves whole to the next page, as it always has; only a section taller than a
 * page runs on, row by row, with its column labels drawn again at the top of
 * each new page. Moving a section whole needs its height before it is drawn, so
 * each section is described once, as data, and both measured and drawn from that
 * one description. Two descriptions drift apart, and then the document changes
 * with no code change.
 *
 * Mechanics carried over from the Helvetica layout, each from a shipped bug:
 *
 *   - Everything is measured in the face and size it is drawn in. pdfkit
 *     measures with whatever font is active, and measuring with the previous
 *     element's font is how paragraphs overlapped in the first issued pack.
 *     PackWriter.measure sets the face before it measures, every time.
 *   - Table rows are measured cell by cell, never estimated from a string's
 *     length: only the renderer knows where a cell wraps.
 *   - The renderer sets pdfkit's own bottom margin to zero, so pdfkit never
 *     adds a page by itself. This cursor decides every break, and the page
 *     count is a function of the facts alone.
 */

import type { CheckState } from './client-evidence.js';
import {
  C,
  CELL_X,
  CELL_Y,
  MARK_INDENT,
  MEASURE,
  NUMBER_INDENT,
  PAGE,
  PackWriter,
  STATE_COLOUR,
  WIDTH,
  type Column,
  type Face,
  type TextStyle,
} from './pack-layout.js';
import type { PdfFaces } from './pdf-fonts.js';

export type { Column };

export const PAGE_MARGIN = PAGE.x;
export const CONTENT_WIDTH = WIDTH;
/** The report has no running head, so a page starts at the margin. */
const TOP = PAGE_MARGIN;
/** The lowest point anything may reach, unchanged from the Helvetica layout. */
const BOTTOM = PAGE.height - PAGE_MARGIN - 24;

const BODY: TextStyle = { face: 'sans', size: 9.5, color: C.ink2, lineGap: 2.4, width: MEASURE };
const NOTE: TextStyle = { face: 'sans', size: 8, color: C.ink3, lineGap: 1.6, width: MEASURE };
const HEADING: TextStyle = { face: 'bold', size: 15, tracking: -0.25, width: WIDTH - NUMBER_INDENT };
const HEADING_NUMBER: TextStyle = { face: 'bold', size: 15, color: C.ink3, tnum: true };

/** Space above a section heading, unless the heading opens a page. */
const SECTION_GAP = 26;
const LABEL_WIDTH = 130;

/** A cursor over the report's pages, with the page-break rule in one place. */
export class ReportPage {
  y: number = TOP;
  /** The pack's text primitives. Its own cursor and sections are not used here. */
  readonly pen: PackWriter;

  constructor(
    readonly doc: PDFKit.PDFDocument,
    faces: PdfFaces,
  ) {
    this.pen = new PackWriter(doc, faces);
  }

  newPage(): void {
    this.doc.addPage();
    this.y = TOP;
  }

  /**
   * Breaks the page unless `height` fits below the cursor. A page with nothing
   * on it yet never breaks: what does not fit there fits nowhere, and breaking
   * would only leave a blank page behind.
   */
  ensure(height: number): void {
    if (this.y > TOP && this.y + height > BOTTOM) {
      this.newPage();
    }
  }
}

/** One table cell. A state cell is drawn as its mark and the word in the state's colour. */
export interface Cell {
  text: string;
  /** Defaults to the sans face, or the medium face for a state word. Domains and IPs pass `mono`. */
  face?: Face;
  /** Defaults to 8.5. */
  size?: number;
  color?: string;
  state?: CheckState;
}

/** One label and value pair. */
export interface FactRow {
  label: string;
  value: string;
  /** A literal value a reader copies exactly: the reference, an address. */
  mono?: boolean;
  /** A figure, set in tabular numerals. */
  figure?: boolean;
}

export type SectionBlock =
  | { kind: 'body'; text: string }
  | { kind: 'note'; text: string }
  | { kind: 'facts'; rows: FactRow[] }
  | { kind: 'table'; columns: Column[]; rows: Cell[][] };

export interface Section {
  /** Set apart in ink-3 before the title, as the pack sets its section numbers. */
  number: string;
  title: string;
  blocks: SectionBlock[];
}

// Facts: label and value pairs divided by hairlines.

const FACT_LABEL: TextStyle = { face: 'medium', size: 8.6, color: C.meta, lineGap: 1.4, width: LABEL_WIDTH - 12 };

function factValue(row: FactRow): TextStyle {
  return {
    face: row.mono ? 'mono' : 'sans',
    size: row.mono ? 8.2 : 9,
    color: C.ink,
    lineGap: 1.8,
    width: WIDTH - LABEL_WIDTH,
    tnum: row.figure === true,
  };
}

function factHeights(page: ReportPage, rows: FactRow[]): number[] {
  return rows.map((row) => Math.max(page.pen.measure(row.label, FACT_LABEL), page.pen.measure(row.value, factValue(row))));
}

/** Opening rule and its space, each row with five points under it, its rule, six more; two after. */
function factsHeight(heights: number[]): number {
  return 6 + heights.reduce((total, height) => total + height + 11, 0) + 2;
}

/**
 * Label and value pairs, one per row, each followed by a hairline. A pair never
 * splits across pages, and the opening rule travels with the first pair.
 */
export function facts(page: ReportPage, rows: FactRow[]): void {
  const heights = factHeights(page, rows);
  page.ensure(6 + (heights[0] ?? 0) + 11);
  page.pen.rule(page.y, C.rule, 0.5);
  page.y += 6;
  rows.forEach((row, index) => {
    const height = heights[index]!;
    page.ensure(height + 11);
    page.pen.textAt(row.label, PAGE.x, page.y, FACT_LABEL);
    page.pen.textAt(row.value, PAGE.x + LABEL_WIDTH, page.y, factValue(row));
    page.y += height + 5;
    page.pen.rule(page.y, C.rule, 0.5);
    page.y += 6;
  });
  page.y += 2;
}

// Tables, set like a timetable.

const FALLBACK_COLUMN: Column = { label: '', width: 80 };

function headerLabel(column: Column): TextStyle {
  return { face: 'medium', size: 7.6, color: C.meta, width: column.width - CELL_X * 2, align: column.align ?? 'left' };
}

function cellStyle(cell: Cell, column: Column): TextStyle {
  const align = column.align ?? 'left';
  return {
    face: cell.face ?? (cell.state ? 'medium' : 'sans'),
    size: cell.size ?? 8.5,
    color: cell.color ?? (cell.state ? STATE_COLOUR[cell.state] : C.ink),
    lineGap: 1.4,
    width: column.width - CELL_X * 2 - (cell.state ? MARK_INDENT : 0),
    align,
    // Figures line up in their column.
    tnum: align === 'right',
  };
}

interface TableLayout {
  /** The column labels, the rule under them and the space before the first row. */
  header: number;
  rows: number[];
  /** The rules run under the columns, not across the page. */
  width: number;
}

function tableLayout(page: ReportPage, columns: Column[], rows: Cell[][]): TableLayout {
  const labels = Math.max(0, ...columns.map((column) => page.pen.measure(column.label, headerLabel(column))));
  return {
    header: labels + 4 + CELL_Y,
    rows: rows.map((row) =>
      Math.max(10, ...row.map((cell, index) => page.pen.measure(cell.text || ' ', cellStyle(cell, columns[index] ?? FALLBACK_COLUMN)))),
    ),
    width: columns.reduce((total, column) => total + column.width, 0),
  };
}

/** Every row is its tallest cell with five points above and below; four after the table. */
function tableHeight(layout: TableLayout): number {
  return layout.header + layout.rows.reduce((total, height) => total + height + CELL_Y * 2, 0) + 4;
}

function tableHeader(page: ReportPage, columns: Column[], layout: TableLayout): void {
  let x = PAGE.x;
  for (const column of columns) {
    page.pen.textAt(column.label, x + CELL_X, page.y, headerLabel(column));
    x += column.width;
  }
  page.y += layout.header - CELL_Y;
  page.pen.rule(page.y, C.rule2, 0.8, PAGE.x, layout.width);
  page.y += CELL_Y;
}

/**
 * Sentence-case column labels over a firmer rule, hairlines between rows, no
 * fills and no vertical rules. A row never splits: one that does not fit moves
 * whole to the next page, and the column labels are drawn again above it.
 */
export function table(page: ReportPage, columns: Column[], rows: Cell[][]): void {
  const layout = tableLayout(page, columns, rows);
  // The labels never stand alone at the foot of a page.
  page.ensure(layout.header + (layout.rows[0] ?? 0) + CELL_Y * 2);
  tableHeader(page, columns, layout);

  rows.forEach((row, index) => {
    const height = layout.rows[index]!;
    if (page.y + height + CELL_Y > BOTTOM) {
      page.newPage();
      tableHeader(page, columns, layout);
    }
    let x = PAGE.x;
    row.forEach((cell, column) => {
      const spec = columns[column] ?? FALLBACK_COLUMN;
      const indent = cell.state ? MARK_INDENT : 0;
      if (cell.state) page.pen.mark(cell.state, x + CELL_X + 3.4, page.y + 5.6);
      page.pen.textAt(cell.text, x + CELL_X + indent, page.y, cellStyle(cell, spec));
      x += spec.width;
    });
    page.y += height + CELL_Y;
    page.pen.rule(page.y, C.rule, 0.5, PAGE.x, layout.width);
    page.y += CELL_Y;
  });
  page.y += 4;
}

// Running text.

function paragraph(page: ReportPage, text: string, style: TextStyle): void {
  const height = page.pen.measure(text, style);
  page.ensure(height);
  page.pen.textAt(text, PAGE.x, page.y, style);
  page.y += height + 6;
}

// Sections.

function headingHeight(page: ReportPage, title: string): number {
  return page.pen.measure(title, HEADING) + 6 + 12;
}

function heading(page: ReportPage, number: string, title: string): void {
  const height = page.pen.measure(title, HEADING);
  page.ensure(height + 18);
  const top = page.y;
  page.pen.line(number, PAGE.x, top + 1.5, HEADING_NUMBER);
  page.pen.textAt(title, PAGE.x + NUMBER_INDENT, top, HEADING);
  page.y = top + height + 6;
  page.pen.rule(page.y, C.ink, 0.9);
  page.y += 12;
}

function blockHeight(page: ReportPage, block: SectionBlock): number {
  switch (block.kind) {
    case 'body':
      return page.pen.measure(block.text, BODY) + 6;
    case 'note':
      return page.pen.measure(block.text, NOTE) + 6;
    case 'facts':
      return factsHeight(factHeights(page, block.rows));
    case 'table':
      return tableHeight(tableLayout(page, block.columns, block.rows));
  }
}

/**
 * Height a section will occupy, from the same measurements and the same spacing
 * the drawing uses. The space above the heading is not included: it is dropped
 * when the section opens a page.
 */
export function sectionHeight(page: ReportPage, spec: Section): number {
  return headingHeight(page, spec.title) + spec.blocks.reduce((total, block) => total + blockHeight(page, block), 0);
}

/** Draws a section, having first moved it whole to the next page if it would split. */
export function section(page: ReportPage, spec: Section): void {
  if (page.y > TOP) page.y += SECTION_GAP;
  page.ensure(sectionHeight(page, spec));
  heading(page, spec.number, spec.title);

  for (const block of spec.blocks) {
    switch (block.kind) {
      case 'body':
        paragraph(page, block.text, BODY);
        break;
      case 'note':
        paragraph(page, block.text, NOTE);
        break;
      case 'facts':
        facts(page, block.rows);
        break;
      case 'table':
        table(page, block.columns, block.rows);
        break;
    }
  }
}
