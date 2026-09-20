const { getScopedClient, extractBearerToken } = require('../../../../../lib/supabase');

// GET /api/establishments/{establishmentId}/menu-items/{menuItemId}/viability
//
// Renvoie l'analyse de viabilite d'un plat : cout matiere estime, food cost %,
// seuil configure pour l'etablissement, et si le plat est viable.
// `viable` peut etre null si les donnees sont incompletes (fiche technique
// manquante ou ingredient sans prix marche) - a distinguer de false.
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

  const supabase = getScopedClient(accessToken);

  // Verifie que le menu_item appartient bien a l'establishment demande,
  // dans le perimetre autorise par RLS (editeur_id du token).
  const { data: menuItem, error: menuItemError } = await supabase
    .from('menu_items')
    .select('id, menu_id, menus!inner(establishment_id)')
    .eq('id', menuItemId)
    .maybeSingle();

  if (menuItemError) {
    console.error('viability: erreur lookup menu_item', menuItemError);
    return res.status(500).json({ error: 'server_error' });
  }
  if (!menuItem || menuItem.menus.establishment_id !== establishmentId) {
    // 404 generique : ne revele pas si le plat existe hors du perimetre autorise
    return res.status(404).json({ error: 'not_found', error_description: 'plat introuvable pour cet etablissement' });
  }

  const { data, error } = await supabase.rpc('menu_item_viability', {
    p_menu_item_id: menuItemId,
  });

  if (error) {
    console.error('viability: erreur rpc menu_item_viability', error);
    return res.status(500).json({ error: 'server_error' });
  }

  const result = Array.isArray(data) ? data[0] : data;
  if (!result) {
    return res.status(404).json({ error: 'not_found', error_description: 'plat introuvable' });
  }

  return res.status(200).json({
    menu_item_id: result.menu_item_id,
    price: result.price,
    estimated_cost: result.estimated_cost,
    food_cost_pct: result.food_cost_pct,
    food_cost_target: result.food_cost_target,
    viable: result.viable, // true / false / null (donnees insuffisantes)
    fiche_technique_incomplete: result.fiche_technique_incomplete,
    cost_incomplete: result.cost_incomplete,
    missing_ingredients_count: result.missing_ingredients_count,
  });
};
