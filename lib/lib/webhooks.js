const crypto = require('crypto');
const https = require('https');
const http = require('http');

// Signe le corps brut (avant parsing) avec HMAC-SHA256 en utilisant le
// secret de l'abonnement. L'editeur doit recalculer cette signature de son
// cote sur le corps brut recu pour verifier que l'appel vient bien de
// Cours Du Jour et n'a pas ete altere en route.
function signPayload(secret, rawBody) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

// POST minimaliste base sur http(s).request plutot que fetch, pour ne pas
// dependre de la version de Node du runtime Vercel. Ne rejette jamais :
// toute erreur (timeout, DNS, connexion refusee, ...) est renvoyee comme
// un resultat { ok: false } plutot que de faire planter l'appelant - un
// abonnement webhook casse chez l'editeur ne doit jamais faire echouer
// /menu/snapshot.
function postJson(urlString, rawBody, extraHeaders) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(urlString);
    } catch (err) {
      resolve({ ok: false, status: null, error: 'url invalide' });
      return;
    }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      resolve({ ok: false, status: null, error: 'protocole non supporte' });
      return;
    }

    const lib = target.protocol === 'http:' ? http : https;
    const options = {
      hostname: target.hostname,
      port: target.port || (target.protocol === 'http:' ? 80 : 443),
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(rawBody),
        ...extraHeaders,
      },
      timeout: 8000,
    };

    const request = lib.request(options, (response) => {
      // Le corps de la reponse de l'editeur ne nous interesse pas, seul le
      // code HTTP compte - on le draine pour liberer le socket proprement.
      response.resume();
      resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, error: null });
    });

    request.on('timeout', () => {
      request.destroy();
      resolve({ ok: false, status: null, error: 'timeout (8s)' });
    });
    request.on('error', (err) => {
      resolve({ ok: false, status: null, error: err.message });
    });

    request.write(rawBody);
    request.end();
  });
}

// Envoie les evenements pertinents a chaque abonnement webhook actif de
// l'editeur (filtre par RLS via le supabase scope) qui a souscrit a au
// moins un des types d'evenements presents dans `events`.
//
// events : tableau d'objets { type, ... } ou type est l'un de
// 'classification_change' | 'price_risk' | 'price_opportunity'.
//
// Un seul appel HTTP est fait par abonnement concerne, regroupant tous les
// evenements qui le concernent en un seul corps JSON. Chaque tentative est
// journalisee dans webhook_deliveries (y compris les echecs), pour que
// l'editeur puisse diagnostiquer un endpoint qui ne repond plus.
async function dispatchWebhookEvents(supabase, establishmentId, establishmentName, events) {
  if (!events || events.length === 0) return;

  const { data: subscriptions, error } = await supabase
    .from('webhook_subscriptions')
    .select('id, url, events, secret')
    .eq('is_active', true);

  if (error) {
    console.error('webhooks: erreur lookup subscriptions', error);
    return;
  }
  if (!subscriptions || subscriptions.length === 0) return;

  const deliveries = [];

  for (const sub of subscriptions) {
    const matchingEvents = events.filter((e) => sub.events.includes(e.type));
    if (matchingEvents.length === 0) continue;

    const payload = {
      establishment_id: establishmentId,
      establishment_name: establishmentName,
      sent_at: new Date().toISOString(),
      events: matchingEvents,
    };
    const rawBody = JSON.stringify(payload);
    const signature = signPayload(sub.secret, rawBody);

    const result = await postJson(sub.url, rawBody, { 'X-Webhook-Signature': `sha256=${signature}` });

    deliveries.push({
      subscription_id: sub.id,
      event_type: matchingEvents.map((e) => e.type).join(','),
      establishment_id: establishmentId,
      payload,
      http_status: result.status,
      error: result.error,
    });
  }

  if (deliveries.length > 0) {
    const { error: logError } = await supabase.from('webhook_deliveries').insert(deliveries);
    if (logError) {
      console.error('webhooks: erreur enregistrement deliveries', logError);
    }
  }
}

module.exports = { dispatchWebhookEvents };
