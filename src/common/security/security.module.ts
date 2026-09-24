import { Global, Module } from '@nestjs/common';
import { ClamAvService } from './clamav.service';

/**
 * Global so the scanner is one instance with one connection policy, and so a
 * module that accepts files does not have to remember to import it.
 *
 * There is exactly one provider here today. It is a module rather than a bare
 * provider because the boot-time reachability check lives in `onModuleInit`,
 * and that only runs for something Nest owns.
 */
@Global()
@Module({
  providers: [ClamAvService],
  exports: [ClamAvService],
})
export class SecurityModule {}
