import { requireAuth } from '../lib/auth.js'
import { getServerSupabase } from '../lib/supabase-server.js'

export default async function handler(req, res) {
  const ctx = await requireAuth(req, res)
  if (!ctx) return

  const supa = getServerSupabase()
  const { data: org, error } = await supa
    .from('orgs')
    .select('id, name, username, values, logo_url, primary_color, accent_color')
    .eq('id', ctx.orgId)
    .maybeSingle()

  if (error || !org) {
    return res.status(500).json({ error: 'Could not load organization' })
  }

  res.setHeader('Cache-Control', 'no-store')
  return res.status(200).json({
    user: { id: ctx.user.id, email: ctx.user.email, role: ctx.role },
    org
  })
}
