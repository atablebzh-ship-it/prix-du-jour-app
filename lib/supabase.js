const { createClient } = require('@supabase/supabase-js');

/**
 * Client Supabase "admin" (service_role) - a n'utiliser que pour des operations
 * internes qui doivent contourner RLS (ex: lookup d'un pos_editor lors de l'auth).
 */
function getServiceClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

/**
 * Client Supabase scope sur le JWT de l'appelant (editeur de caisse authentifie).
 * Toutes les requetes faites avec ce client passent par les policies RLS,
 * qui filtrent automatiquement sur editeur_id via auth.jwt() ->> 'editeur_id'.
 */
function getScopedClient(accessToken) {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  });
}

/**
 * Extrait le token Bearer de l'en-tete Authorization. Retourne null si absent/mal forme.
 */
function extractBearerToken(req) {
  const header = req.headers['authorization'] || req.headers['Authorization'];
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token || null;
}

module.exports = { getServiceClient, getScopedClient, extractBearerToken };
