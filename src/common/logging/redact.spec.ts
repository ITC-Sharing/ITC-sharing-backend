import { REDACTED, redactObject, redactText, safeUrl } from './redact';

/** Each case is something that reached a log line, or would have. */
describe('safeUrl', () => {
  it('redacts the OAuth authorization code', () => {
    // The live leak: GET /auth/google/callback?code=… was logged verbatim by
    // the interceptor, the exception filter, and the Telegram alert.
    const got = safeUrl(
      '/auth/google/callback?code=4/0AY0e-g7xR2mPqL&state=abc123',
    );
    expect(got).toBe(
      `/auth/google/callback?code=${REDACTED}&state=${REDACTED}`,
    );
  });

  it('redacts tokens and codes carried as query parameters', () => {
    const got = safeUrl(
      '/auth/reset?token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig&otp=481920',
    );
    expect(got).not.toContain('eyJ');
    expect(got).not.toContain('481920');
  });

  it('redacts a presigned URL signature', () => {
    expect(
      safeUrl('/f.pdf?X-Amz-Signature=8f3d2a1b9c7e&X-Amz-Expires=300'),
    ).toContain(`X-Amz-Signature=${REDACTED}`);
  });

  it('keeps the parameter names so the line stays useful', () => {
    // "this request carried a code" is worth knowing; the code is not.
    expect(safeUrl('/x?code=secret')).toContain('code=');
  });

  it('keeps allowlisted values', () => {
    expect(safeUrl('/documents?page=2&limit=10&doc_type=TD')).toBe(
      '/documents?page=2&limit=10&doc_type=TD',
    );
  });

  it('redacts anything not allowlisted, including search', () => {
    // People type addresses and ID numbers into search boxes.
    expect(safeUrl('/documents?search=No%2012%20Street%20271&page=1')).toBe(
      `/documents?search=${REDACTED}&page=1`,
    );
  });

  it('leaves a URL with no query alone', () => {
    expect(safeUrl('/admin/users')).toBe('/admin/users');
    expect(safeUrl(undefined)).toBe('');
  });
});

describe('redactText', () => {
  it('removes a JWT wherever it appears', () => {
    expect(
      redactText(
        'verify failed for eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.QmFzZTY0',
      ),
    ).not.toContain('eyJ');
  });

  it('removes the credential, not the scheme, from an Authorization header', () => {
    // Regression: an earlier version replaced the word "Bearer" and left the
    // token standing immediately after it.
    expect(
      redactText('upstream said: Authorization: Bearer sk_live_51H8xKjLmNoPq'),
    ).not.toContain('sk_live_51H8xKjLmNoPq');
  });

  it('removes a bare bearer token with no key in front of it', () => {
    expect(redactText('sent Bearer sk_live_51H8xKjLmNoPq')).not.toContain(
      'sk_live',
    );
  });

  it('removes values of sensitive keys inside free text', () => {
    // A driver error can quote the parameters it was called with.
    const got = redactText(
      'INSERT failed (email=a@b.kh, password=Hunter2!, otp=481920)',
    );
    expect(got).not.toContain('Hunter2!');
    expect(got).not.toContain('481920');
    expect(got).toContain('email=a@b.kh');
  });

  it('removes a card number and its CVV', () => {
    const got = redactText('declined for 4111 1111 1111 1111 cvv=123');
    expect(got).not.toContain('4111');
    expect(got).not.toContain('123');
  });

  it('leaves a long number that is not a card', () => {
    // Luhn separates a payment instrument from a timestamp.
    expect(redactText('processed 1787199298957 bytes')).toContain(
      '1787199298957',
    );
  });

  it('removes an identity number', () => {
    expect(redactText('lookup national_id=012345678')).not.toContain(
      '012345678',
    );
  });

  it('passes empty and absent input through unchanged', () => {
    expect(redactText('')).toBe('');
    expect(redactText(undefined)).toBeUndefined();
  });
});

describe('redactObject', () => {
  const source = {
    email: 'dara@itc.edu.kh',
    password: 'Hunter2!',
    refresh_token: 'abc',
    address: 'No 12, Street 271',
    major_id: '9d5fc666-5714-49d3',
    nested: { cvv: '123', page: 2 },
  };

  it('redacts by field name at every depth', () => {
    const got = redactObject(source) as Record<string, unknown>;
    expect(got.password).toBe(REDACTED);
    expect(got.refresh_token).toBe(REDACTED);
    expect(got.address).toBe(REDACTED);
    expect((got.nested as Record<string, unknown>).cvv).toBe(REDACTED);
  });

  it('keeps ordinary foreign keys', () => {
    // Redacting every *_id would cost the log most of its value.
    const got = redactObject(source) as Record<string, unknown>;
    expect(got.major_id).toBe('9d5fc666-5714-49d3');
  });

  it('does not mutate what the application is still using', () => {
    redactObject(source);
    expect(source.password).toBe('Hunter2!');
  });

  it('stops at a depth rather than following a cycle forever', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => redactObject(cyclic)).not.toThrow();
  });
});
