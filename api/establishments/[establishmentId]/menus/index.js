const { getScopedClient, extractBearerToken } = require('../../../../lib/supabase');

// POST   /api/establishments/{establishmentId}/menus                  (creer)
// PATCH  /api/establishments/{establishmentId}/menus?menuId=...       (modifier)
// DELETE /api/establishments/{establishmentId}/menus?menuId=...       (supprimer)
//
// Un etablissement peut avoir plusieurs cartes (ex: "Carte principale",
// "Carte des vins", "Menu du midi") ; chacune contient ses propres plats.
// PATCH/DELETE regroupes dans ce meme fichier (methode + query string
// plutot qu'un segment d'URL supplementaire) pour rester sous la limite de
// 12 fonctions serverless du plan Vercel Hobby.
module.exports = async (req, res) => {
  const accessToken = extractBearerToken(req);
  if (!accessToken) {
    return res.status(401).json({ error: 'invalid_token', error_description: 'en-tete Authorization: Bearer <token> requis' });
  }

  const { establishmentId } = req.query;
  if (!establishmentId) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'establishmentId requis' });
  }

  const supabase = getScopedClient(accessToken);

  const { data: establishment, error: establishmentError } = await supabase
    .from('establishments')
    .select('id')
    .eq('id', establishmentId)
    .maybeSingle();

  if (establishmentError) {
    console.error('menus: erreur lookup establishment', establishmentError);
    return res.status(500).json({ error: 'server_error' });
  }
  if (!establishment) {
    return res.status(404).json({ error: 'not_found', error_description: 'etablissement introuvable' });
  }

  if (req.method === 'POST') {
    return handleCreate(req, res, supabase, establishmentId);
  }
  if (req.method === 'PATCH') {
    return handleUpdate(req, res, supabase, establishmentId);
  }
  if (req.method === 'DELETE') {
    return handleDelete(req, res, supabase, establishmentId);
  }

  res.setHeader('Allow', 'POST, PATCH, DELETE');
  return res.status(405).json({ error: 'method_not_allowed' });
};

// Corps attendu :
// { "name": "Carte principale", "isActive": true, "position": 1 }
// isActive et position sont optionnels (defaut : isActive=true, position
// = juste apres la derniere carte existante).
async function handleCreate(req, res, supabase, establishmentId) {
  const { name, isActive, position: bodyPosition } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'name requis' });
  }

  let position = bodyPosition;
  if (position !== undefined) {
    position = Number(position);
    if (!Number.isInteger(position) || position < 1) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'position doit etre un entier >= 1' });
    }
  }

  if (position === undefined) {
    const { data: lastMenu, error: lastMenuError } = await supabase
      .from('menus')
      .select('position')
      .eq('establishment_id', establishmentId)
      .order('position', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (lastMenuError) {
      console.error('menus: erreur lookup last position', lastMenuError);
      return res.status(500).json({ error: 'server_error' });
    }
    position = lastMenu ? lastMenu.position + 1 : 1;
  }

  const { data, error } = await supabase
    .from('menus')
    .insert({
      establishment_id: establishmentId,
      name: name.trim(),
      is_active: isActive !== undefined ? Boolean(isActive) : true,
      position,
    })
    .select('id, establishment_id, name, is_active, position')
    .single();

  if (error) {
    console.error('menus: erreur insert', error);
    return res.status(500).json({ error: 'server_error' });
  }

  return res.status(201).json(data);
}

// PATCH .../menus?menuId=...
// Corps : { name?, isActive?, position? } - au moins un champ requis.
async function handleUpdate(req, res, supabase, establishmentId) {
  const { menuId } = req.query;
  if (!menuId || typeof menuId !== 'string') {
    return res.status(400).json({ error: 'invalid_request', error_description: 'menuId (query string) requis' });
  }

  const { name, isActive, position: bodyPosition } = req.body || {};
  const patch = {};

  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'name doit etre une chaine non vide' });
    }
    patch.name = name.trim();
  }
  if (isActive !== undefined) {
    patch.is_active = Boolean(isActive);
  }
  if (bodyPosition !== undefined) {
    const position = Number(bodyPosition);
    if (!Number.isInteger(position) || position < 1) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'position doit etre un entier >= 1' });
    }
    patch.position = position;
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'au moins un champ a modifier (name, isActive, position) est requis' });
  }

  const { data, error } = await supabase
    .from('menus')
    .update(patch)
    .eq('id', menuId)
    .eq('establishment_id', establishmentId)
    .select('id, establishment_id, name, is_active, position')
    .maybeSingle();

  if (error) {
    console.error('menus: erreur update', error);
    return res.status(500).json({ error: 'server_error' });
  }
  if (!data) {
    return res.status(404).json({ error: 'not_found', error_description: 'carte introuvable pour cet etablissement' });
  }

  return res.status(200).json(data);
}

// DELETE .../menus?menuId=...
//
// Supprime une carte et ses plats (cascade automatique en base pour
// menu_items, menu_item_sales, menu_item_period_snapshots). Les fiches
// techniques (recipe_items) des plats de cette carte n'ont pas de cascade
// automatique depuis menu_items : elles sont supprimees explicitement ici
// avant la carte elle-meme.
async function handleDelete(req, res, supabase, establishmentId) {
  const { menuId } = req.query;
  if (!menuId || typeof menuId !== 'string') {
    return res.status(400).json({ error: 'invalid_request', error_description: 'menuId (query string) requis' });
  }

  const { data: menu, error: lookupError } = await supabase
    .from('menus')
    .select('id')
    .eq('id', menuId)
    .eq('establishment_id', establishmentId)
    .maybeSingle();

  if (lookupError) {
    console.error('menus: erreur lookup avant delete', lookupError);
    return res.status(500).json({ error: 'server_error' });
  }
  if (!menu) {
    return res.status(404).json({ error: 'not_found', error_description: 'carte introuvable pour cet etablissement' });
  }

  const { data: menuItems, error: menuItemsError } = await supabase
    .from('menu_items')
    .select('id')
    .eq('menu_id', menuId);

  if (menuItemsError) {
    console.error('menus: erreur lookup menu_items avant delete', menuItemsError);
    return res.status(500).json({ error: 'server_error' });
  }

  const menuItemIds = (menuItems || []).map((mi) => mi.id);
  if (menuItemIds.length > 0) {
    const { error: recipeItemsDeleteError } = await supabase
      .from('recipe_items')
      .delete()
      .in('menu_item_id', menuItemIds);

    if (recipeItemsDeleteError) {
      console.error('menus: erreur suppression recipe_items avant delete', recipeItemsDeleteError);
      return res.status(500).json({ error: 'server_error' });
    }
  }

  const { error: deleteError } = await supabase
    .from('menus')
    .delete()
    .eq('id', menuId);

  if (deleteError) {
    console.error('menus: erreur delete', deleteError);
    return res.status(500).json({ error: 'server_error' });
  }

  return res.status(204).end();
}
