/**
 * What a file actually is, read from its bytes.
 *
 * `file.mimetype` is the Content-Type the CLIENT declared. Renaming
 * `payload.html` to `photo.jpg` and sending `Content-Type: image/jpeg` passes
 * that check and nothing else — which, with objects served from a storage
 * origin, is a stored-XSS primitive. Everything accepted here is confirmed
 * against its own signature instead.
 *
 * Hand-written rather than pulled from a library, deliberately: the allowlist
 * is eight fixed formats, `file-type`'s current major is ESM-only (awkward in a
 * CommonJS Nest build and in Jest), and its last CJS release is unmaintained.
 * Sixty lines of explicit, tested signature checks are easier to audit than a
 * dependency, and the tests below pin every branch.
 */

/** The families the platform accepts. */
export type DetectedKind =
  | 'pdf'
  | 'jpeg'
  | 'png'
  | 'zip' // also docx / pptx / xlsx — they are ZIP containers
  | 'ole' // legacy doc / ppt / xls — OLE2 compound files
  | 'rar';

export interface DetectionResult {
  kind: DetectedKind | null;
  /** A canonical MIME for the detected family, for logging and headers. */
  mime: string | null;
}

/** Magic numbers, longest-first where prefixes overlap. */
const SIGNATURES: {
  kind: DetectedKind;
  mime: string;
  offset: number;
  bytes: number[];
}[] = [
  // %PDF-
  {
    kind: 'pdf',
    mime: 'application/pdf',
    offset: 0,
    bytes: [0x25, 0x50, 0x44, 0x46, 0x2d],
  },
  // JPEG SOI + marker
  { kind: 'jpeg', mime: 'image/jpeg', offset: 0, bytes: [0xff, 0xd8, 0xff] },
  // \x89PNG\r\n\x1a\n
  {
    kind: 'png',
    mime: 'image/png',
    offset: 0,
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  // PK\x03\x04 — a ZIP local file header. docx/pptx/xlsx are ZIPs.
  {
    kind: 'zip',
    mime: 'application/zip',
    offset: 0,
    bytes: [0x50, 0x4b, 0x03, 0x04],
  },
  // Empty and spanned ZIPs carry different second pairs.
  {
    kind: 'zip',
    mime: 'application/zip',
    offset: 0,
    bytes: [0x50, 0x4b, 0x05, 0x06],
  },
  {
    kind: 'zip',
    mime: 'application/zip',
    offset: 0,
    bytes: [0x50, 0x4b, 0x07, 0x08],
  },
  // OLE2 compound file — legacy .doc/.ppt/.xls
  {
    kind: 'ole',
    mime: 'application/msword',
    offset: 0,
    bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
  },
  // Rar!\x1a\x07\x00 (v1.5) and Rar!\x1a\x07\x01\x00 (v5)
  {
    kind: 'rar',
    mime: 'application/vnd.rar',
    offset: 0,
    bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00],
  },
  {
    kind: 'rar',
    mime: 'application/vnd.rar',
    offset: 0,
    bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00],
  },
];

/** Read a buffer's leading bytes and say what family it belongs to. */
export function detectKind(buffer: Buffer): DetectionResult {
  if (!buffer || buffer.length < 4) return { kind: null, mime: null };

  for (const sig of SIGNATURES) {
    const end = sig.offset + sig.bytes.length;
    if (buffer.length < end) continue;
    let match = true;
    for (let i = 0; i < sig.bytes.length; i++) {
      if (buffer[sig.offset + i] !== sig.bytes[i]) {
        match = false;
        break;
      }
    }
    if (match) return { kind: sig.kind, mime: sig.mime };
  }

  return { kind: null, mime: null };
}

/**
 * Which detected families each accepted extension may be.
 *
 * Keyed by extension rather than by declared MIME, because the extension is
 * what the rest of the system uses to pick an icon and a preview strategy — so
 * the name and the bytes have to agree, not just the bytes and a header the
 * client wrote.
 *
 * The Office formats are the subtle case: .docx/.pptx are ZIP containers, and
 * their legacy .doc/.ppt counterparts are OLE2. Both are allowed for those
 * extensions, and neither is allowed for, say, .png.
 */
const ALLOWED_BY_EXTENSION: Record<string, DetectedKind[]> = {
  pdf: ['pdf'],
  jpg: ['jpeg'],
  jpeg: ['jpeg'],
  png: ['png'],
  doc: ['ole', 'zip'],
  docx: ['zip'],
  ppt: ['ole', 'zip'],
  pptx: ['zip'],
  zip: ['zip'],
  rar: ['rar'],
};

export interface ValidationOutcome {
  ok: boolean;
  kind: DetectedKind | null;
  detectedMime: string | null;
  /** Short machine-readable reason, for the security log. Never sent to the client. */
  reason?: 'empty' | 'unknown-extension' | 'undetectable' | 'mismatch';
}

/**
 * Confirm a buffer really is what its filename claims.
 *
 * Returns a structured outcome rather than throwing, so the caller can log the
 * specifics and still answer the client with one generic message.
 */
export function validateFileContent(
  originalName: string | null | undefined,
  buffer: Buffer,
): ValidationOutcome {
  if (!buffer || buffer.length === 0)
    return { ok: false, kind: null, detectedMime: null, reason: 'empty' };

  const ext = (originalName ?? '').split('.').pop()?.toLowerCase() ?? '';
  const allowed = ALLOWED_BY_EXTENSION[ext];
  if (!allowed)
    return {
      ok: false,
      kind: null,
      detectedMime: null,
      reason: 'unknown-extension',
    };

  const { kind, mime } = detectKind(buffer);
  if (!kind)
    return {
      ok: false,
      kind: null,
      detectedMime: null,
      reason: 'undetectable',
    };

  if (!allowed.includes(kind))
    return { ok: false, kind, detectedMime: mime, reason: 'mismatch' };

  return { ok: true, kind, detectedMime: mime };
}

/** True for the two formats the image pipeline handles. */
export function isProcessableImage(kind: DetectedKind | null): boolean {
  return kind === 'jpeg' || kind === 'png';
}
