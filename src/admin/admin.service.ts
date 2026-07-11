import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class AdminService {
  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly notificationsService: NotificationsService,
  ) {}

  // ─── Stats ─────────────────────────────────────────────────────────────────

  async getStats() {
    const client = this.supabaseService.getClient();

    const [usersCount, uploadsCount] = await Promise.all([
      client.from('users').select('id', { count: 'exact', head: true }),
      client.from('uploads').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    ]);

    return {
      totalUsers:      usersCount.count  ?? 0,
      totalDocuments:  uploadsCount.count ?? 0,
    };
  }

  // ─── Recent uploads ────────────────────────────────────────────────────────

  async getRecentDocuments(limit = 10) {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('uploads')
      .select(
        `id, title, doc_type, uploaded_at,
         users    ( id, first_name, last_name ),
         majors   ( id, acronym ),
         subjects ( id, name ),
         documents ( file_size_kb )`,
      )
      .eq('status', 'active')
      .order('uploaded_at', { ascending: false })
      .limit(limit);

    if (error) throw new InternalServerErrorException('Failed to fetch recent documents');
    return data;
  }

  // ─── Users ─────────────────────────────────────────────────────────────────

  async getAllUsers(search?: string) {
    let req = this.supabaseService
      .getClient()
      .from('users')
      .select('id, first_name, last_name, email, role, year_level, created_at, majors ( id, acronym )')
      .order('created_at', { ascending: false });

    if (search) {
      req = req.or(
        `first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%`,
      );
    }

    const { data, error } = await req;
    if (error) throw new InternalServerErrorException('Failed to fetch users');
    return data;
  }

  // ─── All documents (admin table view) ─────────────────────────────────────

  async getAllDocuments(search?: string, docType?: string) {
    let req = this.supabaseService
      .getClient()
      .from('uploads')
      .select(
        `id, title, doc_type, uploaded_at,
         users    ( id, first_name, last_name ),
         majors   ( id, acronym ),
         subjects ( id, name ),
         document_tags ( tag ),
         documents ( id, file_url, original_name, file_size_kb )`,
      )
      .eq('status', 'active')
      .order('uploaded_at', { ascending: false });

    if (search)  req = req.ilike('title', `%${search}%`);
    if (docType) req = req.eq('doc_type', docType);

    const { data, error } = await req;
    if (error) throw new InternalServerErrorException('Failed to fetch documents');
    return data;
  }

  // ─── Subjects ──────────────────────────────────────────────────────────────

  async getPendingSubjects() {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('subjects')
      .select('id, name, slug, year_level, semester, subject_url, majors ( id, acronym ), users ( id, first_name, last_name )')
      .eq('status', 'pending')
      .order('id', { ascending: false });

    if (error) throw new InternalServerErrorException('Failed to fetch pending subjects');
    return data;
  }

  async approveSubject(id: string) {
    const client = this.supabaseService.getClient();

    const { data: subject } = await client
      .from('subjects')
      .select('name, submitted_by')
      .eq('id', id)
      .single();

    const { error } = await client.from('subjects').update({ status: 'active' }).eq('id', id);
    if (error) throw new InternalServerErrorException('Failed to approve subject');

    if (subject?.submitted_by) {
      void this.notificationsService.create({
        user_id:  subject.submitted_by,
        type:     'subject_approved',
        message:  `Your subject "${subject.name}" has been approved.`,
        ref_id:   id,
        ref_type: 'subject',
      });
    }

    return { message: 'Subject approved' };
  }

  async rejectSubject(id: string, reason?: string) {
    const client = this.supabaseService.getClient();

    const { data: subject } = await client
      .from('subjects')
      .select('name, submitted_by, subject_url')
      .eq('id', id)
      .single();

    const imagePath = this.extractStoragePath(subject?.subject_url ?? null, 'subject-images');
    if (imagePath) await client.storage.from('subject-images').remove([imagePath]);

    const { error } = await client.from('subjects').update({
      status:           'rejected',
      rejection_reason: reason ?? null,
      rejected_at:      new Date().toISOString(),
    }).eq('id', id);
    if (error) throw new InternalServerErrorException('Failed to reject subject');

    if (subject?.submitted_by) {
      void this.notificationsService.create({
        user_id:  subject.submitted_by,
        type:     'subject_rejected',
        message:  reason
          ? `Your subject "${subject.name}" was not approved: ${reason}`
          : `Your subject "${subject.name}" was not approved.`,
        ref_id:   id,
        ref_type: 'subject',
      });
    }

    return { message: 'Subject rejected' };
  }

  async getAllSubjects(search?: string) {
    let req = this.supabaseService
      .getClient()
      .from('subjects')
      .select('id, name, slug, year_level, semester, subject_url, status, majors ( id, acronym ), users ( id, first_name, last_name )')
      .order('status')
      .order('id', { ascending: false });

    if (search) req = req.ilike('name', `%${search}%`);

    const { data, error } = await req;
    if (error) throw new InternalServerErrorException('Failed to fetch subjects');
    return data;
  }

  async editSubject(
    id: string,
    dto: { name?: string; slug?: string; semester?: number },
  ) {
    const updates: Record<string, any> = {};
    if (dto.name?.trim())        updates.name     = dto.name.trim();
    if (dto.slug?.trim())        updates.slug     = dto.slug.trim();
    if (dto.semester !== undefined) updates.semester = dto.semester;

    const { error } = await this.supabaseService
      .getClient()
      .from('subjects')
      .update(updates)
      .eq('id', id);

    if (error) throw new InternalServerErrorException('Failed to update subject');
    return { message: 'Subject updated' };
  }

  async removeSubject(id: string) {
    const { error } = await this.supabaseService
      .getClient()
      .from('subjects')
      .delete()
      .eq('id', id);

    if (error) throw new InternalServerErrorException('Failed to delete subject');
    return { message: 'Subject deleted' };
  }

  // ─── Pending documents ─────────────────────────────────────────────────────

  async getPendingDocuments() {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('uploads')
      .select(
        `id, title, doc_type, uploaded_at,
         users    ( id, first_name, last_name ),
         majors   ( id, acronym ),
         subjects ( id, name ),
         documents ( id, file_url, file_size_kb )`,
      )
      .eq('status', 'pending')
      .order('uploaded_at', { ascending: false });

    if (error) throw new InternalServerErrorException('Failed to fetch pending documents');

    // Flatten to match existing frontend shape: one row per file with group_id = upload id
    return (data ?? []).flatMap((upload) => {
      const { documents, ...meta } = upload as any;
      return (documents ?? []).map((doc: any) => ({
        ...doc,
        group_id:    meta.id,
        title:       meta.title,
        doc_type:    meta.doc_type,
        uploaded_at: meta.uploaded_at,
        users:       meta.users,
        majors:      meta.majors,
        subjects:    meta.subjects,
      }));
    });
  }

  // ─── Document group (review page) ──────────────────────────────────────────

  async getDocumentsByGroup(uploadId: string) {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('uploads')
      .select(
        `id, title, doc_type, uploaded_at, status,
         users    ( id, first_name, last_name ),
         majors   ( id, acronym ),
         subjects ( id, name ),
         documents ( id, file_url, file_size_kb, original_name )`,
      )
      .eq('id', uploadId)
      .single();

    if (error || !data) throw new NotFoundException('Upload not found');

    // Return files array with upload metadata attached to each, matching old shape
    const { documents, ...meta } = data as any;
    return (documents ?? []).map((doc: any) => ({
      ...doc,
      group_id:    meta.id,
      title:       meta.title,
      doc_type:    meta.doc_type,
      status:      meta.status,
      uploaded_at: meta.uploaded_at,
      users:       meta.users,
      majors:      meta.majors,
      subjects:    meta.subjects,
    }));
  }

  // ─── Approve / reject upload group ────────────────────────────────────────

  async approveDocumentGroup(uploadId: string) {
    const client = this.supabaseService.getClient();

    const { data: upload } = await client
      .from('uploads')
      .select('id, title, uploader_id')
      .eq('id', uploadId)
      .eq('status', 'pending')
      .single();

    if (!upload) return { message: 'No pending upload found' };

    const { error } = await client
      .from('uploads')
      .update({ status: 'active' })
      .eq('id', uploadId);

    if (error) throw new InternalServerErrorException('Failed to approve upload');

    const { data: files } = await client
      .from('documents')
      .select('id')
      .eq('upload_id', uploadId);

    const fileCount = files?.length ?? 1;

    if (upload.uploader_id) {
      void this.notificationsService.create({
        user_id:  upload.uploader_id,
        type:     'document_approved',
        message:  fileCount === 1
          ? `Your document "${upload.title}" has been approved.`
          : `Your ${fileCount} uploaded documents have been approved.`,
        ref_id:   uploadId,
        ref_type: 'document',
      });
    }

    return { message: 'Documents approved' };
  }

  async rejectDocumentGroup(uploadId: string, reason?: string) {
    const client = this.supabaseService.getClient();

    const { data: upload } = await client
      .from('uploads')
      .select('id, title, uploader_id')
      .eq('id', uploadId)
      .eq('status', 'pending')
      .single();

    if (!upload) return { message: 'No pending upload found' };

    // Delete all files from storage
    const { data: files } = await client
      .from('documents')
      .select('file_url')
      .eq('upload_id', uploadId);

    if (files?.length) {
      const paths = files
        .map((f) => this.extractStoragePath(f.file_url, 'documents'))
        .filter((p): p is string => p !== null);
      if (paths.length) await client.storage.from('documents').remove(paths);
    }

    const { error } = await client
      .from('uploads')
      .update({
        status:           'rejected',
        rejection_reason: reason ?? null,
        rejected_at:      new Date().toISOString(),
      })
      .eq('id', uploadId);

    if (error) throw new InternalServerErrorException('Failed to reject upload');

    const fileCount = files?.length ?? 1;

    if (upload.uploader_id) {
      void this.notificationsService.create({
        user_id:  upload.uploader_id,
        type:     'document_rejected',
        message:  reason
          ? `Your uploaded document${fileCount > 1 ? 's were' : ' was'} not approved: ${reason}`
          : `Your uploaded document${fileCount > 1 ? 's were' : ' was'} not approved.`,
        ref_id:   uploadId,
        ref_type: 'document',
      });
    }

    return { message: 'Documents rejected' };
  }

  // ─── Admin delete upload ───────────────────────────────────────────────────

  async deleteDocument(uploadId: string) {
    const client = this.supabaseService.getClient();

    const { data: upload } = await client
      .from('uploads')
      .select('id')
      .eq('id', uploadId)
      .single();

    if (!upload) throw new NotFoundException('Upload not found');

    const { data: files } = await client
      .from('documents')
      .select('file_url')
      .eq('upload_id', uploadId);

    if (files?.length) {
      const paths = files
        .map((f) => this.extractStoragePath(f.file_url, 'documents'))
        .filter((p): p is string => p !== null);
      if (paths.length) await client.storage.from('documents').remove(paths);
    }

    // CASCADE removes documents + document_tags
    const { error } = await client.from('uploads').delete().eq('id', uploadId);
    if (error) throw new InternalServerErrorException('Failed to delete upload');

    return { message: 'Upload deleted' };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private extractStoragePath(fileUrl: string | null, bucket: string): string | null {
    if (!fileUrl) return null;
    const marker = `/storage/v1/object/public/${bucket}/`;
    const index = fileUrl.indexOf(marker);
    if (index === -1) return null;
    return fileUrl.slice(index + marker.length);
  }
}
