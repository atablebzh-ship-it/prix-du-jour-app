const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { getScopedClient, extractBearerToken } = require('../../lib/supabase');

// POST /api/establishments
//
// Cree un nouvel etablissement (restaurant) pour l'editeur de caisse
// authentifie. C'est le point d'entree de l'onboarding : rien d'autre
// (menu, plat, ingredient, fiche technique) ne peut etre cree sans un
// establishment_id valide.
//
// L'establishment cree est automatiquement rattache a l'editeur du token
// (pos_editor_id), jamais fourni par le client - impossible de creer un
// etablissement pour un autre editeur.
function slugify(text) {
  return text
    .toString()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const accessToken = extractBearerToken(req);
  if (!accessToken) {
    return res.status(401).json({ error: 'invalid_token', error_description: 'en-tete Authorization: Bearer <token> requis' });
  }

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
  const supabase = getScopedClient(accessToken);

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
};
