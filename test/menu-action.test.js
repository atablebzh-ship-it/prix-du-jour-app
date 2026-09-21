const mockExtractBearerToken = jest.fn();
const mockGetScopedClient = jest.fn();
jest.mock('../lib/supabase', () => ({
  extractBearerToken: (...args) => mockExtractBearerToken(...args),
  getScopedClient: (...args) => mockGetScopedClient(...args),
}));

const mockDispatchWebhookEvents = jest.fn().mockResolvedValue(undefined);
jest.mock('../lib/webhooks', () => ({
  dispatchWebhookEvents: (...args) => mockDispatchWebhookEvents(...args),
}));

const handler = require('../api/establishments/[establishmentId]/menu/[action]');

function createRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  res.setHeader = jest.fn(() => res);
  return res;
}

function makeBuilder(result) {
  const builder = {};
  ['select', 'eq', 'in', 'lt', 'order', 'limit', 'upsert', 'maybeSingle'].forEach((method) => {
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

const ESTABLISHMENT_OK = { table: 'establishments', result: { data: { id: 'est-1', name: 'Bistrot du Port' }, error: null } };

function mockRpc(supabase, resultsByName) {
  supabase.rpc = jest.fn((name) => Promise.resolve(resultsByName[name] || { data: [], error: null }));
}

describe('api/establishments/[establishmentId]/menu/[action]', () => {
  let supabase;

  beforeEach(() => {
    jest.clearAllMocks();
    supabase = {};
    mockExtractBearerToken.mockReturnValue('valid-token');
    mockGetScopedClient.mockReturnValue(supabase);
  });

  test('rejects requests without a Bearer token', async () => {
    mockExtractBearerToken.mockReturnValue(null);
    const req = { method: 'GET', query: {} };
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('rejects a missing establishmentId', async () => {
    const req = { method: 'GET', query: { action: 'engineering' } };
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('returns 404 for an unknown action', async () => {
    const req = { method: 'GET', query: { establishmentId: 'est-1', action: 'bogus' } };
    const res = createRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  describe('pricing-opportunities', () => {
    test('rejects non-GET methods', async () => {
      const req = { method: 'POST', query: { establishmentId: 'est-1', action: 'pricing-opportunities' } };
      const res = createRes();
      await handler(req, res);
      expect(res.setHeader).toHaveBeenCalledWith('Allow', 'GET');
      expect(res.status).toHaveBeenCalledWith(405);
    });

    test('rejects invalid lookbackDays/minDropPct', async () => {
      const req = { method: 'GET', query: { establishmentId: 'est-1', action: 'pricing-opportunities', lookbackDays: '0' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('returns 404 when the establishment does not exist', async () => {
      mockFromSequence(supabase, [{ table: 'establishments', result: { data: null, error: null } }]);
      const req = { method: 'GET', query: { establishmentId: 'est-1', action: 'pricing-opportunities' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    test('returns 500 when the establishment lookup fails', async () => {
      mockFromSequence(supabase, [{ table: 'establishments', result: { data: null, error: { message: 'boom' } } }]);
      const req = { method: 'GET', query: { establishmentId: 'est-1', action: 'pricing-opportunities' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    test('returns 500 when the RPC fails', async () => {
      mockFromSequence(supabase, [ESTABLISHMENT_OK]);
      mockRpc(supabase, { menu_pricing_opportunities: { data: null, error: { message: 'boom' } } });
      const req = { method: 'GET', query: { establishmentId: 'est-1', action: 'pricing-opportunities' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    test('returns mapped opportunities with default thresholds', async () => {
      mockFromSequence(supabase, [ESTABLISHMENT_OK]);
      mockRpc(supabase, {
        menu_pricing_opportunities: {
          data: [{ menu_item_id: 'item-1', menu_item_name: 'Risotto', price: 22, food_cost_pct: 20, viable: true, favorable_ingredients: ['riz'] }],
          error: null,
        },
      });
      const req = { method: 'GET', query: { establishmentId: 'est-1', action: 'pricing-opportunities' } };
      const res = createRes();
      await handler(req, res);
      expect(supabase.rpc).toHaveBeenCalledWith('menu_pricing_opportunities', {
        p_establishment_id: 'est-1',
        p_lookback_days: 30,
        p_min_drop_pct: 5,
      });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ lookback_days: 30, min_drop_pct: 5, opportunities: expect.arrayContaining([expect.objectContaining({ menu_item_id: 'item-1' })]) })
      );
    });
  });

  describe('price-risks', () => {
    test('rejects non-GET methods', async () => {
      const req = { method: 'POST', query: { establishmentId: 'est-1', action: 'price-risks' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(405);
    });

    test('rejects invalid lookbackDays/minIncreasePct', async () => {
      const req = { method: 'GET', query: { establishmentId: 'est-1', action: 'price-risks', minIncreasePct: '-1' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('returns 500 when the RPC fails', async () => {
      mockFromSequence(supabase, [ESTABLISHMENT_OK]);
      mockRpc(supabase, { menu_price_risks: { data: null, error: { message: 'boom' } } });
      const req = { method: 'GET', query: { establishmentId: 'est-1', action: 'price-risks' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    test('returns mapped risks with custom thresholds', async () => {
      mockFromSequence(supabase, [ESTABLISHMENT_OK]);
      mockRpc(supabase, {
        menu_price_risks: {
          data: [{ menu_item_id: 'item-2', menu_item_name: 'Entrecote', price: 32, food_cost_pct: 45, viable: false, risky_ingredients: ['boeuf'] }],
          error: null,
        },
      });
      const req = { method: 'GET', query: { establishmentId: 'est-1', action: 'price-risks', lookbackDays: '60', minIncreasePct: '15' } };
      const res = createRes();
      await handler(req, res);
      expect(supabase.rpc).toHaveBeenCalledWith('menu_price_risks', {
        p_establishment_id: 'est-1',
        p_lookback_days: 60,
        p_min_increase_pct: 15,
      });
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  describe('sales', () => {
    test('rejects non-POST methods', async () => {
      const req = { method: 'GET', query: { establishmentId: 'est-1', action: 'sales' } };
      const res = createRes();
      await handler(req, res);
      expect(res.setHeader).toHaveBeenCalledWith('Allow', 'POST');
      expect(res.status).toHaveBeenCalledWith(405);
    });

    test('rejects a missing or empty records array', async () => {
      const req = { method: 'POST', query: { establishmentId: 'est-1', action: 'sales' }, body: { records: [] } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('rejects more than 500 records', async () => {
      const records = Array.from({ length: 501 }, (_, i) => ({ menuItemId: `item-${i}`, saleDate: '2026-09-01', quantity: 1 }));
      const req = { method: 'POST', query: { establishmentId: 'est-1', action: 'sales' }, body: { records } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('rejects a non-object record', async () => {
      const req = { method: 'POST', query: { establishmentId: 'est-1', action: 'sales' }, body: { records: ['not-an-object'] } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('rejects a missing menuItemId', async () => {
      const req = { method: 'POST', query: { establishmentId: 'est-1', action: 'sales' }, body: { records: [{ saleDate: '2026-09-01', quantity: 1 }] } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('rejects an invalid saleDate', async () => {
      const req = {
        method: 'POST',
        query: { establishmentId: 'est-1', action: 'sales' },
        body: { records: [{ menuItemId: 'item-1', saleDate: '01/09/2026', quantity: 1 }] },
      };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('rejects a negative or non-integer quantity', async () => {
      const req = {
        method: 'POST',
        query: { establishmentId: 'est-1', action: 'sales' },
        body: { records: [{ menuItemId: 'item-1', saleDate: '2026-09-01', quantity: -1 }] },
      };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('returns 400 invalid_request when the upsert fails', async () => {
      mockFromSequence(supabase, [
        ESTABLISHMENT_OK,
        { table: 'menu_item_sales', result: { data: null, error: { message: 'boom' } } },
      ]);
      const req = {
        method: 'POST',
        query: { establishmentId: 'est-1', action: 'sales' },
        body: { records: [{ menuItemId: 'item-1', saleDate: '2026-09-01', quantity: 5 }] },
      };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'invalid_request' }));
    });

    test('upserts sales records successfully', async () => {
      mockFromSequence(supabase, [
        ESTABLISHMENT_OK,
        { table: 'menu_item_sales', result: { data: [{ menu_item_id: 'item-1', sale_date: '2026-09-01', quantity: 5 }], error: null } },
      ]);
      const req = {
        method: 'POST',
        query: { establishmentId: 'est-1', action: 'sales' },
        body: { records: [{ menuItemId: 'item-1', saleDate: '2026-09-01', quantity: 5 }] },
      };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ upserted_count: 1 }));
    });
  });

  describe('engineering', () => {
    test('rejects non-GET methods', async () => {
      const req = { method: 'POST', query: { establishmentId: 'est-1', action: 'engineering' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(405);
    });

    test('rejects missing period bounds', async () => {
      const req = { method: 'GET', query: { establishmentId: 'est-1', action: 'engineering' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('rejects periodStart after periodEnd', async () => {
      const req = { method: 'GET', query: { establishmentId: 'est-1', action: 'engineering', periodStart: '2026-09-20', periodEnd: '2026-09-01' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('returns 500 when the RPC fails', async () => {
      mockFromSequence(supabase, [ESTABLISHMENT_OK]);
      mockRpc(supabase, { menu_engineering_matrix: { data: null, error: { message: 'boom' } } });
      const req = { method: 'GET', query: { establishmentId: 'est-1', action: 'engineering', periodStart: '2026-09-01', periodEnd: '2026-09-30' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    test('returns items with thresholds and a natural-language recommendation', async () => {
      mockFromSequence(supabase, [ESTABLISHMENT_OK]);
      mockRpc(supabase, {
        menu_engineering_matrix: {
          data: [
            {
              menu_item_id: 'item-1',
              menu_item_name: 'Risotto',
              price: 22,
              estimated_cost: 5,
              food_cost_pct: 22.7,
              viable: true,
              margin_per_item: 17,
              units_sold: 250,
              total_margin: 4250,
              classification: 'star',
              popularity_threshold: 100,
              profitability_threshold: 15,
            },
          ],
          error: null,
        },
      });
      const req = { method: 'GET', query: { establishmentId: 'est-1', action: 'engineering', periodStart: '2026-09-01', periodEnd: '2026-09-30' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      const payload = res.json.mock.calls[0][0];
      expect(payload.popularity_threshold).toBe(100);
      expect(payload.items[0].recommendation).toContain('STAR DE LA CARTE');
    });

    test('returns null thresholds when there are no items', async () => {
      mockFromSequence(supabase, [ESTABLISHMENT_OK]);
      mockRpc(supabase, { menu_engineering_matrix: { data: [], error: null } });
      const req = { method: 'GET', query: { establishmentId: 'est-1', action: 'engineering', periodStart: '2026-09-01', periodEnd: '2026-09-30' } };
      const res = createRes();
      await handler(req, res);
      const payload = res.json.mock.calls[0][0];
      expect(payload.popularity_threshold).toBeNull();
      expect(payload.items).toEqual([]);
    });
  });

  describe('snapshot', () => {
    function snapshotReq(overrides = {}) {
      return {
        method: 'POST',
        query: { establishmentId: 'est-1', action: 'snapshot', periodStart: '2026-09-01', periodEnd: '2026-09-30', ...overrides },
      };
    }

    test('rejects non-POST methods', async () => {
      const req = { method: 'GET', query: { establishmentId: 'est-1', action: 'snapshot' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(405);
    });

    test('rejects missing or invalid period bounds', async () => {
      const req = snapshotReq({ periodStart: undefined });
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('returns 500 when the engineering RPC fails', async () => {
      mockFromSequence(supabase, [ESTABLISHMENT_OK]);
      mockRpc(supabase, { menu_engineering_matrix: { data: null, error: { message: 'boom' } } });
      const req = snapshotReq();
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    test('returns snapshotted_count 0 when there are no menu items', async () => {
      mockFromSequence(supabase, [ESTABLISHMENT_OK]);
      mockRpc(supabase, { menu_engineering_matrix: { data: [], error: null } });
      const req = snapshotReq();
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ snapshotted_count: 0 }));
      expect(mockDispatchWebhookEvents).not.toHaveBeenCalled();
    });

    test('returns 500 when the snapshot upsert fails', async () => {
      mockFromSequence(supabase, [
        ESTABLISHMENT_OK,
        { table: 'menu_item_period_snapshots', result: { data: [], error: null } }, // previous snapshots lookup
        { table: 'menu_item_period_snapshots', result: { data: null, error: { message: 'boom' } } }, // upsert
      ]);
      mockRpc(supabase, {
        menu_engineering_matrix: {
          data: [{ menu_item_id: 'item-1', menu_item_name: 'Risotto', price: 22, estimated_cost: 5, food_cost_pct: 22.7, margin_per_item: 17, units_sold: 250, total_margin: 4250, classification: 'star' }],
          error: null,
        },
      });
      const req = snapshotReq();
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    test('continues (non-blocking) when the previous-snapshots lookup fails', async () => {
      mockFromSequence(supabase, [
        ESTABLISHMENT_OK,
        { table: 'menu_item_period_snapshots', result: { data: null, error: { message: 'boom' } } }, // previous lookup fails
        { table: 'menu_item_period_snapshots', result: { data: [{ menu_item_id: 'item-1' }], error: null } }, // upsert succeeds
      ]);
      mockRpc(supabase, {
        menu_engineering_matrix: {
          data: [{ menu_item_id: 'item-1', menu_item_name: 'Risotto', price: 22, estimated_cost: 5, food_cost_pct: 22.7, margin_per_item: 17, units_sold: 250, total_margin: 4250, classification: 'star' }],
          error: null,
        },
      });
      const req = snapshotReq();
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ snapshotted_count: 1 }));
    });

    test('does not dispatch webhooks when nothing changed and there are no risks/opportunities', async () => {
      mockFromSequence(supabase, [
        ESTABLISHMENT_OK,
        { table: 'menu_item_period_snapshots', result: { data: [{ menu_item_id: 'item-1', period_start: '2026-08-01', classification: 'star' }], error: null } },
        { table: 'menu_item_period_snapshots', result: { data: [{ menu_item_id: 'item-1' }], error: null } },
      ]);
      mockRpc(supabase, {
        menu_engineering_matrix: {
          data: [{ menu_item_id: 'item-1', menu_item_name: 'Risotto', price: 22, estimated_cost: 5, food_cost_pct: 22.7, margin_per_item: 17, units_sold: 250, total_margin: 4250, classification: 'star' }],
          error: null,
        },
        menu_price_risks: { data: [], error: null },
        menu_pricing_opportunities: { data: [], error: null },
      });
      const req = snapshotReq();
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ webhook_events_dispatched: 0 }));
      expect(mockDispatchWebhookEvents).not.toHaveBeenCalled();
    });

    test('dispatches a classification_change webhook event', async () => {
      mockFromSequence(supabase, [
        ESTABLISHMENT_OK,
        { table: 'menu_item_period_snapshots', result: { data: [{ menu_item_id: 'item-1', period_start: '2026-08-01', classification: 'a_revoir' }], error: null } },
        { table: 'menu_item_period_snapshots', result: { data: [{ menu_item_id: 'item-1' }], error: null } },
      ]);
      mockRpc(supabase, {
        menu_engineering_matrix: {
          data: [{ menu_item_id: 'item-1', menu_item_name: 'Risotto', price: 22, estimated_cost: 5, food_cost_pct: 22.7, margin_per_item: 17, units_sold: 250, total_margin: 4250, classification: 'star' }],
          error: null,
        },
        menu_price_risks: { data: [], error: null },
        menu_pricing_opportunities: { data: [], error: null },
      });
      const req = snapshotReq();
      const res = createRes();
      await handler(req, res);
      expect(mockDispatchWebhookEvents).toHaveBeenCalledWith(
        supabase,
        'est-1',
        'Bistrot du Port',
        expect.arrayContaining([expect.objectContaining({ type: 'classification_change', previous_classification: 'a_revoir', new_classification: 'star' })])
      );
      const payload = res.json.mock.calls[0][0];
      expect(payload.webhook_events_dispatched).toBe(1);
    });

    test('dispatches price_risk and price_opportunity events', async () => {
      mockFromSequence(supabase, [
        ESTABLISHMENT_OK,
        { table: 'menu_item_period_snapshots', result: { data: [], error: null } },
        { table: 'menu_item_period_snapshots', result: { data: [{ menu_item_id: 'item-1' }], error: null } },
      ]);
      mockRpc(supabase, {
        menu_engineering_matrix: {
          data: [{ menu_item_id: 'item-1', menu_item_name: 'Risotto', price: 22, estimated_cost: 5, food_cost_pct: 22.7, margin_per_item: 17, units_sold: 250, total_margin: 4250, classification: 'star' }],
          error: null,
        },
        menu_price_risks: { data: [{ menu_item_id: 'item-2', menu_item_name: 'Entrecote', price: 32, food_cost_pct: 45, viable: false, risky_ingredients: ['boeuf'] }], error: null },
        menu_pricing_opportunities: { data: [{ menu_item_id: 'item-3', menu_item_name: 'Turbot', price: 39, food_cost_pct: 20, viable: true, favorable_ingredients: ['poisson'] }], error: null },
      });
      const req = snapshotReq();
      const res = createRes();
      await handler(req, res);
      const payload = res.json.mock.calls[0][0];
      expect(payload.webhook_events_dispatched).toBe(2);
    });

    test('does not fail the request when webhook dispatch throws', async () => {
      mockFromSequence(supabase, [
        ESTABLISHMENT_OK,
        { table: 'menu_item_period_snapshots', result: { data: [{ menu_item_id: 'item-1', period_start: '2026-08-01', classification: 'a_revoir' }], error: null } },
        { table: 'menu_item_period_snapshots', result: { data: [{ menu_item_id: 'item-1' }], error: null } },
      ]);
      mockRpc(supabase, {
        menu_engineering_matrix: {
          data: [{ menu_item_id: 'item-1', menu_item_name: 'Risotto', price: 22, estimated_cost: 5, food_cost_pct: 22.7, margin_per_item: 17, units_sold: 250, total_margin: 4250, classification: 'star' }],
          error: null,
        },
        menu_price_risks: { data: [], error: null },
        menu_pricing_opportunities: { data: [], error: null },
      });
      mockDispatchWebhookEvents.mockRejectedValueOnce(new Error('network down'));
      const req = snapshotReq();
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ webhook_events_dispatched: 0 }));
    });
  });

  describe('history', () => {
    test('rejects non-GET methods', async () => {
      const req = { method: 'POST', query: { establishmentId: 'est-1', action: 'history' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(405);
    });

    test('rejects a missing menuItemId', async () => {
      const req = { method: 'GET', query: { establishmentId: 'est-1', action: 'history' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('returns 500 when the menu_item lookup fails', async () => {
      mockFromSequence(supabase, [
        ESTABLISHMENT_OK,
        { table: 'menu_items', result: { data: null, error: { message: 'boom' } } },
      ]);
      const req = { method: 'GET', query: { establishmentId: 'est-1', action: 'history', menuItemId: 'item-1' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    test('returns 404 when the menu item does not belong to the establishment', async () => {
      mockFromSequence(supabase, [
        ESTABLISHMENT_OK,
        { table: 'menu_items', result: { data: { id: 'item-1', name: 'Risotto', menu_id: 'menu-1', menus: { establishment_id: 'other-est' } }, error: null } },
      ]);
      const req = { method: 'GET', query: { establishmentId: 'est-1', action: 'history', menuItemId: 'item-1' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    test('returns 500 when the snapshots lookup fails', async () => {
      mockFromSequence(supabase, [
        ESTABLISHMENT_OK,
        { table: 'menu_items', result: { data: { id: 'item-1', name: 'Risotto', menu_id: 'menu-1', menus: { establishment_id: 'est-1' } }, error: null } },
        { table: 'menu_item_period_snapshots', result: { data: null, error: { message: 'boom' } } },
      ]);
      const req = { method: 'GET', query: { establishmentId: 'est-1', action: 'history', menuItemId: 'item-1' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    test('returns a null evolution when there are fewer than 2 snapshots', async () => {
      mockFromSequence(supabase, [
        ESTABLISHMENT_OK,
        { table: 'menu_items', result: { data: { id: 'item-1', name: 'Risotto', menu_id: 'menu-1', menus: { establishment_id: 'est-1' } }, error: null } },
        { table: 'menu_item_period_snapshots', result: { data: [], error: null } },
      ]);
      const req = { method: 'GET', query: { establishmentId: 'est-1', action: 'history', menuItemId: 'item-1' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ evolution: null, snapshots_count: 0 }));
    });

    test('computes evolution and totals across multiple snapshots', async () => {
      mockFromSequence(supabase, [
        ESTABLISHMENT_OK,
        { table: 'menu_items', result: { data: { id: 'item-1', name: 'Risotto', menu_id: 'menu-1', menus: { establishment_id: 'est-1' } }, error: null } },
        {
          table: 'menu_item_period_snapshots',
          result: {
            data: [
              { period_start: '2026-01-01', period_end: '2026-01-31', price: 20, estimated_cost: 4.8, food_cost_pct: 24, margin_per_item: 15.2, units_sold: 900, total_margin: 13680 },
              { period_start: '2026-09-01', period_end: '2026-09-30', price: 22, estimated_cost: 5.35, food_cost_pct: 24.3, margin_per_item: 16.65, units_sold: 950, total_margin: 15817.5 },
            ],
            error: null,
          },
        },
      ]);
      const req = { method: 'GET', query: { establishmentId: 'est-1', action: 'history', menuItemId: 'item-1' } };
      const res = createRes();
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      const payload = res.json.mock.calls[0][0];
      expect(payload.snapshots_count).toBe(2);
      expect(payload.total_units_sold_all_time).toBe(1850);
      expect(payload.evolution.price_change).toBe(2);
      expect(payload.evolution.estimated_cost_change).toBe(0.55);
      expect(payload.evolution.estimated_cost_change_pct).toBeCloseTo(11.46, 1);
    });

    test('handles a null first estimated_cost without throwing (null cost change pct)', async () => {
      mockFromSequence(supabase, [
        ESTABLISHMENT_OK,
        { table: 'menu_items', result: { data: { id: 'item-1', name: 'Risotto', menu_id: 'menu-1', menus: { establishment_id: 'est-1' } }, error: null } },
        {
          table: 'menu_item_period_snapshots',
          result: {
            data: [
              { period_start: '2026-01-01', period_end: '2026-01-31', price: 20, estimated_cost: null, food_cost_pct: null, margin_per_item: null, units_sold: 0, total_margin: null },
              { period_start: '2026-09-01', period_end: '2026-09-30', price: 22, estimated_cost: 5.35, food_cost_pct: 24.3, margin_per_item: 16.65, units_sold: 950, total_margin: 15817.5 },
            ],
            error: null,
          },
        },
      ]);
      const req = { method: 'GET', query: { establishmentId: 'est-1', action: 'history', menuItemId: 'item-1' } };
      const res = createRes();
      await handler(req, res);
      const payload = res.json.mock.calls[0][0];
      expect(payload.evolution.estimated_cost_change_pct).toBeNull();
    });
  });
});
