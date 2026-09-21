const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { getScopedClient, extractBearerToken } = require('../../lib/supabase');

// POST   /api/establishments                        (creer un etablissement)
// PATCH  /api/establishments?establishmentId=...     (modifier un etablissement)
// DELETE /api/establishments?establishmentId=...     (supprimer un etablissement)
//
// Regroupe dans un seul fichier (meme route /api/establishments, methode +
// query string plutot qu'un segment d'URL supplementaire) pour rester sous
// la limite de 12 fonctions serverless du plan Vercel Hobby - voir la note
// technique en fin de README.
//
// C'est le point d'entree de l'onboarding : rien d'autre (menu, plat,
// ingredient, fiche technique) ne peut etre cree sans un establishment_id
// valide. L'establishment cree est automatiquement rattache a l'editeur du
// token (pos_editor_id), jamais fourni par le client.
function slugify(text) {
  return text
    .toString()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

module.exports = async (req, res) => {
  const accessToken = extractBearerToken(req);
  if (!accessToken) {
    return res.status(401).json({ error: 'invalid_token', error_description: 'en-tete Authorization: Bearer <token> requis' });
  }

  const supabase = getScopedClient(accessToken);

  if (req.method === 'POST') {
    return handleCreate(req, res, supabase, accessToken);
  }
  if (req.method === 'PATCH') {
    return handleUpdate(req, res, supabase);
  }
  if (req.method === 'DELETE') {
    return handleDelete(req, res, supabase);
  }

  res.setHeader('Allow', 'POST, PATCH, DELETE');
  return res.status(405).json({ error: 'method_not_allowed' });
};

async function handleCreate(req, res, supabase, accessToken) {
  // Le token a deja ete verifie cryptographiquement par Supabase (meme
  // secret HS256) au moment ou la requete arrive a PostgREST - on peut donc
  // se contenter de decoder localement pour recuperer editeur_id sans
  // reverifier la signature ici.
  let editeurId;
  try {
    const payload = jwt.decode(accessToken);
    editeurId = payload && payload.editeur_id;
  } catch (err) {
    editeurId = null;
  }
  if (!editeurId) {
    return res.status(401).json({ error: 'invalid_token', error_description: 'token invalide ou editeur_id manquant' });
  }

  const { name, foodCostTarget } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'name requis' });
  }

  let target = 30;
  if (foodCostTarget !== undefined) {
    target = Number(foodCostTarget);
    if (!Number.isFinite(target) || target <= 0 || target > 100) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'foodCostTarget doit etre un nombre entre 0 et 100' });
    }
  }

  const slug = `${slugify(name)}-${crypto.randomBytes(3).toString('hex')}`;

  const { data, error } = await supabase
    .from('establishments')
    .insert({ name: name.trim(), slug, pos_editor_id: editeurId, food_cost_target: target })
    .select('id, name, slug, food_cost_target')
    .single();

  if (error) {
    console.error('establishments: erreur insert', error);
    return res.status(500).json({ error: 'server_error' });
  }

  return res.status(201).json(data);
}

// PATCH /api/establishments?establishmentId=...
// Corps : { name?, foodCostTarget? } - au moins un des deux champs requis.
async function handleUpdate(req, res, supabase) {
  const { establishmentId } = req.query;
  if (!establishmentId || typeof establishmentId !== 'string') {
    return res.status(400).json({ error: 'invalid_request', error_description: 'establishmentId (query string) requis' });
  }

  const { name, foodCostTarget } = req.body || {};
  const patch = {};

  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'name doit etre une chaine non vide' });
    }
    patch.name = name.trim();
  }
  if (foodCostTarget !== undefined) {
    const target = Number(foodCostTarget);
    if (!Number.isFinite(target) || target <= 0 || target > 100) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'foodCostTarget doit etre un nombre entre 0 et 100' });
    }
    patch.food_cost_target = target;
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'au moins un champ a modifier (name, foodCostTarget) est requis' });
  }

  const { data, error } = await supabase
    .from('establishments')
    .update(patch)
    .eq('id', establishmentId)
    .select('id, name, slug, food_cost_target')
    .maybeSingle();

  if (error) {
    console.error('establishments: erreur update', error);
    return res.status(500).json({ error: 'server_error' });
  }
  if (!data) {
    return res.status(404).json({ error: 'not_found', error_description: 'etablissement introuvable' });
  }

  return res.status(200).json(data);
}

// DELETE /api/establishments?establishmentId=...
//
// Supprime un etablissement et toutes ses donnees dependantes. Les menus,
// plats, ventes et instantanes sont supprimes automatiquement par cascade
// en base ; les fiches techniques (recipe_items) et les ingredients de
// l'etablissement, qui n'ont pas de cascade automatique, sont supprimes
// explicitement ici avant l'etablissement lui-meme.
async function handleDelete(req, res, supabase) {
  const { establishmentId } = req.query;
  if (!establishmentId || typeof establishmentId !== 'string') {
    return res.status(400).json({ error: 'invalid_request', error_description: 'establishmentId (query string) requis' });
  }

  const { data: establishment, error: lookupError } = await supabase
    .from('establishments')
    .select('id')
    .eq('id', establishmentId)
    .maybeSingle();

  if (lookupError) {
    console.error('establishments: erreur lookup avant delete', lookupError);
    return res.status(500).json({ error: 'server_error' });
  }
  if (!establishment) {
    return res.status(404).json({ error: 'not_found', error_description: 'etablissement introuvable' });
  }

  // 1. Recupere les menu_items de l'etablissement (via ses menus), pour
  //    pouvoir purger leurs fiches techniques (pas de cascade automatique).
  const { data: menus, error: menusError } = await supabase
    .from('menus')
    .select('id')
    .eq('establishment_id', establishmentId);

  if (menusError) {
    console.error('establishments: erreur lookup menus avant delete', menusError);
    return res.status(500).json({ error: 'server_error' });
  }

  const menuIds = (menus || []).map((m) => m.id);
  if (menuIds.length > 0) {
    const { data: menuItems, error: menuItemsError } = await supabase
      .from('menu_items')
      .select('id')
      .in('menu_id', menuIds);

    if (menuItemsError) {
      console.error('establishments: erreur lookup menu_items avant delete', menuItemsError);
      return res.status(500).json({ error: 'server_error' });
    }

    const menuItemIds = (menuItems || []).map((mi) => mi.id);
    if (menuItemIds.length > 0) {
      const { error: recipeItemsDeleteError } = await supabase
        .from('recipe_items')
        .delete()
        .in('menu_item_id', menuItemIds);

      if (recipeItemsDeleteError) {
        console.error('establishments: erreur suppression recipe_items avant delete', recipeItemsDeleteError);
        return res.status(500).json({ error: 'server_error' });
      }
    }
  }

  // 2. Supprime les ingredients de l'etablissement (pas de cascade depuis
  //    establishments). Les recipe_items qui les referencaient viennent
  //    d'etre supprimes ci-dessus.
  const { error: ingredientsDeleteError } = await supabase
    .from('ingredients')
    .delete()
    .eq('establishment_id', establishmentId);

  if (ingredientsDeleteError) {
    console.error('establishments: erreur suppression ingredients avant delete', ingredientsDeleteError);
    return res.status(500).json({ error: 'server_error' });
  }

  // 3. Supprime l'etablissement. menus -> menu_items -> (sales, snapshots)
  //    partent en cascade automatiquement.
  const { error: deleteError } = await supabase
    .from('establishments')
    .delete()
    .eq('id', establishmentId);

  if (deleteError) {
    console.error('establishments: erreur delete', deleteError);
    return res.status(500).json({ error: 'server_error' });
  }

  return res.status(204).end();
}
