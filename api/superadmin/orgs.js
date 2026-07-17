import { requireSuperAdmin } from '../../lib/auth.js'
import { getServerSupabase } from '../../lib/supabase-server.js'
import { generateSetupLink, requestOrigin } from '../../lib/setup-link.js'

// Usernames become the local part of the placeholder login email
// (<username>+placeholder@valuesalign.app), so keep them email-safe:
// lowercase letters, digits, hyphens; no leading/trailing hyphen.
const USERNAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
const HEX_RE = /^#[0-9a-fA-F]{6}$/

export default async function handler(req, res) {
  const ctx = await requireSuperAdmin(req, res)
  if (!ctx) return

  if (req.method === 'GET') return listOrgs(req, res)
  if (req.method === 'POST') return createOrg(req, res)
  return res.status(405).json({ error: 'Method not allowed' })
}

async function listOrgs(req, res) {
  const supa = getServerSupabase()
  const { data, error } = await supa
    .from('orgs')
    .select('id, name, username, created_at, primary_color, accent_color, logo_url, values')
    .order('created_at', { ascending: false })

  if (error) {
    console.error('Superadmin list orgs error:', error)
    return res.status(500).json({ error: 'Could not load organizations.' })
  }

  const orgs = (data || []).map(o => ({
    id: o.id,
    name: o.name,
    username: o.username,
    created_at: o.created_at,
    primary_color: o.primary_color,
    accent_color: o.accent_color,
    has_logo: !!o.logo_url,
    values_count: Array.isArray(o.values) ? o.values.length : 0
  }))

  res.setHeader('Cache-Control', 'no-store')
  return res.status(200).json({ orgs })
}

function validatePayload(body) {
  if (!body || typeof body !== 'object') return { error: 'Invalid request body.' }

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (name.length < 2 || name.length > 80) {
    return { error: 'Organization name must be 2-80 characters.' }
  }

  const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : ''
  if (!USERNAME_RE.test(username)) {
    return { error: 'Username must be 2-40 characters: lowercase letters, numbers, and hyphens only.' }
  }

  if (!Array.isArray(body.values) || body.values.length < 1 || body.values.length > 15) {
    return { error: 'Please provide between 1 and 15 values.' }
  }
  const values = []
  for (const raw of body.values) {
    if (!raw || typeof raw !== 'object') return { error: 'Each value must be an object.' }
    const vName = typeof raw.name === 'string' ? raw.name.trim() : ''
    if (vName.length < 1 || vName.length > 80) {
      return { error: 'Each value needs a name (max 80 characters).' }
    }
    const v = { name: vName }
    for (const [key, max] of [['definition', 1200], ['name_es', 80], ['definition_es', 1200]]) {
      const s = typeof raw[key] === 'string' ? raw[key].trim() : ''
      if (s.length > max) return { error: `Value "${vName}": ${key} is too long (max ${max} characters).` }
      if (s) v[key] = s
    }
    values.push(v)
  }

  const primary_color = typeof body.primary_color === 'string' && body.primary_color.trim()
    ? body.primary_color.trim() : '#1B2A4A'
  const accent_color = typeof body.accent_color === 'string' && body.accent_color.trim()
    ? body.accent_color.trim() : '#C9A84C'
  if (!HEX_RE.test(primary_color) || !HEX_RE.test(accent_color)) {
    return { error: 'Colors must be hex codes like #1B2A4A.' }
  }

  let logo_url = typeof body.logo_url === 'string' ? body.logo_url.trim() : ''
  if (logo_url) {
    if (logo_url.length > 500 || !/^https:\/\//i.test(logo_url)) {
      return { error: 'Logo must be an https:// URL (max 500 characters).' }
    }
  } else {
    logo_url = null
  }

  const password = typeof body.password === 'string' ? body.password : ''
  if (password.length < 10 || password.length > 72) {
    return { error: 'Password must be 10-72 characters.' }
  }

  // Optional handbook. Only saved when policy text is present; HR contact and
  // version label are decorations on it.
  let handbook = null
  if (body.handbook && typeof body.handbook === 'object') {
    const policies = typeof body.handbook.policies === 'string' ? body.handbook.policies.trim() : ''
    const hr_contact = typeof body.handbook.hr_contact === 'string' ? body.handbook.hr_contact.trim() : ''
    const version = typeof body.handbook.version === 'string' ? body.handbook.version.trim() : ''
    if (policies) {
      if (policies.length > 60000) return { error: 'Handbook policy text is too long (max 60,000 characters).' }
      if (hr_contact.length > 200) return { error: 'HR contact is too long (max 200 characters).' }
      if (version.length > 200) return { error: 'Handbook version label is too long (max 200 characters).' }
      handbook = { policies, hr_contact: hr_contact || null, handbook_version: version || null }
    }
  }

  return { org: { name, username, values, primary_color, accent_color, logo_url }, password, handbook }
}

async function createOrg(req, res) {
  const parsed = validatePayload(req.body)
  if (parsed.error) return res.status(400).json({ error: parsed.error })

  const { org, password, handbook } = parsed
  const supa = getServerSupabase()

  // Username drives both the orgs row and the login email, so reject duplicates upfront.
  const { data: existing, error: existsErr } = await supa
    .from('orgs')
    .select('id')
    .eq('username', org.username)
    .maybeSingle()
  if (existsErr) {
    console.error('Superadmin username check error:', existsErr)
    return res.status(500).json({ error: 'Could not verify username availability.' })
  }
  if (existing) {
    return res.status(409).json({ error: `Username "${org.username}" is already taken.` })
  }

  const { data: inserted, error: insertErr } = await supa
    .from('orgs')
    .insert(org)
    .select('id, name, username')
    .single()
  if (insertErr || !inserted) {
    console.error('Superadmin org insert error:', insertErr)
    return res.status(500).json({ error: 'Could not create the organization.' })
  }

  // Best-effort rollback. Order matters: the handbooks row references the org,
  // so it must go before the org row can be deleted.
  const rollback = async ({ handbookRow = false, userId = null } = {}) => {
    if (handbookRow) {
      const { error: hbErr } = await supa.from('handbooks').delete().eq('org_id', inserted.id)
      if (hbErr) console.error('Superadmin rollback (handbook delete) failed:', hbErr)
    }
    if (userId) {
      const { error: userErr } = await supa.auth.admin.deleteUser(userId)
      if (userErr) console.error('Superadmin rollback (user delete) failed:', userErr)
    }
    const { error: delErr } = await supa.from('orgs').delete().eq('id', inserted.id)
    if (delErr) console.error('Superadmin rollback (org delete) failed:', delErr)
  }

  const email = `${org.username}+placeholder@valuesalign.app`
  const userMeta = { org_id: inserted.id, org_username: org.username, org_name: org.name }

  let userId = null
  let createdNewUser = false
  const { data: created, error: createErr } = await supa.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: userMeta
  })

  if (createErr) {
    // An auth user can be left over from a previously deleted org; reclaim it
    // so the username stays usable.
    if (createErr.message?.toLowerCase().includes('already')) {
      const { data: list, error: listErr } = await supa.auth.admin.listUsers({ page: 1, perPage: 1000 })
      const orphan = list?.users?.find(u => u.email === email)
      if (listErr || !orphan) {
        console.error('Superadmin orphan user lookup failed:', listErr)
        await rollback()
        return res.status(500).json({ error: 'Could not create the login account.' })
      }
      const { error: updErr } = await supa.auth.admin.updateUserById(orphan.id, {
        password,
        user_metadata: userMeta
      })
      if (updErr) {
        console.error('Superadmin orphan user update failed:', updErr)
        await rollback()
        return res.status(500).json({ error: 'Could not create the login account.' })
      }
      userId = orphan.id
    } else {
      console.error('Superadmin user create error:', createErr)
      await rollback()
      return res.status(500).json({ error: 'Could not create the login account.' })
    }
  } else {
    userId = created.user.id
    createdNewUser = true
  }

  // Optional handbook row. /api/analyze picks it up automatically (org_id +
  // is_active), so nothing else needs to know about it.
  let handbookInserted = false
  if (handbook) {
    const { error: hbErr } = await supa.from('handbooks').insert({
      org_id: inserted.id,
      org_name: org.name,
      policies: handbook.policies,
      hr_contact: handbook.hr_contact,
      handbook_version: handbook.handbook_version,
      is_active: true
    })
    if (hbErr) {
      console.error('Superadmin handbook insert error:', hbErr)
      await rollback({ userId: createdNewUser ? userId : null })
      return res.status(500).json({ error: 'Could not save the handbook.' })
    }
    handbookInserted = true
  }

  const { error: memErr } = await supa
    .from('org_members')
    .upsert({ user_id: userId, org_id: inserted.id, role: 'admin' })
  if (memErr) {
    console.error('Superadmin membership link error:', memErr)
    await rollback({ handbookRow: handbookInserted, userId: createdNewUser ? userId : null })
    return res.status(500).json({ error: 'Could not link the login account to the organization.' })
  }

  // One-time "choose your password" link. Fail-soft: if generation hiccups,
  // the org is still created and the console falls back to password-only.
  const setupLink = await generateSetupLink(supa, email, requestOrigin(req))

  return res.status(201).json({
    ok: true,
    org: inserted,
    handbook: handbookInserted,
    setup_link: setupLink,
    credentials: { username: org.username, email, password }
  })
}
