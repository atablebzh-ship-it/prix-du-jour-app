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

const handler = require('../api/establishments/index');

function createRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  res.end = jest.fn(() => res);
  res.setHeader = jest.fn(() => res);
  return res;
}

// Un "query builder" Supabase factice : chaque methode de chainage renvoie
// le meme objet (thenable), qui resout vers `result` quand il est awaite -
// peu importe la longueur exacte de la chaine (.select().eq().maybeSingle()
// ou juste .eq()).
function makeBuilder(result) {
  const builder = {};
  ['select', 'insert', 'update', 'delete', 'eq', 'in', 'single', 'maybeSingle'].forEach((method) => {
    builder[method] = jest.fn(() => builder);
  });
  builder.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return builder;
}

// Configure supabase.from() pour renvoyer, dans l'ordre, un builder par
// appel attendu (chaque test sait combien de fois et dans quel ordre le
// handler va appeler .from(...)).
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

describe('api/establishments', () => {
  let supabase;

  beforeEach(() => {
    jest.clearAllMocks();
    supabase = {};
    mockExtractBearerToken.mockReturnValue('valid-token');
    mockGetScopedClient.mockReturnValue(supabase);
  });

  test('rejects requests without a Bearer token', async () => {
    mockExtractBearerToken.mockReturnValue(null);
    const req = { method: 'POST', headers: {}, body: {} };
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: 'invalid_token',
      error_description: 'en-tete Authorization: Bearer <token> requis',
    });
  });

  test('rejects unsupported HTTP methods', async () => {
    const req = { method: 'GET', headers: {}, body: {} };
    const res = createRes();
    await handler(req, res);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', 'POST, PATCH, DELETE');
    expect(res.status).toHaveBeenCalledWith(405);
  });

  describe('POST (creation)', () => {
    test('rejects when the token has no editeur_id', async () => {
      mockDecode.mockReturnValue({});
      const req = { method: 'POST', body: { name: 'Bistrot' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(401);
    });

    test('rejects when jwt.decode throws', async () => {
      mockDecode.mockImplementation(() => {
        throw new Error('malformed token');
      });
      const req = { method: 'POST', body: { name: 'Bistrot' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(401);
    });

    test('rejects a missing name', async () => {
      mockDecode.mockReturnValue({ editeur_id: 'editor-1' });
      const req = { method: 'POST', body: {} };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'invalid_request', error_description: 'name requis' });
    });

    test('rejects a blank name', async () => {
      mockDecode.mockReturnValue({ editeur_id: 'editor-1' });
      const req = { method: 'POST', body: { name: '   ' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('rejects an out-of-range foodCostTarget', async () => {
      mockDecode.mockReturnValue({ editeur_id: 'editor-1' });
      const req = { method: 'POST', body: { name: 'Bistrot', foodCostTarget: 150 } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'invalid_request' })
      );
    });

    test('creates an establishment with a slug and default foodCostTarget', async () => {
      mockDecode.mockReturnValue({ editeur_id: 'editor-1' });
      mockFromSequence(supabase, [
        { table: 'establishments', result: { data: { id: 'est-1', name: 'Bistrot du Port', slug: 'bistrot-du-port-abc123', food_cost_target: 30 }, error: null } },
      ]);
      const req = { method: 'POST', body: { name: 'Bistrot du Port' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'est-1', food_cost_target: 30 })
      );
    });

    test('returns 500 on insert error', async () => {
      mockDecode.mockReturnValue({ editeur_id: 'editor-1' });
      mockFromSequence(supabase, [
        { table: 'establishments', result: { data: null, error: { message: 'boom' } } },
      ]);
      const req = { method: 'POST', body: { name: 'Bistrot' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('PATCH (update)', () => {
    test('rejects a missing establishmentId', async () => {
      const req = { method: 'PATCH', query: {}, body: { name: 'New name' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('rejects when no field is provided to update', async () => {
      const req = { method: 'PATCH', query: { establishmentId: 'est-1' }, body: {} };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'invalid_request' })
      );
    });

    test('rejects an invalid foodCostTarget', async () => {
      const req = { method: 'PATCH', query: { establishmentId: 'est-1' }, body: { foodCostTarget: -5 } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('rejects a blank name on update', async () => {
      const req = { method: 'PATCH', query: { establishmentId: 'est-1' }, body: { name: '   ' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error_description: 'name doit etre une chaine non vide' })
      );
    });

    test('updates successfully', async () => {
      mockFromSequence(supabase, [
        { table: 'establishments', result: { data: { id: 'est-1', name: 'New name', slug: 's', food_cost_target: 28 }, error: null } },
      ]);
      const req = { method: 'PATCH', query: { establishmentId: 'est-1' }, body: { name: 'New name', foodCostTarget: 28 } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ name: 'New name' }));
    });

    test('returns 404 when the establishment does not exist', async () => {
      mockFromSequence(supabase, [
        { table: 'establishments', result: { data: null, error: null } },
      ]);
      const req = { method: 'PATCH', query: { establishmentId: 'missing' }, body: { name: 'X' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    test('returns 500 on update error', async () => {
      mockFromSequence(supabase, [
        { table: 'establishments', result: { data: null, error: { message: 'boom' } } },
      ]);
      const req = { method: 'PATCH', query: { establishmentId: 'est-1' }, body: { name: 'X' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('DELETE', () => {
    test('rejects a missing establishmentId', async () => {
      const req = { method: 'DELETE', query: {} };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('returns 404 when the establishment does not exist', async () => {
      mockFromSequence(supabase, [
        { table: 'establishments', result: { data: null, error: null } },
      ]);
      const req = { method: 'DELETE', query: { establishmentId: 'missing' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    test('returns 500 when the initial lookup fails', async () => {
      mockFromSequence(supabase, [
        { table: 'establishments', result: { data: null, error: { message: 'boom' } } },
      ]);
      const req = { method: 'DELETE', query: { establishmentId: 'est-1' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    test('deletes cleanly when the establishment has no menus', async () => {
      mockFromSequence(supabase, [
        { table: 'establishments', result: { data: { id: 'est-1' }, error: null } }, // lookup
        { table: 'menus', result: { data: [], error: null } }, // no menus
        { table: 'ingredients', result: { error: null } }, // ingredients delete
        { table: 'establishments', result: { error: null } }, // final delete
      ]);
      const req = { method: 'DELETE', query: { establishmentId: 'est-1' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(204);
      expect(res.end).toHaveBeenCalled();
    });

    test('cascades through menus, menu_items and recipe_items before deleting', async () => {
      mockFromSequence(supabase, [
        { table: 'establishments', result: { data: { id: 'est-1' }, error: null } }, // lookup
        { table: 'menus', result: { data: [{ id: 'menu-1' }], error: null } },
        { table: 'menu_items', result: { data: [{ id: 'item-1' }], error: null } },
        { table: 'recipe_items', result: { error: null } },
        { table: 'ingredients', result: { error: null } },
        { table: 'establishments', result: { error: null } },
      ]);
      const req = { method: 'DELETE', query: { establishmentId: 'est-1' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(204);
    });

    test('returns 500 when the final delete fails', async () => {
      mockFromSequence(supabase, [
        { table: 'establishments', result: { data: { id: 'est-1' }, error: null } },
        { table: 'menus', result: { data: [], error: null } },
        { table: 'ingredients', result: { error: null } },
        { table: 'establishments', result: { error: { message: 'boom' } } },
      ]);
      const req = { method: 'DELETE', query: { establishmentId: 'est-1' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    test('returns 500 when the menus lookup fails', async () => {
      mockFromSequence(supabase, [
        { table: 'establishments', result: { data: { id: 'est-1' }, error: null } },
        { table: 'menus', result: { data: null, error: { message: 'boom' } } },
      ]);
      const req = { method: 'DELETE', query: { establishmentId: 'est-1' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    test('returns 500 when the menu_items lookup fails', async () => {
      mockFromSequence(supabase, [
        { table: 'establishments', result: { data: { id: 'est-1' }, error: null } },
        { table: 'menus', result: { data: [{ id: 'menu-1' }], error: null } },
        { table: 'menu_items', result: { data: null, error: { message: 'boom' } } },
      ]);
      const req = { method: 'DELETE', query: { establishmentId: 'est-1' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    test('returns 500 when deleting recipe_items fails', async () => {
      mockFromSequence(supabase, [
        { table: 'establishments', result: { data: { id: 'est-1' }, error: null } },
        { table: 'menus', result: { data: [{ id: 'menu-1' }], error: null } },
        { table: 'menu_items', result: { data: [{ id: 'item-1' }], error: null } },
        { table: 'recipe_items', result: { error: { message: 'boom' } } },
      ]);
      const req = { method: 'DELETE', query: { establishmentId: 'est-1' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    test('returns 500 when deleting ingredients fails', async () => {
      mockFromSequence(supabase, [
        { table: 'establishments', result: { data: { id: 'est-1' }, error: null } },
        { table: 'menus', result: { data: [], error: null } },
        { table: 'ingredients', result: { error: { message: 'boom' } } },
      ]);
      const req = { method: 'DELETE', query: { establishmentId: 'est-1' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });
});
