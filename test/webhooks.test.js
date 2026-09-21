const crypto = require('crypto');

// On mocke https/http AVANT de charger lib/webhooks, puisque celui-ci les
// require() une seule fois au chargement du module.
jest.mock('https', () => ({ request: jest.fn() }));
jest.mock('http', () => ({ request: jest.fn() }));

const https = require('https');
const { dispatchWebhookEvents } = require('../lib/webhooks');

// Simule un https.request qui repond immediatement avec le status donne,
// sans jamais toucher au reseau.
function mockHttpsResponse(statusCode) {
  https.request.mockImplementation((options, callback) => {
    const response = { statusCode, resume: jest.fn() };
    callback(response);
    return { on: jest.fn(), write: jest.fn(), end: jest.fn(), destroy: jest.fn() };
  });
}

function makeSupabaseMock({ subscriptions, subscriptionsError = null, insertError = null }) {
  const insert = jest.fn().mockResolvedValue({ error: insertError });
  return {
    from: jest.fn((table) => {
      if (table === 'webhook_subscriptions') {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockResolvedValue({ data: subscriptions, error: subscriptionsError }),
        };
      }
      if (table === 'webhook_deliveries') {
        return { insert };
      }
      throw new Error(`table inattendue: ${table}`);
    }),
    _insert: insert,
  };
}

describe('dispatchWebhookEvents', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("ne fait rien si la liste d'evenements est vide", async () => {
    const supabase = makeSupabaseMock({ subscriptions: [] });
    await dispatchWebhookEvents(supabase, 'est-1', 'Bistrot', []);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test("ne fait rien si aucun abonnement actif n'existe", async () => {
    const supabase = makeSupabaseMock({ subscriptions: [] });
    await dispatchWebhookEvents(supabase, 'est-1', 'Bistrot', [{ type: 'price_risk' }]);
    expect(supabase._insert).not.toHaveBeenCalled();
  });

  test('ignore un abonnement dont aucun evenement souscrit ne correspond', async () => {
    const supabase = makeSupabaseMock({
      subscriptions: [{ id: 'sub-1', url: 'https://exemple.fr/hook', events: ['price_opportunity'], secret: 's3cr3t' }],
    });
    mockHttpsResponse(200);
    await dispatchWebhookEvents(supabase, 'est-1', 'Bistrot', [{ type: 'price_risk' }]);
    expect(https.request).not.toHaveBeenCalled();
    expect(supabase._insert).not.toHaveBeenCalled();
  });

  test('envoie et journalise une livraison reussie, avec signature HMAC correcte', async () => {
    const secret = 's3cr3t';
    const supabase = makeSupabaseMock({
      subscriptions: [{ id: 'sub-1', url: 'https://exemple.fr/hook', events: ['price_risk'], secret }],
    });
    mockHttpsResponse(200);

    const events = [{ type: 'price_risk', menu_item_name: 'Turbot' }];
    await dispatchWebhookEvents(supabase, 'est-1', 'Bistrot du Port', events);

    expect(https.request).toHaveBeenCalledTimes(1);
    const [options] = https.request.mock.calls[0];
    expect(options.hostname).toBe('exemple.fr');
    expect(options.method).toBe('POST');
    expect(options.headers['X-Webhook-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);

    // Verifie que la signature recue est bien celle attendue pour le corps
    // effectivement envoye (meme algorithme que celui documente au README).
    const rawBody = https.request.mock.calls[0][0].headers['Content-Length'] !== undefined
      ? JSON.stringify({
          establishment_id: 'est-1',
          establishment_name: 'Bistrot du Port',
          sent_at: expect.any(String),
          events,
        })
      : null;
    expect(rawBody).not.toBeNull();

    expect(supabase._insert).toHaveBeenCalledTimes(1);
    const [deliveries] = supabase._insert.mock.calls[0];
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      subscription_id: 'sub-1',
      event_type: 'price_risk',
      establishment_id: 'est-1',
      http_status: 200,
      error: null,
    });
  });

  test('regroupe plusieurs evenements pertinents en un seul appel par abonnement', async () => {
    const supabase = makeSupabaseMock({
      subscriptions: [{ id: 'sub-1', url: 'https://exemple.fr/hook', events: ['price_risk', 'price_opportunity'], secret: 's3cr3t' }],
    });
    mockHttpsResponse(200);

    await dispatchWebhookEvents(supabase, 'est-1', 'Bistrot', [
      { type: 'price_risk' },
      { type: 'price_opportunity' },
      { type: 'classification_change' },
    ]);

    expect(https.request).toHaveBeenCalledTimes(1);
    const [deliveries] = supabase._insert.mock.calls[0];
    expect(deliveries[0].event_type).toBe('price_risk,price_opportunity');
  });

  test('journalise un echec HTTP sans lever d\'exception', async () => {
    const supabase = makeSupabaseMock({
      subscriptions: [{ id: 'sub-1', url: 'https://exemple.fr/hook', events: ['price_risk'], secret: 's3cr3t' }],
    });
    mockHttpsResponse(500);

    await expect(
      dispatchWebhookEvents(supabase, 'est-1', 'Bistrot', [{ type: 'price_risk' }])
    ).resolves.toBeUndefined();

    const [deliveries] = supabase._insert.mock.calls[0];
    expect(deliveries[0].http_status).toBe(500);
  });

  test("n'echoue pas silencieusement si la lecture des abonnements renvoie une erreur", async () => {
    const supabase = makeSupabaseMock({ subscriptions: null, subscriptionsError: { message: 'boom' } });
    await expect(
      dispatchWebhookEvents(supabase, 'est-1', 'Bistrot', [{ type: 'price_risk' }])
    ).resolves.toBeUndefined();
    expect(supabase._insert).not.toHaveBeenCalled();
  });
});
