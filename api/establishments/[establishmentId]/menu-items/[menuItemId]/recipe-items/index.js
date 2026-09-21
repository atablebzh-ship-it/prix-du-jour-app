const { getScopedClient, extractBearerToken } = require('../../../../../../lib/supabase');

// POST   .../recipe-items                         (creer)
// PATCH  .../recipe-items?recipeItemId=...         (modifier)
// DELETE .../recipe-items?recipeItemId=...         (supprimer)
//
// Une ligne de fiche technique : quel ingredient, en quelle quantite. C'est
// la somme des recipe_items d'un plat qui determine son cout matiere
// estime (voir /viability et /price-simulation). PATCH/DELETE regroupes
// dans ce meme fichier (methode + query string plutot qu'un segment d'URL
// supplementaire) pour rester sous la limite de 12 fonctions serverless du
// plan Vercel Hobby.
module.exports = async (req, res) => {
  const accessToken = extractBearerToken(req);
  if (!accessToken) {
    return res.status(401).json({ error: 'invalid_token', error_description: 'en-tete Authorization: Bearer <token> requis' });
  }

  const { establishmentId, menuItemId } = req.query;
  if (!establishmentId || !menuItemId) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'establishmentId et menuItemId requis' });
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

  if (req.method === 'POST') {
    return handleCreate(req, res, supabase, establishmentId, menuItemId);
  }
  if (req.method === 'PATCH') {
    return handleUpdate(req, res, supabase, menuItemId);
  }
  if (req.method === 'DELETE') {
    return handleDelete(req, res, supabase, menuItemId);
  }

  res.setHeader('Allow', 'POST, PATCH, DELETE');
  return res.status(405).json({ error: 'method_not_allowed' });
};

// Corps attendu :
// { "ingredientId": "...", "quantity": 0.4, "unit": "kg" }
async function handleCreate(req, res, supabase, establishmentId, menuItemId) {
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
}

// PATCH .../recipe-items?recipeItemId=...
// Corps : { quantity?, unit? } - au moins un champ requis. Pour changer
// l'ingredient d'une ligne, il est plus sur de la supprimer et d'en creer
// une nouvelle (evite les incoherences de cout).
async function handleUpdate(req, res, supabase, menuItemId) {
  const { recipeItemId } = req.query;
  if (!recipeItemId || typeof recipeItemId !== 'string') {
    return res.status(400).json({ error: 'invalid_request', error_description: 'recipeItemId (query string) requis' });
  }

  const { quantity: bodyQuantity, unit } = req.body || {};
  const patch = {};

  if (bodyQuantity !== undefined) {
    const quantity = Number(bodyQuantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'quantity doit etre un nombre positif' });
    }
    patch.quantity = quantity;
  }
  if (unit !== undefined) {
    if (typeof unit !== 'string' || !unit.trim()) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'unit doit etre une chaine non vide' });
    }
    patch.unit = unit.trim();
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'au moins un champ a modifier (quantity, unit) est requis' });
  }

  const { data, error } = await supabase
    .from('recipe_items')
    .update(patch)
    .eq('id', recipeItemId)
    .eq('menu_item_id', menuItemId)
    .select('id, menu_item_id, ingredient_id, quantity, unit')
    .maybeSingle();

  if (error) {
    console.error('recipe-items: erreur update', error);
    return res.status(500).json({ error: 'server_error' });
  }
  if (!data) {
    return res.status(404).json({ error: 'not_found', error_description: 'ligne de fiche technique introuvable pour ce plat' });
  }

  return res.status(200).json(data);
}

// DELETE .../recipe-items?recipeItemId=...
async function handleDelete(req, res, supabase, menuItemId) {
  const { recipeItemId } = req.query;
  if (!recipeItemId || typeof recipeItemId !== 'string') {
    return res.status(400).json({ error: 'invalid_request', error_description: 'recipeItemId (query string) requis' });
  }

  const { data: recipeItem, error: lookupError } = await supabase
    .from('recipe_items')
    .select('id')
    .eq('id', recipeItemId)
    .eq('menu_item_id', menuItemId)
    .maybeSingle();

  if (lookupError) {
    console.error('recipe-items: erreur lookup avant delete', lookupError);
    return res.status(500).json({ error: 'server_error' });
  }
  if (!recipeItem) {
    return res.status(404).json({ error: 'not_found', error_description: 'ligne de fiche technique introuvable pour ce plat' });
  }

  const { error: deleteError } = await supabase
    .from('recipe_items')
    .delete()
    .eq('id', recipeItemId);

  if (deleteError) {
    console.error('recipe-items: erreur delete', deleteError);
    return res.status(500).json({ error: 'server_error' });
  }

  return res.status(204).end();
}
