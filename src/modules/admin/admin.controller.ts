import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from './guards/admin.guard';
import { ReviewerGuard } from './guards/reviewer.guard';
// `import type` because it appears in decorated signatures: with
// emitDecoratorMetadata a value import would be emitted and fail at runtime.
import type { ReviewerRequest } from './guards/reviewer.guard';
import { AdminService } from './admin.service';
import { ModerationService } from './moderation.service';
import { EditSubjectDto } from './dto/edit-subject.dto';
import { BanUserDto, SetUserRoleDto } from './dto/user-admin.dto';

// Admin-only by default. The review routes below swap AdminGuard for
// ReviewerGuard so department moderators reach them too — each of those then
// checks the department of the resource itself, not just the role.
@Controller('admin')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly moderation: ModerationService,
  ) {}

  /** GET /admin/stats */
  @Get('stats')
  getStats() {
    return this.adminService.getStats();
  }

  /** GET /admin/recent-documents */
  @Get('recent-documents')
  getRecentDocuments() {
    return this.adminService.getRecentDocuments(10);
  }

  /** GET /admin/users?search= */
  @Get('users')
  getAllUsers(@Query('search') search?: string) {
    return this.adminService.getAllUsers(search);
  }

  /** GET /admin/pending/subjects */
  @Get('pending/subjects')
  @UseGuards(ReviewerGuard)
  getPendingSubjects(@Request() req: ReviewerRequest) {
    return this.adminService.getPendingSubjects(req.reviewer!);
  }

  /** GET /admin/subjects?search=&major_id=&status= */
  @Get('subjects')
  getAllSubjects(
    @Query('search') search?: string,
    @Query('major_id') majorId?: string,
    @Query('status') status?: string,
  ) {
    return this.adminService.getAllSubjects(search, majorId, status);
  }

  /** PATCH /admin/subjects/:id — edit name / acronym / semester */
  @Patch('subjects/:id')
  editSubject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EditSubjectDto,
  ) {
    return this.adminService.editSubject(id, dto);
  }

  /** DELETE /admin/subjects/:id */
  @Delete('subjects/:id')
  removeSubject(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.removeSubject(id);
  }

  /** PATCH /admin/subjects/:id/approve */
  @Patch('subjects/:id/approve')
  @UseGuards(ReviewerGuard)
  approveSubject(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: ReviewerRequest,
  ) {
    return this.adminService.approveSubject(id, req.reviewer!);
  }

  /** PATCH /admin/subjects/:id/reject */
  @Patch('subjects/:id/reject')
  @UseGuards(ReviewerGuard)
  rejectSubject(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: ReviewerRequest,
    @Body('reason') reason?: string,
  ) {
    return this.adminService.rejectSubject(id, req.reviewer!, reason);
  }

  /** GET /admin/pending/documents */
  @Get('pending/documents')
  @UseGuards(ReviewerGuard)
  getPendingDocuments(@Request() req: ReviewerRequest) {
    return this.adminService.getPendingDocuments(req.reviewer!);
  }

  /** GET /admin/documents/group/:groupId */
  @Get('documents/group/:groupId')
  getDocumentsByGroup(@Param('groupId', ParseUUIDPipe) groupId: string) {
    return this.adminService.getDocumentsByGroup(groupId);
  }

  /** PATCH /admin/documents/group/:groupId/approve */
  @Patch('documents/group/:groupId/approve')
  @UseGuards(ReviewerGuard)
  approveDocumentGroup(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Request() req: ReviewerRequest,
  ) {
    return this.adminService.approveDocumentGroup(groupId, req.reviewer!);
  }

  /** PATCH /admin/documents/group/:groupId/reject */
  @Patch('documents/group/:groupId/reject')
  @UseGuards(ReviewerGuard)
  rejectDocumentGroup(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Request() req: ReviewerRequest,
    @Body('reason') reason?: string,
  ) {
    return this.adminService.rejectDocumentGroup(
      groupId,
      req.reviewer!,
      reason,
    );
  }

  /**
   * PATCH /admin/documents/files/:fileId/approve — clear a single file added
   * to an upload that is already approved. Its upload never left the feed, so
   * there is no group to act on.
   */
  @Patch('documents/files/:fileId/approve')
  @UseGuards(ReviewerGuard)
  approveFile(
    @Param('fileId', ParseUUIDPipe) fileId: string,
    @Request() req: ReviewerRequest,
  ) {
    return this.adminService.approveFile(fileId, req.reviewer!);
  }

  /** PATCH /admin/documents/files/:fileId/reject */
  @Patch('documents/files/:fileId/reject')
  @UseGuards(ReviewerGuard)
  rejectFile(
    @Param('fileId', ParseUUIDPipe) fileId: string,
    @Request() req: ReviewerRequest,
    @Body('reason') reason?: string,
  ) {
    return this.adminService.rejectFile(fileId, req.reviewer!, reason);
  }

  // ─── Users (admin only) ──────────────────────────────────────────────────

  /** PATCH /admin/users/:id/role — body: { role: 'user' | 'admin' } */
  @Patch('users/:id/role')
  setUserRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetUserRoleDto,
    @Request() req: ReviewerRequest,
  ) {
    return this.adminService.setUserRole(id, dto.role, req.user!.sub!);
  }

  /** PATCH /admin/users/:id/ban — body: { reason? } */
  @Patch('users/:id/ban')
  banUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: BanUserDto,
    @Request() req: ReviewerRequest,
  ) {
    return this.adminService.banUser(id, req.user!.sub!, dto.reason);
  }

  /** PATCH /admin/users/:id/unban */
  @Patch('users/:id/unban')
  unbanUser(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.unbanUser(id);
  }

  // ─── Moderators (admin only) ─────────────────────────────────────────────

  /** GET /admin/majors/:majorId/moderators */
  @Get('majors/:majorId/moderators')
  listModerators(@Param('majorId', ParseUUIDPipe) majorId: string) {
    return this.moderation.listByMajor(majorId);
  }

  /** POST /admin/majors/:majorId/moderators — body: { user_id } */
  @Post('majors/:majorId/moderators')
  assignModerator(
    @Param('majorId', ParseUUIDPipe) majorId: string,
    @Body('user_id', ParseUUIDPipe) userId: string,
  ) {
    return this.moderation.assign(userId, majorId);
  }

  /** DELETE /admin/majors/:majorId/moderators/:userId */
  @Delete('majors/:majorId/moderators/:userId')
  removeModerator(
    @Param('majorId', ParseUUIDPipe) majorId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.moderation.unassign(userId, majorId);
  }

  /**
   * GET /admin/majors/without-moderator — departments nobody reviews yet.
   * Not an error state (admins can still review them), a prompt for the
   * dashboard.
   */
  @Get('majors/without-moderator')
  majorsWithoutModerator() {
    return this.moderation.majorsWithoutModerator();
  }

  /** GET /admin/documents?search=&doc_type=&major_id=&uploader_id=&since= */
  @Get('documents')
  getAllDocuments(
    @Query('search') search?: string,
    @Query('doc_type') docType?: string,
    @Query('major_id') majorId?: string,
    @Query('uploader_id') uploaderId?: string,
    @Query('since') since?: string,
  ) {
    return this.adminService.getAllDocuments({
      search,
      docType,
      majorId,
      uploaderId,
      since,
    });
  }

  /** DELETE /admin/documents/:id */
  @Delete('documents/:id')
  deleteDocument(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.deleteDocument(id);
  }
}
