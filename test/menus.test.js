const mockExtractBearerToken = jest.fn();
const mockGetScopedClient = jest.fn();
jest.mock('../lib/supabase', () => ({
  extractBearerToken: (...args) => mockExtractBearerToken(...args),
  getScopedClient: (...args) => mockGetScopedClient(...args),
}));

const handler = require('../api/establishments/[establishmentId]/menus/index');

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
  ['select', 'insert', 'update', 'delete', 'eq', 'in', 'order', 'limit', 'single', 'maybeSingle'].forEach((method) => {
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

describe('api/establishments/[establishmentId]/menus', () => {
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
    const req = { method: 'POST', query: { establishmentId: 'est-1' }, body: { name: 'Carte' } };
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  test('returns 404 when the establishment does not exist', async () => {
    mockFromSequence(supabase, [
      { table: 'establishments', result: { data: null, error: null } },
    ]);
    const req = { method: 'POST', query: { establishmentId: 'missing' }, body: { name: 'Carte' } };
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
      const req = { method: 'POST', query: { establishmentId: 'est-1' }, body: {} };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('rejects an invalid explicit position', async () => {
      mockFromSequence(supabase, [ESTABLISHMENT_OK]);
      const req = { method: 'POST', query: { establishmentId: 'est-1' }, body: { name: 'Carte', position: 0 } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('auto-computes position from the last existing menu', async () => {
      mockFromSequence(supabase, [
        ESTABLISHMENT_OK,
        { table: 'menus', result: { data: { position: 2 }, error: null } },
        { table: 'menus', result: { data: { id: 'menu-2', name: 'Carte des vins', is_active: true, position: 3 }, error: null } },
      ]);
      const req = { method: 'POST', query: { establishmentId: 'est-1' }, body: { name: 'Carte des vins' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ position: 3 }));
    });

    test('defaults position to 1 when no menu exists yet', async () => {
      mockFromSequence(supabase, [
        ESTABLISHMENT_OK,
        { table: 'menus', result: { data: null, error: null } },
        { table: 'menus', result: { data: { id: 'menu-1', name: 'Carte principale', is_active: true, position: 1 }, error: null } },
      ]);
      const req = { method: 'POST', query: { establishmentId: 'est-1' }, body: { name: 'Carte principale' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ position: 1 }));
    });

    test('returns 500 when the last-position lookup fails', async () => {
      mockFromSequence(supabase, [
        ESTABLISHMENT_OK,
        { table: 'menus', result: { data: null, error: { message: 'boom' } } },
      ]);
      const req = { method: 'POST', query: { establishmentId: 'est-1' }, body: { name: 'Carte' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    test('returns 500 on insert error', async () => {
      mockFromSequence(supabase, [
        ESTABLISHMENT_OK,
        { table: 'menus', result: { data: null, error: null } },
        { table: 'menus', result: { data: null, error: { message: 'boom' } } },
      ]);
      const req = { method: 'POST', query: { establishmentId: 'est-1' }, body: { name: 'Carte' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    test('accepts an explicit valid position and skips the lookup', async () => {
      mockFromSequence(supabase, [
        ESTABLISHMENT_OK,
        { table: 'menus', result: { data: { id: 'menu-5', name: 'Menu brunch', is_active: true, position: 5 }, error: null } },
      ]);
      const req = { method: 'POST', query: { establishmentId: 'est-1' }, body: { name: 'Menu brunch', position: 5 } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(201);
    });
  });

  describe('PATCH (update)', () => {
    test('rejects a missing menuId', async () => {
      mockFromSequence(supabase, [ESTABLISHMENT_OK]);
      const req = { method: 'PATCH', query: { establishmentId: 'est-1' }, body: { name: 'X' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('rejects when no field is provided', async () => {
      mockFromSequence(supabase, [ESTABLISHMENT_OK]);
      const req = { method: 'PATCH', query: { establishmentId: 'est-1', menuId: 'menu-1' }, body: {} };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('rejects a blank name', async () => {
      mockFromSequence(supabase, [ESTABLISHMENT_OK]);
      const req = { method: 'PATCH', query: { establishmentId: 'est-1', menuId: 'menu-1' }, body: { name: '  ' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('rejects an invalid position', async () => {
      mockFromSequence(supabase, [ESTABLISHMENT_OK]);
      const req = { method: 'PATCH', query: { establishmentId: 'est-1', menuId: 'menu-1' }, body: { position: -1 } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('updates successfully', async () => {
      mockFromSequence(supabase, [
        ESTABLISHMENT_OK,
        { table: 'menus', result: { data: { id: 'menu-1', name: 'New name', is_active: true, position: 1 }, error: null } },
      ]);
      const req = { method: 'PATCH', query: { establishmentId: 'est-1', menuId: 'menu-1' }, body: { name: 'New name', isActive: true } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    test('returns 404 when the menu does not exist', async () => {
      mockFromSequence(supabase, [
        ESTABLISHMENT_OK,
        { table: 'menus', result: { data: null, error: null } },
      ]);
      const req = { method: 'PATCH', query: { establishmentId: 'est-1', menuId: 'missing' }, body: { name: 'X' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    test('returns 500 on update error', async () => {
      mockFromSequence(supabase, [
        ESTABLISHMENT_OK,
        { table: 'menus', result: { data: null, error: { message: 'boom' } } },
      ]);
      const req = { method: 'PATCH', query: { establishmentId: 'est-1', menuId: 'menu-1' }, body: { name: 'X' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('DELETE', () => {
    test('rejects a missing menuId', async () => {
      mockFromSequence(supabase, [ESTABLISHMENT_OK]);
      const req = { method: 'DELETE', query: { establishmentId: 'est-1' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('returns 500 when the menu lookup fails', async () => {
      mockFromSequence(supabase, [
        ESTABLISHMENT_OK,
        { table: 'menus', result: { data: null, error: { message: 'boom' } } },
      ]);
      const req = { method: 'DELETE', query: { establishmentId: 'est-1', menuId: 'menu-1' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    test('returns 404 when the menu does not exist', async () => {
      mockFromSequence(supabase, [
        ESTABLISHMENT_OK,
        { table: 'menus', result: { data: null, error: null } },
      ]);
      const req = { method: 'DELETE', query: { establishmentId: 'est-1', menuId: 'missing' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    test('returns 500 when the menu_items lookup fails', async () => {
      mockFromSequence(supabase, [
        ESTABLISHMENT_OK,
        { table: 'menus', result: { data: { id: 'menu-1' }, error: null } },
        { table: 'menu_items', result: { data: null, error: { message: 'boom' } } },
      ]);
      const req = { method: 'DELETE', query: { establishmentId: 'est-1', menuId: 'menu-1' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    test('deletes cleanly when the menu has no items', async () => {
      mockFromSequence(supabase, [
        ESTABLISHMENT_OK,
        { table: 'menus', result: { data: { id: 'menu-1' }, error: null } },
        { table: 'menu_items', result: { data: [], error: null } },
        { table: 'menus', result: { error: null } },
      ]);
      const req = { method: 'DELETE', query: { establishmentId: 'est-1', menuId: 'menu-1' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(204);
    });

    test('cascades through recipe_items when the menu has items', async () => {
      mockFromSequence(supabase, [
        ESTABLISHMENT_OK,
        { table: 'menus', result: { data: { id: 'menu-1' }, error: null } },
        { table: 'menu_items', result: { data: [{ id: 'item-1' }], error: null } },
        { table: 'recipe_items', result: { error: null } },
        { table: 'menus', result: { error: null } },
      ]);
      const req = { method: 'DELETE', query: { establishmentId: 'est-1', menuId: 'menu-1' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(204);
    });

    test('returns 500 when deleting recipe_items fails', async () => {
      mockFromSequence(supabase, [
        ESTABLISHMENT_OK,
        { table: 'menus', result: { data: { id: 'menu-1' }, error: null } },
        { table: 'menu_items', result: { data: [{ id: 'item-1' }], error: null } },
        { table: 'recipe_items', result: { error: { message: 'boom' } } },
      ]);
      const req = { method: 'DELETE', query: { establishmentId: 'est-1', menuId: 'menu-1' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    test('returns 500 when the final delete fails', async () => {
      mockFromSequence(supabase, [
        ESTABLISHMENT_OK,
        { table: 'menus', result: { data: { id: 'menu-1' }, error: null } },
        { table: 'menu_items', result: { data: [], error: null } },
        { table: 'menus', result: { error: { message: 'boom' } } },
      ]);
      const req = { method: 'DELETE', query: { establishmentId: 'est-1', menuId: 'menu-1' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });
});
