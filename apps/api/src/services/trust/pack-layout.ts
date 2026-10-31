/**
 * pack-layout.ts — the evidence pack's page, in the Routes language.
 *
 * White page, near-black ink, hairlines for structure, and colour only where a
 * word carries a state: the same rule the web app and the Trust Center follow,
 * so a client holding both sees one publisher. Every state word travels with
 * its shape (filled square aligned, diamond failing, ring needing attention,
 * hollow grey station not published, hatched square not measured), so the
 * document still reads in black and white.
 *
 * Mechanics an auditor never sees but relies on:
 *
 *   - Everything is measured with the face and size it is drawn in, before it
 *     is drawn. pdfkit measures with whatever font is active, and measuring
 *     with the wrong one is how the first pack overlapped its own paragraphs.
 *   - A table row is never split across pages. A row that does not fit moves
 *     whole to the next page, and the column labels are drawn again above it.
 *   - A heading is never left alone at the foot of a page: it moves with the
 *     first thing beneath it.
 *   - pdfkit's own bottom margin is zero, so it never adds a page by itself.
 *     This cursor decides every page break, which keeps the page count a
 *     function of the facts alone.
 *
 * This file is separate from pdf-layout.ts on purpose. The monthly report
 * still uses that one, and its bytes and its tests rest on Helvetica; moving
 * it to this layout is its own change.
 */

import type { CheckState } from './client-evidence.js';
import type { PdfFaces } from './pdf-fonts.js';

export const C = {
  ink: '#15171b',
  ink2: '#41454d',
  ink3: '#6c717a',
  meta: '#5f646c',
  rule: '#e7e9ed',
  rule2: '#c9cdd4',
  red: '#d9342b',
  ok: '#0f7a3b',
  warn: '#9a5b00',
  warnMark: '#c58a14',
  void: '#6c717a',
  white: '#ffffff',
} as const;

export const PAGE = {
  width: 595.28,
  height: 841.89,
  x: 56,
  /** Where body text starts on a page with a running header. */
  top: 78,
  /** The lowest point body text may reach. */
  bottom: 841.89 - 70,
} as const;

export const WIDTH = PAGE.width - PAGE.x * 2;
/** Running text is set narrower than the page, for a comfortable line. */
export const MEASURE = 440;

export type Face = keyof Omit<PdfFaces, 'embedded'>;

export interface TextStyle {
  face?: Face;
  size?: number;
  color?: string;
  lineGap?: number;
  tracking?: number;
  width?: number;
  align?: 'left' | 'right' | 'center';
  tnum?: boolean;
}

export const STATE_COLOUR: Record<CheckState, string> = {
  pass: C.ok,
  warn: C.warn,
  fail: C.red,
  absent: C.ink3,
  unchecked: C.ink3,
};

export interface Cell {
  text: string;
  face?: Face;
  /** Defaults to 8.5; the data face sets domains a little smaller so they fit their column. */
  size?: number;
  color?: string;
  state?: CheckState;
  /** A second, quieter line under the first. */
  sub?: string | null;
  subFace?: Face;
  /** Draws the three-station policy strip instead of text. */
  strip?: { level: 0 | 1 | 2 | null; planned?: 0 | 1 | 2 | null };
}

export interface Column {
  label: string;
  width: number;
  align?: 'left' | 'right';
}

/** One label and value pair in a facts list. */
export interface FactRow {
  label: string;
  value: string;
  mono?: boolean;
  state?: CheckState;
  /** What the state word rests on, set under it in running ink. */
  detail?: string | null;
  /** The record quoted exactly, set under that in the data face. */
  record?: string | null;
}

interface SectionMark {
  number: string;
  title: string;
  page: number;
  destination: string;
}

const CELL_X = 5;
const CELL_Y = 5;
const MARK_INDENT = 12;
/** Room for a two-digit section number beside its title. */
export const NUMBER_INDENT = 34;

export class PackWriter {
  y: number = PAGE.top;
  readonly sections: SectionMark[] = [];

  constructor(
    readonly doc: PDFKit.PDFDocument,
    readonly faces: PdfFaces,
  ) {}

  /** The zero-based index of the page being drawn. */
  get pageIndex(): number {
    return this.doc.bufferedPageRange().start + this.doc.bufferedPageRange().count - 1;
  }

  newPage(): void {
    this.doc.addPage();
    this.y = PAGE.top;
  }

  /** Breaks the page unless `height` fits below the cursor. True when it broke. */
  ensure(height: number): boolean {
    if (this.y + height > PAGE.bottom) {
      this.newPage();
      return true;
    }
    return false;
  }

  space(points: number): void {
    this.y += points;
  }

  private set(style: TextStyle): void {
    this.doc.font(this.faces[style.face ?? 'sans']).fontSize(style.size ?? 9.5);
  }

  private options(style: TextStyle, width: number): PDFKit.Mixins.TextOptions {
    return {
      width,
      lineGap: style.lineGap ?? 0,
      characterSpacing: style.tracking ?? 0,
      align: style.align ?? 'left',
      features: style.tnum ? ['tnum'] : undefined,
    } as PDFKit.Mixins.TextOptions;
  }

  measure(text: string, style: TextStyle = {}): number {
    if (!text) return 0;
    this.set(style);
    const width = style.width ?? MEASURE;
    return this.doc.heightOfString(text, this.options(style, width));
  }

  widthOf(text: string, style: TextStyle = {}): number {
    this.set(style);
    return this.doc.widthOfString(text, { characterSpacing: style.tracking ?? 0 } as PDFKit.Mixins.TextOptions);
  }

  /** Draws at (x, y) without moving the cursor, and returns the height used. */
  textAt(text: string, x: number, y: number, style: TextStyle = {}): number {
    if (!text) return 0;
    const width = style.width ?? MEASURE;
    const height = this.measure(text, style);
    this.set(style);
    this.doc.fillColor(style.color ?? C.ink).text(text, x, y, this.options(style, width));
    return height;
  }

  /** A single line that must not wrap: running heads, page numbers. */
  line(text: string, x: number, y: number, style: TextStyle = {}): void {
    this.set(style);
    this.doc.fillColor(style.color ?? C.ink).text(text, x, y, {
      lineBreak: false,
      characterSpacing: style.tracking ?? 0,
      features: style.tnum ? ['tnum'] : undefined,
    } as PDFKit.Mixins.TextOptions);
  }

  rule(y: number, color: string = C.rule, weight = 0.6, x = PAGE.x, width = WIDTH): void {
    this.doc.save().moveTo(x, y).lineTo(x + width, y).lineWidth(weight).strokeColor(color).stroke().restore();
  }

  /**
   * A numbered section heading, which also becomes a contents entry and a
   * bookmark.
   *
   * It is not drawn here. It waits for the first block under it, which says
   * how tall it is, and then heading and block are placed together: a heading
   * is never left alone at the foot of a page, whatever comes first beneath it.
   */
  section(number: string, title: string): void {
    this.flushHeading(0);
    this.pending = { number, title };
  }

  private pending: { number: string; title: string } | null = null;

  /** Draws a waiting heading so that `next` points of what follows fit beneath it. */
  flushHeading(next: number): void {
    if (!this.pending) return;
    const { number, title } = this.pending;
    this.pending = null;
    const style: TextStyle = { face: 'bold', size: 15, tracking: -0.25, width: WIDTH - NUMBER_INDENT };
    const height = this.measure(title, style);
    if (this.y > PAGE.top) this.space(26);
    // A fresh page starts flush with the top, so the space above is not carried over.
    this.ensure(height + 18 + Math.min(next, PAGE.bottom - PAGE.top - height - 18));
    const top = this.y;
    const destination = `section-${number}`;
    this.doc.addNamedDestination(destination, 'XYZ', PAGE.x, top - 8, null);
    this.doc.outline.addItem(`${number}. ${title}`);
    this.line(number, PAGE.x, top + 1.5, { face: 'bold', size: 15, color: C.ink3, tnum: true });
    this.textAt(title, PAGE.x + NUMBER_INDENT, top, style);
    this.y = top + height + 6;
    this.rule(this.y, C.ink, 0.9);
    this.y += 12;
    this.sections.push({ number, title, page: this.pageIndex, destination });
  }

  /** A heading inside a section. A domain name passes the data face. */
  subheading(text: string, keepWith = 46, face: Face = 'bold'): void {
    const style: TextStyle = { face, size: face === 'bold' ? 10.5 : 9.8, width: WIDTH };
    const height = this.measure(text, style);
    this.flushHeading(height + 6 + keepWith);
    this.space(10);
    this.ensure(height + 6 + keepWith);
    this.textAt(text, PAGE.x, this.y, style);
    this.y += height + 5;
  }

  paragraph(text: string, style: TextStyle = {}): void {
    const merged: TextStyle = { face: 'sans', size: 9.5, color: C.ink2, lineGap: 2.4, width: MEASURE, ...style };
    const height = this.measure(text, merged);
    this.flushHeading(height);
    this.ensure(height);
    this.textAt(text, PAGE.x, this.y, merged);
    this.y += height + 6;
  }

  note(text: string): void {
    this.paragraph(text, { size: 8, color: C.ink3, lineGap: 1.6 });
  }

  /** The shape that travels with a state word. Centred on (x, y). */
  mark(state: CheckState, x: number, y: number, size = 6.4): void {
    const doc = this.doc;
    const h = size / 2;
    doc.save();
    if (state === 'pass') {
      doc.rect(x - h, y - h, size, size).fillColor(C.ok).fill();
    } else if (state === 'fail') {
      doc.moveTo(x, y - h - 0.6).lineTo(x + h + 0.6, y).lineTo(x, y + h + 0.6).lineTo(x - h - 0.6, y).closePath().fillColor(C.red).fill();
    } else if (state === 'warn') {
      doc.circle(x, y, h - 0.5).lineWidth(1.4).strokeColor(C.warnMark).stroke();
    } else if (state === 'absent') {
      doc.circle(x, y, h - 0.4).lineWidth(1.2).fillColor(C.white).strokeColor(C.rule2).fillAndStroke();
    } else {
      doc.rect(x - h + 0.4, y - h + 0.4, size - 0.8, size - 0.8).lineWidth(0.7).strokeColor(C.void).stroke();
      doc
        .moveTo(x - h + 0.4, y)
        .lineTo(x, y - h + 0.4)
        .moveTo(x - h + 0.4, y + h - 0.4)
        .lineTo(x + h - 0.4, y - h + 0.4)
        .moveTo(x, y + h - 0.4)
        .lineTo(x + h - 0.4, y)
        .lineWidth(0.6)
        .strokeColor(C.void)
        .stroke();
    }
    doc.restore();
  }

  /**
   * The policy strip: p=none, p=quarantine and p=reject as stations on one
   * line. The line is ink as far as the published policy and an unbuilt grey
   * beyond it; a proposed step not yet taken is the dashed planned segment.
   * No usable record leaves the whole line dotted grey with closed stations.
   */
  strip(x: number, y: number, width: number, level: 0 | 1 | 2 | null, planned: 0 | 1 | 2 | null = null): void {
    const doc = this.doc;
    const stations = [x + 4, x + width / 2, x + width - 4];
    doc.save();
    if (level === null) {
      doc.moveTo(stations[0]!, y).lineTo(stations[2]!, y).lineWidth(1.6).dash(1, { space: 2.2 }).strokeColor(C.rule2).stroke().undash();
    } else {
      doc.moveTo(stations[0]!, y).lineTo(stations[2]!, y).lineWidth(2.6).strokeColor(C.rule).stroke();
      if (level > 0) {
        doc.moveTo(stations[0]!, y).lineTo(stations[level]!, y).lineWidth(2.6).strokeColor(C.ink).stroke();
      }
      if (planned !== null && planned > level) {
        doc.moveTo(stations[level]!, y).lineTo(stations[planned]!, y).lineWidth(1.6).dash(3, { space: 2.4 }).strokeColor(C.ink).stroke().undash();
      }
    }
    stations.forEach((sx, index) => {
      const reached = level !== null && index <= level;
      const current = level === index;
      const r = current ? 3.6 : 2.6;
      doc
        .circle(sx, y, r)
        .lineWidth(current ? 1.6 : 1.2)
        .fillColor(C.white)
        .strokeColor(reached ? C.ink : C.rule2)
        .fillAndStroke();
    });
    doc.restore();
  }

  /** The height one cell needs at a column width. */
  private cellHeight(cell: Cell, width: number): number {
    if (cell.strip) return 12;
    const inner = width - CELL_X * 2 - (cell.state ? MARK_INDENT : 0);
    const main = this.measure(cell.text || ' ', {
      face: cell.face ?? (cell.state ? 'medium' : 'sans'),
      size: cell.size ?? 8.5,
      width: inner,
      lineGap: 1.4,
    });
    const sub = cell.sub
      ? this.measure(cell.sub, { face: cell.subFace ?? 'sans', size: 7.6, width: inner, lineGap: 1.2 }) + 1.5
      : 0;
    return main + sub;
  }

  private drawCell(cell: Cell, x: number, y: number, width: number, align: 'left' | 'right'): void {
    if (cell.strip) {
      this.strip(x + CELL_X, y + 5.5, Math.min(width - CELL_X * 2, 92), cell.strip.level, cell.strip.planned ?? null);
      return;
    }
    const indent = cell.state ? MARK_INDENT : 0;
    const inner = width - CELL_X * 2 - indent;
    if (cell.state) this.mark(cell.state, x + CELL_X + 3.4, y + 5.6);
    const mainStyle: TextStyle = {
      face: cell.face ?? (cell.state ? 'medium' : 'sans'),
      size: cell.size ?? 8.5,
      width: inner,
      lineGap: 1.4,
      color: cell.color ?? (cell.state ? STATE_COLOUR[cell.state] : C.ink),
      align,
      tnum: align === 'right',
    };
    const used = this.textAt(cell.text, x + CELL_X + indent, y, mainStyle);
    if (cell.sub) {
      this.textAt(cell.sub, x + CELL_X + indent, y + used + 1.5, {
        face: cell.subFace ?? 'sans',
        size: 7.6,
        width: inner,
        lineGap: 1.2,
        color: C.ink3,
        align,
      });
    }
  }

  private tableHeader(columns: Column[]): void {
    const labelStyle = (column: Column): TextStyle => ({
      face: 'medium',
      size: 7.6,
      color: C.meta,
      width: column.width - CELL_X * 2,
      align: column.align ?? 'left',
    });
    const height = Math.max(...columns.map((column) => this.measure(column.label, labelStyle(column))));
    let x = PAGE.x;
    for (const column of columns) {
      this.textAt(column.label, x + CELL_X, this.y, labelStyle(column));
      x += column.width;
    }
    this.y += height + 4;
    this.rule(this.y, C.rule2, 0.8);
    this.y += CELL_Y;
  }

  /**
   * A table set like a timetable: sentence-case labels over a firmer rule,
   * hairlines between rows, no fills. Rows never split; the labels repeat at
   * the top of every page the table runs onto.
   */
  table(columns: Column[], rows: Cell[][], empty = 'None recorded.'): void {
    if (rows.length === 0) {
      this.paragraph(empty, { color: C.ink3 });
      return;
    }
    const heights = rows.map((row) => Math.max(10, ...row.map((cell, index) => this.cellHeight(cell, columns[index]?.width ?? 80))));
    const headerHeight = 7.6 * 1.4 + 4 + CELL_Y;

    this.flushHeading(headerHeight + heights[0]! + CELL_Y * 2);
    this.ensure(headerHeight + heights[0]! + CELL_Y * 2);
    this.tableHeader(columns);

    rows.forEach((row, index) => {
      const height = heights[index]!;
      if (this.y + height + CELL_Y > PAGE.bottom) {
        this.newPage();
        this.tableHeader(columns);
      }
      let x = PAGE.x;
      row.forEach((cell, column) => {
        const spec = columns[column] ?? { label: '', width: 80 };
        this.drawCell(cell, x, this.y, spec.width, spec.align ?? 'left');
        x += spec.width;
      });
      this.y += height + CELL_Y;
      this.rule(this.y, C.rule, 0.5);
      this.y += CELL_Y;
    });
    this.y += 4;
  }

  /**
   * Label and value pairs, one per row, divided by hairlines. A pair never
   * splits across pages.
   */
  facts(rows: FactRow[], labelWidth = 150): void {
    const labelStyle: TextStyle = { face: 'bold', size: 8.6, width: labelWidth - 12, lineGap: 1.4 };
    const layout = rows.map((row) => this.factLayout(row, labelWidth));
    // The opening rule travels with the first row, so neither is left alone.
    this.flushHeading(6 + (layout[0]?.height ?? 0) + 12);
    this.ensure(6 + (layout[0]?.height ?? 0) + 12);
    this.rule(this.y, C.rule, 0.5);
    this.y += 6;
    rows.forEach((row, index) => {
      const { indent, valueStyle, detailStyle, recordStyle, valueHeight, detailHeight, height } = layout[index]!;
      this.ensure(height + 12);
      if (row.state) this.mark(row.state, PAGE.x + labelWidth + 3.4, this.y + 5.8);
      this.textAt(row.label, PAGE.x, this.y, labelStyle);
      const x = PAGE.x + labelWidth + indent;
      this.textAt(row.value, x, this.y, valueStyle);
      if (row.detail) this.textAt(row.detail, x, this.y + valueHeight + 2, detailStyle);
      if (row.record) this.textAt(row.record, x, this.y + valueHeight + detailHeight + 3, recordStyle);
      this.y += height + 5;
      this.rule(this.y, C.rule, 0.5);
      this.y += 6;
    });
    this.y += 2;
  }

  /**
   * One pair, measured: a state word in its colour, then what it rests on in
   * running ink, then the record itself in the data face. Three runs,
   * measured separately and drawn from the same numbers.
   */
  private factLayout(row: FactRow, labelWidth: number) {
    const valueWidth = WIDTH - labelWidth;
    const labelStyle: TextStyle = { face: 'bold', size: 8.6, width: labelWidth - 12, lineGap: 1.4 };
    const indent = row.state ? MARK_INDENT : 0;
    const valueStyle: TextStyle = {
      face: row.mono ? 'mono' : row.state ? 'medium' : 'sans',
      size: row.mono ? 8.2 : 9,
      width: valueWidth - indent,
      lineGap: 1.8,
      color: row.state ? STATE_COLOUR[row.state] : C.ink2,
    };
    const detailStyle: TextStyle = { face: 'sans', size: 8.6, width: valueWidth - indent, lineGap: 1.6, color: C.ink2 };
    const recordStyle: TextStyle = { face: 'mono', size: 8, width: valueWidth - indent, lineGap: 1.6, color: C.ink };
    const valueHeight = this.measure(row.value, valueStyle);
    const detailHeight = row.detail ? this.measure(row.detail, detailStyle) + 2 : 0;
    const recordHeight = row.record ? this.measure(row.record, recordStyle) + 3 : 0;
    const height = Math.max(this.measure(row.label, labelStyle), valueHeight + detailHeight + recordHeight);
    return { indent, valueStyle, detailStyle, recordStyle, valueHeight, detailHeight, height };
  }

  /** Figures in a row, divided by hairlines, never boxed. */
  readouts(cells: { label: string; value: string; note: string }[]): void {
    const width = WIDTH / cells.length;
    const labelStyle = (w: number): TextStyle => ({ face: 'medium', size: 7.8, color: C.meta, width: w });
    const noteStyle = (w: number): TextStyle => ({ face: 'sans', size: 7.6, color: C.ink3, width: w, lineGap: 1 });
    const inner = (index: number) => width - (index === 0 ? 0 : 10) - 8;
    const height =
      Math.max(...cells.map((cell, index) => this.measure(cell.label, labelStyle(inner(index))))) +
      26 +
      Math.max(...cells.map((cell, index) => this.measure(cell.note, noteStyle(inner(index)))));
    this.flushHeading(height + 20);
    this.ensure(height + 20);
    const top = this.y;
    this.rule(top, C.rule, 0.6);
    cells.forEach((cell, index) => {
      const x = PAGE.x + width * index + (index === 0 ? 0 : 10);
      if (index > 0) {
        this.doc.save().moveTo(PAGE.x + width * index, top).lineTo(PAGE.x + width * index, top + height + 18).lineWidth(0.6).strokeColor(C.rule).stroke().restore();
      }
      let y = top + 9;
      y += this.textAt(cell.label, x, y, labelStyle(inner(index)));
      this.line(cell.value, x, y + 2, { face: 'bold', size: 19, tracking: -0.3, tnum: true });
      y += 26;
      this.textAt(cell.note, x, y, noteStyle(inner(index)));
    });
    this.y = top + height + 18;
    this.rule(this.y, C.rule, 0.6);
    this.y += 10;
  }
}
