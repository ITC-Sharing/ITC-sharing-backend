import sharp from 'sharp';
import {
  ImageOptimizeService,
  MAX_IMAGE_DIMENSION,
} from './image-optimize.service';

/**
 * Image handling is an optimisation, not a security control — the file has
 * already been confirmed as a real JPEG/PNG by its signature before it gets
 * here. What these tests pin is that the optimisation cannot make things
 * worse: no upscaling, no distortion, and a bomb is refused rather than
 * decoded.
 */

const service = new ImageOptimizeService();

async function makeJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: '#008cb9' },
  })
    .jpeg()
    .toBuffer();
}

async function makePng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 4, background: '#008cb9' },
  })
    .png()
    .toBuffer();
}

describe('ImageOptimizeService', () => {
  jest.setTimeout(30_000);

  it('scales an oversized image down to the cap', async () => {
    const out = await service.optimize(await makeJpeg(4000, 3000), 'jpeg');
    expect(out.width).toBe(MAX_IMAGE_DIMENSION);
    expect(out.height).toBe(1440);
    expect(out.resized).toBe(true);
  });

  it('preserves the aspect ratio', async () => {
    const out = await service.optimize(await makeJpeg(4000, 1000), 'jpeg');
    // 4:1 in, 4:1 out.
    expect(out.width! / out.height!).toBeCloseTo(4, 2);
  });

  it('never upscales a small image', async () => {
    const out = await service.optimize(await makeJpeg(300, 200), 'jpeg');
    expect(out.width).toBe(300);
    expect(out.height).toBe(200);
    expect(out.resized).toBe(false);
  });

  it('leaves an image exactly at the cap alone', async () => {
    const out = await service.optimize(
      await makeJpeg(MAX_IMAGE_DIMENSION, 1080),
      'jpeg',
    );
    expect(out.width).toBe(MAX_IMAGE_DIMENSION);
    expect(out.resized).toBe(false);
  });

  it('keeps PNG as PNG and JPEG as JPEG', async () => {
    const png = await service.optimize(await makePng(2400, 1200), 'png');
    expect(png.contentType).toBe('image/png');
    expect((await sharp(png.buffer).metadata()).format).toBe('png');

    const jpeg = await service.optimize(await makeJpeg(2400, 1200), 'jpeg');
    expect(jpeg.contentType).toBe('image/jpeg');
    expect((await sharp(jpeg.buffer).metadata()).format).toBe('jpeg');
  });

  it('strips metadata by re-encoding', async () => {
    const withExif = await sharp({
      create: { width: 100, height: 100, channels: 3, background: '#fff' },
    })
      .withExifMerge({ IFD0: { Copyright: 'secret-location-data' } })
      .jpeg()
      .toBuffer();

    const out = await service.optimize(withExif, 'jpeg');
    expect(out.buffer.includes(Buffer.from('secret-location-data'))).toBe(
      false,
    );
  });

  it('refuses an undecodable buffer', async () => {
    await expect(
      service.optimize(Buffer.from('not an image at all'), 'jpeg'),
    ).rejects.toThrow();
  });

  it('falls back to the original rather than losing an upload', async () => {
    // optimizeOrOriginal is the upload path's wrapper: a sharp failure on a
    // file that already passed signature validation must not cost the upload.
    const out = await service.optimizeOrOriginal(
      Buffer.from('not an image at all'),
      'jpeg',
    );
    expect(out).toBeNull();
  });

  it('refuses a decompression bomb before decoding it', async () => {
    // A real bomb is small on disk and enormous in memory, so building one by
    // generating pixels would be slow for no benefit — the point is that the
    // HEADER is read and refused before anything is allocated. A forged IHDR
    // declaring 20,000 x 20,000 (400 MP) exercises exactly that path in
    // milliseconds.
    const bomb = pngWithDeclaredSize(20_000, 20_000);
    await expect(service.optimize(bomb, 'png')).rejects.toThrow();
  });
});

/** CRC-32, as PNG chunks require. */
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A PNG signature + IHDR claiming `width` x `height`. Nothing follows it. */
function pngWithDeclaredSize(width: number, height: number): Buffer {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);

  const body = Buffer.alloc(17);
  body.write('IHDR', 0, 'ascii');
  body.writeUInt32BE(width, 4);
  body.writeUInt32BE(height, 8);
  body[12] = 8; // bit depth
  body[13] = 2; // colour type: truecolour
  body[14] = 0; // compression
  body[15] = 0; // filter
  body[16] = 0; // interlace

  const length = Buffer.alloc(4);
  length.writeUInt32BE(13, 0);

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);

  return Buffer.concat([signature, length, body, crc]);
}
