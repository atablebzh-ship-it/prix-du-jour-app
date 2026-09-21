const mockExtractBearerToken = jest.fn();
const mockGetScopedClient = jest.fn();
jest.mock('../lib/supabase', () => ({
  extractBearerToken: (...args) => mockExtractBearerToken(...args),
  getScopedClient: (...args) => mockGetScopedClient(...args),
}));

const handler = require('../api/establishments/[establishmentId]/menu-items/[menuItemId]/price-simulation');

function createRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  res.setHeader = jest.fn(() => res);
  return res;
}

function makeBuilder(result) {
  const builder = {};
  ['select', 'eq', 'gte', 'lte', 'maybeSingle'].forEach((method) => {
    builder[method] = jest.fn(() => builder);
  });
  builder.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return builder;
}

const MENU_ITEM_OK = { data: { id: 'item-1', menu_id: 'menu-1', menus: { establishment_id: 'est-1' } }, error: null };

const VIABILITY_OK = {
  data: [
    {
      menu_item_id: 'item-1',
      price: 20,
      estimated_cost: 8,
      food_cost_pct: 40,
      food_cost_target: 30,
      viable: false,
    },
  ],
  error: null,
};

function baseReq(overrides = {}) {
  return {
    method: 'GET',
    query: {
      establishmentId: 'est-1',
      menuItemId: 'item-1',
      newPrice: '25',
      periodStart: '2026-09-01',
      periodEnd: '2026-09-10',
      ...overrides,
    },
  };
}

describe('GET .../menu-items/{menuItemId}/price-simulation', () => {
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

  test('rejects a missing newPrice', async () => {
    const req = baseReq({ newPrice: undefined });
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('rejects a non-positive newPrice', async () => {
    const req = baseReq({ newPrice: '0' });
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('rejects a period with only one bound provided', async () => {
    const req = baseReq({ periodEnd: undefined });
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('rejects a malformed date', async () => {
    const req = baseReq({ periodStart: '01-09-2026' });
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('rejects periodStart after periodEnd', async () => {
    const req = baseReq({ periodStart: '2026-09-20', periodEnd: '2026-09-10' });
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('defaults to a trailing 30-day period when both bounds are omitted', async () => {
    supabase.from.mockReturnValueOnce(makeBuilder(MENU_ITEM_OK));
    supabase.rpc.mockResolvedValue(VIABILITY_OK);
    supabase.from.mockReturnValueOnce(makeBuilder({ data: [], error: null }));
    const req = baseReq({ periodStart: undefined, periodEnd: undefined });
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const payload = res.json.mock.calls[0][0];
    expect(payload.period_start < payload.period_end).toBe(true);
  });

  test('returns 500 when the menu_item lookup fails', async () => {
    supabase.from.mockReturnValueOnce(makeBuilder({ data: null, error: { message: 'boom' } }));
    const req = baseReq();
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  test('returns 404 when the menu item does not belong to the establishment', async () => {
    supabase.from.mockReturnValueOnce(
      makeBuilder({ data: { id: 'item-1', menu_id: 'menu-1', menus: { establishment_id: 'other-est' } }, error: null })
    );
    const req = baseReq();
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('returns 500 when the viability RPC fails', async () => {
    supabase.from.mockReturnValueOnce(makeBuilder(MENU_ITEM_OK));
    supabase.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const req = baseReq();
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  test('returns 404 when the viability RPC returns no row', async () => {
    supabase.from.mockReturnValueOnce(makeBuilder(MENU_ITEM_OK));
    supabase.rpc.mockResolvedValue({ data: [], error: null });
    const req = baseReq();
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('returns 422 when the estimated cost is incomplete', async () => {
    supabase.from.mockReturnValueOnce(makeBuilder(MENU_ITEM_OK));
    supabase.rpc.mockResolvedValue({
      data: [{ menu_item_id: 'item-1', price: 20, estimated_cost: null, food_cost_pct: null, food_cost_target: 30, viable: null }],
      error: null,
    });
    const req = baseReq();
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'donnees_insuffisantes' }));
  });

  test('returns 500 when the sales lookup fails', async () => {
    supabase.from.mockReturnValueOnce(makeBuilder(MENU_ITEM_OK));
    supabase.rpc.mockResolvedValue(VIABILITY_OK);
    supabase.from.mockReturnValueOnce(makeBuilder({ data: null, error: { message: 'boom' } }));
    const req = baseReq();
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  test('computes the margin and volume projection correctly with sales in the period', async () => {
    supabase.from.mockReturnValueOnce(makeBuilder(MENU_ITEM_OK));
    supabase.rpc.mockResolvedValue(VIABILITY_OK); // price 20, cost 8, food_cost_target 30
    // 10-day period (2026-09-01 -> 2026-09-10), 5 rows of quantity 10 => 50 units
    const salesRows = Array.from({ length: 5 }, () => ({ quantity: 10 }));
    supabase.from.mockReturnValueOnce(makeBuilder({ data: salesRows, error: null }));

    const req = baseReq({ newPrice: '25' });
    const res = createRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = res.json.mock.calls[0][0];
    expect(payload.current_margin_per_item).toBe(12);
    expect(payload.new_margin_per_item).toBe(17);
    expect(payload.margin_delta_per_item).toBe(5);
    expect(payload.units_sold_in_period).toBe(50);
    expect(payload.annualized_units_estimate).toBe(1825); // (50/10)*365
    expect(payload.new_food_cost_pct).toBe(32); // 8/25 = 32%
    expect(payload.new_viable).toBe(false); // 32% > 30% target
    expect(payload.period_margin_delta).toBe(250); // 5 * 50
    expect(payload.annual_margin_delta_estimate).toBe(9125); // 5 * 1825
    expect(payload.note).toContain('augmentation');
  });

  test('uses a theoretical note when there are no sales in the period', async () => {
    supabase.from.mockReturnValueOnce(makeBuilder(MENU_ITEM_OK));
    supabase.rpc.mockResolvedValue(VIABILITY_OK);
    supabase.from.mockReturnValueOnce(makeBuilder({ data: [], error: null }));

    const req = baseReq();
    const res = createRes();
    await handler(req, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.units_sold_in_period).toBe(0);
    expect(payload.note).toContain('Aucune vente enregistree');
  });

  test('reports a price decrease with a "baisse" direction', async () => {
    supabase.from.mockReturnValueOnce(makeBuilder(MENU_ITEM_OK));
    supabase.rpc.mockResolvedValue(VIABILITY_OK); // price 20, cost 8
    supabase.from.mockReturnValueOnce(makeBuilder({ data: [{ quantity: 10 }], error: null }));

    const req = baseReq({ newPrice: '15' }); // lower than current price 20
    const res = createRes();
    await handler(req, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.margin_delta_per_item).toBeLessThan(0);
    expect(payload.note).toContain('baisse');
  });
});
