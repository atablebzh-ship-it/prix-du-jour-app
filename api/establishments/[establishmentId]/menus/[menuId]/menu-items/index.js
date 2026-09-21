const { getScopedClient, extractBearerToken } = require('../../../../../../lib/supabase');

// POST   .../menu-items                       (creer)
// PATCH  .../menu-items?menuItemId=...         (modifier)
// DELETE .../menu-items?menuItemId=...         (supprimer)
//
// PATCH/DELETE regroupes dans ce meme fichier (methode + query string
// plutot qu'un segment d'URL supplementaire) pour rester sous la limite de
// 12 fonctions serverless du plan Vercel Hobby.
module.exports = async (req, res) => {
  const accessToken = extractBearerToken(req);
  if (!accessToken) {
    return res.status(401).json({ error: 'invalid_token', error_description: 'en-tete Authorization: Bearer <token> requis' });
  }

  const { establishmentId, menuId } = req.query;
  if (!establishmentId || !menuId) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'establishmentId et menuId requis' });
  }

  const supabase = getScopedClient(accessToken);

  // Verifie que le menu appartient bien a l'establishment demande, dans le
  // perimetre autorise par RLS.
  const { data: menu, error: menuError } = await supabase
    .from('menus')
    .select('id, establishment_id')
    .eq('id', menuId)
    .maybeSingle();

  if (menuError) {
    console.error('menu-items: erreur lookup menu', menuError);
    return res.status(500).json({ error: 'server_error' });
  }
  if (!menu || menu.establishment_id !== establishmentId) {
    return res.status(404).json({ error: 'not_found', error_description: 'menu introuvable pour cet etablissement' });
  }

  if (req.method === 'POST') {
    return handleCreate(req, res, supabase, menuId);
  }
  if (req.method === 'PATCH') {
    return handleUpdate(req, res, supabase, menuId);
  }
  if (req.method === 'DELETE') {
    return handleDelete(req, res, supabase, menuId);
  }

  res.setHeader('Allow', 'POST, PATCH, DELETE');
  return res.status(405).json({ error: 'method_not_allowed' });
};

// Corps attendu :
// { "name": "Risotto", "description": "Risotto cremeux", "price": 22.00, "position": 1 }
// description et position sont optionnels (position = juste apres le
// dernier plat existant sur cette carte).
async function handleCreate(req, res, supabase, menuId) {
  const { name, description, price: bodyPrice, position: bodyPosition } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'name requis' });
  }
  const price = Number(bodyPrice);
  if (!Number.isFinite(price) || price <= 0) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'price (nombre positif) requis' });
  }
  if (description !== undefined && typeof description !== 'string') {
    return res.status(400).json({ error: 'invalid_request', error_description: 'description doit etre une chaine de caracteres' });
  }

  let position = bodyPosition;
  if (position !== undefined) {
    position = Number(position);
    if (!Number.isInteger(position) || position < 1) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'position doit etre un entier >= 1' });
    }
  }

  if (position === undefined) {
    const { data: lastItem, error: lastItemError } = await supabase
      .from('menu_items')
      .select('position')
      .eq('menu_id', menuId)
      .order('position', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (lastItemError) {
      console.error('menu-items: erreur lookup last position', lastItemError);
      return res.status(500).json({ error: 'server_error' });
    }
    position = lastItem ? lastItem.position + 1 : 1;
  }

  const { data, error } = await supabase
    .from('menu_items')
    .insert({
      menu_id: menuId,
      name: name.trim(),
      description: description !== undefined ? description : null,
      price,
      position,
    })
    .select('id, menu_id, name, description, price, position')
    .single();

  if (error) {
    console.error('menu-items: erreur insert', error);
    return res.status(500).json({ error: 'server_error' });
  }

  return res.status(201).json(data);
}

// PATCH .../menu-items?menuItemId=...
// Corps : { name?, description?, price?, position? } - au moins un champ requis.
async function handleUpdate(req, res, supabase, menuId) {
  const { menuItemId } = req.query;
  if (!menuItemId || typeof menuItemId !== 'string') {
    return res.status(400).json({ error: 'invalid_request', error_description: 'menuItemId (query string) requis' });
  }

  const { name, description, price: bodyPrice, position: bodyPosition } = req.body || {};
  const patch = {};

  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'name doit etre une chaine non vide' });
    }
    patch.name = name.trim();
  }
  if (description !== undefined) {
    if (description !== null && typeof description !== 'string') {
      return res.status(400).json({ error: 'invalid_request', error_description: 'description doit etre une chaine de caracteres ou null' });
    }
    patch.description = description;
  }
  if (bodyPrice !== undefined) {
    const price = Number(bodyPrice);
    if (!Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'price doit etre un nombre positif' });
    }
    patch.price = price;
  }
  if (bodyPosition !== undefined) {
    const position = Number(bodyPosition);
    if (!Number.isInteger(position) || position < 1) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'position doit etre un entier >= 1' });
    }
    patch.position = position;
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'au moins un champ a modifier (name, description, price, position) est requis' });
  }

  const { data, error } = await supabase
    .from('menu_items')
    .update(patch)
    .eq('id', menuItemId)
    .eq('menu_id', menuId)
    .select('id, menu_id, name, description, price, position')
    .maybeSingle();

  if (error) {
    console.error('menu-items: erreur update', error);
    return res.status(500).json({ error: 'server_error' });
  }
  if (!data) {
    return res.status(404).json({ error: 'not_found', error_description: 'plat introuvable pour cette carte' });
  }

  return res.status(200).json(data);
}

// DELETE .../menu-items?menuItemId=...
//
// Supprime un plat (cascade automatique en base pour menu_item_sales et
// menu_item_period_snapshots). Les fiches techniques (recipe_items) de ce
// plat n'ont pas de cascade automatique : elles sont supprimees
// explicitement ici avant le plat lui-meme.
async function handleDelete(req, res, supabase, menuId) {
  const { menuItemId } = req.query;
  if (!menuItemId || typeof menuItemId !== 'string') {
    return res.status(400).json({ error: 'invalid_request', error_description: 'menuItemId (query string) requis' });
  }

  const { data: menuItem, error: lookupError } = await supabase
    .from('menu_items')
    .select('id')
    .eq('id', menuItemId)
    .eq('menu_id', menuId)
    .maybeSingle();

  if (lookupError) {
    console.error('menu-items: erreur lookup avant delete', lookupError);
    return res.status(500).json({ error: 'server_error' });
  }
  if (!menuItem) {
    return res.status(404).json({ error: 'not_found', error_description: 'plat introuvable pour cette carte' });
  }

  const { error: recipeItemsDeleteError } = await supabase
    .from('recipe_items')
    .delete()
    .eq('menu_item_id', menuItemId);

  if (recipeItemsDeleteError) {
    console.error('menu-items: erreur suppression recipe_items avant delete', recipeItemsDeleteError);
    return res.status(500).json({ error: 'server_error' });
  }

  const { error: deleteError } = await supabase
    .from('menu_items')
    .delete()
    .eq('id', menuItemId);

  if (deleteError) {
    console.error('menu-items: erreur delete', deleteError);
    return res.status(500).json({ error: 'server_error' });
  }

  return res.status(204).end();
}
