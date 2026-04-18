import {
  Body,
  Controller,
  Get,
  Patch,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UsersService } from './users.service';
import { UpdateUserDto } from './dto/update-user.dto';

type AuthenticatedRequest = {
  user: {
    sub: string;
    email: string;
  };
};

@UseGuards(JwtAuthGuard) // All routes in this controller require a valid JWT
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  /**
   * GET /users/me
   * Returns the full profile of the currently authenticated user.
   */
  @Get('me')
  getMe(@Request() req: AuthenticatedRequest) {
    return this.usersService.getMe(req.user.sub);
  }

  /**
   * PATCH /users/me
   * Partially updates the authenticated user's profile.
   * All fields are optional — only provided fields are written.
   */
  @Patch('me')
  updateMe(@Request() req: AuthenticatedRequest, @Body() dto: UpdateUserDto) {
    return this.usersService.updateMe(req.user.sub, dto);
  }
}
