import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { CreateDocumentDto } from './dto/create-document.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { QueryDocumentsDto } from './dto/query-documents.dto';

const STORAGE_BUCKET = 'documents';

@Injectable()
export class DocumentsService {
  constructor(private readonly supabaseService: SupabaseService) {}

  // ─── Upload ────────────────────────────────────────────────────────────────

  async uploadMany(
    uploaderId: string,
    dto: CreateDocumentDto,
    files: Express.Multer.File[],
  ) {
    if (!files?.length) throw new BadRequestException('No files provided');

    const client = this.supabaseService.getClient();
    const title = this.resolveTitle(dto.title, files[0].originalname);

    // 1. One uploads row for the entire batch
    const { data: upload, error: uploadError } = await client
      .from('uploads')
      .insert({
        uploader_id: uploaderId,
        major_id: dto.major_id,
        subject_id: dto.subject_id ?? null,
        title,
        doc_type: dto.doc_type,
        year_level: dto.year_level,
        academic_year: dto.academic_year ?? null,
        status: 'pending',
      })
      .select('id')
      .single();

    if (uploadError || !upload) {
      if (uploadError?.code === '23503')
        throw new BadRequestException('Invalid major_id or subject_id');
      throw new InternalServerErrorException('Failed to create upload record');
    }

    // 2. One documents row per file
    const fileResults: any[] = [];
    for (const file of files) {
      const doc = await this.uploadFile(
        upload.id,
        uploaderId,
        dto.major_id,
        file,
      );
      fileResults.push(doc);
    }

    // 3. Tags reference upload_id
    if (dto.tags?.length) {
      const tagRows = dto.tags.map((tag) => ({
        upload_id: upload.id,
        tag: tag.toLowerCase().trim(),
      }));
      await client.from('document_tags').insert(tagRows);
    }

    return { upload_id: upload.id, files: fileResults };
  }

  private async uploadFile(
    uploadId: string,
    uploaderId: string,
    majorId: string,
    file: Express.Multer.File,
  ) {
    const client = this.supabaseService.getClient();
    const ext = file.originalname.split('.').pop();
    const storagePath = `${majorId}/${uploaderId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

    const { error: storageError } = await client.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
      });

    if (storageError)
      throw new InternalServerErrorException('File upload failed');

    const { data: urlData } = client.storage
      .from(STORAGE_BUCKET)
      .getPublicUrl(storagePath);

    const { data: doc, error: dbError } = await client
      .from('documents')
      .insert({
        upload_id: uploadId,
        file_url: urlData.publicUrl,
        original_name: file.originalname,
        file_size_kb: Math.round(file.size / 1024),
        download_count: 0,
        view_count: 0,
      })
      .select('id, upload_id, file_url, original_name, file_size_kb')
      .single();

    if (dbError) {
      await client.storage.from(STORAGE_BUCKET).remove([storagePath]);
      throw new InternalServerErrorException('Failed to save document record');
    }

    return doc!;
  }

  private resolveTitle(title: string | undefined, originalName: string) {
    const trimmed = title?.trim();
    if (trimmed) return trimmed;
    return originalName.replace(/\.[^.]+$/, '');
  }

  // ─── List ──────────────────────────────────────────────────────────────────

  async findAll(query: QueryDocumentsDto) {
    const client = this.supabaseService.getClient();

    let req = client
      .from('uploads')
      .select(
        `id, title, doc_type, year_level, academic_year, uploaded_at,
         users ( id, first_name, last_name, avatar_url ),
         majors ( id, acronym ),
         subjects ( id, name, slug ),
         document_tags ( tag ),
         documents ( id, file_url, file_size_kb, download_count, view_count, original_name )`,
        { count: 'exact' },
      )
      .eq('status', 'active')
      .order('uploaded_at', { ascending: false });

    if (query.major_id) req = req.eq('major_id', query.major_id);
    if (query.subject_id) req = req.eq('subject_id', query.subject_id);
    if (query.doc_type) req = req.eq('doc_type', query.doc_type);
    if (query.year_level) req = req.eq('year_level', query.year_level);
    if (query.academic_year) req = req.eq('academic_year', query.academic_year);
    if (query.search) req = req.ilike('title', `%${query.search}%`);
    if (query.uploader_id) req = req.eq('uploader_id', query.uploader_id);

    // Optional pagination — only applied when a limit is requested.
    if (query.limit) {
      const page = query.page && query.page > 0 ? query.page : 1;
      const from = (page - 1) * query.limit;
      req = req.range(from, from + query.limit - 1);
    }

    const { data, count, error } = await req;
    if (error)
      throw new InternalServerErrorException('Failed to fetch documents');
    return { items: data ?? [], total: count ?? data?.length ?? 0 };
  }

  // ─── Get one ───────────────────────────────────────────────────────────────

  async findOne(uploadId: string) {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('uploads')
      .select(
        `id, title, doc_type, year_level, academic_year, uploaded_at,
         users ( id, first_name, last_name, avatar_url ),
         majors ( id, acronym ),
         subjects ( id, name, slug ),
         document_tags ( tag ),
         documents ( id, file_url, file_size_kb, download_count, view_count, original_name )`,
      )
      .eq('id', uploadId)
      .eq('status', 'active')
      .single();

    if (error || !data) throw new NotFoundException('Document not found');
    return data;
  }

  // ─── Track view (per file) ─────────────────────────────────────────────────

  async incrementView(documentId: string) {
    const client = this.supabaseService.getClient();
    const { data: doc } = await client
      .from('documents')
      .select('view_count')
      .eq('id', documentId)
      .single();

    if (!doc) return;
    await client
      .from('documents')
      .update({ view_count: doc.view_count + 1 })
      .eq('id', documentId);
  }

  // ─── Track download (per file) ─────────────────────────────────────────────

  async incrementDownload(documentId: string) {
    const client = this.supabaseService.getClient();
    const { data: doc } = await client
      .from('documents')
      .select('download_count')
      .eq('id', documentId)
      .single();

    if (!doc) throw new NotFoundException('Document not found');
    await client
      .from('documents')
      .update({ download_count: doc.download_count + 1 })
      .eq('id', documentId);
  }

  // ─── Delete (uploader only) ────────────────────────────────────────────────

  // ─── Update own upload (metadata only) ──────────────────────────────────────

  async update(uploadId: string, userId: string, dto: UpdateDocumentDto) {
    const client = this.supabaseService.getClient();

    const { data: upload } = await client
      .from('uploads')
      .select('id, uploader_id, status')
      .eq('id', uploadId)
      .single();

    if (!upload) throw new NotFoundException('Upload not found');
    if (upload.uploader_id !== userId)
      throw new ForbiddenException('Not your upload');

    // Build the patch — only fields that were sent.
    const patch: Record<string, any> = {};
    if (dto.title !== undefined) patch.title = dto.title;
    if (dto.doc_type !== undefined) patch.doc_type = dto.doc_type;
    if (dto.major_id !== undefined) patch.major_id = dto.major_id;
    if (dto.subject_id !== undefined) patch.subject_id = dto.subject_id ?? null;
    if (dto.year_level !== undefined) patch.year_level = dto.year_level;
    if (dto.academic_year !== undefined)
      patch.academic_year = dto.academic_year ?? null;

    // Editing sends the upload back for review.
    if (upload.status !== 'active') {
      patch.status = 'pending';
      patch.rejection_reason = null;
    }

    if (Object.keys(patch).length) {
      const { error } = await client
        .from('uploads')
        .update(patch)
        .eq('id', uploadId);
      if (error) {
        if (error.code === '23503')
          throw new BadRequestException('Invalid major_id or subject_id');
        throw new InternalServerErrorException('Failed to update upload');
      }
    }

    // Replace tags wholesale when provided.
    if (dto.tags !== undefined) {
      await client.from('document_tags').delete().eq('upload_id', uploadId);
      if (dto.tags.length) {
        await client.from('document_tags').insert(
          dto.tags.map((tag: string) => ({
            upload_id: uploadId,
            tag: tag.toLowerCase().trim(),
          })),
        );
      }
    }

    return { message: 'Upload updated' };
  }

  /** Add files to an existing upload (uploader only). */
  async addFiles(
    uploadId: string,
    userId: string,
    files: Express.Multer.File[],
  ) {
    if (!files?.length) throw new BadRequestException('No files provided');
    const client = this.supabaseService.getClient();

    const { data: upload } = await client
      .from('uploads')
      .select('id, uploader_id, major_id, status')
      .eq('id', uploadId)
      .single();

    if (!upload) throw new NotFoundException('Upload not found');
    if (upload.uploader_id !== userId)
      throw new ForbiddenException('Not your upload');

    const results: any[] = [];
    for (const file of files) {
      results.push(
        await this.uploadFile(uploadId, userId, upload.major_id, file),
      );
    }

    // Editing sends the upload back for review.
    if (upload.status !== 'active') {
      await client
        .from('uploads')
        .update({ status: 'pending', rejection_reason: null })
        .eq('id', uploadId);
    }

    return { files: results };
  }

  /** Remove one file from an upload (uploader only). An upload must keep ≥1 file. */
  async removeFile(fileId: string, userId: string) {
    const client = this.supabaseService.getClient();

    const { data: file } = await client
      .from('documents')
      .select('id, file_url, upload_id')
      .eq('id', fileId)
      .single();

    if (!file) throw new NotFoundException('File not found');

    const { data: upload } = await client
      .from('uploads')
      .select('id, uploader_id')
      .eq('id', file.upload_id)
      .single();

    if (!upload) throw new NotFoundException('Upload not found');
    if (upload.uploader_id !== userId)
      throw new ForbiddenException('Not your upload');

    const { count } = await client
      .from('documents')
      .select('id', { count: 'exact', head: true })
      .eq('upload_id', file.upload_id);

    if ((count ?? 0) <= 1)
      throw new BadRequestException('An upload must keep at least one file');

    const path = this.extractStoragePath(file.file_url);
    if (path) await client.storage.from(STORAGE_BUCKET).remove([path]);

    const { error } = await client.from('documents').delete().eq('id', fileId);
    if (error) throw new InternalServerErrorException('Failed to remove file');

    return { message: 'File removed' };
  }

  async delete(uploadId: string, userId: string) {
    const client = this.supabaseService.getClient();

    const { data: upload } = await client
      .from('uploads')
      .select('id, uploader_id')
      .eq('id', uploadId)
      .single();

    if (!upload) throw new NotFoundException('Upload not found');
    if (upload.uploader_id !== userId)
      throw new ForbiddenException('Not your upload');

    const { data: files } = await client
      .from('documents')
      .select('file_url')
      .eq('upload_id', uploadId);

    if (files?.length) {
      const paths = files
        .map((f) => this.extractStoragePath(f.file_url))
        .filter((p): p is string => p !== null);
      if (paths.length) await client.storage.from(STORAGE_BUCKET).remove(paths);
    }

    // CASCADE deletes documents + document_tags
    const { error } = await client.from('uploads').delete().eq('id', uploadId);
    if (error)
      throw new InternalServerErrorException('Failed to delete upload');

    return { message: 'Upload deleted' };
  }

  private extractStoragePath(fileUrl: string | null): string | null {
    if (!fileUrl) return null;
    const marker = `/storage/v1/object/public/${STORAGE_BUCKET}/`;
    const index = fileUrl.indexOf(marker);
    if (index === -1) return null;
    return fileUrl.slice(index + marker.length);
  }

  // ─── My uploads (pending / rejected) ──────────────────────────────────────

  async findMine(userId: string) {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('uploads')
      .select(
        `id, title, doc_type, year_level, academic_year, status, rejection_reason, rejected_at, uploaded_at,
         subjects ( id, name ),
         majors ( id, acronym ),
         document_tags ( tag ),
         documents ( id, original_name, file_size_kb )`,
      )
      .eq('uploader_id', userId)
      .in('status', ['pending', 'rejected'])
      .order('uploaded_at', { ascending: false });

    if (error)
      throw new InternalServerErrorException('Failed to fetch your documents');
    return data;
  }
}
