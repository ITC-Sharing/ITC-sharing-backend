import {
  Injectable,
  InternalServerErrorException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { CreateSubjectDto } from './dto/create-subject.dto';

const SUBJECTS_STORAGE_BUCKET = 'subject-images';

@Injectable()
export class SubjectsService {
  constructor(private readonly supabaseService: SupabaseService) {}

  async findByMajor(majorId: string, yearLevel?: number) {
    let req = this.supabaseService
      .getClient()
      .from('subjects')
      .select('id, name, semester, year_level, subject_url')
      .eq('major_id', majorId)
      .order('semester')
      .order('subject_url', { ascending: true, nullsFirst: false }); // subjects with URLs first

    if (yearLevel) req = req.eq('year_level', yearLevel); // ← add this

    const { data, error } = await req;
    if (error)
      throw new InternalServerErrorException('Failed to fetch subjects');
    return data;
  }

  async create(dto: CreateSubjectDto, image?: Express.Multer.File) {
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

    const finalSubjectUrl = uploadedImageUrl ?? subjectUrl ?? null;

    const { data, error } = await client
      .from('subjects')
      .insert({
        major_id: dto.major_id,
        name: dto.name.trim(),
        year_level: dto.year_level,
        semester: dto.semester,
        subject_url: finalSubjectUrl,
      })
      .select('id, name, year_level, semester, major_id, subject_url')
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
}
