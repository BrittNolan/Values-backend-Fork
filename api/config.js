// /api/config used to expose the Supabase anon key for the client to use directly.
// As of Phase 2B, the browser loads its Supabase Auth client from /api/supabase-browser.js
// (which embeds the anon key safely at request time, and the anon key is harmless once RLS is on).
// This endpoint now returns only safe app metadata so any old clients fail gracefully.
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300')
  res.status(200).json({
    app: 'values-align',
    version: '1.1.0',
    features: { audio: true, languages: ['en', 'es'] }
  })
}
