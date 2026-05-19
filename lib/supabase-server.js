import { createClient } from '@supabase/supabase-js'

let cached = null

export function getServerSupabase() {
  if (cached) return cached
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('Server Supabase credentials missing (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)')
  }
  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'public' }
  })
  return cached
}
