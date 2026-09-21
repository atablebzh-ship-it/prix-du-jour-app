const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { getScopedClient, extractBearerToken } = require('../../lib/supabase');

// POST   /api/webhooks                       (creer un abonnement)
// GET    /api/webhooks                       (lister ses abonnements)
// PATCH  /api/webhooks?subscriptionId=...     (modifier)
// DELETE /api/webhooks?subscriptionId=...     (supprimer)
//
// Permet a l'editeur de caisse de s'abonner a des evenements plutot que de
// faire du polling sur /menu/engineering ou /menu/price-risks. Les
// evenements sont declenches a chaque appel de POST /menu/snapshot (voir
// lib/webhooks.js), en comparant au snapshot precedent et en detectant
// les risques/opportunites tarifaires du moment.
//
// Evenements disponibles :
// - classification_change : un plat change de categorie menu engineering
//   (ex: star -> populaire_peu_rentable) entre deux instantanes.
// - price_risk             : un ingredient a augmente significativement,
//   menacant la marge d'un ou plusieurs plats.
// - price_opportunity      : un ingredient a baisse significativement.
const VALID_EVENTS = ['classification_change', 'price_risk', 'price_opportunity'];

module.exports = async (req, res) => {
  const accessToken = extractBearerToken(req);
  if (!accessToken) {
    return res.status(401).json({ error: 'invalid_token', error_description: 'en-tete Authorization: Bearer <token> requis' });
  }

  let editeurId;
  try {
    const payload = jwt.decode(accessToken);
    editeurId = payload && payload.editeur_id;
  } catch (err) {
    editeurId = null;
  }
  if (!editeurId) {
    return res.status(401).json({ error: 'invalid_token', error_description: 'token invalide ou editeur_id manquant' });
  }

  const supabase = getScopedClient(accessToken);

  if (req.method === 'POST') {
    return handleCreate(req, res, supabase, editeurId);
  }
  if (req.method === 'GET') {
    return handleList(req, res, supabase);
  }
  if (req.method === 'PATCH') {
    return handleUpdate(req, res, supabase);
  }
  if (req.method === 'DELETE') {
    return handleDelete(req, res, supabase);
  }

  res.setHeader('Allow', 'POST, GET, PATCH, DELETE');
  return res.status(405).json({ error: 'method_not_allowed' });
};

// Corps attendu :
// { "url": "https://...", "events": ["classification_change", "price_risk"] }
//
// Le "secret" est genere automatiquement et renvoye UNE SEULE FOIS dans la
// reponse de creation - il sert a verifier la signature HMAC-SHA256 jointe
// a chaque webhook envoye (en-tete X-Webhook-Signature). Il n'est plus
// jamais renvoye ensuite (GET/PATCH le masquent).
async function handleCreate(req, res, supabase, editeurId) {
  const { url, events } = req.body || {};

  if (!url || typeof url !== 'string' || !/^https:\/\//i.test(url)) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'url requise et doit commencer par https://' });
  }
  if (!Array.isArray(events) || events.length === 0) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'events (tableau non vide) requis' });
  }
  const invalidEvents = events.filter((e) => !VALID_EVENTS.includes(e));
  if (invalidEvents.length > 0) {
    return res.status(400).json({
      error: 'invalid_request',
      error_description: `events invalides: ${invalidEvents.join(', ')} - valeurs acceptees: ${VALID_EVENTS.join(', ')}`,
    });
  }

  const secret = crypto.randomBytes(32).toString('hex');

  const { data, error } = await supabase
    .from('webhook_subscriptions')
    .insert({ pos_editor_id: editeurId, url, events, secret })
    .select('id, url, events, is_active, created_at')
    .single();

  if (error) {
    console.error('webhooks: erreur insert', error);
    return res.status(500).json({ error: 'server_error' });
  }

  return res.status(201).json({ ...data, secret });
}

async function handleList(req, res, supabase) {
  const { data, error } = await supabase
    .from('webhook_subscriptions')
    .select('id, url, events, is_active, created_at')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('webhooks: erreur list', error);
    return res.status(500).json({ error: 'server_error' });
  }

  return res.status(200).json({ subscriptions: data || [] });
}

// PATCH /api/webhooks?subscriptionId=...
// Corps : { url?, events?, isActive? } - au moins un champ requis.
async function handleUpdate(req, res, supabase) {
  const { subscriptionId } = req.query;
  if (!subscriptionId || typeof subscriptionId !== 'string') {
    return res.status(400).json({ error: 'invalid_request', error_description: 'subscriptionId (query string) requis' });
  }

  const { url, events, isActive } = req.body || {};
  const patch = {};

  if (url !== undefined) {
    if (typeof url !== 'string' || !/^https:\/\//i.test(url)) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'url doit commencer par https://' });
    }
    patch.url = url;
  }
  if (events !== undefined) {
    if (!Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'events doit etre un tableau non vide' });
    }
    const invalidEvents = events.filter((e) => !VALID_EVENTS.includes(e));
    if (invalidEvents.length > 0) {
      return res.status(400).json({
        error: 'invalid_request',
        error_description: `events invalides: ${invalidEvents.join(', ')} - valeurs acceptees: ${VALID_EVENTS.join(', ')}`,
      });
    }
    patch.events = events;
  }
  if (isActive !== undefined) {
    patch.is_active = Boolean(isActive);
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'au moins un champ a modifier (url, events, isActive) est requis' });
  }

  const { data, error } = await supabase
    .from('webhook_subscriptions')
    .update(patch)
    .eq('id', subscriptionId)
    .select('id, url, events, is_active, created_at')
    .maybeSingle();

  if (error) {
    console.error('webhooks: erreur update', error);
    return res.status(500).json({ error: 'server_error' });
  }
  if (!data) {
    return res.status(404).json({ error: 'not_found', error_description: 'abonnement introuvable' });
  }

  return res.status(200).json(data);
}

async function handleDelete(req, res, supabase) {
  const { subscriptionId } = req.query;
  if (!subscriptionId || typeof subscriptionId !== 'string') {
    return res.status(400).json({ error: 'invalid_request', error_description: 'subscriptionId (query string) requis' });
  }

  const { data: subscription, error: lookupError } = await supabase
    .from('webhook_subscriptions')
    .select('id')
    .eq('id', subscriptionId)
    .maybeSingle();

  if (lookupError) {
    console.error('webhooks: erreur lookup avant delete', lookupError);
    return res.status(500).json({ error: 'server_error' });
  }
  if (!subscription) {
    return res.status(404).json({ error: 'not_found', error_description: 'abonnement introuvable' });
  }

  const { error: deleteError } = await supabase
    .from('webhook_subscriptions')
    .delete()
    .eq('id', subscriptionId);

  if (deleteError) {
    console.error('webhooks: erreur delete', deleteError);
    return res.status(500).json({ error: 'server_error' });
  }

  return res.status(204).end();
}
