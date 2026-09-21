const mockExtractBearerToken = jest.fn();
const mockGetScopedClient = jest.fn();
jest.mock('../lib/supabase', () => ({
  extractBearerToken: (...args) => mockExtractBearerToken(...args),
  getScopedClient: (...args) => mockGetScopedClient(...args),
}));

const handler = require('../api/establishments/[establishmentId]/ingredients/index');

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
  ['select', 'insert', 'update', 'delete', 'eq', 'single', 'maybeSingle'].forEach((method) => {
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

const ESTABLISHMENT_OK = { table: 'establishments', result: { data: { id: 'est-1' }, error: null } };

describe('api/establishments/[establishmentId]/ingredients', () => {
  let supabase;

  beforeEach(() => {
    jest.clearAllMocks();
    supabase = {};
    mockExtractBearerToken.mockReturnValue('valid-token');
    mockGetScopedClient.mockReturnValue(supabase);
  });

  test('rejects requests without a Bearer token', async () => {
    mockExtractBearerToken.mockReturnValue(null);
    const req = { method: 'POST', query: {}, body: {} };
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('rejects a missing establishmentId', async () => {
    const req = { method: 'POST', query: {}, body: {} };
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('returns 500 when the establishment lookup fails', async () => {
    mockFromSequence(supabase, [
      { table: 'establishments', result: { data: null, error: { message: 'boom' } } },
    ]);
    const req = { method: 'POST', query: { establishmentId: 'est-1' }, body: {} };
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  test('returns 404 when the establishment does not exist', async () => {
    mockFromSequence(supabase, [
      { table: 'establishments', result: { data: null, error: null } },
    ]);
    const req = { method: 'POST', query: { establishmentId: 'missing' }, body: {} };
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('rejects unsupported HTTP methods', async () => {
    mockFromSequence(supabase, [ESTABLISHMENT_OK]);
    const req = { method: 'GET', query: { establishmentId: 'est-1' } };
    const res = createRes();
    await handler(req, res);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', 'POST, PATCH, DELETE');
    expect(res.status).toHaveBeenCalledWith(405);
  });

  describe('POST (creation)', () => {
    test('rejects a missing name', async () => {
      mockFromSequence(supabase, [ESTABLISHMENT_OK]);
      const req = { method: 'POST', query: { establishmentId: 'est-1' }, body: { unit: 'kg' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('rejects a missing unit', async () => {
      mockFromSequence(supabase, [ESTABLISHMENT_OK]);
      const req = { method: 'POST', query: { establishmentId: 'est-1' }, body: { name: 'Aubergine' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('rejects a non-string marketReferenceCode', async () => {
      mockFromSequence(supabase, [ESTABLISHMENT_OK]);
      const req = {
        method: 'POST',
        query: { establishmentId: 'est-1' },
        body: { name: 'Aubergine', unit: 'kg', marketReferenceCode: 42 },
      };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('creates an ingredient with a market reference code', async () => {
      mockFromSequence(supabase, [
        ESTABLISHMENT_OK,
        { table: 'ingredients', result: { data: { id: 'ing-1', name: 'Aubergine', unit: 'kg', market_reference_code: 'aubergine' }, error: null } },
      ]);
      const req = {
        method: 'POST',
        query: { establishmentId: 'est-1' },
        body: { name: 'Aubergine', unit: 'kg', marketReferenceCode: 'aubergine' },
      };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(201);
    });

    test('creates an ingredient without a market reference code (defaults to null)', async () => {
      mockFromSequence(supabase, [
        ESTABLISHMENT_OK,
        { table: 'ingredients', result: { data: { id: 'ing-2', name: 'Beurre', unit: 'kg', market_reference_code: null }, error: null } },
      ]);
      const req = { method: 'POST', query: { establishmentId: 'est-1' }, body: { name: 'Beurre', unit: 'kg' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ market_reference_code: null }));
    });

    test('returns 500 on insert error', async () => {
      mockFromSequence(supabase, [
        ESTABLISHMENT_OK,
        { table: 'ingredients', result: { data: null, error: { message: 'boom' } } },
      ]);
      const req = { method: 'POST', query: { establishmentId: 'est-1' }, body: { name: 'Aubergine', unit: 'kg' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('PATCH (update)', () => {
    test('rejects a missing ingredientId', async () => {
      mockFromSequence(supabase, [ESTABLISHMENT_OK]);
      const req = { method: 'PATCH', query: { establishmentId: 'est-1' }, body: { name: 'X' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('rejects when no field is provided', async () => {
      mockFromSequence(supabase, [ESTABLISHMENT_OK]);
      const req = { method: 'PATCH', query: { establishmentId: 'est-1', ingredientId: 'ing-1' }, body: {} };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('rejects a blank name', async () => {
      mockFromSequence(supabase, [ESTABLISHMENT_OK]);
      const req = { method: 'PATCH', query: { establishmentId: 'est-1', ingredientId: 'ing-1' }, body: { name: '  ' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('rejects a blank unit', async () => {
      mockFromSequence(supabase, [ESTABLISHMENT_OK]);
      const req = { method: 'PATCH', query: { establishmentId: 'est-1', ingredientId: 'ing-1' }, body: { unit: '  ' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('rejects an invalid marketReferenceCode type', async () => {
      mockFromSequence(supabase, [ESTABLISHMENT_OK]);
      const req = { method: 'PATCH', query: { establishmentId: 'est-1', ingredientId: 'ing-1' }, body: { marketReferenceCode: 42 } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('accepts a null marketReferenceCode to clear it', async () => {
      mockFromSequence(supabase, [
        ESTABLISHMENT_OK,
        { table: 'ingredients', result: { data: { id: 'ing-1', name: 'Aubergine', unit: 'kg', market_reference_code: null }, error: null } },
      ]);
      const req = { method: 'PATCH', query: { establishmentId: 'est-1', ingredientId: 'ing-1' }, body: { marketReferenceCode: null } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    test('updates successfully', async () => {
      mockFromSequence(supabase, [
        ESTABLISHMENT_OK,
        { table: 'ingredients', result: { data: { id: 'ing-1', name: 'Aubergine bio', unit: 'kg', market_reference_code: 'aubergine' }, error: null } },
      ]);
      const req = { method: 'PATCH', query: { establishmentId: 'est-1', ingredientId: 'ing-1' }, body: { name: 'Aubergine bio' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    test('returns 404 when the ingredient does not exist', async () => {
      mockFromSequence(supabase, [
        ESTABLISHMENT_OK,
        { table: 'ingredients', result: { data: null, error: null } },
      ]);
      const req = { method: 'PATCH', query: { establishmentId: 'est-1', ingredientId: 'missing' }, body: { name: 'X' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    test('returns 500 on update error', async () => {
      mockFromSequence(supabase, [
        ESTABLISHMENT_OK,
        { table: 'ingredients', result: { data: null, error: { message: 'boom' } } },
      ]);
      const req = { method: 'PATCH', query: { establishmentId: 'est-1', ingredientId: 'ing-1' }, body: { name: 'X' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('DELETE', () => {
    test('rejects a missing ingredientId', async () => {
      mockFromSequence(supabase, [ESTABLISHMENT_OK]);
      const req = { method: 'DELETE', query: { establishmentId: 'est-1' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('returns 500 when the lookup fails', async () => {
      mockFromSequence(supabase, [
        ESTABLISHMENT_OK,
        { table: 'ingredients', result: { data: null, error: { message: 'boom' } } },
      ]);
      const req = { method: 'DELETE', query: { establishmentId: 'est-1', ingredientId: 'ing-1' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    test('returns 404 when the ingredient does not exist', async () => {
      mockFromSequence(supabase, [
        ESTABLISHMENT_OK,
        { table: 'ingredients', result: { data: null, error: null } },
      ]);
      const req = { method: 'DELETE', query: { establishmentId: 'est-1', ingredientId: 'missing' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    test('returns 500 when the usage check fails', async () => {
      mockFromSequence(supabase, [
        ESTABLISHMENT_OK,
        { table: 'ingredients', result: { data: { id: 'ing-1' }, error: null } },
        { table: 'recipe_items', result: { count: null, error: { message: 'boom' } } },
      ]);
      const req = { method: 'DELETE', query: { establishmentId: 'est-1', ingredientId: 'ing-1' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    test('returns 409 conflict when the ingredient is still used in recipes', async () => {
      mockFromSequence(supabase, [
        ESTABLISHMENT_OK,
        { table: 'ingredients', result: { data: { id: 'ing-1' }, error: null } },
        { table: 'recipe_items', result: { count: 3, error: null } },
      ]);
      const req = { method: 'DELETE', query: { establishmentId: 'est-1', ingredientId: 'ing-1' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'conflict' })
      );
    });

    test('deletes successfully when unused', async () => {
      mockFromSequence(supabase, [
        ESTABLISHMENT_OK,
        { table: 'ingredients', result: { data: { id: 'ing-1' }, error: null } },
        { table: 'recipe_items', result: { count: 0, error: null } },
        { table: 'ingredients', result: { error: null } },
      ]);
      const req = { method: 'DELETE', query: { establishmentId: 'est-1', ingredientId: 'ing-1' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(204);
    });

    test('returns 500 when the final delete fails', async () => {
      mockFromSequence(supabase, [
        ESTABLISHMENT_OK,
        { table: 'ingredients', result: { data: { id: 'ing-1' }, error: null } },
        { table: 'recipe_items', result: { count: 0, error: null } },
        { table: 'ingredients', result: { error: { message: 'boom' } } },
      ]);
      const req = { method: 'DELETE', query: { establishmentId: 'est-1', ingredientId: 'ing-1' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });
});
