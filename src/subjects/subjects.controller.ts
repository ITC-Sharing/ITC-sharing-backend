import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SubjectsService } from './subjects.service';
import { CreateSubjectDto } from './dto/create-course.dto';

@Controller('subjects')
export class SubjectsController {
  constructor(private readonly subjectsService: SubjectsService) {}

  /**
   * GET /courses?major_id=<uuid>
   * Public — used to populate course dropdowns filtered by major
   */
  @Get()
  findByMajor(
    @Query('major_id') majorId: string,
    @Query('year_level') yearLevel?: string, // ← add this
  ) {
    if (!majorId) throw new BadRequestException('major_id is required');
    return this.subjectsService.findByMajor(
      majorId,
      yearLevel ? Number(yearLevel) : undefined,
    );
  }

  /**
   * POST /subjects
   * Any logged-in user can contribute a missing subject
   */
  @UseGuards(JwtAuthGuard)
  @Post()
  create(@Body() dto: CreateSubjectDto) {
    return this.subjectsService.create(dto);
  }
}
