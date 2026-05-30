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

  async getStats() {
    const client = this.supabaseService.getClient();

    const [usersCount, docsResult] = await Promise.all([
      client.from('users').select('id', { count: 'exact', head: true }),
      client
        .from('documents')
        .select('download_count, view_count', { count: 'exact' })
        .eq('status', 'active'),
    ]);

    const docs = docsResult.data ?? [];
    const totalDownloads = docs.reduce(
      (sum, d) => sum + (d.download_count ?? 0),
      0,
    );
    const totalViews = docs.reduce((sum, d) => sum + (d.view_count ?? 0), 0);

    return {
      totalUsers: usersCount.count ?? 0,
      totalDocuments: docsResult.count ?? 0,
      totalDownloads,
      totalViews,
    };
  }

  async getRecentDocuments(limit = 10) {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('documents')
      .select(
        `id, title, doc_type, file_size_kb, download_count, uploaded_at,
         users ( id, first_name, last_name ),
         majors ( id, acronym ),
         subjects ( id, name )`,
      )
      .eq('status', 'active')
      .order('uploaded_at', { ascending: false })
      .limit(limit);

    if (error) throw new InternalServerErrorException('Failed to fetch recent documents');
    return data;
  }

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

  async getAllDocuments(search?: string, docType?: string) {
    let req = this.supabaseService
      .getClient()
      .from('documents')
      .select(
        `id, title, doc_type, file_size_kb, download_count, view_count, uploaded_at,
         users ( id, first_name, last_name ),
         majors ( id, acronym ),
         subjects ( id, name ),
         document_tags ( tag )`,
      )
      .eq('status', 'active')
      .order('uploaded_at', { ascending: false });

    if (search) req = req.ilike('title', `%${search}%`);
    if (docType) req = req.eq('doc_type', docType);

    const { data, error } = await req;
    if (error) throw new InternalServerErrorException('Failed to fetch documents');
    return data;
  }

  // ─── Approvals ─────────────────────────────────────────────────────────────

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
        user_id: subject.submitted_by,
        type: 'subject_approved',
        message: `Your subject "${subject.name}" has been approved.`,
        ref_id: id,
        ref_type: 'subject',
      });
    }

    return { message: 'Subject approved' };
  }

  async rejectSubject(id: string) {
    const client = this.supabaseService.getClient();

    const { data: subject } = await client
      .from('subjects')
      .select('name, submitted_by')
      .eq('id', id)
      .single();

    const { error } = await client.from('subjects').update({ status: 'rejected' }).eq('id', id);
    if (error) throw new InternalServerErrorException('Failed to reject subject');

    if (subject?.submitted_by) {
      void this.notificationsService.create({
        user_id: subject.submitted_by,
        type: 'subject_rejected',
        message: `Your subject "${subject.name}" was not approved.`,
        ref_id: id,
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

  async editSubject(id: string, name: string, semester?: number) {
    const updates: Record<string, any> = {};
    if (name?.trim()) updates.name = name.trim();
    if (semester !== undefined) updates.semester = semester;

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

  async getPendingDocuments() {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('documents')
      .select(
        `id, title, doc_type, file_size_kb, uploaded_at,
         users ( id, first_name, last_name ),
         majors ( id, acronym ),
         subjects ( id, name )`,
      )
      .eq('status', 'pending')
      .order('uploaded_at', { ascending: false });

    if (error) throw new InternalServerErrorException('Failed to fetch pending documents');
    return data;
  }

  async approveDocument(id: string) {
    const client = this.supabaseService.getClient();

    const { data: doc } = await client
      .from('documents')
      .select('title, uploader_id')
      .eq('id', id)
      .single();

    const { error } = await client.from('documents').update({ status: 'active' }).eq('id', id);
    if (error) throw new InternalServerErrorException('Failed to approve document');

    if (doc?.uploader_id) {
      void this.notificationsService.create({
        user_id: doc.uploader_id,
        type: 'document_approved',
        message: `Your document "${doc.title}" has been approved.`,
        ref_id: id,
        ref_type: 'document',
      });
    }

    return { message: 'Document approved' };
  }

  async rejectDocument(id: string) {
    const client = this.supabaseService.getClient();

    const { data: doc } = await client
      .from('documents')
      .select('title, uploader_id')
      .eq('id', id)
      .single();

    const { error } = await client.from('documents').update({ status: 'rejected' }).eq('id', id);
    if (error) throw new InternalServerErrorException('Failed to reject document');

    if (doc?.uploader_id) {
      void this.notificationsService.create({
        user_id: doc.uploader_id,
        type: 'document_rejected',
        message: `Your document "${doc.title}" was not approved.`,
        ref_id: id,
        ref_type: 'document',
      });
    }

    return { message: 'Document rejected' };
  }

  async deleteDocument(documentId: string) {
    const client = this.supabaseService.getClient();

    const { data: doc } = await client
      .from('documents')
      .select('id')
      .eq('id', documentId)
      .single();

    if (!doc) throw new NotFoundException('Document not found');

    await client.from('document_tags').delete().eq('document_id', documentId);
    await client.from('document_saves').delete().eq('document_id', documentId);

    const { error } = await client.from('documents').delete().eq('id', documentId);
    if (error) throw new InternalServerErrorException('Failed to delete document');

    return { message: 'Document deleted' };
  }
}
