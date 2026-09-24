import { Injectable, Logger } from '@nestjs/common';
import sharp from 'sharp';

/**
 * Re-encode uploaded images to a bounded size.
 *
 * This is an OPTIMISATION, not a security check: the file has already been
 * confirmed as a real JPEG or PNG by its signature before it reaches here.
 * What this adds is a cap on what gets stored, and a re-encode that drops
 * whatever metadata came with it.
 *
 * Only images are touched. PDFs, Office files and archives are stored exactly
 * as uploaded — a student's document must come back byte-for-byte.
 */

/** Longest edge of a stored image. Anything larger is scaled down to fit. */
export const MAX_IMAGE_DIMENSION = 1920;

/**
 * Refuse to decode beyond this. A 50,000 × 50,000 PNG is a few hundred KB
 * compressed and ~7.5 GB decoded — the classic decompression bomb. sharp reads
 * the header first, so this is checked before any pixels are allocated.
 */
export const MAX_IMAGE_PIXELS = 50_000_000; // 50 MP

const JPEG_QUALITY = 82;

export interface OptimizedImage {
  buffer: Buffer;
  contentType: string;
  width: number | null;
  height: number | null;
  /** False when the original was already within bounds and was re-encoded only. */
  resized: boolean;
}

@Injectable()
export class ImageOptimizeService {
  private readonly logger = new Logger(ImageOptimizeService.name);

  /**
   * Bound and re-encode an image.
   *
   * Throws on a refusal (bomb-sized, or undecodable) so the caller can reject
   * the upload — an image sharp cannot read is not an image we should store.
   */
  async optimize(
    buffer: Buffer,
    kind: 'jpeg' | 'png',
  ): Promise<OptimizedImage> {
    // Header-only read: cheap, and the gate before anything is decoded.
    const meta = await sharp(buffer, { limitInputPixels: MAX_IMAGE_PIXELS })
      .metadata()
      .catch(() => null);

    if (!meta?.width || !meta?.height) {
      throw new Error('Image could not be decoded');
    }
    if (meta.width * meta.height > MAX_IMAGE_PIXELS) {
      throw new Error('Image dimensions exceed the processing limit');
    }

    const needsResize =
      meta.width > MAX_IMAGE_DIMENSION || meta.height > MAX_IMAGE_DIMENSION;

    // withoutEnlargement is what keeps a 300px thumbnail at 300px: `resize` on
    // its own would happily upscale it to 1920 and store a blurrier, larger
    // file than the one that arrived.
    const pipeline = sharp(buffer, { limitInputPixels: MAX_IMAGE_PIXELS })
      .rotate() // honour EXIF orientation before the tag is stripped
      .resize({
        width: MAX_IMAGE_DIMENSION,
        height: MAX_IMAGE_DIMENSION,
        fit: 'inside', // preserves aspect ratio
        withoutEnlargement: true,
      });

    // Re-encoding is what removes EXIF — including GPS coordinates, which a
    // phone photo of a whiteboard carries by default.
    const encoded =
      kind === 'jpeg'
        ? pipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
        : pipeline.png({ compressionLevel: 9, palette: true });

    const out = await encoded.toBuffer({ resolveWithObject: true });

    return {
      buffer: out.data,
      contentType: kind === 'jpeg' ? 'image/jpeg' : 'image/png',
      width: out.info.width,
      height: out.info.height,
      resized: needsResize,
    };
  }

  /**
   * Optimise if possible, fall back to the original bytes if not.
   *
   * Used on the upload path: a sharp failure on a file that already passed
   * signature validation should not cost a student their upload. A refusal for
   * being bomb-sized is different and is re-thrown by the caller's check.
   */
  async optimizeOrOriginal(
    buffer: Buffer,
    kind: 'jpeg' | 'png',
  ): Promise<OptimizedImage | null> {
    try {
      return await this.optimize(buffer, kind);
    } catch (err) {
      this.logger.warn(
        `Image optimisation skipped (${kind}): ${err instanceof Error ? err.message : 'unknown'}`,
      );
      return null;
    }
  }
}
