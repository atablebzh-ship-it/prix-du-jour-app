const mockExtractBearerToken = jest.fn();
const mockGetScopedClient = jest.fn();
jest.mock('../lib/supabase', () => ({
  extractBearerToken: (...args) => mockExtractBearerToken(...args),
  getScopedClient: (...args) => mockGetScopedClient(...args),
}));

const handler = require('../api/establishments/[establishmentId]/menus/[menuId]/menu-items/index');

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
  ['select', 'insert', 'update', 'delete', 'eq', 'order', 'limit', 'single', 'maybeSingle'].forEach((method) => {
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

const MENU_OK = { table: 'menus', result: { data: { id: 'menu-1', establishment_id: 'est-1' }, error: null } };

describe('api/establishments/[establishmentId]/menus/[menuId]/menu-items', () => {
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

  test('rejects a missing establishmentId or menuId', async () => {
    const req = { method: 'POST', query: { establishmentId: 'est-1' }, body: {} };
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('returns 500 when the menu lookup fails', async () => {
    mockFromSequence(supabase, [
      { table: 'menus', result: { data: null, error: { message: 'boom' } } },
    ]);
    const req = { method: 'POST', query: { establishmentId: 'est-1', menuId: 'menu-1' }, body: {} };
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  test('returns 404 when the menu does not exist', async () => {
    mockFromSequence(supabase, [
      { table: 'menus', result: { data: null, error: null } },
    ]);
    const req = { method: 'POST', query: { establishmentId: 'est-1', menuId: 'missing' }, body: {} };
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('returns 404 when the menu belongs to a different establishment', async () => {
    mockFromSequence(supabase, [
      { table: 'menus', result: { data: { id: 'menu-1', establishment_id: 'other-est' }, error: null } },
    ]);
    const req = { method: 'POST', query: { establishmentId: 'est-1', menuId: 'menu-1' }, body: {} };
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('rejects unsupported HTTP methods', async () => {
    mockFromSequence(supabase, [MENU_OK]);
    const req = { method: 'GET', query: { establishmentId: 'est-1', menuId: 'menu-1' } };
    const res = createRes();
    await handler(req, res);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', 'POST, PATCH, DELETE');
    expect(res.status).toHaveBeenCalledWith(405);
  });

  describe('POST (creation)', () => {
    test('rejects a missing name', async () => {
      mockFromSequence(supabase, [MENU_OK]);
      const req = { method: 'POST', query: { establishmentId: 'est-1', menuId: 'menu-1' }, body: { price: 22 } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('rejects a missing or invalid price', async () => {
      mockFromSequence(supabase, [MENU_OK]);
      const req = { method: 'POST', query: { establishmentId: 'est-1', menuId: 'menu-1' }, body: { name: 'Risotto', price: -5 } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('rejects a non-string description', async () => {
      mockFromSequence(supabase, [MENU_OK]);
      const req = { method: 'POST', query: { establishmentId: 'est-1', menuId: 'menu-1' }, body: { name: 'Risotto', price: 22, description: 42 } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('rejects an invalid explicit position', async () => {
      mockFromSequence(supabase, [MENU_OK]);
      const req = { method: 'POST', query: { establishmentId: 'est-1', menuId: 'menu-1' }, body: { name: 'Risotto', price: 22, position: 0 } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('auto-computes position from the last existing item', async () => {
      mockFromSequence(supabase, [
        MENU_OK,
        { table: 'menu_items', result: { data: { position: 4 }, error: null } },
        { table: 'menu_items', result: { data: { id: 'item-2', name: 'Turbot', description: null, price: 39, position: 5 }, error: null } },
      ]);
      const req = { method: 'POST', query: { establishmentId: 'est-1', menuId: 'menu-1' }, body: { name: 'Turbot', price: 39 } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ position: 5 }));
    });

    test('defaults position to 1 when the menu is empty', async () => {
      mockFromSequence(supabase, [
        MENU_OK,
        { table: 'menu_items', result: { data: null, error: null } },
        { table: 'menu_items', result: { data: { id: 'item-1', name: 'Risotto', description: null, price: 22, position: 1 }, error: null } },
      ]);
      const req = { method: 'POST', query: { establishmentId: 'est-1', menuId: 'menu-1' }, body: { name: 'Risotto', price: 22 } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ position: 1 }));
    });

    test('returns 500 when the last-position lookup fails', async () => {
      mockFromSequence(supabase, [
        MENU_OK,
        { table: 'menu_items', result: { data: null, error: { message: 'boom' } } },
      ]);
      const req = { method: 'POST', query: { establishmentId: 'est-1', menuId: 'menu-1' }, body: { name: 'Risotto', price: 22 } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    test('returns 500 on insert error', async () => {
      mockFromSequence(supabase, [
        MENU_OK,
        { table: 'menu_items', result: { data: null, error: null } },
        { table: 'menu_items', result: { data: null, error: { message: 'boom' } } },
      ]);
      const req = { method: 'POST', query: { establishmentId: 'est-1', menuId: 'menu-1' }, body: { name: 'Risotto', price: 22 } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('PATCH (update)', () => {
    test('rejects a missing menuItemId', async () => {
      mockFromSequence(supabase, [MENU_OK]);
      const req = { method: 'PATCH', query: { establishmentId: 'est-1', menuId: 'menu-1' }, body: { name: 'X' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('rejects when no field is provided', async () => {
      mockFromSequence(supabase, [MENU_OK]);
      const req = { method: 'PATCH', query: { establishmentId: 'est-1', menuId: 'menu-1', menuItemId: 'item-1' }, body: {} };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('rejects a blank name', async () => {
      mockFromSequence(supabase, [MENU_OK]);
      const req = { method: 'PATCH', query: { establishmentId: 'est-1', menuId: 'menu-1', menuItemId: 'item-1' }, body: { name: '  ' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('rejects an invalid description type', async () => {
      mockFromSequence(supabase, [MENU_OK]);
      const req = { method: 'PATCH', query: { establishmentId: 'est-1', menuId: 'menu-1', menuItemId: 'item-1' }, body: { description: 42 } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('rejects an invalid price', async () => {
      mockFromSequence(supabase, [MENU_OK]);
      const req = { method: 'PATCH', query: { establishmentId: 'est-1', menuId: 'menu-1', menuItemId: 'item-1' }, body: { price: 0 } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('rejects an invalid position', async () => {
      mockFromSequence(supabase, [MENU_OK]);
      const req = { method: 'PATCH', query: { establishmentId: 'est-1', menuId: 'menu-1', menuItemId: 'item-1' }, body: { position: -1 } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('accepts a null description to clear it', async () => {
      mockFromSequence(supabase, [
        MENU_OK,
        { table: 'menu_items', result: { data: { id: 'item-1', name: 'Risotto', description: null, price: 22, position: 1 }, error: null } },
      ]);
      const req = { method: 'PATCH', query: { establishmentId: 'est-1', menuId: 'menu-1', menuItemId: 'item-1' }, body: { description: null } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    test('updates successfully', async () => {
      mockFromSequence(supabase, [
        MENU_OK,
        { table: 'menu_items', result: { data: { id: 'item-1', name: 'Risotto royal', description: null, price: 24, position: 1 }, error: null } },
      ]);
      const req = { method: 'PATCH', query: { establishmentId: 'est-1', menuId: 'menu-1', menuItemId: 'item-1' }, body: { name: 'Risotto royal', price: 24 } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    test('returns 404 when the item does not exist', async () => {
      mockFromSequence(supabase, [
        MENU_OK,
        { table: 'menu_items', result: { data: null, error: null } },
      ]);
      const req = { method: 'PATCH', query: { establishmentId: 'est-1', menuId: 'menu-1', menuItemId: 'missing' }, body: { name: 'X' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    test('returns 500 on update error', async () => {
      mockFromSequence(supabase, [
        MENU_OK,
        { table: 'menu_items', result: { data: null, error: { message: 'boom' } } },
      ]);
      const req = { method: 'PATCH', query: { establishmentId: 'est-1', menuId: 'menu-1', menuItemId: 'item-1' }, body: { name: 'X' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('DELETE', () => {
    test('rejects a missing menuItemId', async () => {
      mockFromSequence(supabase, [MENU_OK]);
      const req = { method: 'DELETE', query: { establishmentId: 'est-1', menuId: 'menu-1' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('returns 500 when the lookup fails', async () => {
      mockFromSequence(supabase, [
        MENU_OK,
        { table: 'menu_items', result: { data: null, error: { message: 'boom' } } },
      ]);
      const req = { method: 'DELETE', query: { establishmentId: 'est-1', menuId: 'menu-1', menuItemId: 'item-1' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    test('returns 404 when the item does not exist', async () => {
      mockFromSequence(supabase, [
        MENU_OK,
        { table: 'menu_items', result: { data: null, error: null } },
      ]);
      const req = { method: 'DELETE', query: { establishmentId: 'est-1', menuId: 'menu-1', menuItemId: 'missing' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    test('returns 500 when deleting recipe_items fails', async () => {
      mockFromSequence(supabase, [
        MENU_OK,
        { table: 'menu_items', result: { data: { id: 'item-1' }, error: null } },
        { table: 'recipe_items', result: { error: { message: 'boom' } } },
      ]);
      const req = { method: 'DELETE', query: { establishmentId: 'est-1', menuId: 'menu-1', menuItemId: 'item-1' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    test('deletes successfully', async () => {
      mockFromSequence(supabase, [
        MENU_OK,
        { table: 'menu_items', result: { data: { id: 'item-1' }, error: null } },
        { table: 'recipe_items', result: { error: null } },
        { table: 'menu_items', result: { error: null } },
      ]);
      const req = { method: 'DELETE', query: { establishmentId: 'est-1', menuId: 'menu-1', menuItemId: 'item-1' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(204);
    });

    test('returns 500 when the final delete fails', async () => {
      mockFromSequence(supabase, [
        MENU_OK,
        { table: 'menu_items', result: { data: { id: 'item-1' }, error: null } },
        { table: 'recipe_items', result: { error: null } },
        { table: 'menu_items', result: { error: { message: 'boom' } } },
      ]);
      const req = { method: 'DELETE', query: { establishmentId: 'est-1', menuId: 'menu-1', menuItemId: 'item-1' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });
});
