const { getScopedClient, extractBearerToken } = require('../../../../lib/supabase');

// POST /api/establishments/{establishmentId}/menus
//
// Cree une carte (menu) pour un etablissement existant. Un etablissement
// peut avoir plusieurs cartes (ex: "Carte principale", "Carte des vins",
// "Menu du midi") ; chacune contient ses propres plats.
//
// Corps attendu :
// { "name": "Carte principale", "isActive": true, "position": 1 }
// isActive et position sont optionnels (defaut : isActive=true, position
// = juste apres la derniere carte existante).
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
};
