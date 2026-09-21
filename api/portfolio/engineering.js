const { getScopedClient, extractBearerToken } = require('../../lib/supabase');
const { buildRecommendation } = require('../../lib/recommendations');

// GET /api/portfolio/engineering
//   ?periodStart=2026-09-01&periodEnd=2026-09-30
//
// Vue agregee sur TOUS les etablissements de l'editeur authentifie (pas un
// seul restaurant) : combien de plats sont en risque, combien sont des
// STAR, quelle marge totale est en jeu sur l'ensemble du portefeuille.
// Pense pour un tableau de bord editeur qui gere plusieurs restaurants
// clients.
//
// Le perimetre est automatiquement limite aux etablissements de l'editeur
// du token (RLS), exactement comme les autres endpoints - aucun parametre
// d'editeur a fournir.
module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const accessToken = extractBearerToken(req);
  if (!accessToken) {
    return res.status(401).json({ error: 'invalid_token', error_description: 'en-tete Authorization: Bearer <token> requis' });
  }

  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
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

  const supabase = getScopedClient(accessToken);

  const { data, error } = await supabase.rpc('portfolio_engineering_summary', {
    p_period_start: periodStart,
    p_period_end: periodEnd,
  });

  if (error) {
    console.error('portfolio/engineering: erreur rpc portfolio_engineering_summary', error);
    return res.status(500).json({ error: 'server_error' });
  }

  const rows = data || [];

  // Regroupe les lignes par etablissement, et calcule les totaux du
  // portefeuille en meme temps.
  const byEstablishment = new Map();
  const classificationCounts = {
    star: 0,
    rentable_peu_vendu: 0,
    populaire_peu_rentable: 0,
    a_revoir: 0,
    donnees_insuffisantes: 0,
  };
  let totalMarginAcrossPortfolio = 0;

  for (const row of rows) {
    if (!byEstablishment.has(row.establishment_id)) {
      byEstablishment.set(row.establishment_id, {
        establishment_id: row.establishment_id,
        establishment_name: row.establishment_name,
        items: [],
      });
    }
    byEstablishment.get(row.establishment_id).items.push({
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
    });

    if (classificationCounts[row.classification] !== undefined) {
      classificationCounts[row.classification] += 1;
    }
    if (row.total_margin !== null && row.total_margin !== undefined) {
      totalMarginAcrossPortfolio += Number(row.total_margin);
    }
  }

  const establishments = Array.from(byEstablishment.values());

  // Priorites : les plats "populaire_peu_rentable" et "a_revoir" sont ceux
  // qui necessitent une action, tous etablissements confondus - utile pour
  // que l'editeur sache ou concentrer l'attention en premier.
  const priorityItems = rows
    .filter((r) => r.classification === 'populaire_peu_rentable' || r.classification === 'a_revoir')
    .map((row) => ({
      establishment_id: row.establishment_id,
      establishment_name: row.establishment_name,
      menu_item_id: row.menu_item_id,
      menu_item_name: row.menu_item_name,
      classification: row.classification,
      margin_per_item: row.margin_per_item,
      units_sold: row.units_sold,
      recommendation: buildRecommendation(row),
    }))
    .sort((a, b) => (b.units_sold || 0) - (a.units_sold || 0));

  return res.status(200).json({
    period_start: periodStart,
    period_end: periodEnd,
    establishments_count: establishments.length,
    items_count: rows.length,
    classification_counts: classificationCounts,
    total_margin_across_portfolio: Math.round(totalMarginAcrossPortfolio * 100) / 100,
    priority_items: priorityItems,
    establishments,
  });
};
