const { getScopedClient, extractBearerToken } = require('../../../../lib/supabase');

// POST /api/establishments/{establishmentId}/menu/sales
//
// Permet a l'editeur de caisse de remonter les ventes par plat et par jour.
// Corps attendu :
// {
//   "records": [
//     { "menuItemId": "...", "saleDate": "2026-09-20", "quantity": 12 },
//     ...
//   ]
// }
//
// Chaque enregistrement fait un upsert sur (menu_item_id, sale_date) : si une
// vente existe deja pour ce plat et cette date, la quantite est remplacee
// (permet de renvoyer une correction en cas d'erreur de caisse).
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

  const { records } = req.body || {};
  if (!Array.isArray(records) || records.length === 0) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'records (tableau non vide) requis' });
  }
  if (records.length > 500) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'maximum 500 enregistrements par appel' });
  }

  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const rows = [];
  for (const r of records) {
    if (!r || typeof r !== 'object') {
      return res.status(400).json({ error: 'invalid_request', error_description: 'chaque record doit etre un objet' });
    }
    const { menuItemId, saleDate, quantity } = r;
    if (!menuItemId || typeof menuItemId !== 'string') {
      return res.status(400).json({ error: 'invalid_request', error_description: 'menuItemId requis pour chaque record' });
    }
    if (!saleDate || !dateRe.test(saleDate)) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'saleDate au format YYYY-MM-DD requis pour chaque record' });
    }
    if (!Number.isInteger(quantity) || quantity < 0) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'quantity doit etre un entier positif ou nul' });
    }
    rows.push({ menu_item_id: menuItemId, sale_date: saleDate, quantity });
  }

  const supabase = getScopedClient(accessToken);

  // Verifie que l'etablissement est bien dans le perimetre autorise par RLS.
  const { data: establishment, error: establishmentError } = await supabase
    .from('establishments')
    .select('id')
    .eq('id', establishmentId)
    .maybeSingle();

  if (establishmentError) {
    console.error('menu/sales: erreur lookup establishment', establishmentError);
    return res.status(500).json({ error: 'server_error' });
  }
  if (!establishment) {
    return res.status(404).json({ error: 'not_found', error_description: 'etablissement introuvable' });
  }

  // Upsert : RLS filtre automatiquement les menu_item_id hors perimetre
  // (la ligne echouerait la policy), donc on laisse la base renvoyer une
  // erreur plutot que de re-verifier chaque menu_item_id manuellement.
  const { data, error } = await supabase
    .from('menu_item_sales')
    .upsert(rows, { onConflict: 'menu_item_id,sale_date' })
    .select('menu_item_id, sale_date, quantity');

  if (error) {
    console.error('menu/sales: erreur upsert menu_item_sales', error);
    return res.status(400).json({
      error: 'invalid_request',
      error_description: 'un ou plusieurs menuItemId sont invalides ou hors perimetre',
    });
  }

  return res.status(200).json({
    establishment_id: establishmentId,
    upserted_count: (data || []).length,
    records: data,
  });
};
