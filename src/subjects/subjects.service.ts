import {
  Injectable,
  InternalServerErrorException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { CreateSubjectDto } from './dto/create-subject.dto';
import { UpdateSubjectDto } from './dto/update-subject.dto';

const SUBJECTS_STORAGE_BUCKET = 'subject-images';
const DEFAULT_SUBJECT_IMAGE_URL =
  'https://unyfbtktbxbulxemmoga.supabase.co/storage/v1/object/public/subject-images/d0479768-e6d2-4460-8cca-889cf560ab6a/no-image.png';

@Injectable()
export class SubjectsService {
  constructor(private readonly supabaseService: SupabaseService) {}

  async countsByMajor(majorId: string): Promise<Record<number, number>> {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('subjects')
      .select('year_level')
      .eq('major_id', majorId)
      .eq('status', 'active');

    if (error)
      throw new InternalServerErrorException('Failed to fetch subject counts');

    const counts: Record<number, number> = {};
    for (const row of data ?? []) {
      const year = Number(row.year_level);
      if (Number.isInteger(year) && year >= 1) {
        counts[year] = (counts[year] ?? 0) + 1;
      }
    }
    return counts;
  }

  async findByMajor(
    majorId: string,
    yearLevel?: number,
    semester?: number,
    search?: string,
  ) {
    let req = this.supabaseService
      .getClient()
      .from('subjects')
      .select('id, name, slug, semester, year_level, subject_url')
      .eq('major_id', majorId)
      .eq('status', 'active')
      .order('semester')
      .order('subject_url', { ascending: true, nullsFirst: false });

    if (yearLevel && yearLevel > 0) req = req.eq('year_level', yearLevel);
    if (semester === 1 || semester === 2) req = req.eq('semester', semester);
    if (search?.trim()) req = req.ilike('name', `%${search.trim()}%`);

    const { data, error } = await req;
    if (error)
      throw new InternalServerErrorException('Failed to fetch subjects');
    return data;
  }

  async create(
    dto: CreateSubjectDto,
    image?: Express.Multer.File,
    submittedBy?: string,
  ) {
    const client = this.supabaseService.getClient();
    const subjectUrl = dto.subject_url?.trim();

    let uploadedImageUrl: string | null = null;
    let uploadedStoragePath: string | null = null;

    if (image) {
      const ext = image.originalname.split('.').pop() ?? 'bin';
      uploadedStoragePath = `${dto.major_id}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

      const { error: storageError } = await client.storage
        .from(SUBJECTS_STORAGE_BUCKET)
        .upload(uploadedStoragePath, image.buffer, {
          contentType: image.mimetype,
          upsert: false,
        });

      if (storageError) {
        if (storageError.statusCode === '404') {
          throw new BadRequestException(
            `Storage bucket "${SUBJECTS_STORAGE_BUCKET}" does not exist`,
          );
        }

        if (storageError.statusCode === '403') {
          throw new ForbiddenException(
            'You are not allowed to upload subject images',
          );
        }

        throw new InternalServerErrorException(
          storageError.message || 'Failed to upload subject image',
        );
      }

      const { data: publicUrlData } = client.storage
        .from(SUBJECTS_STORAGE_BUCKET)
        .getPublicUrl(uploadedStoragePath);
      uploadedImageUrl = publicUrlData.publicUrl;
    }

    const finalSubjectUrl =
      uploadedImageUrl ?? subjectUrl ?? DEFAULT_SUBJECT_IMAGE_URL;

    const { data, error } = await client
      .from('subjects')
      .insert({
        major_id: dto.major_id,
        name: dto.name.trim(),
        slug: dto.slug.trim(),
        year_level: dto.year_level,
        semester: dto.semester,
        subject_url: finalSubjectUrl,
        status: 'pending',
        submitted_by: submittedBy ?? null,
      })
      .select('id, name, slug, year_level, semester, major_id, subject_url')
      .single();

    if (error) {
      if (uploadedStoragePath) {
        await client.storage
          .from(SUBJECTS_STORAGE_BUCKET)
          .remove([uploadedStoragePath]);
      }

      // Supabase surfaces unique constraint violations as code 23505
      if (error.code === '23505') {
        throw new ConflictException(
          'A subject with this name already exists for this major',
        );
      }

      // Foreign key constraint violation (e.g. major_id does not exist)
      if (error.code === '23503') {
        throw new BadRequestException('Invalid major_id');
      }

      // Not-null constraint violation (e.g. missing required column such as code)
      if (error.code === '23502') {
        throw new BadRequestException(
          error.message || 'Missing required field for subject creation',
        );
      }

      // Insufficient privilege / RLS policy blocks insert
      if (error.code === '42501') {
        throw new ForbiddenException('You are not allowed to create subjects');
      }

      throw new BadRequestException(
        error.message || 'Failed to create subject',
      );
    }

    return data;
  }

  async findMine(userId: string) {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('subjects')
      .select(
        'id, name, slug, year_level, semester, subject_url, status, rejection_reason, rejected_at, created_at, majors ( id, acronym )',
      )
      .eq('submitted_by', userId)
      .in('status', ['pending', 'rejected'])
      .order('id', { ascending: false });

    if (error)
      throw new InternalServerErrorException('Failed to fetch your subjects');
    return data;
  }

  async updateOwn(id: string, userId: string, dto: UpdateSubjectDto) {
    const client = this.supabaseService.getClient();

    const { data: existing } = await client
      .from('subjects')
      .select('submitted_by, status')
      .eq('id', id)
      .single();

    if (!existing) throw new NotFoundException('Subject not found');
    if (existing.submitted_by !== userId)
      throw new ForbiddenException('Not your subject');
    if (existing.status === 'active')
      throw new ForbiddenException('Cannot edit an approved subject');

    const updates: Record<string, any> = {};
    if (dto.name !== undefined) updates.name = dto.name.trim();
    if (dto.semester !== undefined) updates.semester = dto.semester;

    if (!Object.keys(updates).length) return existing;

    const { data, error } = await client
      .from('subjects')
      .update(updates)
      .eq('id', id)
      .select('id, name, slug, year_level, semester, subject_url, status')
      .single();

    if (error)
      throw new InternalServerErrorException('Failed to update subject');
    return data;
  }

  async removeOwn(id: string, userId: string) {
    const client = this.supabaseService.getClient();

    const { data: existing } = await client
      .from('subjects')
      .select('submitted_by, status')
      .eq('id', id)
      .single();

    if (!existing) throw new NotFoundException('Subject not found');
    if (existing.submitted_by !== userId)
      throw new ForbiddenException('Not your subject');
    if (existing.status === 'active')
      throw new ForbiddenException('Cannot delete an approved subject');

    const { error } = await client.from('subjects').delete().eq('id', id);
    if (error)
      throw new InternalServerErrorException('Failed to delete subject');
    return { message: 'Subject deleted' };
  }
}
