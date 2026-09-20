const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getServiceClient } = require('../../lib/supabase');

const TOKEN_TTL_SECONDS = 3600;

// POST /api/oauth/token
// OAuth2 client_credentials grant pour les editeurs de caisse.
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const { client_id, client_secret, grant_type } = req.body || {};

  if (grant_type !== 'client_credentials') {
    return res.status(400).json({ error: 'unsupported_grant_type' });
  }
  if (!client_id || !client_secret) {
    return res.status(400).json({
      error: 'invalid_request',
      error_description: 'client_id et client_secret requis',
    });
  }

  let editor;
  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from('pos_editors')
      .select('id, client_secret_hash, active')
      .eq('client_id', client_id)
      .maybeSingle();
    if (error) throw error;
    editor = data;
  } catch (err) {
    console.error('oauth/token: erreur lookup pos_editors', err);
    return res.status(500).json({ error: 'server_error' });
  }

  const invalidCredentials = () =>
    res.status(401).json({ error: 'invalid_client', error_description: 'client_id ou client_secret invalide' });

  if (!editor || !editor.active) return invalidCredentials();

  const secretMatches = await bcrypt.compare(client_secret, editor.client_secret_hash);
  if (!secretMatches) return invalidCredentials();

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    role: 'authenticated',
    editeur_id: editor.id,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  };
  const accessToken = jwt.sign(payload, process.env.SUPABASE_JWT_SECRET, { algorithm: 'HS256' });

  return res.status(200).json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: TOKEN_TTL_SECONDS,
  });
};
