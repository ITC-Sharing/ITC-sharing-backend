import {
  detectKind,
  isProcessableImage,
  validateFileContent,
} from './file-signature';

/**
 * These tests are the security boundary for "is this file what it says it is".
 *
 * The important cases are the negative ones: a file whose NAME and declared
 * type say `.jpg` while its BYTES say something else is precisely the payload
 * this check exists to stop.
 */

/** Minimal but genuine headers — enough bytes for the signature to be real. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const PDF = Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'binary');
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
const OLE = Buffer.from([
  0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00,
]);
const RAR5 = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);

const HTML = Buffer.from('<!doctype html><script>alert(1)</script>', 'utf8');
const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  'utf8',
);

describe('detectKind', () => {
  it.each([
    ['JPEG', JPEG, 'jpeg'],
    ['PNG', PNG, 'png'],
    ['PDF', PDF, 'pdf'],
    ['ZIP', ZIP, 'zip'],
    ['OLE2', OLE, 'ole'],
    ['RAR5', RAR5, 'rar'],
  ])('recognises %s', (_label, buffer, expected) => {
    expect(detectKind(buffer).kind).toBe(expected);
  });

  it('returns null for content with no known signature', () => {
    expect(detectKind(HTML).kind).toBeNull();
    expect(detectKind(SVG).kind).toBeNull();
  });

  it('returns null for a buffer too short to carry a signature', () => {
    expect(detectKind(Buffer.from([0xff])).kind).toBeNull();
    expect(detectKind(Buffer.alloc(0)).kind).toBeNull();
  });
});

describe('validateFileContent — accepts genuine files', () => {
  it.each([
    ['photo.jpg', JPEG],
    ['photo.jpeg', JPEG],
    ['diagram.png', PNG],
    ['notes.pdf', PDF],
    ['slides.pptx', ZIP],
    ['essay.docx', ZIP],
    ['archive.zip', ZIP],
    ['legacy.doc', OLE],
    ['legacy.ppt', OLE],
    ['archive.rar', RAR5],
  ])('accepts %s', (name, buffer) => {
    expect(validateFileContent(name, buffer).ok).toBe(true);
  });

  it('is case-insensitive about the extension', () => {
    expect(validateFileContent('PHOTO.JPG', JPEG).ok).toBe(true);
  });
});

describe('validateFileContent — rejects disguised files', () => {
  it('rejects HTML renamed to .jpg — the stored-XSS case', () => {
    const outcome = validateFileContent('document.jpg', HTML);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('undetectable');
  });

  it('rejects SVG renamed to .png', () => {
    expect(validateFileContent('logo.png', SVG).ok).toBe(false);
  });

  it('rejects a PDF renamed to .jpg — real file, wrong extension', () => {
    const outcome = validateFileContent('photo.jpg', PDF);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('mismatch');
    // The detection result is kept for the log, not for the client.
    expect(outcome.detectedMime).toBe('application/pdf');
  });

  it('rejects a JPEG renamed to .pdf', () => {
    expect(validateFileContent('notes.pdf', JPEG).ok).toBe(false);
  });

  it('rejects an executable-looking payload with an allowed extension', () => {
    const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
    expect(validateFileContent('slides.pptx', elf).ok).toBe(false);
  });

  it('rejects an extension that is not on the allowlist', () => {
    const outcome = validateFileContent('script.html', HTML);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('unknown-extension');
  });

  it('rejects a file with no extension at all', () => {
    expect(validateFileContent('README', PDF).ok).toBe(false);
  });

  it('rejects an empty buffer', () => {
    const outcome = validateFileContent('notes.pdf', Buffer.alloc(0));
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('empty');
  });

  it('does not let a ZIP masquerade as a PNG', () => {
    // .docx and .pptx are ZIPs, so `zip` is an accepted kind — but only for
    // the extensions that are actually ZIP containers.
    expect(validateFileContent('image.png', ZIP).ok).toBe(false);
  });
});

describe('isProcessableImage', () => {
  it('is true only for the two formats the image pipeline handles', () => {
    expect(isProcessableImage('jpeg')).toBe(true);
    expect(isProcessableImage('png')).toBe(true);
    expect(isProcessableImage('pdf')).toBe(false);
    expect(isProcessableImage('zip')).toBe(false);
    expect(isProcessableImage(null)).toBe(false);
  });
});
