const mockCompare = jest.fn();
jest.mock('bcryptjs', () => ({
  compare: (...args) => mockCompare(...args),
}));

const mockSign = jest.fn(() => 'signed.jwt.token');
jest.mock('jsonwebtoken', () => ({
  sign: (...args) => mockSign(...args),
}));

const mockMaybeSingle = jest.fn();
const mockEq = jest.fn(() => ({ maybeSingle: mockMaybeSingle }));
const mockSelect = jest.fn(() => ({ eq: mockEq }));
const mockFrom = jest.fn(() => ({ select: mockSelect }));
const mockGetServiceClient = jest.fn(() => ({ from: mockFrom }));

jest.mock('../lib/supabase', () => ({
  getServiceClient: (...args) => mockGetServiceClient(...args),
}));

const handler = require('../api/oauth/token');

function createRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  res.setHeader = jest.fn(() => res);
  return res;
}

describe('POST /api/oauth/token', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...OLD_ENV, SUPABASE_JWT_SECRET: 'test-jwt-secret' };
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  test('rejects non-POST methods with 405 and an Allow header', async () => {
    const req = { method: 'GET', body: {} };
    const res = createRes();
    await handler(req, res);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', 'POST');
    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.json).toHaveBeenCalledWith({ error: 'method_not_allowed' });
  });

  test('rejects an unsupported grant_type', async () => {
    const req = { method: 'POST', body: { grant_type: 'password', client_id: 'a', client_secret: 'b' } };
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'unsupported_grant_type' });
  });

  test('rejects a missing client_id or client_secret', async () => {
    const req = { method: 'POST', body: { grant_type: 'client_credentials', client_id: 'only-id' } };
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'invalid_request',
      error_description: 'client_id et client_secret requis',
    });
  });

  test('handles a missing request body gracefully (400 invalid_request)', async () => {
    const req = { method: 'POST' };
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('returns 500 server_error when the Supabase lookup throws', async () => {
    mockMaybeSingle.mockRejectedValueOnce(new Error('db unreachable'));
    const req = {
      method: 'POST',
      body: { grant_type: 'client_credentials', client_id: 'editor-1', client_secret: 'secret' },
    };
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'server_error' });
  });

  test('returns 500 server_error when Supabase returns an error object', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    const req = {
      method: 'POST',
      body: { grant_type: 'client_credentials', client_id: 'editor-1', client_secret: 'secret' },
    };
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  test('returns 401 invalid_client when no editor matches the client_id', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const req = {
      method: 'POST',
      body: { grant_type: 'client_credentials', client_id: 'unknown', client_secret: 'secret' },
    };
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: 'invalid_client',
      error_description: 'client_id ou client_secret invalide',
    });
    expect(mockCompare).not.toHaveBeenCalled();
  });

  test('returns 401 invalid_client when the editor is inactive', async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: { id: 'editor-uuid', client_secret_hash: 'hash', active: false },
      error: null,
    });
    const req = {
      method: 'POST',
      body: { grant_type: 'client_credentials', client_id: 'editor-1', client_secret: 'secret' },
    };
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockCompare).not.toHaveBeenCalled();
  });

  test('returns 401 invalid_client when the secret does not match the stored hash', async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: { id: 'editor-uuid', client_secret_hash: 'hash', active: true },
      error: null,
    });
    mockCompare.mockResolvedValueOnce(false);
    const req = {
      method: 'POST',
      body: { grant_type: 'client_credentials', client_id: 'editor-1', client_secret: 'wrong-secret' },
    };
    const res = createRes();
    await handler(req, res);
    expect(mockCompare).toHaveBeenCalledWith('wrong-secret', 'hash');
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('issues a signed JWT on valid credentials', async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: { id: 'editor-uuid', client_secret_hash: 'hash', active: true },
      error: null,
    });
    mockCompare.mockResolvedValueOnce(true);
    const req = {
      method: 'POST',
      body: { grant_type: 'client_credentials', client_id: 'editor-1', client_secret: 'good-secret' },
    };
    const res = createRes();
    await handler(req, res);

    expect(mockSign).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'authenticated', editeur_id: 'editor-uuid' }),
      'test-jwt-secret',
      { algorithm: 'HS256' }
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      access_token: 'signed.jwt.token',
      token_type: 'Bearer',
      expires_in: 3600,
    });
  });

  test('the issued token payload carries a 1 hour expiry window', async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: { id: 'editor-uuid', client_secret_hash: 'hash', active: true },
      error: null,
    });
    mockCompare.mockResolvedValueOnce(true);
    const req = {
      method: 'POST',
      body: { grant_type: 'client_credentials', client_id: 'editor-1', client_secret: 'good-secret' },
    };
    const res = createRes();
    await handler(req, res);

    const payload = mockSign.mock.calls[0][0];
    expect(payload.exp - payload.iat).toBe(3600);
  });
});
