import { Controller, Get } from '@nestjs/common';
import { MajorsService } from './majors.service';

@Controller('majors')
export class MajorsController {
  constructor(private readonly majorsService: MajorsService) {}

  /**
   * GET /majors
   * Public — no auth required (used on registration screen)
   */
  @Get()
  findAll() {
    return this.majorsService.findAll();
  }
}
