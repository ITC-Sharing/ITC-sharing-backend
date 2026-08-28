import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service';

// Global: registration needs it today, password reset will tomorrow, and
// neither should have to re-import a module with no other dependencies.
@Global()
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
