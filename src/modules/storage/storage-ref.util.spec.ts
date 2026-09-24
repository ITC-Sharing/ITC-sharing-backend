import {
  contentDisposition,
  isSafeKeySegment,
  parseRef,
  sanitizeFilename,
} from './storage-ref.util';

/**
 * Path and header safety.
 *
 * Storage keys are generated server-side, so these are defence in depth — but
 * they are the last gate before a value reaches S3 or an HTTP header, and both
 * are places where a stray `..` or newline changes what the request means.
 */

describe('isSafeKeySegment', () => {
  it('accepts an ordinary generated key', () => {
    expect(isSafeKeySegment('documents/3f2c/8b1e-4c2a.pdf')).toBe(true);
  });

  it.each([
    ['parent traversal', 'documents/../secrets/key.pdf'],
    ['bare traversal', '../etc/passwd'],
    ['leading slash', '/documents/a.pdf'],
    ['backslash', 'documents\\a.pdf'],
    ['double slash', 'documents//a.pdf'],
    ['newline', 'documents/a\n.pdf'],
    ['carriage return', 'documents/a\r.pdf'],
    ['null byte', 'documents/a\u0000.pdf'],
    ['empty', ''],
  ])('rejects %s', (_label, value) => {
    expect(isSafeKeySegment(value)).toBe(false);
  });
});

describe('parseRef', () => {
  it('splits a bucket-qualified ref', () => {
    expect(parseRef('documents/abc/def.pdf')).toEqual({
      bucket: 'documents',
      key: 'abc/def.pdf',
    });
  });

  it.each([
    ['traversal', 'documents/../other/a.pdf'],
    ['no bucket segment', 'justakey.pdf'],
    ['leading slash', '/documents/a.pdf'],
    ['empty key', 'documents/'],
    ['null', null],
    ['undefined', undefined],
  ])('refuses %s', (_label, value) => {
    expect(parseRef(value as string | null)).toBeNull();
  });

  it('refuses a bucket name that is not a flat label', () => {
    expect(parseRef('Documents/a.pdf')).toBeNull(); // uppercase is not valid
  });
});

describe('sanitizeFilename', () => {
  it('keeps an ordinary name', () => {
    expect(sanitizeFilename('Lecture Notes 1.pdf')).toBe('Lecture Notes 1.pdf');
  });

  it('keeps non-Latin names intact — Khmer filenames are routine here', () => {
    expect(sanitizeFilename('តេស្ត.png')).toBe('តេស្ត.png');
  });

  it('reduces a path to its basename', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\Windows\\system32\\evil.pdf')).toBe(
      'evil.pdf',
    );
  });

  it('strips control characters used for header injection', () => {
    expect(sanitizeFilename('a\r\nX-Evil: 1.pdf')).toBe('aX-Evil: 1.pdf');
  });

  it('strips quotes that would break out of the header value', () => {
    expect(sanitizeFilename('evil".pdf')).toBe('evil.pdf');
  });

  it('returns null when nothing usable survives', () => {
    expect(sanitizeFilename('')).toBeNull();
    expect(sanitizeFilename(null)).toBeNull();
    expect(sanitizeFilename('\u0000\u0001')).toBeNull();
  });
});

describe('contentDisposition', () => {
  it('defaults to attachment — an uploaded file must not render inline', () => {
    expect(contentDisposition('notes.pdf')).toMatch(/^attachment;/);
  });

  it('allows inline only when asked, for server-generated previews', () => {
    expect(contentDisposition('preview.pdf', 'inline')).toMatch(/^inline;/);
  });

  it('emits both an ASCII fallback and an encoded filename*', () => {
    const header = contentDisposition('តេស្ត.png');
    expect(header).toContain('filename="');
    expect(header).toContain("filename*=UTF-8''");
    // The ASCII half must not carry raw non-ASCII bytes.
    const ascii = /filename="([^"]*)"/.exec(header)![1];
    expect(/^[\x20-\x7e]*$/.test(ascii)).toBe(true);
  });

  it('cannot be used to inject a second header', () => {
    const header = contentDisposition('a\r\nSet-Cookie: admin=1.pdf');
    expect(header).not.toContain('\r');
    expect(header).not.toContain('\n');
  });

  it('falls back to a safe name when the input is unusable', () => {
    expect(contentDisposition(null)).toContain('filename="download"');
  });
});
