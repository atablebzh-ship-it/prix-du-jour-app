const { getScopedClient, extractBearerToken } = require('../../../../../../lib/supabase');

// POST /api/establishments/{establishmentId}/menu-items/{menuItemId}/recipe-items
//
// Ajoute une ligne de fiche technique a un plat : quel ingredient, en
// quelle quantite. C'est la somme des recipe_items d'un plat qui determine
// son cout matiere estime (voir /viability et /price-simulation).
//
// Corps attendu :
// { "ingredientId": "...", "quantity": 0.4, "unit": "kg" }
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
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

  const { ingredientId, quantity: bodyQuantity, unit } = req.body || {};
  if (!ingredientId || typeof ingredientId !== 'string') {
    return res.status(400).json({ error: 'invalid_request', error_description: 'ingredientId requis' });
  }
  const quantity = Number(bodyQuantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'quantity (nombre positif) requis' });
  }
  if (!unit || typeof unit !== 'string' || !unit.trim()) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'unit requis' });
  }

  const supabase = getScopedClient(accessToken);

  // Verifie que le menu_item appartient bien a l'establishment demande.
  const { data: menuItem, error: menuItemError } = await supabase
    .from('menu_items')
    .select('id, menu_id, menus!inner(establishment_id)')
    .eq('id', menuItemId)
    .maybeSingle();

  if (menuItemError) {
    console.error('recipe-items: erreur lookup menu_item', menuItemError);
    return res.status(500).json({ error: 'server_error' });
  }
  if (!menuItem || menuItem.menus.establishment_id !== establishmentId) {
    return res.status(404).json({ error: 'not_found', error_description: 'plat introuvable pour cet etablissement' });
  }

  // Verifie que l'ingredient appartient bien au meme etablissement.
  const { data: ingredient, error: ingredientError } = await supabase
    .from('ingredients')
    .select('id, establishment_id')
    .eq('id', ingredientId)
    .maybeSingle();

  if (ingredientError) {
    console.error('recipe-items: erreur lookup ingredient', ingredientError);
    return res.status(500).json({ error: 'server_error' });
  }
  if (!ingredient || ingredient.establishment_id !== establishmentId) {
    return res.status(404).json({ error: 'not_found', error_description: 'ingredient introuvable pour cet etablissement' });
  }

  const { data, error } = await supabase
    .from('recipe_items')
    .insert({
      menu_item_id: menuItemId,
      ingredient_id: ingredientId,
      quantity,
      unit: unit.trim(),
    })
    .select('id, menu_item_id, ingredient_id, quantity, unit')
    .single();

  if (error) {
    console.error('recipe-items: erreur insert', error);
    return res.status(500).json({ error: 'server_error' });
  }

  return res.status(201).json(data);
};
