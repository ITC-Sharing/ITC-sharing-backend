/**
 * Helpers for object refs and download headers.
 *
 * Kept out of StorageService so they can be unit-tested without an S3 client,
 * and so the sanitising rules live in one place rather than at each call site.
 */

/** A "<bucket>/<key>" ref split into its parts. */
export interface StorageRef {
  bucket: string;
  key: string;
}

/**
 * Parse a "<bucket>/<key>" ref as stored in `storage_key` / `preview_key`.
 *
 * Rejects anything that could climb out of its prefix. A key is built by the
 * server today, but this is the last gate before a value reaches S3, and a row
 * written by an older version — or by a future bug — must not be able to reach
 * another bucket's objects.
 */
export function parseRef(ref: string | null | undefined): StorageRef | null {
  if (!ref || typeof ref !== 'string') return null;
  if (!isSafeKeySegment(ref)) return null;

  const slash = ref.indexOf('/');
  if (slash < 1) return null;

  const bucket = ref.slice(0, slash);
  const key = ref.slice(slash + 1);
  if (!bucket || !key) return null;
  // A bucket name is a flat label; a slash in it means the ref is malformed.
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(bucket)) return null;

  return { bucket, key };
}

/**
 * True when a storage path contains nothing that could traverse or inject.
 *
 * `..` is the obvious one. The rest matter because keys end up in URLs and, via
 * Content-Disposition, in headers: a NUL or a newline in either is a splitting
 * primitive, and a backslash is a separator on some clients.
 */
export function isSafeKeySegment(value: string): boolean {
  if (!value) return false;
  if (value.includes('..')) return false;
  if (value.startsWith('/')) return false;
  if (value.includes('\\')) return false;
  if (value.includes('//')) return false;
  // Control characters, including CR/LF and NUL.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  return true;
}

/**
 * Strip a user-supplied filename down to something safe to echo back.
 *
 * Keeps the basename only — a name like `../../etc/passwd` becomes `passwd` —
 * removes control characters and quotes, and caps the length. Returns null when
 * nothing usable survives, so callers fall back to a generated name rather than
 * emitting an empty filename.
 */
export function sanitizeFilename(
  name: string | null | undefined,
): string | null {
  if (!name || typeof name !== 'string') return null;

  // Basename, whichever separator was used.
  const base = name.split(/[\\/]/).pop() ?? '';

  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/["\\]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 100);

  return cleaned || null;
}

/**
 * A Content-Disposition header value that cannot be used to inject.
 *
 * Two forms are emitted, as RFC 6266 prescribes: a plain ASCII `filename` for
 * old clients and a percent-encoded `filename*` that carries the real name —
 * which matters here, where names are routinely Khmer.
 *
 * `attachment` is the default on purpose. Documents are uploaded by students
 * and an inline HTML or SVG would otherwise run as a page on the storage
 * origin; only previews we generated ourselves are served inline.
 */
export function contentDisposition(
  name: string | null | undefined,
  type: 'attachment' | 'inline' = 'attachment',
): string {
  const safe = sanitizeFilename(name) ?? 'download';

  // The ASCII fallback keeps only characters that are safe unquoted-ish; the
  // real name travels in filename*.
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  const encoded = encodeURIComponent(safe);

  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
