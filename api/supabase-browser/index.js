// Serves a small ES module that exposes a configured Supabase Auth client to the browser.
// Loaded by index.html (via org-loader.js) and admin.html.
// The anon key is intentionally public — RLS is what protects data.

export default function handler(req, res) {
  const url = process.env.SUPABASE_URL || ''
  const anon = process.env.SUPABASE_ANON_KEY || ''
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300')
  res.status(200).send(`import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.106.0'
export const supabase = createClient(${JSON.stringify(url)}, ${JSON.stringify(anon)}, {
  auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true, storageKey: 'valuesalign-auth' }
})
`)
}
