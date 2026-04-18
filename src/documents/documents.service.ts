import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { CreateDocumentDto } from './dto/create-document.dto';
import { QueryDocumentsDto } from './dto/query-documents.dto';

const STORAGE_BUCKET = 'documents';

@Injectable()
export class DocumentsService {
  constructor(private readonly supabaseService: SupabaseService) {}

  // ─── Upload ────────────────────────────────────────────────────────────────

  async upload(
    uploaderId: string,
    dto: CreateDocumentDto,
    file: Express.Multer.File,
  ) {
    const client = this.supabaseService.getClient();

    // 1. Build a unique storage path: <major_id>/<uploader_id>/<timestamp>-<filename>
    const ext = file.originalname.split('.').pop();
    const storagePath = `${dto.major_id}/${uploaderId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

    // 2. Upload file buffer to Supabase Storage
    const { error: storageError } = await client.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
      });

    if (storageError) {
      throw new InternalServerErrorException('File upload failed');
    }

    // 3. Get the public URL
    const { data: urlData } = client.storage
      .from(STORAGE_BUCKET)
      .getPublicUrl(storagePath);

    // 4. Insert document row
    const { data: doc, error: dbError } = await client
      .from('documents')
      .insert({
        uploader_id: uploaderId,
        major_id: dto.major_id,
        subject_id: dto.subject_id ?? null,
        title: dto.title.trim(),
        doc_type: dto.doc_type,
        file_url: urlData.publicUrl,
        file_size_kb: Math.round(file.size / 1024),
        status: 'active',
        download_count: 0,
        view_count: 0,
      })
      .select(
        'id, title, doc_type, file_url, file_size_kb, status, uploaded_at',
      )
      .single();

    if (dbError) {
      // Clean up orphaned file if DB insert fails
      await client.storage.from(STORAGE_BUCKET).remove([storagePath]);

      if (dbError.code === '23503') {
        throw new BadRequestException(
          dbError.message || 'Invalid major_id or subject_id',
        );
      }

      if (dbError.code === '23502') {
        throw new BadRequestException(
          dbError.message || 'Missing required document field',
        );
      }

      if (dbError.code === '42501') {
        throw new ForbiddenException('You are not allowed to upload documents');
      }

      throw new InternalServerErrorException(
        dbError.message || 'Failed to save document record',
      );
    }

    const insertedDoc = doc as { id: string } | null;
    if (!insertedDoc?.id) {
      throw new InternalServerErrorException(
        'Document record created without id',
      );
    }

    // 5. Insert tags if provided
    if (dto.tags && dto.tags.length > 0) {
      const tagRows = dto.tags.map((tag) => ({
        document_id: insertedDoc.id,
        tag: tag.toLowerCase().trim(),
      }));

      await client.from('document_tags').insert(tagRows);
    }

    return doc;
  }

  // ─── List ──────────────────────────────────────────────────────────────────

  async findAll(query: QueryDocumentsDto) {
    const client = this.supabaseService.getClient();

    let req = client
      .from('documents')
      .select(
        `
        id, title, doc_type, file_url, file_size_kb,
        download_count, view_count, status, uploaded_at,
        major_id, subject_id,
        users ( id, first_name, last_name, avatar_url ),
        subjects ( id, name ),
        document_tags ( tag )
      `,
      )
      .eq('status', 'active')
      .order('uploaded_at', { ascending: false });

    if (query.major_id) req = req.eq('major_id', query.major_id);
    if (query.subject_id) req = req.eq('subject_id', query.subject_id);
    if (query.doc_type) req = req.eq('doc_type', query.doc_type);
    if (query.search) req = req.ilike('title', `%${query.search}%`);

    const { data, error } = await req;

    if (error)
      throw new InternalServerErrorException('Failed to fetch documents');

    return data;
  }

  // ─── Get one ───────────────────────────────────────────────────────────────

  async findOne(id: string) {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('documents')
      .select(
        `
        id, title, doc_type, file_url, file_size_kb,
        download_count, view_count, status, uploaded_at,
        major_id, subject_id,
        users ( id, first_name, last_name, avatar_url ),
        subjects ( id, name ),
        document_tags ( tag )
      `,
      )
      .eq('id', id)
      .eq('status', 'active')
      .single();

    if (error || !data) throw new NotFoundException('Document not found');

    return data;
  }

  // ─── Track view ────────────────────────────────────────────────────────────

  async incrementView(id: string) {
    const client = this.supabaseService.getClient();

    const { data: doc } = await client
      .from('documents')
      .select('view_count')
      .eq('id', id)
      .single();

    if (!doc) throw new NotFoundException('Document not found');

    await client
      .from('documents')
      .update({ view_count: doc.view_count + 1 })
      .eq('id', id);
  }

  // ─── Track download ────────────────────────────────────────────────────────

  async incrementDownload(id: string) {
    const client = this.supabaseService.getClient();

    const { data: doc } = await client
      .from('documents')
      .select('download_count')
      .eq('id', id)
      .single();

    if (!doc) throw new NotFoundException('Document not found');

    await client
      .from('documents')
      .update({ download_count: doc.download_count + 1 })
      .eq('id', id);
  }

  // ─── Delete ────────────────────────────────────────────────────────────────

  async delete(id: string, userId: string) {
    const client = this.supabaseService.getClient();

    const { data: doc } = await client
      .from('documents')
      .select('id, uploader_id, file_url')
      .eq('id', id)
      .single();

    if (!doc) throw new NotFoundException('Document not found');
    if (doc.uploader_id !== userId)
      throw new ForbiddenException('Not your document');

    // Soft delete — keeps the row, just hides it from queries
    await client.from('documents').update({ status: 'deleted' }).eq('id', id);

    return { message: 'Document deleted' };
  }

  // ─── Save / unsave ─────────────────────────────────────────────────────────

  async save(userId: string, documentId: string) {
    const client = this.supabaseService.getClient();

    // Verify document exists
    const { data: doc } = await client
      .from('documents')
      .select('id')
      .eq('id', documentId)
      .eq('status', 'active')
      .single();

    if (!doc) throw new NotFoundException('Document not found');

    const { error } = await client
      .from('document_saves')
      .insert({ user_id: userId, document_id: documentId });

    if (error?.code === '23505') {
      throw new BadRequestException('Document already saved');
    }
    if (error)
      throw new InternalServerErrorException('Failed to save document');

    return { message: 'Document saved' };
  }

  async unsave(userId: string, documentId: string) {
    await this.supabaseService
      .getClient()
      .from('document_saves')
      .delete()
      .eq('user_id', userId)
      .eq('document_id', documentId);

    return { message: 'Document unsaved' };
  }

  async getSaved(userId: string) {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('document_saves')
      .select(
        `
        saved_at,
        documents (
          id, title, doc_type, file_url, file_size_kb,
          download_count, view_count, uploaded_at,
          users ( id, first_name, last_name ),
          subjects ( id, name ),
          document_tags ( tag )
        )
      `,
      )
      .eq('user_id', userId)
      .order('saved_at', { ascending: false });

    if (error)
      throw new InternalServerErrorException('Failed to fetch saved documents');

    return data;
  }
}
