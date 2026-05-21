import Anthropic from '@anthropic-ai/sdk'
import { ORG_HANDBOOK } from '../lib/handbook.js'
import { requireAuth } from '../lib/auth.js'
import { parseOr400, roleplaySchema } from '../lib/validation.js'

const ANTHROPIC_TIMEOUT_MS = 45000
const ROLEPLAY_MODEL = 'claude-opus-4-7'

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  timeout: ANTHROPIC_TIMEOUT_MS
})

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

const SYSTEM_PROMPT_TEMPLATE = (mode, scenario, valuesAnalysis) => `You are running a role-play simulation for a leadership coaching tool called Values Lab. You play TWO roles in one response:

ROLE 1: The staff member in the scenario below
ROLE 2: A leadership coach giving real-time feedback to the leader after each of their messages

=== THE SCENARIO ===
${scenario}

=== ORGANIZATIONAL VALUES IN PLAY ===
${valuesAnalysis}

=== STAFF MEMBER POSTURE (mode: ${mode}) ===
${MODE_PROFILES[mode].posture}

Stay in character. React to the leader's tone in real time. If the leader is harsh, get sharper. If the leader is warm and curious, soften gradually but realistically. Do not become receptive instantly just because the leader said one nice thing. Real people need a few moments of consistent care before they open up.

Keep staff responses to 1-3 sentences. Conversational, not monologue.

=== COACHING POSTURE ===
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
  "staffReply": "what the staff member says next, in character",
  "coaching": {
    "level": "aligned" | "mixed" | "off-track",
    "summary": "1-2 sentences naming what worked or what landed off, in invitational language",
    "tryThis": "a specific alternative phrasing the leader could try"
  }
}

For the FIRST message of the conversation (when there is no leader message yet), generate an opening staff message based on the scenario and mode. In that case, return:

{
  "staffReply": "the staff member's opening line, in character",
  "coaching": null
}
`

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const ctx = await requireAuth(req, res)
  if (!ctx) return

  const body = parseOr400(roleplaySchema, req.body, res)
  if (!body) return

  const { scenario, mode, valuesAnalysis, conversation } = body

  const systemPrompt = SYSTEM_PROMPT_TEMPLATE(
    mode,
    scenario,
    valuesAnalysis || 'No values analysis provided.'
  )

  const messages = []

  if (!conversation || conversation.length === 0) {
    messages.push({
      role: 'user',
      content: 'Generate the staff member\'s opening message based on the scenario and mode. Return JSON only.'
    })
  } else {
    conversation.forEach(turn => {
      if (turn.role === 'leader') {
        messages.push({ role: 'user', content: turn.text })
      } else if (turn.role === 'staff') {
        messages.push({ role: 'assistant', content: JSON.stringify({ staffReply: turn.text, coaching: null }) })
      }
    })
  }

  let parsed = null
  let lastError = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const message = await client.messages.create({
        model: ROLEPLAY_MODEL,
        max_tokens: 1000,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages
      })

      const text = message.content.map(b => b.type === 'text' ? b.text : '').join('')
      parsed = extractJsonObject(text)
      break
    } catch (err) {
      lastError = err
      console.warn(`Roleplay attempt ${attempt + 1} failed:`, err.message)
    }
  }

  if (!parsed) {
    console.error('Roleplay failed after retry:', lastError)
    return res.status(502).json({ error: 'Role play response was malformed. Please try again.', retryable: true })
  }

  return res.status(200).json(parsed)
}
