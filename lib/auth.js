import { createClient } from '@supabase/supabase-js';
import { bearerToken } from './security/validate';

// Resolve the signed-in user from a Bearer token, and give back a client that acts as them (RLS applies).
export async function userFromRequest(req) {
  const token = bearerToken(req.headers.get('authorization'));
  if (!token) return null;
  const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });
  const { data, error } = await client.auth.getUser(token);
  return !error && data?.user ? { user: data.user, client } : null;
}
