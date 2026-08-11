import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Office document extensions we convert to PDF for in-browser preview.
const CONVERTIBLE = new Set([
  'ppt',
  'pptx',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'odp',
  'odt',
  'ods',
]);

/**
 * Converts office documents (pptx/docx/xlsx/…) to PDF using a headless
 * LibreOffice (`soffice`) so the browser can preview them as PDF.
 *
 * Conversion is best-effort: if LibreOffice isn't installed or a file fails to
 * convert, we log and return null. Uploads must still succeed — the file just
 * won't get an inline preview rendition.
 */
@Injectable()
export class OfficeConvertService {
  private readonly logger = new Logger(OfficeConvertService.name);
  // Resolve the binary once; `soffice` on most distros, overridable for envs
  // where it's named `libreoffice`.
  private readonly bin = process.env.LIBREOFFICE_BIN ?? 'soffice';

  /** True if `name`'s extension is one we can convert to PDF. */
  canConvert(name: string | null | undefined): boolean {
    const ext = (name ?? '').split('.').pop()?.toLowerCase() ?? '';
    return CONVERTIBLE.has(ext);
  }

  /**
   * Convert an office file buffer to a PDF buffer. Returns null if conversion
   * is unavailable or fails — callers treat that as "no preview rendition".
   */
  async toPdf(
    input: Buffer,
    originalName: string,
  ): Promise<Buffer | null> {
    if (!this.canConvert(originalName)) return null;

    // LibreOffice works on files, not stdin — stage the input in an isolated
    // temp dir and let it write the .pdf alongside.
    let workDir: string | undefined;
    try {
      workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'itc-convert-'));
      const ext = originalName.split('.').pop()!.toLowerCase();
      const inPath = path.join(workDir, `src.${ext}`);
      const outPath = path.join(workDir, 'src.pdf');
      await fs.writeFile(inPath, input);

      // `--convert-to pdf` writes <basename>.pdf into --outdir. A per-call
      // profile dir avoids clashes when conversions run concurrently.
      await execFileAsync(
        this.bin,
        [
          '--headless',
          '--norestore',
          `-env:UserInstallation=file://${path.join(workDir, 'profile')}`,
          '--convert-to',
          'pdf',
          '--outdir',
          workDir,
          inPath,
        ],
        { timeout: 60_000 },
      );

      return await fs.readFile(outPath);
    } catch (err) {
      this.logger.warn(
        `PDF conversion failed for "${originalName}" (is LibreOffice installed?): ${String(err)}`,
      );
      return null;
    } finally {
      if (workDir) {
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}
