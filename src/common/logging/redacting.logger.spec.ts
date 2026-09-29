import { RedactingLogger } from './redacting.logger';

/**
 * The point of this logger is that a call site does NOT have to cooperate.
 * Every case below is a line some service writes today, unmodified.
 */
describe('RedactingLogger', () => {
  let written: string;

  beforeEach(() => {
    written = '';
    const capture = (chunk: unknown) => {
      written += String(chunk);
      return true;
    };
    jest.spyOn(process.stdout, 'write').mockImplementation(capture as never);
    jest.spyOn(process.stderr, 'write').mockImplementation(capture as never);
  });

  afterEach(() => jest.restoreAllMocks());

  const logger = () => new RedactingLogger('Test');

  it('scrubs a driver error quoted by an untouched call site', () => {
    // telegram.service.ts interpolates err.message raw; it does not know about
    // this class, and does not have to.
    logger().warn(
      'Could not create a link token: insert failed token=abc123def456ghi',
    );
    expect(written).not.toContain('abc123def456ghi');
    expect(written).toContain('[redacted]');
  });

  it('scrubs a stack passed as a second argument', () => {
    const err = new Error(
      '535 auth failed for user=bot@itc.edu.kh password=s3cr3tpass',
    );
    logger().error('send failed', err.stack);
    expect(written).not.toContain('s3cr3tpass');
  });

  it('scrubs an Error object without damaging the original', () => {
    const err = new Error('token=abcdefghijklmnopqrstuvwxyz123456');
    logger().error(err);
    expect(written).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
    // The application is still holding this exception.
    expect(err.message).toContain('abcdefghijklmnopqrstuvwxyz123456');
  });

  it('scrubs objects by field name', () => {
    logger().log({ email: 'a@b.kh', password: 'Hunter2!' });
    expect(written).not.toContain('Hunter2!');
  });

  it('leaves an ordinary line readable', () => {
    logger().log('GET /documents?page=2 → 200 (4ms)');
    expect(written).toContain('/documents?page=2');
    expect(written).toContain('200');
  });

  it('covers every level, not just the ones in use today', () => {
    const secret = 'password=LeakedValue123';
    const log = logger();
    for (const level of [
      'log',
      'error',
      'warn',
      'debug',
      'verbose',
      'fatal',
    ] as const) {
      written = '';
      (log[level] as (m: string) => void)(secret);
      expect(written).not.toContain('LeakedValue123');
    }
  });
});
