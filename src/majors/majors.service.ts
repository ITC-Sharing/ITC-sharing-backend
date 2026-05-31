import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class MajorsService {
  constructor(private readonly supabaseService: SupabaseService) {}

  async findAll() {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('majors')
      .select('id, name, acronym, image_url')
      .order('name');

    if (error) throw new InternalServerErrorException('Failed to fetch majors');

    return data;
  }
}
