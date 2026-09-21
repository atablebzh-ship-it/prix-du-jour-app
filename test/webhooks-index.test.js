const mockDecode = jest.fn();
jest.mock('jsonwebtoken', () => ({
  decode: (...args) => mockDecode(...args),
}));

const mockExtractBearerToken = jest.fn();
const mockGetScopedClient = jest.fn();
jest.mock('../lib/supabase', () => ({
  extractBearerToken: (...args) => mockExtractBearerToken(...args),
  getScopedClient: (...args) => mockGetScopedClient(...args),
}));

const handler = require('../api/webhooks/index');

function createRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  res.end = jest.fn(() => res);
  res.setHeader = jest.fn(() => res);
  return res;
}

function makeBuilder(result) {
  const builder = {};
  ['select', 'insert', 'update', 'delete', 'eq', 'order', 'single', 'maybeSingle'].forEach((method) => {
    builder[method] = jest.fn(() => builder);
  });
  builder.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return builder;
}

function mockFromSequence(supabase, results) {
  supabase.from = jest.fn();
  results.forEach(({ table, result }) => {
    supabase.from.mockImplementationOnce((calledTable) => {
      expect(calledTable).toBe(table);
      return makeBuilder(result);
    });
  });
  return supabase;
}

describe('api/webhooks', () => {
  let supabase;

  beforeEach(() => {
    jest.clearAllMocks();
    supabase = {};
    mockExtractBearerToken.mockReturnValue('valid-token');
    mockGetScopedClient.mockReturnValue(supabase);
    mockDecode.mockReturnValue({ editeur_id: 'editor-1' });
  });

  test('rejects requests without a Bearer token', async () => {
    mockExtractBearerToken.mockReturnValue(null);
    const req = { method: 'POST', body: {} };
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('rejects when the token has no editeur_id', async () => {
    mockDecode.mockReturnValue({});
    const req = { method: 'POST', body: {} };
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('rejects when jwt.decode throws', async () => {
    mockDecode.mockImplementation(() => {
      throw new Error('malformed');
    });
    const req = { method: 'POST', body: {} };
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('rejects unsupported HTTP methods', async () => {
    const req = { method: 'PUT', query: {}, body: {} };
    const res = createRes();
    await handler(req, res);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', 'POST, GET, PATCH, DELETE');
    expect(res.status).toHaveBeenCalledWith(405);
  });

  describe('POST (create subscription)', () => {
    test('rejects a missing or non-https url', async () => {
      const req = { method: 'POST', body: { url: 'http://insecure.example.com', events: ['price_risk'] } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('rejects a missing events array', async () => {
      const req = { method: 'POST', body: { url: 'https://example.com/webhook' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('rejects an empty events array', async () => {
      const req = { method: 'POST', body: { url: 'https://example.com/webhook', events: [] } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('rejects an invalid event type', async () => {
      const req = { method: 'POST', body: { url: 'https://example.com/webhook', events: ['classification_change', 'bogus_event'] } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'invalid_request' }));
    });

    test('creates a subscription and returns the secret once', async () => {
      mockFromSequence(supabase, [
        {
          table: 'webhook_subscriptions',
          result: { data: { id: 'sub-1', url: 'https://example.com/webhook', events: ['price_risk'], is_active: true, created_at: '2026-09-01T00:00:00Z' }, error: null },
        },
      ]);
      const req = { method: 'POST', body: { url: 'https://example.com/webhook', events: ['price_risk'] } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(201);
      const payload = res.json.mock.calls[0][0];
      expect(payload.id).toBe('sub-1');
      expect(typeof payload.secret).toBe('string');
      expect(payload.secret.length).toBeGreaterThan(0);
    });

    test('returns 500 on insert error', async () => {
      mockFromSequence(supabase, [
        { table: 'webhook_subscriptions', result: { data: null, error: { message: 'boom' } } },
      ]);
      const req = { method: 'POST', body: { url: 'https://example.com/webhook', events: ['price_risk'] } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('GET (list subscriptions)', () => {
    test('lists subscriptions ordered by creation date', async () => {
      mockFromSequence(supabase, [
        { table: 'webhook_subscriptions', result: { data: [{ id: 'sub-1' }, { id: 'sub-2' }], error: null } },
      ]);
      const req = { method: 'GET', query: {} };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ subscriptions: [{ id: 'sub-1' }, { id: 'sub-2' }] });
    });

    test('returns an empty array when there is no data', async () => {
      mockFromSequence(supabase, [
        { table: 'webhook_subscriptions', result: { data: null, error: null } },
      ]);
      const req = { method: 'GET', query: {} };
      const res = createRes();
      await handler(req, res);
      expect(res.json).toHaveBeenCalledWith({ subscriptions: [] });
    });

    test('returns 500 on list error', async () => {
      mockFromSequence(supabase, [
        { table: 'webhook_subscriptions', result: { data: null, error: { message: 'boom' } } },
      ]);
      const req = { method: 'GET', query: {} };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('PATCH (update subscription)', () => {
    test('rejects a missing subscriptionId', async () => {
      const req = { method: 'PATCH', query: {}, body: { isActive: false } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('rejects a non-https url', async () => {
      const req = { method: 'PATCH', query: { subscriptionId: 'sub-1' }, body: { url: 'ftp://example.com' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('rejects an empty events array', async () => {
      const req = { method: 'PATCH', query: { subscriptionId: 'sub-1' }, body: { events: [] } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('rejects an invalid event type', async () => {
      const req = { method: 'PATCH', query: { subscriptionId: 'sub-1' }, body: { events: ['not_a_real_event'] } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('rejects when no field is provided', async () => {
      const req = { method: 'PATCH', query: { subscriptionId: 'sub-1' }, body: {} };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('deactivates a subscription successfully', async () => {
      mockFromSequence(supabase, [
        { table: 'webhook_subscriptions', result: { data: { id: 'sub-1', url: 'https://example.com/webhook', events: ['price_risk'], is_active: false, created_at: '2026-09-01T00:00:00Z' }, error: null } },
      ]);
      const req = { method: 'PATCH', query: { subscriptionId: 'sub-1' }, body: { isActive: false } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ is_active: false }));
    });

    test('returns 404 when the subscription does not exist', async () => {
      mockFromSequence(supabase, [
        { table: 'webhook_subscriptions', result: { data: null, error: null } },
      ]);
      const req = { method: 'PATCH', query: { subscriptionId: 'missing' }, body: { isActive: true } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    test('returns 500 on update error', async () => {
      mockFromSequence(supabase, [
        { table: 'webhook_subscriptions', result: { data: null, error: { message: 'boom' } } },
      ]);
      const req = { method: 'PATCH', query: { subscriptionId: 'sub-1' }, body: { isActive: true } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('DELETE', () => {
    test('rejects a missing subscriptionId', async () => {
      const req = { method: 'DELETE', query: {} };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('returns 500 when the lookup fails', async () => {
      mockFromSequence(supabase, [
        { table: 'webhook_subscriptions', result: { data: null, error: { message: 'boom' } } },
      ]);
      const req = { method: 'DELETE', query: { subscriptionId: 'sub-1' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    test('returns 404 when the subscription does not exist', async () => {
      mockFromSequence(supabase, [
        { table: 'webhook_subscriptions', result: { data: null, error: null } },
      ]);
      const req = { method: 'DELETE', query: { subscriptionId: 'missing' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    test('deletes successfully', async () => {
      mockFromSequence(supabase, [
        { table: 'webhook_subscriptions', result: { data: { id: 'sub-1' }, error: null } },
        { table: 'webhook_subscriptions', result: { error: null } },
      ]);
      const req = { method: 'DELETE', query: { subscriptionId: 'sub-1' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(204);
    });

    test('returns 500 when the final delete fails', async () => {
      mockFromSequence(supabase, [
        { table: 'webhook_subscriptions', result: { data: { id: 'sub-1' }, error: null } },
        { table: 'webhook_subscriptions', result: { error: { message: 'boom' } } },
      ]);
      const req = { method: 'DELETE', query: { subscriptionId: 'sub-1' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });
});
