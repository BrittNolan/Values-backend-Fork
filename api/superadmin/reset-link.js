import { requireSuperAdmin } from '../../lib/auth.js'
import { getServerSupabase } from '../../lib/supabase-server.js'
import { generateSetupLink, requestOrigin } from '../../lib/setup-link.js'

// Mint a fresh one-time "choose your password" link for an ALREADY-created org.
// This is the "client (or admin) lost the password" path: the original backup
// password is unrecoverable by design, so instead of resetting a secret we hand
// out a new link that lets them set their own. Each new link invalidates the
// previous one (single-use recovery token).
//
// Usernames drive the login email (<username>+placeholder@valuesalign.app), same
// rule the onboarding wizard enforces.
const USERNAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/

export default async function handler(req, res) {
  const ctx = await requireSuperAdmin(req, res)
  if (!ctx) return

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const username = typeof req.body?.username === 'string'
    ? req.body.username.trim().toLowerCase()
    : ''
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'A valid organization username is required.' })
  }

  const supa = getServerSupabase()

  // Confirm the org exists before minting a link for its login. Keeps this from
  // generating recovery tokens for arbitrary email addresses.
  const { data: org, error: orgErr } = await supa
    .from('orgs')
    .select('id, name, username')
    .eq('username', username)
    .maybeSingle()
  if (orgErr) {
    console.error('Reset-link org lookup error:', orgErr)
    return res.status(500).json({ error: 'Could not look up the organization.' })
  }
  if (!org) {
    return res.status(404).json({ error: `No organization found with username "${username}".` })
  }

  const email = `${org.username}+placeholder@valuesalign.app`
  const setupLink = await generateSetupLink(supa, email, requestOrigin(req))
  if (!setupLink) {
    return res.status(500).json({ error: 'Could not generate a set-password link. Please try again.' })
  }

  return res.status(200).json({
    ok: true,
    org: { id: org.id, name: org.name, username: org.username },
    email,
    setup_link: setupLink
  })
}
