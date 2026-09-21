const mockExtractBearerToken = jest.fn();
const mockGetScopedClient = jest.fn();
jest.mock('../lib/supabase', () => ({
  extractBearerToken: (...args) => mockExtractBearerToken(...args),
  getScopedClient: (...args) => mockGetScopedClient(...args),
}));

const handler = require('../api/establishments/[establishmentId]/menu-items/[menuItemId]/viability');

function createRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  res.setHeader = jest.fn(() => res);
  return res;
}

function makeSelectBuilder(result) {
  const builder = {};
  ['select', 'eq', 'maybeSingle'].forEach((method) => {
    builder[method] = jest.fn(() => builder);
  });
  builder.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return builder;
}

const MENU_ITEM_OK = { data: { id: 'item-1', menu_id: 'menu-1', menus: { establishment_id: 'est-1' } }, error: null };

describe('GET .../menu-items/{menuItemId}/viability', () => {
  let supabase;

  beforeEach(() => {
    jest.clearAllMocks();
    supabase = { from: jest.fn(), rpc: jest.fn() };
    mockExtractBearerToken.mockReturnValue('valid-token');
    mockGetScopedClient.mockReturnValue(supabase);
  });

  test('rejects non-GET methods', async () => {
    const req = { method: 'POST', query: {} };
    const res = createRes();
    await handler(req, res);
    expect(res.setHeader).toHaveBeenCalledWith('Allow', 'GET');
    expect(res.status).toHaveBeenCalledWith(405);
  });

  test('rejects requests without a Bearer token', async () => {
    mockExtractBearerToken.mockReturnValue(null);
    const req = { method: 'GET', query: {} };
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('rejects a missing establishmentId or menuItemId', async () => {
    const req = { method: 'GET', query: { establishmentId: 'est-1' } };
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('returns 500 when the menu_item lookup fails', async () => {
    supabase.from.mockReturnValue(makeSelectBuilder({ data: null, error: { message: 'boom' } }));
    const req = { method: 'GET', query: { establishmentId: 'est-1', menuItemId: 'item-1' } };
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  test('returns 404 when the menu item does not exist', async () => {
    supabase.from.mockReturnValue(makeSelectBuilder({ data: null, error: null }));
    const req = { method: 'GET', query: { establishmentId: 'est-1', menuItemId: 'missing' } };
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('returns 404 when the menu item belongs to a different establishment', async () => {
    supabase.from.mockReturnValue(
      makeSelectBuilder({ data: { id: 'item-1', menu_id: 'menu-1', menus: { establishment_id: 'other-est' } }, error: null })
    );
    const req = { method: 'GET', query: { establishmentId: 'est-1', menuItemId: 'item-1' } };
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('returns 500 when the RPC call fails', async () => {
    supabase.from.mockReturnValue(makeSelectBuilder(MENU_ITEM_OK));
    supabase.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const req = { method: 'GET', query: { establishmentId: 'est-1', menuItemId: 'item-1' } };
    const res = createRes();
    await handler(req, res);
    expect(supabase.rpc).toHaveBeenCalledWith('menu_item_viability', { p_menu_item_id: 'item-1' });
    expect(res.status).toHaveBeenCalledWith(500);
  });

  test('returns 404 when the RPC returns no row', async () => {
    supabase.from.mockReturnValue(makeSelectBuilder(MENU_ITEM_OK));
    supabase.rpc.mockResolvedValue({ data: [], error: null });
    const req = { method: 'GET', query: { establishmentId: 'est-1', menuItemId: 'item-1' } };
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('unwraps the first row when the RPC returns an array', async () => {
    supabase.from.mockReturnValue(makeSelectBuilder(MENU_ITEM_OK));
    supabase.rpc.mockResolvedValue({
      data: [
        {
          menu_item_id: 'item-1',
          price: 22,
          estimated_cost: 6.5,
          food_cost_pct: 29.5,
          food_cost_target: 30,
          viable: true,
          fiche_technique_incomplete: false,
          cost_incomplete: false,
          missing_ingredients_count: 0,
        },
      ],
      error: null,
    });
    const req = { method: 'GET', query: { establishmentId: 'est-1', menuItemId: 'item-1' } };
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      menu_item_id: 'item-1',
      price: 22,
      estimated_cost: 6.5,
      food_cost_pct: 29.5,
      food_cost_target: 30,
      viable: true,
      fiche_technique_incomplete: false,
      cost_incomplete: false,
      missing_ingredients_count: 0,
    });
  });

  test('accepts the RPC result as a plain object (non-array)', async () => {
    supabase.from.mockReturnValue(makeSelectBuilder(MENU_ITEM_OK));
    supabase.rpc.mockResolvedValue({
      data: {
        menu_item_id: 'item-1',
        price: 22,
        estimated_cost: null,
        food_cost_pct: null,
        food_cost_target: 30,
        viable: null,
        fiche_technique_incomplete: true,
        cost_incomplete: false,
        missing_ingredients_count: 2,
      },
      error: null,
    });
    const req = { method: 'GET', query: { establishmentId: 'est-1', menuItemId: 'item-1' } };
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ viable: null, fiche_technique_incomplete: true, missing_ingredients_count: 2 })
    );
  });
});
