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
  constructor(private readonly coursesService: SubjectsService) {}

  /**
   * GET /courses?major_id=<uuid>
   * Public — used to populate course dropdowns filtered by major
   */
  @Get()
  findByMajor(@Query('major_id') majorId: string) {
    if (!majorId)
      throw new BadRequestException('major_id query param is required');
    return this.coursesService.findByMajor(majorId);
  }

  /**
   * POST /courses
   * Any logged-in user can contribute a missing course
   */
  @UseGuards(JwtAuthGuard)
  @Post()
  create(@Body() dto: CreateSubjectDto) {
    return this.coursesService.create(dto);
  }
}
