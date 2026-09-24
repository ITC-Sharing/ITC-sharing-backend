/**
 * The filename as the user typed it, not as the transport mangled it.
 *
 * Multipart form data carries a filename as raw bytes, and busboy — which
 * Multer sits on — decodes them as latin1. A UTF-8 name therefore arrives one
 * character per byte: "តេស្ត.png" becomes "á\x9E\x8Fá\x9F\x81….png", which is
 * what ends up stored and shown. Reading those same bytes back as UTF-8
 * restores the original.
 *
 * Guarded, because the round-trip is only right for names that were mangled
 * this way: if the bytes are not valid UTF-8 the decode yields replacement
 * characters, and the name is handed back untouched instead of being corrupted
 * a second time.
 */
export function decodeUploadName(name: string | undefined | null): string {
  if (!name) return '';
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  return decoded.includes('�') ? name : decoded;
}
