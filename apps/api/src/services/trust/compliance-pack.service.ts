import { createHash, randomUUID } from 'node:crypto';
import PDFDocument from 'pdfkit';
import { prisma } from '../../database/prisma.js';
import { recordAuditEvent } from '../audit.service.js';
import { resolveEntitlements } from '../entitlements/entitlement.service.js';
import { planCatalog } from '../entitlements/plan-catalog.js';
import { TrustCenterError, subProcessors } from './trust-center.service.js';

/**
 * The signed compliance pack.
 *
 * One document an MSP hands to their client's procurement team, covering
 * everything that team asks about: what is held, who can read it, how long it
 * is kept, who else touches it, and what the client's rights are.
 *
 * The integrity model is deliberately modest and deliberately honest. The PDF is
 * not stored. Its SHA-256 is, and that hash is published on the client's Trust
 * Center, so anybody holding a copy can prove it has not been altered since it
 * was issued. What that does not prove is that we are trustworthy or that the
 * contents are true, and the document says so on its own face rather than
 * implying a guarantee it cannot deliver.
 *
 * Determinism is a requirement, not a nicety. pdfkit stamps a creation date of
 * its own, which would make every regeneration a different document with a
 * different hash, and the agency could never show that nothing had changed. The
 * date is therefore pinned to the as of timestamp the document already states,
 * so identical inputs produce identical bytes.
 */


/**
 * Builds the reference a reader quotes.
 *
 * Human-readable on purpose. This value appears in a document a customer hands
 * to their compliance team, and they have to be able to read it back over a phone
 * when asking us for the published digest. A cuid fails that: 25 characters of
 * noise that also disclose that the value is a database row and roughly when it
 * was created.
 *
 * Client slug and issue date so a reference sorts into a filing, plus a short
 * random suffix for uniqueness within the same day.
 */
export function compliancePackReference(clientName: string, asOf: Date): string {
  const slug = clientName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .toUpperCase();

  const date = asOf.toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();

  return `DMARC-${date}-${slug || 'CLIENT'}-${suffix}`;
}

/**
 * A filename safe to put in a Content-Disposition header.
 *
 * The reference is already alphanumeric plus hyphens, so this is a guard rather
 * than a transform: it exists so a future change to the reference format cannot
 * put a quote, a newline or a path separator into a response header.
 */
export function compliancePackFilename(reference: string, asOf: Date): string {
  const safe = reference.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80);
  return `dmarc-compliance-${safe}-${asOf.toISOString().slice(0, 10)}.pdf`;
}

export const documentVersion = '1.0';

export class CompliancePackError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = 'COMPLIANCE_PACK_ERROR', status = 400) {
    super(message);
    this.name = 'CompliancePackError';
    this.code = code;
    this.status = status;
  }
}

const INK = '#0f172a';
const MUTED = '#64748b';
const RULE = '#e2e8f0';
const ACCENT = '#0f766e';

const PAGE_MARGIN = 56;
const PAGE_WIDTH = 595.28;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;

/**
 * Why the hash is not printed in the document.
 *
 * A file cannot contain its own digest. Printing the SHA-256 inside the PDF
 * changes the bytes, which changes the digest, which changes what would have to
 * be printed. Any scheme that appears to solve this is either circular or is
 * really a signature over the content with the signature block excluded.
 *
 * So the document carries a reference the reader can quote, and the digest is
 * published separately on the Trust Center. Verification is then: hash the
 * downloaded file, compare it with the published value. That is a real check,
 * and it cannot be faked by editing the file, because editing it changes the
 * digest.
 */
interface PackFacts {
  client: { name: string };
  provider: { workspaceName: string; planLabel: string; region: string };
  asOf: Date;
  domains: { name: string; status: string; policy: string | null; verifiedAt: Date | null }[];
  portalContacts: number;
  dataHeld: { category: string; description: string; personal: boolean }[];
  retention: { data: string; audit: string; erasure: string };
  erasures: { scope: string; completedAt: string; records: number }[];
  rights: { export: string; erasure: string };
  lawEnforcement: string;
  reference: string;
}

/**
 * Gathers everything the document asserts.
 *
 * Scoped to one client throughout. An agency holds many clients, and a document
 * that names another customer's data would be handed to a procurement team and
 * kept on file, which is worse than anything this feature could ever be worth.
 */
async function collectFacts(clientId: string, asOf: Date, reference: string): Promise<PackFacts> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      id: true,
      name: true,
      organizationId: true,
      organization: { select: { name: true, plan: true } },
    },
  });

  if (!client) {
    throw new CompliancePackError('That client does not exist.', 'CLIENT_NOT_FOUND', 404);
  }

  const entitlements = await resolveEntitlements(client.organizationId);
  const namedRecipients = Boolean(entitlements.features['reports.forensicNamed']);

  const [domains, contacts, erasures] = await Promise.all([
    prisma.domain.findMany({
      where: { clientId: client.id },
      select: { name: true, status: true, dmarcPolicy: true, verifiedAt: true },
      orderBy: { name: 'asc' },
      take: 500,
    }),
    prisma.clientPortalAccess.count({ where: { clientId: client.id, revokedAt: null } }),
    prisma.erasureRequest.findMany({
      where: {
        organizationId: client.organizationId,
        state: 'COMPLETED',
        OR: [{ scope: 'ORGANIZATION' }, { scope: 'CLIENT', targetId: client.id }],
      },
      select: { id: true, scope: true, completedAt: true, certificate: true },
      orderBy: { completedAt: 'desc' },
      take: 25,
    }),
  ]);

  const plan = planCatalog[client.organization.plan];

  const counts = await Promise.all(
    erasures.map(async (request) => ({
      scope: request.scope === 'ORGANIZATION' ? 'Whole workspace' : 'Single client',
      completedAt: request.completedAt?.toISOString().slice(0, 10) ?? '',
      records: countDeleted(request.certificate),
    })),
  );

  return {
    client: { name: client.name },
    provider: {
      workspaceName: client.organization.name,
      planLabel: plan.label,
      region: 'As configured for the provider account',
    },
    asOf,
    domains: domains.map((domain) => ({
      name: domain.name,
      status: domain.status,
      policy: domain.dmarcPolicy,
      verifiedAt: domain.verifiedAt,
    })),
    portalContacts: contacts,
    dataHeld: [
      { category: 'DMARC aggregate reports', description: 'Volume, authentication results and sending source counts per period.', personal: false },
      { category: 'Domain and DNS records', description: 'Domain names, DMARC policy, and the ownership record proving control.', personal: false },
      { category: 'SPF, DKIM and MX scans', description: 'Results captured when a domain is added or re-checked.', personal: false },
      { category: 'Forensic reports', description: 'Per message source detail including sending IP addresses.', personal: false },
      { category: 'Named recipients', description: 'Individual recipients.', personal: namedRecipients },
      { category: 'Account and billing records', description: 'Workspace members, portal grants and payment history.', personal: true },
    ],
    retention: {
      data: `${plan.dataRetentionDays} days`,
      audit: `${plan.auditRetentionDays} days`,
      erasure: '7 days between a request and it running',
    },
    erasures: counts,
    rights: {
      export: 'A machine readable export of everything held can be requested at any time and is available on every plan, including the free one.',
      erasure: 'Deletion can be requested for this client, the whole workspace, or a single domain. A certificate recording what was removed is retained.',
    },
    lawEnforcement:
      'A valid legal process is the only circumstance in which data for this client is disclosed outside the provider who manages it. Any such request is recorded in the audit trail.',
    reference,
  };
}

function countDeleted(certificate: unknown): number {
  if (typeof certificate !== 'object' || certificate === null || !('deleted' in certificate)) {
    return 0;
  }
  const deleted = (certificate as { deleted?: Record<string, number> }).deleted;
  if (typeof deleted !== 'object' || deleted === null) {
    return 0;
  }
  return Object.values(deleted).reduce((total, value) => (typeof value === 'number' ? total + value : total), 0);
}

/* ------------------------------------------------------------------ rendering */

class Page {
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
function measure(
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
interface SectionBlock {
  kind: 'body' | 'labelled' | 'table' | 'note';
  text?: string;
  label?: string;
  value?: string;
  columns?: { label: string; width: number }[];
  rows?: string[][];
  size?: number;
}

interface Section {
  title: string;
  blocks: SectionBlock[];
}

/**
 * Height a section will occupy, using the same measurement and the same spacing
 * constants the render path uses.
 */
function sectionHeight(doc: PDFKit.PDFDocument, section: Section): number {
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
function section(doc: PDFKit.PDFDocument, page: Page, spec: Section): void {
  page.ensure(sectionHeight(doc, spec));
  heading(doc, page, spec.title);

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
function ensure(page: Page, points: number): void {
  page.ensure(points);
}

function heading(doc: PDFKit.PDFDocument, page: Page, text: string): void {
  const height = measure(doc, text, CONTENT_WIDTH, { font: 'Helvetica', size: 12, bold: true });
  ensure(page, height + 20 + 2);

  const top = page.y;
  doc.font('Helvetica-Bold').fontSize(12).fillColor(ACCENT).text(text, PAGE_MARGIN, top, { width: CONTENT_WIDTH });
  page.y = top + height + 4;

  doc.moveTo(PAGE_MARGIN, page.y).lineTo(PAGE_WIDTH - PAGE_MARGIN, page.y).lineWidth(0.75).strokeColor(RULE).stroke();
  page.move(14);
}

function body(doc: PDFKit.PDFDocument, page: Page, text: string, size = 9.5): void {
  // Measured at the size it will actually be drawn at. Measuring before setting the
  // font is what produced overlapping paragraphs in the first issued pack.
  const height = measure(doc, text, CONTENT_WIDTH, { font: 'Helvetica', size });
  ensure(page, height + 8);

  const top = page.y;
  doc.font('Helvetica').fontSize(size).fillColor(INK).text(text, PAGE_MARGIN, top, { width: CONTENT_WIDTH });
  page.y = top + height;
  page.move(8);
}

function labelled(doc: PDFKit.PDFDocument, page: Page, label: string, value: string): void {
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

function table(doc: PDFKit.PDFDocument, page: Page, columns: { label: string; width: number }[], rows: string[][]): void {
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

/**
 * Renders the document and returns the exact bytes.
 *
 * The hash is taken over this buffer and these same bytes are what the caller
 * streams to the client. Hashing anything else would produce a fingerprint of a
 * document nobody ever received.
 */
async function render(facts: PackFacts): Promise<{ buffer: Buffer; pageCount: number }> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: PAGE_MARGIN,
    // Needed to report an accurate page count without guessing.
    bufferPages: true,
    // Uncompressed so the text stays selectable and searchable. An auditor
    // copying a retention figure out of this document is a normal thing to do,
    // and a compressed stream would make that impossible.
    compress: false,
    // Pinned, so the same facts give the same bytes and therefore the same hash.
    info: {
      Title: `DMARC Harbor compliance statement - ${facts.client.name}`,
      Author: facts.provider.workspaceName,
      Subject: 'DMARC data handling, retention and access',
      Creator: 'DMARC Harbor',
      Producer: 'DMARC Harbor',
      CreationDate: facts.asOf,
      ModDate: facts.asOf,
    },
  });

  const page = new Page(doc);
  const chunks: Buffer[] = [];

  doc.on('data', (chunk: Buffer) => chunks.push(chunk));

  // Cover
  doc.font('Helvetica-Bold').fontSize(22).fillColor(INK).text('DMARC compliance statement', PAGE_MARGIN, page.y, { width: CONTENT_WIDTH });
  page.move(30);

  doc.font('Helvetica').fontSize(10).fillColor(MUTED).text(
    `Prepared for ${facts.client.name} by ${facts.provider.workspaceName}`,
    PAGE_MARGIN,
    page.y,
    { width: CONTENT_WIDTH },
  );
  page.move(16);

  labelled(doc, page, 'Client', facts.client.name);
  labelled(doc, page, 'Prepared by', facts.provider.workspaceName);
  labelled(doc, page, 'Plan', facts.provider.planLabel);
  labelled(doc, page, 'Data as of', facts.asOf.toISOString().slice(0, 10));
  labelled(doc, page, 'Document version', documentVersion);
  labelled(doc, page, 'Domains in scope', String(facts.domains.length));
  labelled(doc, page, 'Active portal contacts', String(facts.portalContacts));

  section(doc, page, {
    title: '1. What is held for this client',
    blocks: [
      {
        kind: 'body',
        text: 'Only the categories below are collected. A category marked as containing personal data means named individuals are involved, and that data is held under a lawful basis the provider who manages it is responsible for.',
      },
      {
        kind: 'table',
        columns: [
          { label: 'Category', width: 150 },
          { label: 'Description', width: 268 },
          { label: 'Personal data', width: 65 },
        ],
        rows: facts.dataHeld.map((entry) => [entry.category, entry.description, entry.personal ? 'Yes' : 'No']),
      },
    ],
  });

  section(doc, page, {
    title: '2. Who can read it',
    blocks: [
      {
        kind: 'body',
        text: "Access is checked on every request rather than only at sign in. No other client of the same provider, and no other organisation using this platform, can read this client's records. The boundary is enforced by the application and covered by an automated test suite that attempts cross tenant access and asserts every attempt is refused.",
      },
      {
        kind: 'body',
        text: `${facts.portalContacts} portal contact${facts.portalContacts === 1 ? '' : 's'} currently have access. Portal contacts can see report volume, sending sources and spoofing warnings. They cannot see forensic data or named recipients, and that restriction is enforced on the response, not in the interface.`,
      },
    ],
  });

  section(doc, page, {
    title: '3. Domains and enforcement',
    blocks: [
      {
        kind: 'table',
        columns: [
          { label: 'Domain', width: 200 },
          { label: 'Status', width: 90 },
          { label: 'Policy', width: 70 },
          { label: 'Verified', width: 123 },
        ],
        rows: facts.domains.map((domain) => [
          domain.name,
          domain.status,
          domain.policy ?? 'not published',
          domain.verifiedAt ? domain.verifiedAt.toISOString().slice(0, 10) : 'no',
        ]),
      },
    ],
  });

  section(doc, page, {
    title: '4. How long it is kept',
    blocks: [
      { kind: 'labelled', label: 'DMARC and domain data', value: facts.retention.data },
      { kind: 'labelled', label: 'Audit trail', value: facts.retention.audit },
      { kind: 'labelled', label: 'Deletion window', value: facts.retention.erasure },
      {
        kind: 'body',
        text: 'A failed payment does not delete anything. A workspace whose subscription lapses moves to the free plan with every client, domain and report intact, and upgrading restores the previous plan.',
      },
    ],
  });

  section(doc, page, {
    title: '5. Who else touches this data',
    blocks: [
      {
        kind: 'table',
        columns: [
          { label: 'Sub processor', width: 130 },
          { label: 'Purpose', width: 200 },
          { label: 'Data', width: 153 },
        ],
        rows: subProcessors.map((entry) => [entry.name, entry.purpose, entry.data]),
      },
      { kind: 'labelled', label: 'Hosting region', value: facts.provider.region },
      { kind: 'body', text: `Law enforcement. ${facts.lawEnforcement}` },
    ],
  });

  const rightsBlocks: SectionBlock[] = [
    { kind: 'labelled', label: 'Export', value: facts.rights.export },
    { kind: 'labelled', label: 'Deletion', value: facts.rights.erasure },
  ];

  if (facts.erasures.length > 0) {
    rightsBlocks.push({ kind: 'body', text: 'Completed deletions covering this client:' });
    rightsBlocks.push({
      kind: 'table',
      columns: [
        { label: 'Scope', width: 180 },
        { label: 'Completed', width: 120 },
        { label: 'Records removed', width: 183 },
      ],
      rows: facts.erasures.map((entry) => [entry.scope, entry.completedAt, String(entry.records)]),
    });
  } else {
    rightsBlocks.push({ kind: 'note', text: 'No deletion covering this client has been requested.' });
  }

  section(doc, page, { title: '6. Your rights', blocks: rightsBlocks });

  // Flows from wherever the rights section ended. A forced break here cost a whole
  // mostly empty page, and this block is short enough to usually fit in what is
  // left of the current one.
  page.ensure(150);

  // Measured, like everything else. These were hand-positioned with fixed offsets,
  // which works until a heading wraps and then draws over the paragraph beneath it.
  doc.font('Helvetica-Bold').fontSize(14).fillColor(INK).text('How to verify this document', PAGE_MARGIN, page.y, { width: CONTENT_WIDTH });
  page.y += doc.heightOfString('How to verify this document', { width: CONTENT_WIDTH }) + 14;

  body(
    doc,
    page,
    'This statement is self attested. Verifying it proves the document has not been altered since it was issued. It does not attest that the provider is trustworthy, and it is not a third party audit or certification.',
  );
  body(
    doc,
    page,
    `To verify: compute the SHA-256 digest of this file and compare it with the value published on the Trust Center page for ${facts.client.name}. If they match, the file you hold is byte for byte the one that was issued. If the file has been edited in any way, the digest will not match.`,
  );

  // The reference is drawn in a fixed-width face on purpose. In a proportional one,
  // DMARC-20261003-ACME and DMARC-2026100S-ACME differ by a glyph a reader cannot
  // distinguish, and this is the value they are told to read back over a phone.
  const referenceText = facts.reference;
  const referenceWidth = CONTENT_WIDTH - 130;
  doc.font('Courier-Bold').fontSize(10);
  const referenceHeight = doc.heightOfString(referenceText, { width: referenceWidth });

  ensure(page, Math.max(referenceHeight, 12) + 10);
  const referenceTop = page.y;
  doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text('Document reference', PAGE_MARGIN, referenceTop, {
    width: 126,
  });
  doc.font('Courier-Bold').fontSize(10).fillColor(INK).text(referenceText, PAGE_MARGIN + 130, referenceTop, {
    width: referenceWidth,
  });
  page.y = referenceTop + Math.max(referenceHeight, 12) + 10;

  body(
    doc,
    page,
    'The digest is deliberately not printed here. A file cannot contain its own digest, because writing it in changes the file and therefore changes the digest. It is published on the Trust Center instead, so there is exactly one value and it cannot disagree with itself.',
  );

  body(doc, page, `Document version ${documentVersion}, data as of ${facts.asOf.toISOString().slice(0, 10)}.`, 8.5);

  const pageCount = doc.bufferedPageRange().count;
  doc.flushPages();

  // pdfkit is a readable stream, so the bytes only exist once the stream has
  // finished. Collecting them synchronously after end() would race and yield an
  // empty document.
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  doc.end();

  return { buffer: await finished, pageCount };
}

/**
 * Renders the document and returns the exact bytes.
 *
 * The digest is taken over this buffer, and these same bytes are what the
 * caller streams to the client. Hashing anything else would fingerprint a
 * document nobody ever received.
 *
 * Rendering is deterministic for a given set of facts, so regenerating a pack
 * for the same as of date produces the same digest. The PDF creation date is
 * pinned to that as of timestamp rather than taken from the clock, because
 * pdfkit would otherwise stamp a fresh date on every run and make every
 * regeneration a different document.
 */
export async function buildCompliancePackPdf(input: {
  clientId: string;
  asOf?: Date;
  reference: string;
}): Promise<{ buffer: Buffer; hash: string; pageCount: number; asOf: Date; documentVersion: string }> {
  const asOf = input.asOf ?? new Date();
  const facts = await collectFacts(input.clientId, asOf, input.reference);

  const rendered = await render(facts);
  const hash = createHash('sha256').update(rendered.buffer).digest('hex');

  return { buffer: rendered.buffer, hash, pageCount: rendered.pageCount, asOf, documentVersion };
}

export interface IssuedPack {
  id: string;
  /** The value printed in the document, quoted in the filename and used to verify. */
  reference: string;
  /**
   * Exposed because it is the cheapest available regression signal for the layout.
   *
   * The first issued pack ran to seven pages for the same facts because row heights
   * were estimated from string length, reserving 80 to 95 points for a single line
   * of text. A correct render of the same facts is three. A future change that
   * reintroduces the estimate moves this number, so it is asserted rather than
   * eyeballed.
   */
  pageCount: number;
  hash: string;
  byteSize: number;
  asOf: Date;
  documentVersion: string;
  supersededPrevious: boolean;
}

/**
 * Issues a pack and records its fingerprint.
 *
 * The bytes are streamed to the client and deliberately not persisted. What is
 * stored is the hash of exactly those bytes, so a reader can prove the copy
 * they hold is the one that was issued.
 */
export async function issueCompliancePack(input: {
  clientId: string;
  organizationId: string;
  actorUserId?: string | null;
  asOf?: Date;
}): Promise<IssuedPack & { buffer: Buffer }> {
  const asOf = input.asOf ?? new Date();

  // The reference is derived from the client and the date so it is legible, and it
  // is stored rather than minted and discarded. The first implementation printed a
  // UUID that was never persisted while the public lookup resolved on the primary
  // key, so the value the document told a reader to quote could not be quoted.
  const client = await prisma.client.findFirstOrThrow({
    where: { id: input.clientId, organizationId: input.organizationId },
    select: { name: true },
  });
  const reference = compliancePackReference(client.name, asOf);

  const rendered = await buildCompliancePackPdf({
    clientId: input.clientId,
    asOf,
    reference,
  });

  const previous = await prisma.compliancePack.findFirst({
    where: { clientId: input.clientId, supersededAt: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });

  // An identical document for the same as of date has the same hash, which
  // would collide on the unique index. Reuse it rather than fail.
  const existing = await prisma.compliancePack.findUnique({
    where: { pdfHash: rendered.hash },
    select: { id: true, createdAt: true, reference: true },
  });

  if (existing) {
    return {
      id: existing.id,
      reference: existing.reference,
      pageCount: rendered.pageCount,
      hash: rendered.hash,
      byteSize: rendered.buffer.length,
      asOf: rendered.asOf,
      documentVersion: rendered.documentVersion,
      supersededPrevious: false,
      buffer: rendered.buffer,
    };
  }

  const row = await prisma.$transaction(async (tx) => {
    if (previous) {
      // History is kept, because an auditor may already hold the older pack and
      // the answer to "was this one ever issued" has to outlive a regeneration.
      await tx.compliancePack.update({ where: { id: previous.id }, data: { supersededAt: new Date() } });
    }

    return tx.compliancePack.create({
      data: {
        organizationId: input.organizationId,
        clientId: input.clientId,
        scope: 'CLIENT',
        documentVersion: rendered.documentVersion,
        asOf: rendered.asOf,
        pdfHash: rendered.hash,
        reference,
        byteSize: rendered.buffer.length,
        pageCount: rendered.pageCount,
        generatedById: input.actorUserId ?? null,
      },
      select: { id: true, createdAt: true, reference: true },
    });
  });

  await recordAuditEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId ?? undefined,
    action: 'COMPLIANCE_PACK_ISSUED',
    targetType: 'compliance_pack',
    targetId: row.id,
    detail: {
      clientId: input.clientId,
      reference: row.reference,
      hash: rendered.hash,
      byteSize: rendered.buffer.length,
      documentVersion: rendered.documentVersion,
      asOf: rendered.asOf.toISOString(),
    },
  });

  return {
    id: row.id,
    reference: row.reference,
    pageCount: rendered.pageCount,
    hash: rendered.hash,
    byteSize: rendered.buffer.length,
    asOf: rendered.asOf,
    documentVersion: rendered.documentVersion,
    supersededPrevious: Boolean(previous),
    buffer: rendered.buffer,
  };
}

/** What has been issued for a client, newest first. */
export async function listCompliancePacks(clientId: string): Promise<
  { id: string; hash: string; issuedAt: string; asOf: string; superseded: boolean; documentVersion: string }[]
> {
  const rows = await prisma.compliancePack.findMany({
    where: { clientId },
    select: { id: true, pdfHash: true, createdAt: true, asOf: true, supersededAt: true, documentVersion: true },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  return rows.map((row) => ({
    id: row.id,
    hash: row.pdfHash,
    issuedAt: row.createdAt.toISOString(),
    asOf: row.asOf.toISOString(),
    superseded: row.supersededAt !== null,
    documentVersion: row.documentVersion,
  }));
}

export { TrustCenterError };
