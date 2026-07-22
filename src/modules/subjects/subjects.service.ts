import {
  Injectable,
  InternalServerErrorException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Subject } from '../../entities/subject.entity';
import { BUCKETS, StorageService } from '../storage/storage.service';
import { pgCode, errMessage } from '../../common/utils/pg-error';
import { CreateSubjectDto } from './dto/create-subject.dto';
import { UpdateSubjectDto } from './dto/update-subject.dto';

@Injectable()
export class SubjectsService {
  constructor(
    @InjectRepository(Subject)
    private readonly subjects: Repository<Subject>,
    private readonly storage: StorageService,
  ) {}

  async countsByMajor(majorId: string): Promise<Record<number, number>> {
    let rows: { year_level: number }[];
    try {
      rows = await this.subjects.find({
        select: { year_level: true },
        where: { major_id: majorId, status: 'active' },
      });
    } catch {
      throw new InternalServerErrorException('Failed to fetch subject counts');
    }

    const counts: Record<number, number> = {};
    for (const row of rows) {
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
    const qb = this.subjects
      .createQueryBuilder('s')
      .select([
        's.id',
        's.name',
        's.slug',
        's.semester',
        's.year_level',
        's.subject_url',
      ])
      .where('s.major_id = :majorId', { majorId })
      .andWhere('s.status = :status', { status: 'active' })
      .orderBy('s.semester', 'ASC')
      .addOrderBy('s.subject_url', 'ASC', 'NULLS LAST');

    if (yearLevel && yearLevel > 0)
      qb.andWhere('s.year_level = :yearLevel', { yearLevel });
    if (semester === 1 || semester === 2)
      qb.andWhere('s.semester = :semester', { semester });
    if (search?.trim())
      qb.andWhere('s.name ILIKE :search', { search: `%${search.trim()}%` });

    try {
      return await qb.getMany();
    } catch {
      throw new InternalServerErrorException('Failed to fetch subjects');
    }
  }

  async create(
    dto: CreateSubjectDto,
    image?: Express.Multer.File,
    submittedBy?: string,
  ) {
    const subjectUrl = dto.subject_url?.trim();

    let uploadedImageUrl: string | null = null;
    let uploadedKey: string | null = null;

    if (image) {
      const ext = image.originalname.split('.').pop() ?? 'bin';
      uploadedKey = `${dto.major_id}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

      try {
        uploadedImageUrl = await this.storage.upload(
          BUCKETS.SUBJECTS,
          uploadedKey,
          image.buffer,
          image.mimetype,
        );
      } catch (err) {
        throw new InternalServerErrorException(
          errMessage(err) || 'Failed to upload subject image',
        );
      }
    }

    // Null when the submitter supplied neither a file nor a URL. Deliberately
    // NOT a placeholder image: the client decides what to render for a subject
    // with no cover (SubjectCard shows the slug), and it can only do that if
    // "no cover" is representable.
    const finalSubjectUrl = uploadedImageUrl ?? subjectUrl ?? null;

    try {
      const saved = await this.subjects.save(
        this.subjects.create({
          major_id: dto.major_id,
          name: dto.name.trim(),
          slug: dto.slug.trim(),
          year_level: dto.year_level,
          semester: dto.semester,
          subject_url: finalSubjectUrl,
          status: 'pending',
          submitted_by: submittedBy ?? null,
        }),
      );

      return {
        id: saved.id,
        name: saved.name,
        slug: saved.slug,
        year_level: saved.year_level,
        semester: saved.semester,
        major_id: saved.major_id,
        subject_url: saved.subject_url,
      };
    } catch (err) {
      if (uploadedKey)
        await this.storage.remove([`${BUCKETS.SUBJECTS}/${uploadedKey}`]);

      const code = pgCode(err);
      if (code === '23505')
        throw new ConflictException(
          'A subject with this name already exists for this major',
        );
      if (code === '23503') throw new BadRequestException('Invalid major_id');
      if (code === '23502')
        throw new BadRequestException(
          errMessage(err) || 'Missing required field for subject creation',
        );
      throw new BadRequestException(
        errMessage(err) || 'Failed to create subject',
      );
    }
  }

  async findMine(userId: string) {
    let rows: Subject[];
    try {
      rows = await this.subjects
        .createQueryBuilder('s')
        .leftJoinAndSelect('s.major', 'major')
        .where('s.submitted_by = :userId', { userId })
        .andWhere('s.status IN (:...statuses)', {
          statuses: ['pending', 'rejected'],
        })
        .orderBy('s.id', 'DESC')
        .getMany();
    } catch {
      throw new InternalServerErrorException('Failed to fetch your subjects');
    }

    return rows.map((s) => ({
      id: s.id,
      name: s.name,
      slug: s.slug,
      year_level: s.year_level,
      semester: s.semester,
      subject_url: s.subject_url,
      status: s.status,
      rejection_reason: s.rejection_reason,
      rejected_at: s.rejected_at,
      created_at: s.created_at,
      majors: s.major ? { id: s.major.id, acronym: s.major.acronym } : null,
    }));
  }

  async updateOwn(id: string, userId: string, dto: UpdateSubjectDto) {
    const existing = await this.subjects.findOne({
      where: { id },
      select: { id: true, submitted_by: true, status: true },
    });

    if (!existing) throw new NotFoundException('Subject not found');
    if (existing.submitted_by !== userId)
      throw new ForbiddenException('Not your subject');
    if (existing.status === 'active')
      throw new ForbiddenException('Cannot edit an approved subject');

    const updates: Partial<Subject> = {};
    if (dto.name !== undefined) updates.name = dto.name.trim();
    if (dto.semester !== undefined) updates.semester = dto.semester;

    if (!Object.keys(updates).length) return existing;

    try {
      await this.subjects.update({ id }, updates);
    } catch {
      throw new InternalServerErrorException('Failed to update subject');
    }

    const updated = await this.subjects.findOne({
      where: { id },
      select: {
        id: true,
        name: true,
        slug: true,
        year_level: true,
        semester: true,
        subject_url: true,
        status: true,
      },
    });
    return updated;
  }

  async removeOwn(id: string, userId: string) {
    const existing = await this.subjects.findOne({
      where: { id },
      select: { id: true, submitted_by: true, status: true },
    });

    if (!existing) throw new NotFoundException('Subject not found');
    if (existing.submitted_by !== userId)
      throw new ForbiddenException('Not your subject');
    if (existing.status === 'active')
      throw new ForbiddenException('Cannot delete an approved subject');

    try {
      await this.subjects.delete({ id });
    } catch {
      throw new InternalServerErrorException('Failed to delete subject');
    }
    return { message: 'Subject deleted' };
  }
}
