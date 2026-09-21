const { getScopedClient, extractBearerToken } = require('../../../../lib/supabase');

// GET /api/establishments/{establishmentId}/menu/pricing-opportunities
//   ?lookbackDays=30&minDropPct=5
//
// Repere les plats de la carte dont le cout matiere s'ameliore grace a une
// baisse recente du prix d'un ou plusieurs ingredients sur le marche
// (le "cours du jour"). Utile pour suggerer quels plats mettre en avant
// maintenant, ou quels ingredients bon marche pourraient inspirer un
// nouveau plat.
//
// - lookbackDays : fenetre de comparaison pour calculer le prix moyen
//   recent d'un ingredient (defaut 30 jours).
// - minDropPct : baisse minimale du prix (en %) pour qu'un ingredient
//   soit considere comme une "opportunite tarifaire" (defaut 5%).
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

  const lookbackDays = req.query.lookbackDays ? parseInt(req.query.lookbackDays, 10) : 30;
  const minDropPct = req.query.minDropPct ? parseFloat(req.query.minDropPct) : 5;
  if (!Number.isFinite(lookbackDays) || lookbackDays <= 0 || !Number.isFinite(minDropPct) || minDropPct <= 0) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'lookbackDays et minDropPct doivent etre des nombres positifs' });
  }

  const supabase = getScopedClient(accessToken);

  // Verifie que l'etablissement est bien dans le perimetre autorise par RLS
  // avant d'appeler la fonction (evite de renvoyer 200 vide pour un id
  // hors perimetre, ce qui serait ambigu avec "aucune opportunite").
  const { data: establishment, error: establishmentError } = await supabase
    .from('establishments')
    .select('id')
    .eq('id', establishmentId)
    .maybeSingle();

  if (establishmentError) {
    console.error('pricing-opportunities: erreur lookup establishment', establishmentError);
    return res.status(500).json({ error: 'server_error' });
  }
  if (!establishment) {
    return res.status(404).json({ error: 'not_found', error_description: 'etablissement introuvable' });
  }

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
};
