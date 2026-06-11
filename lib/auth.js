import { getServerSupabase } from './supabase-server.js'

export async function getAuthContext(req) {
  const authHeader = req.headers.authorization || req.headers.Authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null
  }
  const jwt = authHeader.slice(7)

  const supa = getServerSupabase()
  const { data, error } = await supa.auth.getUser(jwt)
  if (error || !data?.user) {
    return null
  }

  // Look up org membership. Indexed query, single row.
  const { data: membership } = await supa
    .from('org_members')
    .select('org_id, role, orgs(username, name)')
    .eq('user_id', data.user.id)
    .maybeSingle()

  if (!membership) {
    return { user: data.user, orgId: null, orgUsername: null, orgName: null, role: null }
  }

  return {
    user: data.user,
    orgId: membership.org_id,
    orgUsername: membership.orgs?.username || null,
    orgName: membership.orgs?.name || null,
    role: membership.role
  }
}

export async function requireAuth(req, res) {
  const ctx = await getAuthContext(req)
  if (!ctx || !ctx.orgId) {
    res.status(401).json({ error: 'Authentication required' })
    return null
  }
  return ctx
}

// Super admin = KLG-side account allowed to onboard new organizations.
// The flag lives in app_metadata (server-controlled; users cannot edit it
// themselves, unlike user_metadata).
export async function requireSuperAdmin(req, res) {
  const authHeader = req.headers.authorization || req.headers.Authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' })
    return null
  }
  const jwt = authHeader.slice(7)

  const supa = getServerSupabase()
  const { data, error } = await supa.auth.getUser(jwt)
  if (error || !data?.user) {
    res.status(401).json({ error: 'Authentication required' })
    return null
  }
  if (data.user.app_metadata?.is_super_admin !== true) {
    res.status(403).json({ error: 'This account does not have onboarding access' })
    return null
  }
  return { user: data.user }
}
