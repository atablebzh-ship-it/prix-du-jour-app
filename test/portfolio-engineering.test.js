const mockExtractBearerToken = jest.fn();
const mockGetScopedClient = jest.fn();
jest.mock('../lib/supabase', () => ({
  extractBearerToken: (...args) => mockExtractBearerToken(...args),
  getScopedClient: (...args) => mockGetScopedClient(...args),
}));

const handler = require('../api/portfolio/engineering');

function createRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  res.setHeader = jest.fn(() => res);
  return res;
}

function baseReq(overrides = {}) {
  return {
    method: 'GET',
    query: { periodStart: '2026-09-01', periodEnd: '2026-09-30', ...overrides },
  };
}

describe('GET /api/portfolio/engineering', () => {
  let supabase;

  beforeEach(() => {
    jest.clearAllMocks();
    supabase = { rpc: jest.fn() };
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

  test('rejects missing or malformed period bounds', async () => {
    const req = baseReq({ periodStart: '01-09-2026' });
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('rejects periodStart after periodEnd', async () => {
    const req = baseReq({ periodStart: '2026-09-30', periodEnd: '2026-09-01' });
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('returns 500 when the RPC fails', async () => {
    supabase.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const req = baseReq();
    const res = createRes();
    await handler(req, res);
    expect(supabase.rpc).toHaveBeenCalledWith('portfolio_engineering_summary', {
      p_period_start: '2026-09-01',
      p_period_end: '2026-09-30',
    });
    expect(res.status).toHaveBeenCalledWith(500);
  });

  test('returns empty aggregates when there are no rows', async () => {
    supabase.rpc.mockResolvedValue({ data: [], error: null });
    const req = baseReq();
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        establishments_count: 0,
        items_count: 0,
        total_margin_across_portfolio: 0,
        priority_items: [],
        establishments: [],
      })
    );
  });

  test('groups items by establishment, counts classifications, and sums margin', async () => {
    supabase.rpc.mockResolvedValue({
      data: [
        {
          establishment_id: 'est-1', establishment_name: 'Bistrot du Port',
          menu_item_id: 'item-1', menu_item_name: 'Risotto', price: 22, estimated_cost: 5, food_cost_pct: 22.7,
          viable: true, margin_per_item: 17, units_sold: 250, total_margin: 4250, classification: 'star',
        },
        {
          establishment_id: 'est-1', establishment_name: 'Bistrot du Port',
          menu_item_id: 'item-2', menu_item_name: 'Turbot', price: 39, estimated_cost: 21, food_cost_pct: 53.8,
          viable: false, margin_per_item: 18, units_sold: 35, total_margin: 630, classification: 'rentable_peu_vendu',
        },
        {
          establishment_id: 'est-2', establishment_name: 'Le Comptoir',
          menu_item_id: 'item-3', menu_item_name: 'Burger', price: 14, estimated_cost: 9, food_cost_pct: 64.3,
          viable: false, margin_per_item: 5, units_sold: 400, total_margin: 2000, classification: 'populaire_peu_rentable',
        },
      ],
      error: null,
    });
    const req = baseReq();
    const res = createRes();
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = res.json.mock.calls[0][0];
    expect(payload.establishments_count).toBe(2);
    expect(payload.items_count).toBe(3);
    expect(payload.classification_counts).toEqual(
      expect.objectContaining({ star: 1, rentable_peu_vendu: 1, populaire_peu_rentable: 1, a_revoir: 0, donnees_insuffisantes: 0 })
    );
    expect(payload.total_margin_across_portfolio).toBe(6880); // 4250 + 630 + 2000
    const est1 = payload.establishments.find((e) => e.establishment_id === 'est-1');
    expect(est1.items).toHaveLength(2);
    expect(est1.items[0].recommendation).toContain('STAR DE LA CARTE');
  });

  test('builds priority_items from populaire_peu_rentable and a_revoir only, sorted by units_sold desc', async () => {
    supabase.rpc.mockResolvedValue({
      data: [
        { establishment_id: 'est-1', establishment_name: 'Bistrot', menu_item_id: 'item-1', menu_item_name: 'Star', price: 22, estimated_cost: 5, food_cost_pct: 22, viable: true, margin_per_item: 17, units_sold: 250, total_margin: 4250, classification: 'star' },
        { establishment_id: 'est-1', establishment_name: 'Bistrot', menu_item_id: 'item-2', menu_item_name: 'Low priority', price: 14, estimated_cost: 9, food_cost_pct: 64, viable: false, margin_per_item: 5, units_sold: 100, total_margin: 500, classification: 'populaire_peu_rentable' },
        { establishment_id: 'est-2', establishment_name: 'Comptoir', menu_item_id: 'item-3', menu_item_name: 'High priority', price: 12, estimated_cost: 10, food_cost_pct: 83, viable: false, margin_per_item: 2, units_sold: 500, total_margin: 1000, classification: 'populaire_peu_rentable' },
        { establishment_id: 'est-2', establishment_name: 'Comptoir', menu_item_id: 'item-4', menu_item_name: 'To review', price: 8, estimated_cost: 6, food_cost_pct: 75, viable: false, margin_per_item: 1.5, units_sold: 4, total_margin: 6, classification: 'a_revoir' },
      ],
      error: null,
    });
    const req = baseReq();
    const res = createRes();
    await handler(req, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.priority_items).toHaveLength(3);
    expect(payload.priority_items.map((i) => i.menu_item_id)).toEqual(['item-3', 'item-2', 'item-4']);
    expect(payload.priority_items[0].recommendation).toBeDefined();
  });

  test('ignores a null/undefined total_margin when summing the portfolio total', async () => {
    supabase.rpc.mockResolvedValue({
      data: [
        { establishment_id: 'est-1', establishment_name: 'Bistrot', menu_item_id: 'item-1', menu_item_name: 'New dish', price: 15, estimated_cost: null, food_cost_pct: null, viable: null, margin_per_item: null, units_sold: null, total_margin: null, classification: 'donnees_insuffisantes' },
        { establishment_id: 'est-1', establishment_name: 'Bistrot', menu_item_id: 'item-2', menu_item_name: 'Risotto', price: 22, estimated_cost: 5, food_cost_pct: 22, viable: true, margin_per_item: 17, units_sold: 250, total_margin: 4250, classification: 'star' },
      ],
      error: null,
    });
    const req = baseReq();
    const res = createRes();
    await handler(req, res);
    const payload = res.json.mock.calls[0][0];
    expect(payload.total_margin_across_portfolio).toBe(4250);
    expect(payload.classification_counts.donnees_insuffisantes).toBe(1);
  });
});
