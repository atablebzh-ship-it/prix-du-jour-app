const mockCreateClient = jest.fn(() => ({ mocked: 'client' }));

jest.mock('@supabase/supabase-js', () => ({
  createClient: (...args) => mockCreateClient(...args),
}));

const {
  getServiceClient,
  getScopedClient,
  extractBearerToken,
} = require('../lib/supabase');

describe('extractBearerToken', () => {
  test('extracts the token from a well-formed Authorization header', () => {
    const req = { headers: { authorization: 'Bearer abc123' } };
    expect(extractBearerToken(req)).toBe('abc123');
  });

  test('is case-insensitive on the header key (capital Authorization)', () => {
    const req = { headers: { Authorization: 'Bearer xyz789' } };
    expect(extractBearerToken(req)).toBe('xyz789');
  });

  test('trims surrounding whitespace from the token', () => {
    const req = { headers: { authorization: 'Bearer   abc123  ' } };
    expect(extractBearerToken(req)).toBe('abc123');
  });

  test('returns null when the header is missing', () => {
    const req = { headers: {} };
    expect(extractBearerToken(req)).toBeNull();
  });

  test('returns null when the header does not start with "Bearer "', () => {
    const req = { headers: { authorization: 'Basic abc123' } };
    expect(extractBearerToken(req)).toBeNull();
  });

  test('returns null when the token part is empty', () => {
    const req = { headers: { authorization: 'Bearer ' } };
    expect(extractBearerToken(req)).toBeNull();
  });
});

describe('getServiceClient', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...OLD_ENV,
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    };
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  test('creates a client with the service role key and no auth persistence', () => {
    getServiceClient();
    expect(mockCreateClient).toHaveBeenCalledWith(
      'https://example.supabase.co',
      'service-role-key',
      { auth: { persistSession: false } }
    );
  });
});

describe('getScopedClient', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...OLD_ENV,
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    };
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  test('creates a client forwarding the caller access token as a Bearer header', () => {
    getScopedClient('caller-token-123');
    expect(mockCreateClient).toHaveBeenCalledWith(
      'https://example.supabase.co',
      'service-role-key',
      {
        auth: { persistSession: false },
        global: { headers: { Authorization: 'Bearer caller-token-123' } },
      }
    );
  });
});
