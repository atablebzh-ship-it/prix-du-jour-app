const { getScopedClient, extractBearerToken } = require('../../../../lib/supabase');
const { buildRecommendation } = require('../../../../lib/recommendations');
const { dispatchWebhookEvents } = require('../../../../lib/webhooks');

// Ce fichier remplace 4 fichiers separes (pricing-opportunities.js,
// price-risks.js, sales.js, engineering.js) par UNE seule fonction
// serverless qui route selon le segment d'URL {action}. Raison : le plan
// Hobby de Vercel limite a 12 fonctions serverless par deploiement ; avec
// autant d'endpoints, il fallait consolider pour garder de la marge pour
// les prochaines fonctionnalites.
//
// Routes couvertes (memes chemins, meme comportement qu'avant) :
// - GET  /api/establishments/{id}/menu/pricing-opportunities
// - GET  /api/establishments/{id}/menu/price-risks
// - POST /api/establishments/{id}/menu/sales
// - GET  /api/establishments/{id}/menu/engineering
// - POST /api/establishments/{id}/menu/snapshot     (capture un instantane periodique)
// - GET  /api/establishments/{id}/menu/history       (historique d'un plat dans le temps)
//
// snapshot declenche egalement les webhooks (voir lib/webhooks.js et le
// fichier separe api/webhooks/index.js pour la gestion des abonnements).
const dateRe = /^\d{4}-\d{2}-\d{2}$/;

module.exports = async (req, res) => {
  const accessToken = extractBearerToken(req);
  if (!accessToken) {
    return res.status(401).json({ error: 'invalid_token', error_description: 'en-tete Authorization: Bearer <token> requis' });
  }

  const { establishmentId, action } = req.query;
  if (!establishmentId) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'establishmentId requis' });
  }

  const supabase = getScopedClient(accessToken);

  switch (action) {
    case 'pricing-opportunities':
      return handlePricingOpportunities(req, res, supabase, establishmentId);
    case 'price-risks':
      return handlePriceRisks(req, res, supabase, establishmentId);
    case 'sales':
      return handleSales(req, res, supabase, establishmentId);
    case 'engineering':
      return handleEngineering(req, res, supabase, establishmentId);
    case 'snapshot':
      return handleSnapshot(req, res, supabase, establishmentId);
    case 'history':
      return handleHistory(req, res, supabase, establishmentId);
    default:
      return res.status(404).json({ error: 'not_found', error_description: 'route inconnue' });
  }
};

async function getEstablishmentOr404(supabase, establishmentId, res) {
  const { data: establishment, error } = await supabase
    .from('establishments')
    .select('id, name')
    .eq('id', establishmentId)
    .maybeSingle();

  if (error) {
    console.error('menu/[action]: erreur lookup establishment', error);
    res.status(500).json({ error: 'server_error' });
    return null;
  }
  if (!establishment) {
    res.status(404).json({ error: 'not_found', error_description: 'etablissement introuvable' });
    return null;
  }
  return establishment;
}

// GET .../menu/pricing-opportunities?lookbackDays=30&minDropPct=5
async function handlePricingOpportunities(req, res, supabase, establishmentId) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const lookbackDays = req.query.lookbackDays ? parseInt(req.query.lookbackDays, 10) : 30;
  const minDropPct = req.query.minDropPct ? parseFloat(req.query.minDropPct) : 5;
  if (!Number.isFinite(lookbackDays) || lookbackDays <= 0 || !Number.isFinite(minDropPct) || minDropPct <= 0) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'lookbackDays et minDropPct doivent etre des nombres positifs' });
  }

  if (!(await getEstablishmentOr404(supabase, establishmentId, res))) return;

  const { data, error } = await supabase.rpc('menu_pricing_opportunities', {
    p_establishment_id: establishmentId,
    p_lookback_days: lookbackDays,
    p_min_drop_pct: minDropPct,
  });

  if (error) {
    console.error('pricing-opportunities: erreur rpc menu_pricing_opportunities', error);
    return res.status(500).json({ error: 'server_error' });
  }

  return res.status(200).json({
    establishment_id: establishmentId,
    lookback_days: lookbackDays,
    min_drop_pct: minDropPct,
    opportunities: (data || []).map((row) => ({
      menu_item_id: row.menu_item_id,
      menu_item_name: row.menu_item_name,
      price: row.price,
      food_cost_pct: row.food_cost_pct,
      viable: row.viable,
      favorable_ingredients: row.favorable_ingredients,
    })),
  });
}

// GET .../menu/price-risks?lookbackDays=30&minIncreasePct=10
async function handlePriceRisks(req, res, supabase, establishmentId) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const lookbackDays = req.query.lookbackDays ? parseInt(req.query.lookbackDays, 10) : 30;
  const minIncreasePct = req.query.minIncreasePct ? parseFloat(req.query.minIncreasePct) : 10;
  if (!Number.isFinite(lookbackDays) || lookbackDays <= 0 || !Number.isFinite(minIncreasePct) || minIncreasePct <= 0) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'lookbackDays et minIncreasePct doivent etre des nombres positifs' });
  }

  if (!(await getEstablishmentOr404(supabase, establishmentId, res))) return;

  const { data, error } = await supabase.rpc('menu_price_risks', {
    p_establishment_id: establishmentId,
    p_lookback_days: lookbackDays,
    p_min_increase_pct: minIncreasePct,
  });

  if (error) {
    console.error('price-risks: erreur rpc menu_price_risks', error);
    return res.status(500).json({ error: 'server_error' });
  }

  return res.status(200).json({
    establishment_id: establishmentId,
    lookback_days: lookbackDays,
    min_increase_pct: minIncreasePct,
    risks: (data || []).map((row) => ({
      menu_item_id: row.menu_item_id,
      menu_item_name: row.menu_item_name,
      price: row.price,
      food_cost_pct: row.food_cost_pct,
      viable: row.viable,
      risky_ingredients: row.risky_ingredients,
    })),
  });
}

// POST .../menu/sales  { records: [{ menuItemId, saleDate, quantity }, ...] }
async function handleSales(req, res, supabase, establishmentId) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const { records } = req.body || {};
  if (!Array.isArray(records) || records.length === 0) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'records (tableau non vide) requis' });
  }
  if (records.length > 500) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'maximum 500 enregistrements par appel' });
  }

  const rows = [];
  for (const r of records) {
    if (!r || typeof r !== 'object') {
      return res.status(400).json({ error: 'invalid_request', error_description: 'chaque record doit etre un objet' });
    }
    const { menuItemId, saleDate, quantity } = r;
    if (!menuItemId || typeof menuItemId !== 'string') {
      return res.status(400).json({ error: 'invalid_request', error_description: 'menuItemId requis pour chaque record' });
    }
    if (!saleDate || !dateRe.test(saleDate)) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'saleDate au format YYYY-MM-DD requis pour chaque record' });
    }
    if (!Number.isInteger(quantity) || quantity < 0) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'quantity doit etre un entier positif ou nul' });
    }
    rows.push({ menu_item_id: menuItemId, sale_date: saleDate, quantity });
  }

  if (!(await getEstablishmentOr404(supabase, establishmentId, res))) return;

  const { data, error } = await supabase
    .from('menu_item_sales')
    .upsert(rows, { onConflict: 'menu_item_id,sale_date' })
    .select('menu_item_id, sale_date, quantity');

  if (error) {
    console.error('menu/sales: erreur upsert menu_item_sales', error);
    return res.status(400).json({
      error: 'invalid_request',
      error_description: 'un ou plusieurs menuItemId sont invalides ou hors perimetre',
    });
  }

  return res.status(200).json({
    establishment_id: establishmentId,
    upserted_count: (data || []).length,
    records: data,
  });
}

// GET .../menu/engineering?periodStart=YYYY-MM-DD&periodEnd=YYYY-MM-DD
async function handleEngineering(req, res, supabase, establishmentId) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const { periodStart, periodEnd } = req.query;
  if (!periodStart || !periodEnd || !dateRe.test(periodStart) || !dateRe.test(periodEnd)) {
    return res.status(400).json({
      error: 'invalid_request',
      error_description: 'periodStart et periodEnd (format YYYY-MM-DD) sont requis',
    });
  }
  if (periodStart > periodEnd) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'periodStart doit etre avant ou egal a periodEnd' });
  }

  if (!(await getEstablishmentOr404(supabase, establishmentId, res))) return;

  const { data, error } = await supabase.rpc('menu_engineering_matrix', {
    p_establishment_id: establishmentId,
    p_period_start: periodStart,
    p_period_end: periodEnd,
  });

  if (error) {
    console.error('menu/engineering: erreur rpc menu_engineering_matrix', error);
    return res.status(500).json({ error: 'server_error' });
  }

  const items = (data || []).map((row) => ({
    menu_item_id: row.menu_item_id,
    menu_item_name: row.menu_item_name,
    price: row.price,
    estimated_cost: row.estimated_cost,
    food_cost_pct: row.food_cost_pct,
    viable: row.viable,
    margin_per_item: row.margin_per_item,
    units_sold: row.units_sold,
    total_margin: row.total_margin,
    classification: row.classification,
    recommendation: buildRecommendation(row),
  }));

  return res.status(200).json({
    establishment_id: establishmentId,
    period_start: periodStart,
    period_end: periodEnd,
    popularity_threshold: items.length ? data[0].popularity_threshold : null,
    profitability_threshold: items.length ? data[0].profitability_threshold : null,
    items,
  });
}

// POST .../menu/snapshot?periodStart=YYYY-MM-DD&periodEnd=YYYY-MM-DD
//
// Capture un instantane (prix, cout, marge, ventes, classification) de
// chaque plat de l'etablissement pour la periode donnee, et le sauvegarde
// dans menu_item_period_snapshots. A appeler periodiquement (ex: une fois
// par mois) par l'editeur de caisse pour construire un historique dans le
// temps - c'est ce qui permet ensuite /menu/history de repondre a des
// questions comme "tu as vendu 1850 risottos cette annee" ou "ton cout
// matiere est passe de 4.80 EUR a 5.35 EUR".
//
// Un appel avec la meme periode ecrase (upsert) l'instantane precedent :
// pas de risque de doublon si l'editeur rejoue l'appel.
//
// C'est aussi le point de declenchement des webhooks (voir lib/webhooks.js
// et POST /api/webhooks) : apres avoir calcule le nouvel instantane, on le
// compare au precedent pour detecter les changements de classification
// ('classification_change'), et on verifie l'etat actuel des prix marche
// pour detecter risques ('price_risk') et opportunites ('price_opportunity')
// tarifaires. Les abonnements actifs pertinents sont notifies en un seul
// appel HTTP signe (HMAC-SHA256), sans jamais faire echouer la reponse de
// /menu/snapshot elle-meme si un webhook echoue.
async function handleSnapshot(req, res, supabase, establishmentId) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const { periodStart, periodEnd } = req.query;
  if (!periodStart || !periodEnd || !dateRe.test(periodStart) || !dateRe.test(periodEnd)) {
    return res.status(400).json({
      error: 'invalid_request',
      error_description: 'periodStart et periodEnd (format YYYY-MM-DD) sont requis',
    });
  }
  if (periodStart > periodEnd) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'periodStart doit etre avant ou egal a periodEnd' });
  }

  const establishment = await getEstablishmentOr404(supabase, establishmentId, res);
  if (!establishment) return;

  const { data, error } = await supabase.rpc('menu_engineering_matrix', {
    p_establishment_id: establishmentId,
    p_period_start: periodStart,
    p_period_end: periodEnd,
  });

  if (error) {
    console.error('menu/snapshot: erreur rpc menu_engineering_matrix', error);
    return res.status(500).json({ error: 'server_error' });
  }

  const currentRows = data || [];
  const rows = currentRows.map((row) => ({
    menu_item_id: row.menu_item_id,
    period_start: periodStart,
    period_end: periodEnd,
    price: row.price,
    estimated_cost: row.estimated_cost,
    food_cost_pct: row.food_cost_pct,
    margin_per_item: row.margin_per_item,
    units_sold: row.units_sold,
    total_margin: row.total_margin,
    classification: row.classification,
  }));

  if (rows.length === 0) {
    return res.status(200).json({ establishment_id: establishmentId, period_start: periodStart, period_end: periodEnd, snapshotted_count: 0 });
  }

  // Recupere, pour chaque plat, le dernier instantane STRICTEMENT anterieur
  // a cette periode - c'est la base de comparaison pour detecter un
  // changement de classification. On prend le plus recent par plat cote
  // JS (pas de DISTINCT ON portable facilement via le client Supabase).
  const menuItemIds = rows.map((r) => r.menu_item_id);
  const { data: previousSnapshots, error: previousError } = await supabase
    .from('menu_item_period_snapshots')
    .select('menu_item_id, period_start, classification')
    .in('menu_item_id', menuItemIds)
    .lt('period_start', periodStart)
    .order('period_start', { ascending: false });

  if (previousError) {
    console.error('menu/snapshot: erreur lookup instantanes precedents', previousError);
    // Non bloquant pour la capture elle-meme : on continue sans detection
    // de changement de classification plutot que de faire echouer l'appel.
  }

  const latestPreviousByItem = new Map();
  for (const snap of previousSnapshots || []) {
    if (!latestPreviousByItem.has(snap.menu_item_id)) {
      latestPreviousByItem.set(snap.menu_item_id, snap.classification);
    }
  }

  const { data: inserted, error: insertError } = await supabase
    .from('menu_item_period_snapshots')
    .upsert(rows, { onConflict: 'menu_item_id,period_start,period_end' })
    .select('menu_item_id');

  if (insertError) {
    console.error('menu/snapshot: erreur upsert menu_item_period_snapshots', insertError);
    return res.status(500).json({ error: 'server_error' });
  }

  // Construit les evenements webhook a partir de cet instantane. Jamais
  // bloquant : toute erreur ici est journalisee mais ne fait pas echouer
  // la reponse HTTP de /menu/snapshot.
  let webhookEventsDispatched = 0;
  try {
    const events = [];

    for (const row of currentRows) {
      const previousClassification = latestPreviousByItem.get(row.menu_item_id);
      if (previousClassification && previousClassification !== row.classification) {
        events.push({
          type: 'classification_change',
          menu_item_id: row.menu_item_id,
          menu_item_name: row.menu_item_name,
          previous_classification: previousClassification,
          new_classification: row.classification,
          margin_per_item: row.margin_per_item,
          units_sold: row.units_sold,
        });
      }
    }

    const [{ data: risks }, { data: opportunities }] = await Promise.all([
      supabase.rpc('menu_price_risks', { p_establishment_id: establishmentId, p_lookback_days: 30, p_min_increase_pct: 10 }),
      supabase.rpc('menu_pricing_opportunities', { p_establishment_id: establishmentId, p_lookback_days: 30, p_min_drop_pct: 5 }),
    ]);

    for (const row of risks || []) {
      events.push({
        type: 'price_risk',
        menu_item_id: row.menu_item_id,
        menu_item_name: row.menu_item_name,
        price: row.price,
        food_cost_pct: row.food_cost_pct,
        viable: row.viable,
        risky_ingredients: row.risky_ingredients,
      });
    }
    for (const row of opportunities || []) {
      events.push({
        type: 'price_opportunity',
        menu_item_id: row.menu_item_id,
        menu_item_name: row.menu_item_name,
        price: row.price,
        food_cost_pct: row.food_cost_pct,
        viable: row.viable,
        favorable_ingredients: row.favorable_ingredients,
      });
    }

    if (events.length > 0) {
      await dispatchWebhookEvents(supabase, establishmentId, establishment.name, events);
      webhookEventsDispatched = events.length;
    }
  } catch (webhookError) {
    console.error('menu/snapshot: erreur declenchement webhooks', webhookError);
  }

  return res.status(200).json({
    establishment_id: establishmentId,
    period_start: periodStart,
    period_end: periodEnd,
    snapshotted_count: (inserted || []).length,
    webhook_events_dispatched: webhookEventsDispatched,
  });
}

// GET .../menu/history?menuItemId=...
//
// Renvoie l'historique des instantanes d'un plat (un par periode
// capturee via /menu/snapshot), du plus ancien au plus recent, avec un
// resume : total des ventes cumulees sur tout l'historique, et evolution
// du prix / cout / marge entre le premier et le dernier instantane.
async function handleHistory(req, res, supabase, establishmentId) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const { menuItemId } = req.query;
  if (!menuItemId || typeof menuItemId !== 'string') {
    return res.status(400).json({ error: 'invalid_request', error_description: 'menuItemId requis' });
  }

  if (!(await getEstablishmentOr404(supabase, establishmentId, res))) return;

  // Verifie que le menu_item appartient bien a l'establishment demande.
  const { data: menuItem, error: menuItemError } = await supabase
    .from('menu_items')
    .select('id, name, menu_id, menus!inner(establishment_id)')
    .eq('id', menuItemId)
    .maybeSingle();

  if (menuItemError) {
    console.error('menu/history: erreur lookup menu_item', menuItemError);
    return res.status(500).json({ error: 'server_error' });
  }
  if (!menuItem || menuItem.menus.establishment_id !== establishmentId) {
    return res.status(404).json({ error: 'not_found', error_description: 'plat introuvable pour cet etablissement' });
  }

  const { data: snapshots, error: snapshotsError } = await supabase
    .from('menu_item_period_snapshots')
    .select('period_start, period_end, price, estimated_cost, food_cost_pct, margin_per_item, units_sold, total_margin, classification, captured_at')
    .eq('menu_item_id', menuItemId)
    .order('period_start', { ascending: true });

  if (snapshotsError) {
    console.error('menu/history: erreur lookup menu_item_period_snapshots', snapshotsError);
    return res.status(500).json({ error: 'server_error' });
  }

  const rows = snapshots || [];
  const totalUnitsSold = rows.reduce((sum, r) => sum + (r.units_sold || 0), 0);
  const totalMarginGenerated = rows.reduce((sum, r) => sum + (r.total_margin !== null ? Number(r.total_margin) : 0), 0);

  let evolution = null;
  if (rows.length >= 2) {
    const first = rows[0];
    const last = rows[rows.length - 1];
    const costChangePct = first.estimated_cost && Number(first.estimated_cost) > 0
      ? Math.round(((Number(last.estimated_cost) - Number(first.estimated_cost)) / Number(first.estimated_cost)) * 10000) / 100
      : null;
    evolution = {
      from_period: { start: first.period_start, end: first.period_end },
      to_period: { start: last.period_start, end: last.period_end },
      price_change: last.price !== null && first.price !== null ? Math.round((Number(last.price) - Number(first.price)) * 100) / 100 : null,
      estimated_cost_change: last.estimated_cost !== null && first.estimated_cost !== null ? Math.round((Number(last.estimated_cost) - Number(first.estimated_cost)) * 100) / 100 : null,
      estimated_cost_change_pct: costChangePct,
      margin_per_item_change: last.margin_per_item !== null && first.margin_per_item !== null ? Math.round((Number(last.margin_per_item) - Number(first.margin_per_item)) * 100) / 100 : null,
    };
  }

  return res.status(200).json({
    establishment_id: establishmentId,
    menu_item_id: menuItemId,
    menu_item_name: menuItem.name,
    snapshots_count: rows.length,
    total_units_sold_all_time: totalUnitsSold,
    total_margin_generated_all_time: Math.round(totalMarginGenerated * 100) / 100,
    evolution,
    snapshots: rows,
  });
}
