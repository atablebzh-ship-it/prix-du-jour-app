const { getScopedClient, extractBearerToken } = require('../../../../../lib/supabase');

// GET /api/establishments/{establishmentId}/menu-items/{menuItemId}/price-simulation
//   ?newPrice=25.00&periodStart=2026-09-01&periodEnd=2026-09-30
//
// Simule l'impact d'un changement de prix sur un plat, a volume constant.
// Le volume "constant" est estime a partir des ventes reelles sur une
// periode donnee (par defaut : les 30 derniers jours), puis annualise pour
// donner un impact en euros par an - le format utilise dans le document de
// reference du projet ("augmenter le prix de 2 EUR ajouterait environ
// 3600 EUR de marge annuelle a volume constant").
//
// Le cout matiere est suppose inchange (on ne simule qu'un changement de
// prix de vente, pas un changement de recette).
const DAY_MS = 24 * 60 * 60 * 1000;
const dateRe = /^\d{4}-\d{2}-\d{2}$/;

function toDateOnly(d) {
  return d.toISOString().slice(0, 10);
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const accessToken = extractBearerToken(req);
  if (!accessToken) {
    return res.status(401).json({ error: 'invalid_token', error_description: 'en-tete Authorization: Bearer <token> requis' });
  }

  const { establishmentId, menuItemId } = req.query;
  if (!establishmentId || !menuItemId) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'establishmentId et menuItemId requis' });
  }

  const newPrice = req.query.newPrice !== undefined ? parseFloat(req.query.newPrice) : NaN;
  if (!Number.isFinite(newPrice) || newPrice <= 0) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'newPrice (nombre positif) requis' });
  }

  let { periodStart, periodEnd } = req.query;
  if (!periodStart && !periodEnd) {
    const today = new Date();
    periodEnd = toDateOnly(today);
    periodStart = toDateOnly(new Date(today.getTime() - 29 * DAY_MS));
  }
  if (!periodStart || !periodEnd || !dateRe.test(periodStart) || !dateRe.test(periodEnd)) {
    return res.status(400).json({
      error: 'invalid_request',
      error_description: 'periodStart et periodEnd (format YYYY-MM-DD) doivent etre fournis ensemble, ou omis tous les deux',
    });
  }
  if (periodStart > periodEnd) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'periodStart doit etre avant ou egal a periodEnd' });
  }

  const supabase = getScopedClient(accessToken);

  // Verifie que le menu_item appartient bien a l'establishment demande,
  // dans le perimetre autorise par RLS (editeur_id du token).
  const { data: menuItem, error: menuItemError } = await supabase
    .from('menu_items')
    .select('id, menu_id, menus!inner(establishment_id)')
    .eq('id', menuItemId)
    .maybeSingle();

  if (menuItemError) {
    console.error('price-simulation: erreur lookup menu_item', menuItemError);
    return res.status(500).json({ error: 'server_error' });
  }
  if (!menuItem || menuItem.menus.establishment_id !== establishmentId) {
    return res.status(404).json({ error: 'not_found', error_description: 'plat introuvable pour cet etablissement' });
  }

  const { data: viabilityData, error: viabilityError } = await supabase.rpc('menu_item_viability', {
    p_menu_item_id: menuItemId,
  });
  if (viabilityError) {
    console.error('price-simulation: erreur rpc menu_item_viability', viabilityError);
    return res.status(500).json({ error: 'server_error' });
  }
  const viability = Array.isArray(viabilityData) ? viabilityData[0] : viabilityData;
  if (!viability) {
    return res.status(404).json({ error: 'not_found', error_description: 'plat introuvable' });
  }
  if (viability.estimated_cost === null || viability.estimated_cost === undefined) {
    return res.status(422).json({
      error: 'donnees_insuffisantes',
      error_description: 'fiche technique ou cout matiere incomplet : impossible de simuler un changement de prix',
    });
  }

  const { data: salesRows, error: salesError } = await supabase
    .from('menu_item_sales')
    .select('quantity')
    .eq('menu_item_id', menuItemId)
    .gte('sale_date', periodStart)
    .lte('sale_date', periodEnd);

  if (salesError) {
    console.error('price-simulation: erreur lookup menu_item_sales', salesError);
    return res.status(500).json({ error: 'server_error' });
  }

  const unitsInPeriod = (salesRows || []).reduce((sum, r) => sum + (r.quantity || 0), 0);
  const periodDays = Math.round((new Date(periodEnd) - new Date(periodStart)) / DAY_MS) + 1;
  const dailyAvgUnits = unitsInPeriod / periodDays;
  const annualizedUnits = Math.round(dailyAvgUnits * 365);

  const currentPrice = Number(viability.price);
  const cost = Number(viability.estimated_cost);
  const foodCostTarget = viability.food_cost_target !== null ? Number(viability.food_cost_target) : null;

  const currentMargin = Math.round((currentPrice - cost) * 100) / 100;
  const newMargin = Math.round((newPrice - cost) * 100) / 100;
  const marginDeltaPerUnit = Math.round((newMargin - currentMargin) * 100) / 100;

  const newFoodCostPct = newPrice > 0 ? Math.round((cost / newPrice) * 10000) / 100 : null;
  const newViable = foodCostTarget !== null && newFoodCostPct !== null ? newFoodCostPct <= foodCostTarget : null;

  const periodMarginDelta = Math.round(marginDeltaPerUnit * unitsInPeriod * 100) / 100;
  const annualMarginDelta = Math.round(marginDeltaPerUnit * annualizedUnits * 100) / 100;

  const direction = marginDeltaPerUnit >= 0 ? 'augmentation' : 'baisse';
  const note = unitsInPeriod > 0
    ? `A volume constant (estime a partir de ${unitsInPeriod} ventes sur la periode ${periodStart} -> ${periodEnd}), passer le prix de ${currentPrice.toFixed(2)} EUR a ${newPrice.toFixed(2)} EUR (${direction} de ${Math.abs(newPrice - currentPrice).toFixed(2)} EUR) ajouterait environ ${annualMarginDelta.toFixed(2)} EUR de marge annuelle.`
    : `Aucune vente enregistree sur la periode ${periodStart} -> ${periodEnd} : l'impact ne peut etre estime qu'a titre theorique (marge par plat), pas projete sur un volume reel.`;

  return res.status(200).json({
    menu_item_id: menuItemId,
    current_price: currentPrice,
    new_price: newPrice,
    estimated_cost: cost,
    current_margin_per_item: currentMargin,
    new_margin_per_item: newMargin,
    margin_delta_per_item: marginDeltaPerUnit,
    current_food_cost_pct: viability.food_cost_pct,
    new_food_cost_pct: newFoodCostPct,
    food_cost_target: foodCostTarget,
    current_viable: viability.viable,
    new_viable: newViable,
    period_start: periodStart,
    period_end: periodEnd,
    units_sold_in_period: unitsInPeriod,
    annualized_units_estimate: annualizedUnits,
    period_margin_delta: periodMarginDelta,
    annual_margin_delta_estimate: annualMarginDelta,
    note,
  });
};
