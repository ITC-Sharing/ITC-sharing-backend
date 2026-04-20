import {
  Injectable,
  InternalServerErrorException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { CreateSubjectDto } from './dto/create-course.dto';

@Injectable()
export class SubjectsService {
  constructor(private readonly supabaseService: SupabaseService) {}

  async findByMajor(majorId: string, yearLevel?: number) {
    let req = this.supabaseService
      .getClient()
      .from('subjects')
      .select('id, name, semester, year_level')
      .eq('major_id', majorId)
      .order('semester');

    if (yearLevel) req = req.eq('year_level', yearLevel); // ← add this

    const { data, error } = await req;
    if (error)
      throw new InternalServerErrorException('Failed to fetch subjects');
    return data;
  }

  async create(dto: CreateSubjectDto) {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('subjects')
      .insert({
        major_id: dto.major_id,
        name: dto.name.trim(),
        year_level: dto.year_level,
        semester: dto.semester,
      })
      .select('id, name, year_level, semester, major_id')
      .single();

    if (error) {
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
