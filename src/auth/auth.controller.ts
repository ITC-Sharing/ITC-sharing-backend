import { Controller, Post, Body, Req, Res, HttpCode } from '@nestjs/common';
import type { Request, Response, CookieOptions } from 'express';
import { AuthService, REFRESH_TTL_MS } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

const REFRESH_COOKIE = 'refresh_token';

// httpOnly cookie. The SPA and API are on different origins (localhost:5173 vs
// :3000, or separate prod domains), so the cookie must be SameSite=None; Secure
// to be stored/sent on credentialed cross-origin requests. Chrome treats
// http://localhost as a secure context, so Secure works in local dev too.
function refreshCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    path: '/',
    maxAge: REFRESH_TTL_MS,
  };
}

function readRefreshCookie(req: Request): string | undefined {
  const cookies = req.cookies as Record<string, string> | undefined;
  return cookies?.[REFRESH_COOKIE];
}

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('login')
  @HttpCode(200)
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user, accessToken, refreshToken } =
      await this.authService.login(dto);
    res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions());
    return { user, token: accessToken };
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { accessToken, refreshToken } = await this.authService.refresh(
      readRefreshCookie(req),
    );
    res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions());
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
