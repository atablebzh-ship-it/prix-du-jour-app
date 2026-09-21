const { getScopedClient, extractBearerToken } = require('../../../../../../lib/supabase');

// POST /api/establishments/{establishmentId}/menus/{menuId}/menu-items
//
// Cree un plat sur une carte existante.
//
// Corps attendu :
// { "name": "Risotto", "description": "Risotto cremeux", "price": 22.00, "position": 1 }
// description et position sont optionnels (position = juste apres le
// dernier plat existant sur cette carte).
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const accessToken = extractBearerToken(req);
  if (!accessToken) {
    return res.status(401).json({ error: 'invalid_token', error_description: 'en-tete Authorization: Bearer <token> requis' });
  }

  const { establishmentId, menuId } = req.query;
  if (!establishmentId || !menuId) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'establishmentId et menuId requis' });
  }

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
};
