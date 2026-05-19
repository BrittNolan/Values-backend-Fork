#!/usr/bin/env node
// One-shot: creates a Supabase Auth user per existing org, with placeholder email.
// Email pattern: <org_username>+placeholder@valuesalign.app
// Password: generated random, written to stdout. Capture and save securely.
// Idempotent - if a user with that email already exists, skips creation but
// still ensures the org_members link.
//
// Run:  node scripts/bootstrap-auth-users.js
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
  const supa = createClient(url, key, { auth: { persistSession: false } })

  const { data: orgs, error } = await supa.from('orgs').select('id, username, name')
  if (error) {
    console.error('Failed to list orgs:', error)
    process.exit(1)
  }

  console.log(`\nBootstrapping ${orgs.length} admin users...`)
  console.log('=============================================')
  console.log('SAVE THESE CREDENTIALS - shown only once:')
  console.log('=============================================\n')

  for (const org of orgs) {
    const email = `${org.username}+placeholder@valuesalign.app`
    const password = randomBytes(12).toString('base64url')

    const { data: created, error: createErr } = await supa.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { org_id: org.id, org_username: org.username, org_name: org.name }
    })

    let userId
    if (createErr) {
      if (createErr.message?.toLowerCase().includes('already')) {
        const { data: list } = await supa.auth.admin.listUsers()
        const existing = list?.users?.find(u => u.email === email)
        if (!existing) {
          console.error(`  FAIL ${org.username}: user "exists" but lookup failed`)
          continue
        }
        userId = existing.id
        console.log(`  SKIP    ${org.name.padEnd(35)} (already exists: ${email})`)
      } else {
        console.error(`  FAIL    ${org.name}: ${createErr.message}`)
        continue
      }
    } else {
      userId = created.user.id
      console.log(`  CREATED ${org.name.padEnd(35)} ${email}`)
      console.log(`          password: ${password}`)
    }

    const { error: memErr } = await supa
      .from('org_members')
      .upsert({ user_id: userId, org_id: org.id, role: 'admin' })
    if (memErr) {
      console.error(`  Membership link FAILED for ${org.name}: ${memErr.message}`)
    }
  }

  console.log('\n=============================================')
  console.log('Done. Save the passwords above in a password manager.')
  console.log('You will use these to log into the app for testing.')
  console.log('=============================================\n')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
