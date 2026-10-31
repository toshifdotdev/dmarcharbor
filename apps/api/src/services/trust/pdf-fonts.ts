import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The faces the evidence pack is set in: Albert Sans for every word a person
 * reads, Atkinson Hyperlegible Mono for the values a reader copies exactly
 * (domains, DNS records, the document reference). The same two families as the
 * web app, so the PDF and the Trust Center look like one publisher's work.
 *
 * The files live in apps/api/assets/fonts (SIL Open Font License, the licence
 * texts beside them). They are found relative to this module, which sits at
 * the same depth in src/ (run with tsx or vitest) and in dist/ (the container),
 * so `../../../assets/fonts` is apps/api/assets/fonts in both. The working
 * directory is a second guess, for a layout where only the cwd is known.
 *
 * A missing or unreadable file never stops a pack from being issued: the
 * document falls back to the PDF standard faces, Helvetica and Courier, whole
 * family at a time, so a document is never half in one face and half in
 * another. Which faces were used is returned, and a renderer that cares can
 * say so.
 */

export interface PdfFaces {
  sans: string;
  medium: string;
  bold: string;
  mono: string;
  monoMedium: string;
  /** False when the standard faces stood in for a family. */
  embedded: { sans: boolean; mono: boolean };
}

export interface PdfFontFiles {
  sans?: Buffer | null;
  sansMedium?: Buffer | null;
  sansBold?: Buffer | null;
  mono?: Buffer | null;
  monoMedium?: Buffer | null;
}

const FILES: Record<keyof PdfFontFiles, string> = {
  sans: 'AlbertSans-Regular.ttf',
  sansMedium: 'AlbertSans-Medium.ttf',
  sansBold: 'AlbertSans-Bold.ttf',
  mono: 'AtkinsonHyperlegibleMono-Regular.ttf',
  monoMedium: 'AtkinsonHyperlegibleMono-Medium.ttf',
};

function candidateDirectories(): string[] {
  const directories: string[] = [];
  try {
    directories.push(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../assets/fonts'));
  } catch {
    // Not a file URL (a bundler, say). The cwd guess below still applies.
  }
  directories.push(path.resolve(process.cwd(), 'assets/fonts'));
  directories.push(path.resolve(process.cwd(), 'apps/api/assets/fonts'));
  return [...new Set(directories)];
}

function readFirst(name: string): Buffer | null {
  for (const directory of candidateDirectories()) {
    try {
      return readFileSync(path.join(directory, name));
    } catch {
      // Try the next place.
    }
  }
  return null;
}

let cached: PdfFontFiles | null = null;

/** Reads the font files once per process. A file that is not there is null. */
export function packFontFiles(): PdfFontFiles {
  if (cached) return cached;
  cached = {
    sans: readFirst(FILES.sans),
    sansMedium: readFirst(FILES.sansMedium),
    sansBold: readFirst(FILES.sansBold),
    mono: readFirst(FILES.mono),
    monoMedium: readFirst(FILES.monoMedium),
  };
  return cached;
}

/**
 * Registers the faces on a document and returns the names to set text in.
 *
 * Each family is opened once here, inside a try, so a corrupt file is found
 * now and swapped for the standard face rather than throwing halfway through a
 * render. Opening a face does not embed it: only faces that draw text are
 * written into the file.
 */
export function applyPackFonts(doc: PDFKit.PDFDocument, files: PdfFontFiles = packFontFiles()): PdfFaces {
  let sansEmbedded = false;
  if (files.sans && files.sansMedium && files.sansBold) {
    try {
      doc.registerFont('Pack-Sans', files.sans);
      doc.registerFont('Pack-Sans-Medium', files.sansMedium);
      doc.registerFont('Pack-Sans-Bold', files.sansBold);
      doc.font('Pack-Sans-Bold');
      doc.font('Pack-Sans-Medium');
      doc.font('Pack-Sans');
      sansEmbedded = true;
    } catch {
      sansEmbedded = false;
    }
  }

  let monoEmbedded = false;
  if (files.mono && files.monoMedium) {
    try {
      doc.registerFont('Pack-Mono', files.mono);
      doc.registerFont('Pack-Mono-Medium', files.monoMedium);
      doc.font('Pack-Mono-Medium');
      doc.font('Pack-Mono');
      monoEmbedded = true;
    } catch {
      monoEmbedded = false;
    }
  }

  const faces: PdfFaces = {
    sans: sansEmbedded ? 'Pack-Sans' : 'Helvetica',
    medium: sansEmbedded ? 'Pack-Sans-Medium' : 'Helvetica-Bold',
    bold: sansEmbedded ? 'Pack-Sans-Bold' : 'Helvetica-Bold',
    mono: monoEmbedded ? 'Pack-Mono' : 'Courier',
    monoMedium: monoEmbedded ? 'Pack-Mono-Medium' : 'Courier-Bold',
    embedded: { sans: sansEmbedded, mono: monoEmbedded },
  };
  doc.font(faces.sans);
  return faces;
}
