import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DevAlertService } from './dev-alert.service';

/**
 * Global so a service can report a security event without its module having to
 * declare a dependency on an observability channel — the same reasoning that
 * makes SecurityModule and MailModule global.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [DevAlertService],
  exports: [DevAlertService],
})
export class DevAlertModule {}
