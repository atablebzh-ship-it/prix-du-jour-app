const { getScopedClient, extractBearerToken } = require('../../../../lib/supabase');

// POST   .../ingredients                        (creer)
// PATCH  .../ingredients?ingredientId=...        (modifier)
// DELETE .../ingredients?ingredientId=...        (supprimer)
//
// Un ingredient peut ensuite etre utilise dans une ou plusieurs fiches
// techniques (recipe_items). PATCH/DELETE regroupes dans ce meme fichier
// (methode + query string plutot qu'un segment d'URL supplementaire) pour
// rester sous la limite de 12 fonctions serverless du plan Vercel Hobby.
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
    console.error('ingredients: erreur lookup establishment', establishmentError);
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
// { "name": "Aubergine", "unit": "kg", "marketReferenceCode": "aubergine" }
// - unit : unite d'achat de l'ingredient (kg, L, unit, ...)
// - marketReferenceCode : optionnel. Code utilise pour relier l'ingredient
//   au "cours du jour" (market_prices). Sans ce code, l'ingredient ne
//   beneficiera pas du suivi automatique des prix marche (viabilite,
//   opportunites, risques).
async function handleCreate(req, res, supabase, establishmentId) {
  const { name, unit, marketReferenceCode } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'name requis' });
  }
  if (!unit || typeof unit !== 'string' || !unit.trim()) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'unit requis' });
  }
  if (marketReferenceCode !== undefined && marketReferenceCode !== null && typeof marketReferenceCode !== 'string') {
    return res.status(400).json({ error: 'invalid_request', error_description: 'marketReferenceCode doit etre une chaine de caracteres' });
  }

  const { data, error } = await supabase
    .from('ingredients')
    .insert({
      establishment_id: establishmentId,
      name: name.trim(),
      unit: unit.trim(),
      market_reference_code: marketReferenceCode ? marketReferenceCode.trim() : null,
    })
    .select('id, establishment_id, name, unit, market_reference_code')
    .single();

  if (error) {
    console.error('ingredients: erreur insert', error);
    return res.status(500).json({ error: 'server_error' });
  }

  return res.status(201).json(data);
}

// PATCH .../ingredients?ingredientId=...
// Corps : { name?, unit?, marketReferenceCode? } - au moins un champ requis.
async function handleUpdate(req, res, supabase, establishmentId) {
  const { ingredientId } = req.query;
  if (!ingredientId || typeof ingredientId !== 'string') {
    return res.status(400).json({ error: 'invalid_request', error_description: 'ingredientId (query string) requis' });
  }

  const { name, unit, marketReferenceCode } = req.body || {};
  const patch = {};

  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'name doit etre une chaine non vide' });
    }
    patch.name = name.trim();
  }
  if (unit !== undefined) {
    if (typeof unit !== 'string' || !unit.trim()) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'unit doit etre une chaine non vide' });
    }
    patch.unit = unit.trim();
  }
  if (marketReferenceCode !== undefined) {
    if (marketReferenceCode !== null && typeof marketReferenceCode !== 'string') {
      return res.status(400).json({ error: 'invalid_request', error_description: 'marketReferenceCode doit etre une chaine de caracteres ou null' });
    }
    patch.market_reference_code = marketReferenceCode ? marketReferenceCode.trim() : null;
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'au moins un champ a modifier (name, unit, marketReferenceCode) est requis' });
  }

  const { data, error } = await supabase
    .from('ingredients')
    .update(patch)
    .eq('id', ingredientId)
    .eq('establishment_id', establishmentId)
    .select('id, establishment_id, name, unit, market_reference_code')
    .maybeSingle();

  if (error) {
    console.error('ingredients: erreur update', error);
    return res.status(500).json({ error: 'server_error' });
  }
  if (!data) {
    return res.status(404).json({ error: 'not_found', error_description: 'ingredient introuvable pour cet etablissement' });
  }

  return res.status(200).json(data);
}

// DELETE .../ingredients?ingredientId=...
//
// Refuse la suppression (409) si l'ingredient est encore utilise dans une
// ou plusieurs fiches techniques (recipe_items) : il faut d'abord retirer
// ces lignes de recette, pour eviter de casser silencieusement le calcul
// de cout d'un plat.
async function handleDelete(req, res, supabase, establishmentId) {
  const { ingredientId } = req.query;
  if (!ingredientId || typeof ingredientId !== 'string') {
    return res.status(400).json({ error: 'invalid_request', error_description: 'ingredientId (query string) requis' });
  }

  const { data: ingredient, error: lookupError } = await supabase
    .from('ingredients')
    .select('id')
    .eq('id', ingredientId)
    .eq('establishment_id', establishmentId)
    .maybeSingle();

  if (lookupError) {
    console.error('ingredients: erreur lookup avant delete', lookupError);
    return res.status(500).json({ error: 'server_error' });
  }
  if (!ingredient) {
    return res.status(404).json({ error: 'not_found', error_description: 'ingredient introuvable pour cet etablissement' });
  }

  const { count: usageCount, error: usageError } = await supabase
    .from('recipe_items')
    .select('id', { count: 'exact', head: true })
    .eq('ingredient_id', ingredientId);

  if (usageError) {
    console.error('ingredients: erreur verification usage avant delete', usageError);
    return res.status(500).json({ error: 'server_error' });
  }
  if (usageCount && usageCount > 0) {
    return res.status(409).json({
      error: 'conflict',
      error_description: `cet ingredient est utilise dans ${usageCount} fiche(s) technique(s) - retirez-le des recettes concernees avant de le supprimer`,
    });
  }

  const { error: deleteError } = await supabase
    .from('ingredients')
    .delete()
    .eq('id', ingredientId);

  if (deleteError) {
    console.error('ingredients: erreur delete', deleteError);
    return res.status(500).json({ error: 'server_error' });
  }

  return res.status(204).end();
}
