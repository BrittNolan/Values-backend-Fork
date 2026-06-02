import Anthropic from '@anthropic-ai/sdk'
import { ORG_HANDBOOK } from '../lib/handbook.js'
import { requireAuth } from '../lib/auth.js'
import { parseOr400, roleplaySchema } from '../lib/validation.js'

const ANTHROPIC_TIMEOUT_MS = 45000

// TWO PARALLEL ENGINES, fronted by a safety gate.
// Engine 1 (STAFF) is the role-play track: it only ever plays the staff member.
// Engine 2 (COACH) is the evaluation track: it only ever evaluates the leader.
// They fire simultaneously via Promise.all, so they run as genuinely parallel
// tracks rather than one model doing both jobs in a single response.
const STAFF_MODEL = 'claude-opus-4-7'
// Evaluation is more constrained than character work. To cut cost you can drop
// the coach to a cheaper model (e.g. 'claude-sonnet-4-6'); since both calls fire
// in parallel, this does not change the turn's latency.
const COACH_MODEL = 'claude-opus-4-7'
// The safety screen is a constrained binary classification, so it runs on a
// faster/cheaper model to minimize the latency it adds in front of the engines.
const SAFETY_MODEL = 'claude-sonnet-4-6'

// If the semantic safety check itself errors out (transient model failure), do
// we let the role-play proceed (fail open) or block it (fail closed)? The
// keyword net below still runs regardless. Flip to false for a stricter,
// escalation-biased posture.
const SAFETY_FAIL_OPEN = true

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  timeout: ANTHROPIC_TIMEOUT_MS
})

// Anthropic returns billing failures as 400s with "credit balance" in the
// error body. Detect this so the API can surface a useful message instead of
// the generic "malformed response" 502 (retrying doesn't help).
function isCreditBalanceError(err) {
  if (!err) return false
  const msg = (err.message || '') + ' ' + JSON.stringify(err.error || {})
  return /credit balance/i.test(msg)
}

// Same robust JSON extractor analyze.js uses - tolerates preamble, trailing prose,
// markdown fences. See comment there for details.
function extractJsonObject(raw) {
  const stripped = String(raw).replace(/```(?:json)?\s*|```/g, '').trim()
  try { return JSON.parse(stripped) } catch {}
  const start = stripped.indexOf('{')
  if (start === -1) throw new Error('No JSON object in AI response')
  let depth = 0, inString = false, escape = false
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i]
    if (escape) { escape = false; continue }
    if (ch === '\\') { escape = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) {
      return JSON.parse(stripped.slice(start, i + 1))
    }
  }
  throw new Error('No balanced JSON object in AI response')
}

// The staff engine is instructed to return plain text. If it ignores that and
// wraps the line in JSON or quotes anyway, recover the spoken words cleanly.
function sanitizeStaffReply(text) {
  let t = String(text).trim()
  if (t.startsWith('{')) {
    try {
      const o = extractJsonObject(t)
      if (o && typeof o.staffReply === 'string') return o.staffReply.trim()
    } catch {}
  }
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('\u201C') && t.endsWith('\u201D'))) {
    t = t.slice(1, -1).trim()
  }
  return t
}

// ============================================================
// HR-OVERRIDE SAFETY NET (hybrid detection: keyword list + semantic check)
// Mirrors the override in /api/analyze. Runs BEFORE the engines so it
// intercepts and suppresses coaching/role-play generation on detection,
// rather than generating it and discarding it.
// ============================================================

// Conservative, escalation-biased keyword net. KEEP IN SYNC with the list in
// /api/analyze — ideally lift both into ../lib/escalation.js so there is a
// single source of truth.
const ESCALATION_TERMS = [
  'harass', 'discriminat', 'retaliat', 'bully', 'bullying',
  'racism', 'racist', 'sexism', 'sexist', 'ageism', 'ageist',
  'ableism', 'ableist', 'classism', 'classist',
  'homophob', 'transphob', 'xenophob',
  'hostile work environment', 'quid pro quo', 'protected class',
  'protected category', 'slur', 'grope', 'groped', 'unwanted touching',
  'sexually', 'sexual harassment', 'sexual advance'
]

const SAFETY_SYSTEM_PROMPT = `You are a safety classifier for a leadership coaching tool. Your only job is to decide whether a workplace situation or a leader's message involves potential harassment, discrimination, retaliation, bullying, or any protected-category "ism" (racism, sexism, ageism, ableism, classism, and so on).

Trigger TRUE even when no explicit term is used but the sense is clearly present. Example: a report that a manager told someone they look "sexy" is a sense of harassment and triggers TRUE.

Be conservative: if it plausibly crosses into any of these areas, trigger TRUE. These matters must go to a human (HR), not a coaching role-play.

Return ONLY valid JSON. No preamble, no markdown fences:
{ "trigger": true | false, "category": "short label or empty string" }`

// Single inference call with the existing retry + credit-balance handling.
// Returns { ok: true, text } or { ok: false, error }.
async function callClaude(model, systemPrompt, messages, label) {
  let lastError = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const message = await client.messages.create({
        model,
        max_tokens: 1000,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages
      })
      const text = message.content.map(b => b.type === 'text' ? b.text : '').join('')
      return { ok: true, text }
    } catch (err) {
      lastError = err
      console.warn(`[${label}] attempt ${attempt + 1} failed [${err.name || 'Error'}]:`, err.message)
      if (isCreditBalanceError(err)) break
    }
  }
  return { ok: false, error: lastError }
}

// Hybrid screen. Keyword net first (instant, no token cost). If it does not
// trip, run the semantic check to catch the no-keyword cases.
async function screenForEscalation({ scenario, leaderText }) {
  const haystack = `${scenario || ''}\n${leaderText || ''}`.toLowerCase()
  const keywordHit = ESCALATION_TERMS.find(t => haystack.includes(t))
  if (keywordHit) {
    return { trigger: true, via: 'keyword', category: keywordHit }
  }

  const result = await callClaude(
    SAFETY_MODEL,
    SAFETY_SYSTEM_PROMPT,
    [{
      role: 'user',
      content: `Situation:\n${scenario || '(none)'}\n\nLeader's latest message:\n${leaderText || '(none)'}\n\nReturn JSON only.`
    }],
    'safety'
  )

  if (result.ok) {
    try {
      const parsed = extractJsonObject(result.text)
      if (parsed && parsed.trigger === true) {
        return { trigger: true, via: 'semantic', category: parsed.category || '' }
      }
      return { trigger: false }
    } catch (e) {
      console.warn('Safety screen parse failed:', e.message)
    }
  }

  // Semantic check failed. Keyword net already passed. Fall back per policy.
  return { trigger: !SAFETY_FAIL_OPEN, via: 'screen-error', category: '' }
}

const REROUTE_MESSAGE =
  "This may involve conduct that needs to go to HR, not a coaching role-play. " +
  "Please pause here and bring it directly to your HR partner and a trusted colleague. " +
  "Values Lab does not coach on potential harassment, discrimination, retaliation, or bullying. " +
  "Those go to a person, not a practice tool."

const MODE_PROFILES = {
  defensive: {
    posture: "You push back, deflect, minimize, and compare yourself to others. You feel singled out. You are not hostile, but you are protecting yourself. You soften only when the leader earns it through curiosity, acknowledgment, and not rushing.",
    coachingFocus: "Help the leader stay calm and curious under pressure. Watch for defensiveness in their language (commands, blame, comparison) and name when they get pulled into argument."
  },
  receptive: {
    posture: "You are open, reflective, and a little vulnerable. You acknowledge the pattern. You may share what's been going on if the leader makes space. You are not performing okayness, you are genuinely willing to talk.",
    coachingFocus: "Help the leader hold space without rushing to solutions. Watch for the urge to fix, advise, or move to action too quickly. Coach toward staying curious one more beat."
  },
  shutdown: {
    posture: "You give short answers. You say 'I don't know' or 'it's fine.' You want to get back to work. You are not angry, you are withdrawn. You soften only when the leader stops pushing and signals patience and safety.",
    coachingFocus: "Help the leader slow down and use less pressure. Watch for too many questions, filling silence, or trying to extract information. Coach toward patience, naming what they notice without demanding a response, and giving the staff member permission to choose what to share."
  }
}

// ============================================================
// ENGINE 1 — STAFF MEMBER (the role-play track)
// ============================================================
const STAFF_SYSTEM_PROMPT = (mode, scenario, valuesAnalysis) => `You are ONE role only: the staff member in the scenario below, inside a leadership role-play simulation for a tool called Values Lab. You are NOT a coach. You never break character, you never give feedback, you never comment on the conversation. You only speak and react as this one person.

=== THE SCENARIO ===
${scenario}

=== ORGANIZATIONAL VALUES IN PLAY ===
${valuesAnalysis}

=== YOUR POSTURE (mode: ${mode}) ===
${MODE_PROFILES[mode].posture}

Stay in character. React to the leader's tone in real time. If the leader is harsh, get sharper. If the leader is warm and curious, soften gradually but realistically. Do not become receptive instantly just because the leader said one nice thing. Real people need a few moments of consistent care before they open up.

Keep your responses to 1-3 sentences. Conversational, not a monologue. Speak only as the staff member.

=== OUTPUT ===
Return ONLY the staff member's spoken words as plain text. No JSON, no quotation marks, no labels, no stage directions.`

// ============================================================
// ENGINE 2 — COACH / EVALUATOR (the parallel evaluation track)
// ============================================================
const COACH_SYSTEM_PROMPT = (mode, scenario, valuesAnalysis) => `You are a leadership coach running a real-time evaluation track alongside a role-play simulation for a tool called Values Lab. You do NOT speak to the staff member and you do NOT play any character. Your only job is to evaluate the LEADER's most recent message and give them trauma-informed feedback.

=== THE SCENARIO ===
${scenario}

=== ORGANIZATIONAL VALUES IN PLAY ===
${valuesAnalysis}

=== COACHING FOCUS (mode: ${mode}) ===
${MODE_PROFILES[mode].coachingFocus}

Coaching rules:
- Trauma-informed and invitational. No "you should have." Use "try" and "notice" instead.
- Never shame the leader, even when their response was off-track. Name the consequence, not their character.
- Always include a specific "try this" reframe as a sample alternative phrasing.
- Reference organizational values when the leader's response either upheld or strained them.

=== HANDBOOK REFERENCE (optional, for context) ===
${ORG_HANDBOOK.organization} handbook is available. Only reference policy when directly relevant. The role play is primarily a values-and-language exercise, not a policy briefing.

=== EVALUATION SCALE ===
Rate the leader's most recent message on this scale:

- "aligned": Values-aligned, trauma-informed, curious. Acknowledged the staff member, named the pattern without blame, opened space.
- "mixed": Partly worked, partly missed. Maybe the words were okay but the timing was off, or the question was right but loaded with assumption.
- "off-track": Likely to escalate or shut down the conversation. Directive language ("I need you to," "you have to"), blame, comparison, lecturing, or rushing to action.

=== OUTPUT FORMAT ===
Return ONLY valid JSON. No preamble, no markdown fences. Structure:

{
  "level": "aligned" | "mixed" | "off-track",
  "summary": "1-2 sentences naming what worked or what landed off, in invitational language",
  "tryThis": "a specific alternative phrasing the leader could try"
}`

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const ctx = await requireAuth(req, res)
  if (!ctx) return

  const body = parseOr400(roleplaySchema, req.body, res)
  if (!body) return

  const { scenario, mode, valuesAnalysis, conversation } = body
  const values = valuesAnalysis || 'No values analysis provided.'
  const isOpening = !conversation || conversation.length === 0
  const lastLeader = isOpening
    ? null
    : [...conversation].reverse().find(t => t.role === 'leader')

  // ---- HR-OVERRIDE SAFETY GATE (runs before any generation) ----
  const screen = await screenForEscalation({
    scenario,
    leaderText: lastLeader ? lastLeader.text : ''
  })
  if (screen.trigger) {
    // Compliance log (auditable trail in Vercel logs). To persist this to
    // Supabase like /api/analyze does, wire in your existing log helper here.
    console.warn('[COMPLIANCE][roleplay-reroute]', JSON.stringify({
      ts: new Date().toISOString(),
      via: screen.via,
      category: screen.category || null,
      mode,
      organization: ORG_HANDBOOK.organization
    }))
    // Suppress the engines entirely and return the reroute. `error` carries the
    // message so the current front end displays it and halts; `rerouted` is the
    // structured signal for a dedicated reroute card once index.html is updated.
    return res.status(200).json({
      rerouted: true,
      reroute: { message: REROUTE_MESSAGE, via: screen.via },
      error: REROUTE_MESSAGE,
      staffReply: null,
      coaching: null
    })
  }

  // ---- Build STAFF engine input ----
  const staffSystem = STAFF_SYSTEM_PROMPT(mode, scenario, values)
  const staffMessages = []
  if (isOpening) {
    staffMessages.push({
      role: 'user',
      content: 'Generate the staff member\'s opening line based on the scenario and your posture. Plain text only.'
    })
  } else {
    conversation.forEach(turn => {
      if (turn.role === 'leader') {
        staffMessages.push({ role: 'user', content: turn.text })
      } else if (turn.role === 'staff') {
        staffMessages.push({ role: 'assistant', content: turn.text })
      }
    })
  }

  // ---- Build COACH engine input (only when there is a leader message to grade) ----
  let coachPromise = Promise.resolve(null)
  if (lastLeader) {
    const transcript = conversation
      .map(t => `${t.role === 'leader' ? 'LEADER' : 'STAFF MEMBER'}: ${t.text}`)
      .join('\n')
    const coachSystem = COACH_SYSTEM_PROMPT(mode, scenario, values)
    const coachMessages = [{
      role: 'user',
      content: `Here is the role-play conversation so far:\n\n${transcript}\n\nEvaluate the LEADER's most recent message:\n"${lastLeader.text}"\n\nReturn JSON only.`
    }]
    coachPromise = callClaude(COACH_MODEL, coachSystem, coachMessages, 'coach')
  }

  // ---- Fire both engines in parallel ----
  const [staffResult, coachResult] = await Promise.all([
    callClaude(STAFF_MODEL, staffSystem, staffMessages, 'staff'),
    coachPromise
  ])

  // The staff reply is essential. If it fails after retries, surface the error.
  if (!staffResult || !staffResult.ok) {
    const err = staffResult ? staffResult.error : null
    console.error('Roleplay staff engine failed:', err)
    if (isCreditBalanceError(err)) {
      return res.status(402).json({
        error: 'AI service is out of credits. Top up at https://console.anthropic.com/settings/billing and try again.',
        retryable: false
      })
    }
    return res.status(502).json({ error: 'Role play response was malformed. Please try again.', retryable: true })
  }

  const staffReply = sanitizeStaffReply(staffResult.text)

  // Coaching is an enhancement track. If it fails or returns junk, degrade
  // gracefully: return the staff reply with coaching: null rather than failing
  // the whole turn.
  let coaching = null
  if (coachResult && coachResult.ok) {
    try {
      const parsed = extractJsonObject(coachResult.text)
      if (parsed && parsed.level) {
        coaching = {
          level: parsed.level,
          summary: parsed.summary || '',
          tryThis: parsed.tryThis || ''
        }
      }
    } catch (e) {
      console.warn('Coaching parse failed, returning staff reply without coaching:', e.message)
    }
  } else if (coachResult && !coachResult.ok) {
    console.warn(
      'Coaching engine failed, returning staff reply without coaching:',
      coachResult.error && coachResult.error.message
    )
  }

  // Response contract is unchanged for the normal path: { staffReply, coaching }.
  return res.status(200).json({ staffReply, coaching })
}
