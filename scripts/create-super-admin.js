#!/usr/bin/env node
// One-shot: creates (or upgrades) a SUPER ADMIN account for the onboarding
// wizard at /superadmin.html. Super admins are not tied to any org; they are
// marked with app_metadata.is_super_admin = true, which the
// /api/superadmin/* routes check server-side.
//
// Run:  node scripts/create-super-admin.js <email> [password]
//   - New user, no password given:  a random password is generated and printed.
//   - Existing user, no password:   the account is upgraded to super admin and
//                                   the password is left unchanged.
//   - Password given:               used (new user) or set (existing user).
//
// Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in environment (.env.local works).

import { createClient } from '@supabase/supabase-js'
import { config as loadEnv } from 'dotenv'
import { randomBytes } from 'node:crypto'

loadEnv({ path: '.env.local' })

async function main() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local')
    process.exit(1)
  }

  const email = (process.argv[2] || '').trim().toLowerCase()
  const passwordArg = process.argv[3] || ''
  if (!email || !email.includes('@')) {
    console.error('Usage: node scripts/create-super-admin.js <email> [password]')
    process.exit(1)
  }
  if (passwordArg && passwordArg.length < 10) {
    console.error('Password must be at least 10 characters.')
    process.exit(1)
  }

  const supa = createClient(url, key, { auth: { persistSession: false } })
  const password = passwordArg || randomBytes(12).toString('base64url')

  const { data: created, error: createErr } = await supa.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { is_super_admin: true }
  })

  if (!createErr) {
    console.log('\nSuper admin CREATED:')
    console.log(`  email:    ${email}`)
    console.log(`  password: ${password}`)
    console.log('\nSave the password now - it is shown only once.')
    console.log(`Sign in at: https://<your-app-domain>/superadmin.html  (user id: ${created.user.id})\n`)
    return
  }

  if (!createErr.message?.toLowerCase().includes('already')) {
    console.error('Failed to create user:', createErr.message)
    process.exit(1)
  }

  // User already exists: upgrade them to super admin.
  const { data: list, error: listErr } = await supa.auth.admin.listUsers({ page: 1, perPage: 1000 })
  const existing = list?.users?.find(u => u.email === email)
  if (listErr || !existing) {
    console.error('User "exists" but lookup failed:', listErr?.message || 'not found')
    process.exit(1)
  }

  const update = {
    app_metadata: { ...existing.app_metadata, is_super_admin: true }
  }
  if (passwordArg) update.password = passwordArg

  const { error: updErr } = await supa.auth.admin.updateUserById(existing.id, update)
  if (updErr) {
    console.error('Failed to upgrade existing user:', updErr.message)
    process.exit(1)
  }

  console.log('\nExisting user UPGRADED to super admin:')
  console.log(`  email:    ${email}`)
  console.log(passwordArg ? `  password: ${passwordArg} (reset)` : '  password: unchanged')
  console.log(`\nSign in at: https://<your-app-domain>/superadmin.html  (user id: ${existing.id})\n`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
