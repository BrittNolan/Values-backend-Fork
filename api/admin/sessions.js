import { requireAuth } from '../../lib/auth.js'
import { getServerSupabase } from '../../lib/supabase-server.js'

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const ctx = await requireAuth(req, res)
  if (!ctx) return

  const supa = getServerSupabase()
  const { data, error } = await supa
    .from('sessions')
    .select('id, org_id, behavior, pattern, misaligned_values, upheld_values, recommended_action, result_json, created_at')
    .eq('org_id', ctx.orgId)
    .order('created_at', { ascending: false })
    .limit(1000)

  if (error) {
    console.error('Admin sessions error:', error)
    return res.status(500).json({ error: 'Could not load sessions.' })
  }

  res.setHeader('Cache-Control', 'no-store')
  return res.status(200).json({ sessions: data || [] })
}
