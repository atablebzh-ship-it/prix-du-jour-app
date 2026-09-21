const { getScopedClient, extractBearerToken } = require('../../../../lib/supabase');
const { buildRecommendation } = require('../../../../lib/recommendations');

// GET /api/establishments/{establishmentId}/menu/engineering
//   ?periodStart=2026-09-01&periodEnd=2026-09-30
//
// Croise popularite (nombre de ventes) et rentabilite (marge par plat) sur
// une periode donnee pour classer chaque plat de la carte dans l'un des
// 4 groupes classiques du "menu engineering" :
//
// - star                    : forte popularite + forte marge -> a mettre en avant
// - rentable_peu_vendu       : forte marge + faible volume -> travailler la
//                              presentation, le prix ou la communication
// - populaire_peu_rentable   : fort volume + faible marge -> priorite absolue,
//                              revoir la recette ou le prix
// - a_revoir                 : faible volume + faible marge -> envisager de
//                              retirer le plat
// - donnees_insuffisantes    : pas assez de donnees (aucune vente sur la
//                              periode, ou fiche technique/cout incomplet)
//
// Seuils utilises (transparents, renvoyes dans la reponse) :
// - popularity_threshold      = 70% du volume moyen de vente par plat sur la
//                                periode (regle classique du "menu engineering")
// - profitability_threshold   = marge moyenne ponderee par les volumes
//                                (marge totale generee / total des ventes)
//
// Chaque plat renvoie en plus un champ "recommendation" : une phrase prete a
// afficher dans le logiciel de caisse, formulee sur le modele du document de
// reference du projet (ex: "RISOTTO - STAR DE LA CARTE : 250 ventes x 17 EUR
// de marge = 4 250 EUR generes. A conserver / mettre en avant."). Generee
// par lib/recommendations.js, partagee avec l'endpoint portefeuille.
module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const accessToken = extractBearerToken(req);
  if (!accessToken) {
    return res.status(401).json({ error: 'invalid_token', error_description: 'en-tete Authorization: Bearer <token> requis' });
  }

  const { establishmentId } = req.query;
  if (!establishmentId) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'establishmentId requis' });
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

  const { data: establishment, error: establishmentError } = await supabase
    .from('establishments')
    .select('id')
    .eq('id', establishmentId)
    .maybeSingle();

  if (establishmentError) {
    console.error('menu/engineering: erreur lookup establishment', establishmentError);
    return res.status(500).json({ error: 'server_error' });
  }
  if (!establishment) {
    return res.status(404).json({ error: 'not_found', error_description: 'etablissement introuvable' });
  }

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
};
