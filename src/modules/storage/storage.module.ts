import { Global, Module } from '@nestjs/common';
import { StorageService } from './storage.service';
import { OfficeConvertService } from './office-convert.service';
import { ImageOptimizeService } from './image-optimize.service';

@Global()
@Module({
  providers: [StorageService, OfficeConvertService, ImageOptimizeService],
  exports: [StorageService, OfficeConvertService, ImageOptimizeService],
})
export class StorageModule {}
