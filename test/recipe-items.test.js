const mockExtractBearerToken = jest.fn();
const mockGetScopedClient = jest.fn();
jest.mock('../lib/supabase', () => ({
  extractBearerToken: (...args) => mockExtractBearerToken(...args),
  getScopedClient: (...args) => mockGetScopedClient(...args),
}));

const handler = require('../api/establishments/[establishmentId]/menu-items/[menuItemId]/recipe-items/index');

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

const MENU_ITEM_OK = {
  table: 'menu_items',
  result: { data: { id: 'item-1', menu_id: 'menu-1', menus: { establishment_id: 'est-1' } }, error: null },
};

describe('api/establishments/[establishmentId]/menu-items/[menuItemId]/recipe-items', () => {
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

  test('rejects a missing establishmentId or menuItemId', async () => {
    const req = { method: 'POST', query: { establishmentId: 'est-1' }, body: {} };
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('returns 500 when the menu_item lookup fails', async () => {
    mockFromSequence(supabase, [
      { table: 'menu_items', result: { data: null, error: { message: 'boom' } } },
    ]);
    const req = { method: 'POST', query: { establishmentId: 'est-1', menuItemId: 'item-1' }, body: {} };
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  test('returns 404 when the menu item does not exist', async () => {
    mockFromSequence(supabase, [
      { table: 'menu_items', result: { data: null, error: null } },
    ]);
    const req = { method: 'POST', query: { establishmentId: 'est-1', menuItemId: 'missing' }, body: {} };
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('returns 404 when the menu item belongs to a different establishment', async () => {
    mockFromSequence(supabase, [
      { table: 'menu_items', result: { data: { id: 'item-1', menu_id: 'menu-1', menus: { establishment_id: 'other-est' } }, error: null } },
    ]);
    const req = { method: 'POST', query: { establishmentId: 'est-1', menuItemId: 'item-1' }, body: {} };
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('rejects unsupported HTTP methods', async () => {
    mockFromSequence(supabase, [MENU_ITEM_OK]);
    const req = { method: 'GET', query: { establishmentId: 'est-1', menuItemId: 'item-1' } };
    const res = createRes();
    await handler(req, res);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', 'POST, PATCH, DELETE');
    expect(res.status).toHaveBeenCalledWith(405);
  });

  describe('POST (creation)', () => {
    test('rejects a missing ingredientId', async () => {
      mockFromSequence(supabase, [MENU_ITEM_OK]);
      const req = { method: 'POST', query: { establishmentId: 'est-1', menuItemId: 'item-1' }, body: { quantity: 0.4, unit: 'kg' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('rejects an invalid quantity', async () => {
      mockFromSequence(supabase, [MENU_ITEM_OK]);
      const req = { method: 'POST', query: { establishmentId: 'est-1', menuItemId: 'item-1' }, body: { ingredientId: 'ing-1', quantity: -1, unit: 'kg' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('rejects a missing unit', async () => {
      mockFromSequence(supabase, [MENU_ITEM_OK]);
      const req = { method: 'POST', query: { establishmentId: 'est-1', menuItemId: 'item-1' }, body: { ingredientId: 'ing-1', quantity: 0.4 } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('returns 500 when the ingredient lookup fails', async () => {
      mockFromSequence(supabase, [
        MENU_ITEM_OK,
        { table: 'ingredients', result: { data: null, error: { message: 'boom' } } },
      ]);
      const req = { method: 'POST', query: { establishmentId: 'est-1', menuItemId: 'item-1' }, body: { ingredientId: 'ing-1', quantity: 0.4, unit: 'kg' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    test('returns 404 when the ingredient does not exist', async () => {
      mockFromSequence(supabase, [
        MENU_ITEM_OK,
        { table: 'ingredients', result: { data: null, error: null } },
      ]);
      const req = { method: 'POST', query: { establishmentId: 'est-1', menuItemId: 'item-1' }, body: { ingredientId: 'missing', quantity: 0.4, unit: 'kg' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    test('returns 404 when the ingredient belongs to a different establishment', async () => {
      mockFromSequence(supabase, [
        MENU_ITEM_OK,
        { table: 'ingredients', result: { data: { id: 'ing-1', establishment_id: 'other-est' }, error: null } },
      ]);
      const req = { method: 'POST', query: { establishmentId: 'est-1', menuItemId: 'item-1' }, body: { ingredientId: 'ing-1', quantity: 0.4, unit: 'kg' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    test('creates a recipe item successfully', async () => {
      mockFromSequence(supabase, [
        MENU_ITEM_OK,
        { table: 'ingredients', result: { data: { id: 'ing-1', establishment_id: 'est-1' }, error: null } },
        { table: 'recipe_items', result: { data: { id: 'ri-1', menu_item_id: 'item-1', ingredient_id: 'ing-1', quantity: 0.4, unit: 'kg' }, error: null } },
      ]);
      const req = { method: 'POST', query: { establishmentId: 'est-1', menuItemId: 'item-1' }, body: { ingredientId: 'ing-1', quantity: 0.4, unit: 'kg' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(201);
    });

    test('returns 500 on insert error', async () => {
      mockFromSequence(supabase, [
        MENU_ITEM_OK,
        { table: 'ingredients', result: { data: { id: 'ing-1', establishment_id: 'est-1' }, error: null } },
        { table: 'recipe_items', result: { data: null, error: { message: 'boom' } } },
      ]);
      const req = { method: 'POST', query: { establishmentId: 'est-1', menuItemId: 'item-1' }, body: { ingredientId: 'ing-1', quantity: 0.4, unit: 'kg' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('PATCH (update)', () => {
    test('rejects a missing recipeItemId', async () => {
      mockFromSequence(supabase, [MENU_ITEM_OK]);
      const req = { method: 'PATCH', query: { establishmentId: 'est-1', menuItemId: 'item-1' }, body: { quantity: 0.5 } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('rejects when no field is provided', async () => {
      mockFromSequence(supabase, [MENU_ITEM_OK]);
      const req = { method: 'PATCH', query: { establishmentId: 'est-1', menuItemId: 'item-1', recipeItemId: 'ri-1' }, body: {} };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('rejects an invalid quantity', async () => {
      mockFromSequence(supabase, [MENU_ITEM_OK]);
      const req = { method: 'PATCH', query: { establishmentId: 'est-1', menuItemId: 'item-1', recipeItemId: 'ri-1' }, body: { quantity: 0 } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('rejects a blank unit', async () => {
      mockFromSequence(supabase, [MENU_ITEM_OK]);
      const req = { method: 'PATCH', query: { establishmentId: 'est-1', menuItemId: 'item-1', recipeItemId: 'ri-1' }, body: { unit: '  ' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('updates successfully', async () => {
      mockFromSequence(supabase, [
        MENU_ITEM_OK,
        { table: 'recipe_items', result: { data: { id: 'ri-1', menu_item_id: 'item-1', ingredient_id: 'ing-1', quantity: 0.5, unit: 'kg' }, error: null } },
      ]);
      const req = { method: 'PATCH', query: { establishmentId: 'est-1', menuItemId: 'item-1', recipeItemId: 'ri-1' }, body: { quantity: 0.5 } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    test('returns 404 when the recipe item does not exist', async () => {
      mockFromSequence(supabase, [
        MENU_ITEM_OK,
        { table: 'recipe_items', result: { data: null, error: null } },
      ]);
      const req = { method: 'PATCH', query: { establishmentId: 'est-1', menuItemId: 'item-1', recipeItemId: 'missing' }, body: { quantity: 0.5 } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    test('returns 500 on update error', async () => {
      mockFromSequence(supabase, [
        MENU_ITEM_OK,
        { table: 'recipe_items', result: { data: null, error: { message: 'boom' } } },
      ]);
      const req = { method: 'PATCH', query: { establishmentId: 'est-1', menuItemId: 'item-1', recipeItemId: 'ri-1' }, body: { quantity: 0.5 } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('DELETE', () => {
    test('rejects a missing recipeItemId', async () => {
      mockFromSequence(supabase, [MENU_ITEM_OK]);
      const req = { method: 'DELETE', query: { establishmentId: 'est-1', menuItemId: 'item-1' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('returns 500 when the lookup fails', async () => {
      mockFromSequence(supabase, [
        MENU_ITEM_OK,
        { table: 'recipe_items', result: { data: null, error: { message: 'boom' } } },
      ]);
      const req = { method: 'DELETE', query: { establishmentId: 'est-1', menuItemId: 'item-1', recipeItemId: 'ri-1' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    test('returns 404 when the recipe item does not exist', async () => {
      mockFromSequence(supabase, [
        MENU_ITEM_OK,
        { table: 'recipe_items', result: { data: null, error: null } },
      ]);
      const req = { method: 'DELETE', query: { establishmentId: 'est-1', menuItemId: 'item-1', recipeItemId: 'missing' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    test('deletes successfully', async () => {
      mockFromSequence(supabase, [
        MENU_ITEM_OK,
        { table: 'recipe_items', result: { data: { id: 'ri-1' }, error: null } },
        { table: 'recipe_items', result: { error: null } },
      ]);
      const req = { method: 'DELETE', query: { establishmentId: 'est-1', menuItemId: 'item-1', recipeItemId: 'ri-1' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(204);
    });

    test('returns 500 when the final delete fails', async () => {
      mockFromSequence(supabase, [
        MENU_ITEM_OK,
        { table: 'recipe_items', result: { data: { id: 'ri-1' }, error: null } },
        { table: 'recipe_items', result: { error: { message: 'boom' } } },
      ]);
      const req = { method: 'DELETE', query: { establishmentId: 'est-1', menuItemId: 'item-1', recipeItemId: 'ri-1' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });
});
