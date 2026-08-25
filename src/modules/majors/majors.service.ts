import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Major } from '../../entities/major.entity';
import { Subject } from '../../entities/subject.entity';
import { Upload } from '../../entities/upload.entity';
import { Book } from '../../entities/book.entity';
import { CreateMajorDto } from './dto/create-major.dto';
import { UpdateMajorDto } from './dto/update-major.dto';
import { pgCode, errMessage } from '../../common/utils/pg-error';
import { BUCKETS, StorageService } from '../storage/storage.service';

/**
 * Object key for a major logo: `<filename>-<upload date>.<ext>`, e.g.
 * `gic-logo-2026-07-21.png`. Flat in the bucket — no per-major folder.
 *
 * The name is slugified because it ends up in a public URL: spaces, slashes and
 * non-ASCII would otherwise need escaping, and a `/` would silently create a
 * folder. Deliberately has no random suffix, so re-uploading the same filename
 * on the same day overwrites the previous object rather than accumulating junk.
 */
function objectKey(originalName: string): string {
  const ext = (originalName.includes('.') ? originalName.split('.').pop() : '')
    ?.toLowerCase()
    .replace(/[^a-z0-9]/g, '');

  const base =
    originalName
      .replace(/\.[^.]+$/, '')
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'logo';

  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  return `${base}-${date}${ext ? `.${ext}` : ''}`;
}

@Injectable()
export class MajorsService {
  constructor(
    @InjectRepository(Major)
    private readonly majors: Repository<Major>,
    private readonly storage: StorageService,
  ) {}

  async findAll() {
    try {
      return await this.majors.find({
        select: { id: true, name: true, acronym: true, image_url: true },
        order: { name: 'ASC' },
      });
    } catch {
      throw new InternalServerErrorException('Failed to fetch majors');
    }
  }

  async create(dto: CreateMajorDto, image?: Express.Multer.File) {
    const acronym = dto.acronym.trim().toUpperCase();

    // An uploaded file wins over an image_url in the body.
    let uploadedUrl: string | null = null;
    let uploadedKey: string | null = null;

    if (image) {
      uploadedKey = objectKey(image.originalname);

      try {
        uploadedUrl = await this.storage.upload(
          BUCKETS.MAJORS,
          uploadedKey,
          image.buffer,
          image.mimetype,
        );
      } catch (err) {
        throw new InternalServerErrorException(
          errMessage(err) || 'Failed to upload major image',
        );
      }
    }

    let saved: Major;
    try {
      saved = await this.majors.save(
        this.majors.create({
          name: dto.name.trim(),
          acronym,
          image_url: uploadedUrl ?? dto.image_url?.trim() ?? null,
        }),
      );
    } catch (err) {
      // The row never landed — don't leave the just-uploaded object orphaned.
      if (uploadedKey) {
        await this.storage.remove([`${BUCKETS.MAJORS}/${uploadedKey}`]);
      }
      // 23505 = unique_violation on majors.acronym
      if (pgCode(err) === '23505') {
        throw new ConflictException(`Major '${acronym}' already exists`);
      }
      throw new InternalServerErrorException('Failed to create major');
    }

    return {
      id: saved.id,
      name: saved.name,
      acronym: saved.acronym,
      image_url: saved.image_url,
    };
  }

  async update(id: string, dto: UpdateMajorDto, image?: Express.Multer.File) {
    const major = await this.majors.findOne({ where: { id } });
    if (!major) throw new NotFoundException('Major not found');

    const previousImageUrl = major.image_url;

    let uploadedKey: string | null = null;
    if (image) {
      uploadedKey = objectKey(image.originalname);
      try {
        major.image_url = await this.storage.upload(
          BUCKETS.MAJORS,
          uploadedKey,
          image.buffer,
          image.mimetype,
        );
      } catch (err) {
        throw new InternalServerErrorException(
          errMessage(err) || 'Failed to upload major image',
        );
      }
    } else if (dto.image_url !== undefined) {
      major.image_url = dto.image_url.trim() || null;
    }

    if (dto.name !== undefined) major.name = dto.name.trim();
    if (dto.acronym !== undefined) major.acronym = dto.acronym.trim().toUpperCase();

    let saved: Major;
    try {
      saved = await this.majors.save(major);
    } catch (err) {
      // The row never changed — don't leave the just-uploaded object orphaned.
      if (uploadedKey) {
        await this.storage.remove([`${BUCKETS.MAJORS}/${uploadedKey}`]);
      }
      if (pgCode(err) === '23505') {
        throw new ConflictException(`Major '${major.acronym}' already exists`);
      }
      throw new InternalServerErrorException('Failed to update major');
    }

    // The old logo is unreachable once the row points elsewhere.
    if (uploadedKey && previousImageUrl && previousImageUrl !== saved.image_url) {
      await this.storage.remove([this.storage.extractKey(previousImageUrl)]);
    }

    return {
      id: saved.id,
      name: saved.name,
      acronym: saved.acronym,
      image_url: saved.image_url,
    };
  }

  async remove(id: string) {
    const major = await this.majors.findOne({ where: { id } });
    if (!major) throw new NotFoundException('Major not found');

    // subjects, uploads and books all cascade from majors, so deleting a
    // department in use would silently take its content with it. Refuse, and
    // say what is in the way.
    const manager = this.majors.manager;
    const [subjects, uploads, books] = await Promise.all([
      manager.count(Subject, { where: { major_id: id } }),
      manager.count(Upload, { where: { major_id: id } }),
      manager.count(Book, { where: { major_id: id } }),
    ]);

    if (subjects || uploads || books) {
      const blocking = [
        subjects && `${subjects} subject(s)`,
        uploads && `${uploads} document(s)`,
        books && `${books} book(s)`,
      ].filter(Boolean);
      throw new ConflictException(
        `'${major.acronym}' still has ${blocking.join(', ')}. Move or delete them first.`,
      );
    }

    try {
      await this.majors.delete(id);
    } catch {
      throw new InternalServerErrorException('Failed to delete major');
    }

    await this.storage.remove([this.storage.extractKey(major.image_url)]);
    return { id, deleted: true };
  }
}
