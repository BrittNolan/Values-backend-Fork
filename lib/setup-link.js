// One-time "choose your password" links for org logins.
//
// We generate a Supabase recovery token server-side and wrap its token_hash
// in OUR OWN page URL (/setup-password.html), where the browser client calls
// auth.verifyOtp({ type: 'recovery', token_hash }). Compared to Supabase's
// raw action_link, this needs no redirect-URL allowlisting and the link the
// client receives lives on the app's own domain.
//
// Tokens are single-use and expire per the project's Email OTP expiry
// setting (Supabase default: 1 hour). The console can mint a fresh link
// anytime, which also serves as the "client lost their password" reset path.

export async function generateSetupLink(supa, email, origin) {
  if (!origin) return null
  try {
    const { data, error } = await supa.auth.admin.generateLink({
      type: 'recovery',
      email
    })
    const tokenHash = data?.properties?.hashed_token
    if (error || !tokenHash) {
      console.error('Setup link generation failed:', error || 'no hashed_token in response')
      return null
    }
    return `${origin}/setup-password.html?token_hash=${encodeURIComponent(tokenHash)}&type=recovery`
  } catch (e) {
    console.error('Setup link generation threw:', e)
    return null
  }
}

// Best-effort origin for building links: same-origin POSTs always carry an
// Origin header; fall back to the Host header.
export function requestOrigin(req) {
  const origin = req.headers.origin || req.headers.Origin
  if (origin) return origin
  const host = req.headers.host
  if (!host) return null
  const proto = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ? 'http' : 'https'
  return `${proto}://${host}`
}
