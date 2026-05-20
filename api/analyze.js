import Anthropic from '@anthropic-ai/sdk'
import { getServerSupabase } from '../lib/supabase-server.js'
import { parseOr400, analyzeSchema } from '../lib/validation.js'
import { requireAuth } from '../lib/auth.js'
import { DEFAULT_ANALYZE_SYSTEM_PROMPT, buildHandbookBlock } from '../lib/system-prompts.js'

// Vercel function ceiling is 300s on Pro (see vercel.json). Give Claude generous
// budget for the first attempt and still leave room for a parse-failure retry,
// while keeping a hard ceiling so the function can't be killed mid-response.
const ANTHROPIC_TIMEOUT_MS = 120000
const RETRY_TIMEOUT_MS = 60000
const FUNCTION_BUDGET_MS = 290000
const ANALYZE_MODEL = 'claude-opus-4-7'
const MAX_TOKENS = 4000

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  timeout: ANTHROPIC_TIMEOUT_MS
})

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const ctx = await requireAuth(req, res)
  if (!ctx) return

  const body = parseOr400(analyzeSchema, req.body, res)
  if (!body) return

  const { situation, pattern, systemPrompt: clientPrompt } = body
  const orgId = ctx.orgId
  const supa = getServerSupabase()

  let handbook = null
  if (orgId) {
    const { data } = await supa
      .from('handbooks')
      .select('org_name, handbook_version, hr_contact, policies')
      .eq('org_id', orgId)
      .eq('is_active', true)
      .maybeSingle()
    if (data) handbook = data
  }

  // The frontend builds rich, dynamic prompts (sector, tone, language, impairment
  // handling, quickView schema). Accept that prompt if provided; fall back to the
  // server-side default if not. Auth is required upstream so randos can't hit this,
  // and the Zod schema caps the prompt at 30KB so nobody can stuff a novel.
  const basePrompt = clientPrompt && clientPrompt.length > 0
    ? clientPrompt
    : DEFAULT_ANALYZE_SYSTEM_PROMPT
  const fullPrompt = basePrompt + buildHandbookBlock(handbook)

  // Retry once on JSON parse failure (audit fix B3), but only if the function
  // still has budget — otherwise the retry would push us past Vercel's 60s ceiling
  // and the platform would kill us mid-response.
  const startedAt = Date.now()
  let parsed = null
  let lastError = null
  for (let attempt = 0; attempt < 2; attempt++) {
    const elapsed = Date.now() - startedAt
    if (attempt === 1 && elapsed > FUNCTION_BUDGET_MS - RETRY_TIMEOUT_MS) {
      console.warn(`Analyze retry skipped: ${elapsed}ms elapsed, not enough budget left`)
      break
    }
    try {
      const userMessage = attempt === 0
        ? `Analyze this situation: ${situation.trim()}`
        : `Analyze this situation: ${situation.trim()}\n\n(Note: your previous response was not valid JSON. Return ONLY valid JSON, no markdown, no preamble.)`

      const message = await client.messages.create({
        model: ANALYZE_MODEL,
        max_tokens: MAX_TOKENS,
        // Prompt caching saves ~90% on the long stable system prompt
        system: [{ type: 'text', text: fullPrompt, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: userMessage }]
      }, { timeout: attempt === 0 ? ANTHROPIC_TIMEOUT_MS : RETRY_TIMEOUT_MS })

      const text = message.content.map(b => b.type === 'text' ? b.text : '').join('')
      const clean = text.replace(/```json|```/g, '').trim()
      parsed = JSON.parse(clean)
      break
    } catch (err) {
      lastError = err
      console.warn(`Analyze attempt ${attempt + 1} failed:`, err.message)
    }
  }

  if (!parsed) {
    console.error('Analyze failed after retry:', lastError)
    return res.status(502).json({
      error: 'AI response was malformed. Please try again.',
      retryable: true
    })
  }

  // Server-side session write (replaces the previous client-side write)
  const misaligned = (parsed.valuesAnalysis || [])
    .filter(v => v.status === 'Misaligned')
    .map(v => v.value)
  const upheld = (parsed.valuesAnalysis || [])
    .filter(v => v.status === 'Upheld')
    .map(v => v.value)

  const { error: insErr } = await supa.from('sessions').insert({
    org_id: orgId,
    behavior: situation.trim(),
    pattern: pattern || 'first',
    misaligned_values: misaligned,
    upheld_values: upheld,
    recommended_action: parsed.recommendedAction?.action || null,
    result_json: parsed
  })
  if (insErr) {
    // Don't fail the user - coaching response is already in hand
    console.warn('Session log write failed:', insErr)
  }

  return res.status(200).json(parsed)
}
