import { Global, Module } from '@nestjs/common';
import { StorageService } from './storage.service';
import { OfficeConvertService } from './office-convert.service';

@Global()
@Module({
  providers: [StorageService, OfficeConvertService],
  exports: [StorageService, OfficeConvertService],
})
export class StorageModule {}
