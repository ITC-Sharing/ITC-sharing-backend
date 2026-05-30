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

  /** PATCH /admin/subjects/:id — edit name / semester */
  @Patch('subjects/:id')
  editSubject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('name') name: string,
    @Body('semester') semester?: number,
  ) {
    return this.adminService.editSubject(id, name, semester);
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
  rejectSubject(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.rejectSubject(id);
  }

  /** GET /admin/pending/documents */
  @Get('pending/documents')
  getPendingDocuments() {
    return this.adminService.getPendingDocuments();
  }

  /** PATCH /admin/documents/:id/approve */
  @Patch('documents/:id/approve')
  approveDocument(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.approveDocument(id);
  }

  /** PATCH /admin/documents/:id/reject */
  @Patch('documents/:id/reject')
  rejectDocument(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.rejectDocument(id);
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
