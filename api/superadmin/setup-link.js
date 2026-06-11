import { requireSuperAdmin } from '../../lib/auth.js'
import { getServerSupabase } from '../../lib/supabase-server.js'
import { generateSetupLink, requestOrigin } from '../../lib/setup-link.js'

// Mints a fresh one-time set-password link for an existing org. Used when a
// previous link expired unused, and as the reset path when an org loses its
// password. Each link invalidates nothing until clicked; clicking consumes it.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const ctx = await requireSuperAdmin(req, res)
  if (!ctx) return

  const orgId = typeof req.body?.org_id === 'string' ? req.body.org_id.trim() : ''
  if (!orgId) return res.status(400).json({ error: 'org_id is required.' })

  const supa = getServerSupabase()
  const { data: org, error } = await supa
    .from('orgs')
    .select('id, name, username')
    .eq('id', orgId)
    .maybeSingle()
  if (error) {
    console.error('Setup link org lookup error:', error)
    return res.status(500).json({ error: 'Could not look up the organization.' })
  }
  if (!org) return res.status(404).json({ error: 'Organization not found.' })

  const email = `${org.username}+placeholder@valuesalign.app`
  const link = await generateSetupLink(supa, email, requestOrigin(req))
  if (!link) {
    return res.status(500).json({ error: 'Could not generate the link. Please try again.' })
  }

  res.setHeader('Cache-Control', 'no-store')
  return res.status(200).json({ ok: true, org: { id: org.id, name: org.name, username: org.username }, link })
}
