import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

/**
 * Outbound email: address verification and password resets.
 *
 * SMTP is OPTIONAL on purpose. With no SMTP_* configured the service logs the
 * code instead of sending it, which keeps local development working without
 * anyone needing Gmail credentials — and keeps the app booting if mail is
 * misconfigured, rather than taking the whole API down over it.
 *
 * The trade-off is that a production box with no SMTP silently delivers nothing,
 * so the constructor logs a loud warning and every fallback send is logged at
 * WARN. If you see "SMTP not configured" in the server log, real students are
 * not receiving codes.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transport: nodemailer.Transporter | null;
  private readonly from: string;

  constructor(private readonly config: ConfigService) {
    const host = this.config.get<string>('SMTP_HOST');
    const user = this.config.get<string>('SMTP_USER');
    const pass = this.config.get<string>('SMTP_PASS');

    this.from =
      this.config.get<string>('MAIL_FROM') ??
      'ITC Sharing <no-reply@localhost>';

    if (!host || !user || !pass) {
      this.transport = null;
      this.logger.warn(
        'SMTP not configured (SMTP_HOST/SMTP_USER/SMTP_PASS) — ' +
          'registration codes will be LOGGED, not emailed.',
      );
      return;
    }

    const port = Number(this.config.get<string>('SMTP_PORT') ?? 587);
    this.transport = nodemailer.createTransport({
      host,
      port,
      // 465 is implicit TLS; 587 starts plaintext and upgrades via STARTTLS.
      secure: port === 465,
      auth: { user, pass },
    });
  }

  /** True when mail actually leaves the machine. */
  get isConfigured(): boolean {
    return this.transport !== null;
  }

  async sendRegistrationOtp(to: string, code: string): Promise<void> {
    const subject = 'Your ITC Sharing verification code';
    const text =
      `Your verification code is ${code}\n\n` +
      'It expires in 3 minutes. If you did not try to create an ITC Sharing ' +
      'account, you can ignore this email.';

    if (!this.transport) {
      this.logger.warn(
        `SMTP not configured — code for ${to} is ${code} (not emailed)`,
      );
      return;
    }

    try {
      await this.transport.sendMail({
        from: this.from,
        to,
        subject,
        text,
        html: this.codeHtml(
          'Verify your email',
          'Enter this code to finish creating your ITC Sharing account.',
          code,
          'This code expires in 3 minutes. If you did not request it, ignore this email.',
        ),
      });
    } catch (error) {
      // Logged with the address but never the code: a failed send still has to
      // leave no way to read the OTP out of the logs on a configured server.
      this.logger.error(
        `Failed to send verification code to ${to}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }

  /**
   * The code that authorises a new password.
   *
   * Sent only to an address that already has an account with a password of
   * ours. The endpoint that triggers it answers identically either way — see
   * forgotPassword — so this being sent or not must never be observable to
   * whoever asked.
   */
  async sendPasswordReset(to: string, code: string): Promise<void> {
    const subject = 'Your ITC Sharing password reset code';
    const text =
      `Your password reset code is ${code}\n\n` +
      'It expires in 3 minutes and can be used once. If you did not ask to ' +
      'reset your password, ignore this email — your password has not changed.';

    if (!this.transport) {
      this.logger.warn(
        `SMTP not configured — reset code for ${to} is ${code} (not emailed)`,
      );
      return;
    }

    await this.deliver(
      to,
      subject,
      text,
      this.codeHtml(
        'Reset your password',
        'Enter this code to choose a new password.',
        code,
        'This code expires in 3 minutes and can be used once. If you did not ' +
          'ask for it, ignore this email — your password has not changed.',
      ),
    );
  }

  /**
   * One send path for every message.
   *
   * The unconfigured case logs the whole body, link included, so local
   * development and a staging box without SMTP still work — you copy the link
   * out of the server log. On a configured server this branch never runs, and
   * the boot warning says so loudly enough that nobody should be surprised.
   */
  private async deliver(
    to: string,
    subject: string,
    text: string,
    html: string,
  ): Promise<void> {
    if (!this.transport) {
      this.logger.warn(
        `SMTP not configured — "${subject}" for ${to} was NOT emailed:\n${text}`,
      );
      return;
    }

    try {
      await this.transport.sendMail({
        from: this.from,
        to,
        subject,
        text,
        html,
      });
    } catch (error) {
      // The address is logged; the link is not. A failed send must not leave a
      // working credential sitting in the log of a configured server.
      this.logger.error(
        `Failed to send "${subject}" to ${to}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }

  private codeHtml(
    heading: string,
    lead: string,
    code: string,
    footer: string,
  ): string {
    return `
      <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="margin:0 0 8px;color:#111">${heading}</h2>
        <p style="margin:0 0 24px;color:#555;font-size:14px">${lead}</p>
        <div style="font-size:32px;font-weight:700;letter-spacing:8px;text-align:center;
                    padding:16px;background:#f4f6f8;border-radius:12px;color:#111">
          ${code}
        </div>
        <p style="margin:24px 0 0;color:#888;font-size:12px">${footer}</p>
      </div>`;
  }
}
