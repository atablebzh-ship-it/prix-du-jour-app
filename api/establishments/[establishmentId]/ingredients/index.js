const { getScopedClient, extractBearerToken } = require('../../../../lib/supabase');

// POST /api/establishments/{establishmentId}/ingredients
//
// Cree un ingredient pour un etablissement. Un ingredient peut ensuite
// etre utilise dans une ou plusieurs fiches techniques (recipe_items).
//
// Corps attendu :
// { "name": "Aubergine", "unit": "kg", "marketReferenceCode": "aubergine" }
// - unit : unite d'achat de l'ingredient (kg, L, unit, ...)
// - marketReferenceCode : optionnel. Code utilise pour relier l'ingredient
//   au "cours du jour" (market_prices). Sans ce code, l'ingredient ne
//   beneficiera pas du suivi automatique des prix marche (viabilite,
//   opportunites, risques), mais peut tout de meme etre utilise dans une
//   fiche technique avec un cout fixe/manuel si le modele l'evolue en ce sens.
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
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
};
