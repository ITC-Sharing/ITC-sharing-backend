import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Req,
  Res,
  HttpCode,
} from '@nestjs/common';
import type { Request, Response, CookieOptions } from 'express';
import { AuthService } from './auth.service';
import { randomBytes } from 'crypto';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import {
  EmailDto,
  ResetPasswordDto,
  VerifyCodeDto,
} from './dto/email-flows.dto';
import { RateLimitTier } from '../../common/rate-limit/rate-limit.decorator';
import { contextFrom } from '../../common/alerts/request-context';

const REFRESH_COOKIE = 'refresh_token';
// Short-lived, and only exists between the redirect out and the callback back.
const OAUTH_STATE_COOKIE = 'g_oauth_state';

// httpOnly cookie. The SPA and API are on different origins (localhost:5173 vs
// :3000, or separate prod domains), so the cookie must be SameSite=None; Secure
// to be stored/sent on credentialed cross-origin requests. Chrome treats
// http://localhost as a secure context, so Secure works in local dev too.
function refreshCookieOptions(maxAge: number): CookieOptions {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    path: '/',
    maxAge,
  };
}

function readRefreshCookie(req: Request): string | undefined {
  const cookies = req.cookies as Record<string, string> | undefined;
  return cookies?.[REFRESH_COOKIE];
}

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  /**
   * Create the account and sign in, in one call. Mirrors login: same body
   * shape back, same refresh cookie set.
   */
  /**
   * Create the account. Does NOT sign anyone in.
   *
   * It used to return the same token pair as login, which is what made the
   * address unproven — an account was usable the moment somebody typed an
   * address they did not own. The caller now gets a message and an email.
   */
  @RateLimitTier('signup')
  @Post('register')
  async register(@Body() dto: RegisterDto, @Req() req: Request) {
    return this.authService.register(dto, contextFrom(req));
  }

  /**
   * Confirm an address with the six-digit code from the sign-up email.
   *
   * On its own tier: a code is guessable in a way a reset link is not, so the
   * budget for hammering this endpoint is tighter than for redeeming a link.
   * The per-code attempt cap in the service is the real control; this bounds
   * how fast someone can burn through codes to get more attempts.
   */
  @RateLimitTier('email-code')
  @Post('verify-email')
  @HttpCode(200)
  async verifyEmail(
    @Body() dto: VerifyCodeDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Returns a session, so the same cookie login sets is set here — a
    // confirmed address goes straight into the app rather than back to a
    // sign-in form it has already earned the right to skip.
    const { message, user, accessToken, refreshToken } =
      await this.authService.verifyEmailCode(dto.email, dto.code);

    res.cookie(
      REFRESH_COOKIE,
      refreshToken,
      refreshCookieOptions(this.authService.refreshTtlMs),
    );

    return { message, user, token: accessToken };
  }

  /** Send the verification link again. Answers the same for any address. */
  @RateLimitTier('email-send')
  @Post('resend-verification')
  @HttpCode(200)
  async resendVerification(@Body() dto: EmailDto) {
    return this.authService.resendVerification(dto.email);
  }

  /** Start a password reset. Answers the same for any address. */
  @RateLimitTier('email-send')
  @Post('forgot-password')
  @HttpCode(200)
  async forgotPassword(@Body() dto: EmailDto, @Req() req: Request) {
    return this.authService.forgotPassword(dto.email, contextFrom(req));
  }

  /**
   * Check a reset code without spending it.
   *
   * Lets the client confirm the code before collecting a new password, so a
   * wrong code costs six digits rather than a password typed twice. A wrong
   * guess still counts against the same five-attempt cap — a check that did
   * not count would be an unlimited oracle.
   */
  @RateLimitTier('email-code')
  @Post('reset-code/check')
  @HttpCode(200)
  async checkResetCode(@Body() dto: VerifyCodeDto) {
    return this.authService.checkResetCode(dto.email, dto.code);
  }

  /**
   * Finish a password reset with the emailed code.
   *
   * Same tier as confirming an address: both submit a six-digit code, so both
   * need the budget that bounds guessing at one.
   *
   * Deliberately does not sign the caller in. The password is being set by
   * someone who could not produce the old one, so the session waits until they
   * can type the new one — which also means an abandoned reset leaves no
   * logged-in tab behind.
   */
  @RateLimitTier('email-code')
  @Post('reset-password')
  @HttpCode(200)
  async resetPassword(@Body() dto: ResetPasswordDto, @Req() req: Request) {
    return this.authService.resetPassword(
      dto.email,
      dto.code,
      dto.password,
      contextFrom(req),
    );
  }

  @RateLimitTier('auth')
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user, accessToken, refreshToken } = await this.authService.login(
      dto,
      contextFrom(req),
    );
    res.cookie(
      REFRESH_COOKIE,
      refreshToken,
      refreshCookieOptions(this.authService.refreshTtlMs),
    );
    return { user, token: accessToken };
  }

  /**
   * GET /auth/google — send the browser to Google's consent screen.
   *
   * The `state` value is stored in a short-lived cookie and echoed back by
   * Google, so the callback can tell its own redirect apart from one someone
   * else constructed.
   */
  @RateLimitTier('oauth')
  /**
   * Plain `@Res()`, NOT passthrough.
   *
   * `passthrough: true` means "I will touch the response, but Nest still sends
   * the reply from my return value". This handler sends its own reply —
   * res.redirect() writes the 302 and ends the response — so Nest then tried to
   * send `undefined` on top of a finished response and Express threw
   * ERR_HTTP_HEADERS_SENT. The redirect still reached the browser, so Google
   * sign-in worked while every click logged a 500 behind it.
   *
   * googleCallback below has always used plain `@Res()` for the same reason.
   */
  @Get('google')
  googleRedirect(@Res() res: Response) {
    const state = randomBytes(16).toString('hex');
    // Built first: if Google isn't configured this throws, and we'd rather not
    // leave a stray state cookie behind on a request that never left.
    const url = this.authService.buildGoogleAuthUrl(state);
    res.cookie(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 10 * 60 * 1000,
    });
    res.redirect(url);
  }

  /**
   * GET /auth/google/callback — Google sends the browser back here.
   *
   * Ends in a redirect to the SPA, never a JSON body: this is a top-level
   * navigation, so the user must land on a page. The session travels in the
   * httpOnly refresh cookie rather than a token in the URL, which would end up
   * in browser history and in any referrer.
   */
  @RateLimitTier('oauth')
  @Get('google/callback')
  async googleCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const frontend = (process.env.CORS_ORIGIN ?? 'http://localhost:5173').split(
      ',',
    )[0];
    const cookies = req.cookies as Record<string, string> | undefined;
    const expectedState = cookies?.[OAUTH_STATE_COOKIE];
    res.clearCookie(OAUTH_STATE_COOKIE, { path: '/' });

    const fail = (reason: string) =>
      res.redirect(
        `${frontend}/auth/login?google_error=${encodeURIComponent(reason)}`,
      );

    // The user pressed cancel, or Google refused outright.
    if (error) return fail(error);
    if (!code) return fail('missing_code');
    if (!state || !expectedState || state !== expectedState)
      return fail('state_mismatch');

    try {
      const { refreshToken } = await this.authService.completeGoogleLogin(
        code,
        contextFrom(req),
      );
      res.cookie(
        REFRESH_COOKIE,
        refreshToken,
        refreshCookieOptions(this.authService.refreshTtlMs),
      );
      // The SPA trades this cookie for an access token on landing.
      return res.redirect(`${frontend}/auth/callback`);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Google sign-in failed';
      return fail(message);
    }
  }

  @RateLimitTier('refresh')
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { accessToken, refreshToken } = await this.authService.refresh(
      readRefreshCookie(req),
    );
    res.cookie(
      REFRESH_COOKIE,
      refreshToken,
      refreshCookieOptions(this.authService.refreshTtlMs),
    );
    return { token: accessToken };
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.authService.logout(readRefreshCookie(req));
    res.clearCookie(REFRESH_COOKIE, {
      path: '/',
      secure: true,
      sameSite: 'none',
    });
    return { message: 'Logged out' };
  }
}
