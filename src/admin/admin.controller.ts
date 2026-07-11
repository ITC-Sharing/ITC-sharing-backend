import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from './guards/admin.guard';
import { AdminService } from './admin.service';
import { EditSubjectDto } from './dto/edit-subject.dto';

@Controller('admin')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

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
  getPendingSubjects() {
    return this.adminService.getPendingSubjects();
  }

  /** GET /admin/subjects?search= */
  @Get('subjects')
  getAllSubjects(@Query('search') search?: string) {
    return this.adminService.getAllSubjects(search);
  }

  /** PATCH /admin/subjects/:id — edit name / slug / semester */
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
  approveSubject(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.approveSubject(id);
  }

  /** PATCH /admin/subjects/:id/reject */
  @Patch('subjects/:id/reject')
  rejectSubject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('reason') reason?: string,
  ) {
    return this.adminService.rejectSubject(id, reason);
  }

  /** GET /admin/pending/documents */
  @Get('pending/documents')
  getPendingDocuments() {
    return this.adminService.getPendingDocuments();
  }

  /** GET /admin/documents/group/:groupId */
  @Get('documents/group/:groupId')
  getDocumentsByGroup(@Param('groupId', ParseUUIDPipe) groupId: string) {
    return this.adminService.getDocumentsByGroup(groupId);
  }

  /** PATCH /admin/documents/group/:groupId/approve */
  @Patch('documents/group/:groupId/approve')
  approveDocumentGroup(@Param('groupId', ParseUUIDPipe) groupId: string) {
    return this.adminService.approveDocumentGroup(groupId);
  }

  /** PATCH /admin/documents/group/:groupId/reject */
  @Patch('documents/group/:groupId/reject')
  rejectDocumentGroup(
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Body('reason') reason?: string,
  ) {
    return this.adminService.rejectDocumentGroup(groupId, reason);
  }

  /** GET /admin/documents?search=&doc_type= */
  @Get('documents')
  getAllDocuments(
    @Query('search') search?: string,
    @Query('doc_type') docType?: string,
  ) {
    return this.adminService.getAllDocuments(search, docType);
  }

  /** DELETE /admin/documents/:id */
  @Delete('documents/:id')
  deleteDocument(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.deleteDocument(id);
  }
}
