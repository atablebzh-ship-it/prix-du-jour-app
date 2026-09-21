const { getScopedClient, extractBearerToken } = require('../../../../lib/supabase');
const { buildRecommendation } = require('../../../../lib/recommendations');

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
    default:
      return res.status(404).json({ error: 'not_found', error_description: 'route inconnue' });
  }
};

async function getEstablishmentOr404(supabase, establishmentId, res) {
  const { data: establishment, error } = await supabase
    .from('establishments')
    .select('id')
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
