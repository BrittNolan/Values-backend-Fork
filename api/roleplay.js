import Anthropic from '@anthropic-ai/sdk'
import { ORG_HANDBOOK } from './lifemoves-handbook.js'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

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

  const { scenario, valuesAnalysis, mode, conversation } = req.body

  if (!scenario || !mode || !MODE_PROFILES[mode]) {
    return res.status(400).json({ error: 'Missing or invalid scenario/mode' })
  }

  const systemPrompt = SYSTEM_PROMPT_TEMPLATE(
    mode,
    scenario,
    valuesAnalysis || 'No values analysis provided.'
  )

  // Build the message history for Claude
  const messages = []

  if (!conversation || conversation.length === 0) {
    // First call: generate the staff member's opening line
    messages.push({
      role: 'user',
      content: 'Generate the staff member\'s opening message based on the scenario and mode. Return JSON only.'
    })
  } else {
    // Subsequent calls: pass the conversation as alternating user/assistant
    // The leader's messages are "user" (since they're talking to the staff member)
    // The staff member's previous replies are "assistant"
    conversation.forEach(turn => {
      if (turn.role === 'leader') {
        messages.push({ role: 'user', content: turn.text })
      } else if (turn.role === 'staff') {
        messages.push({ role: 'assistant', content: JSON.stringify({ staffReply: turn.text, coaching: null }) })
      }
    })
  }

  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1000,
      system: systemPrompt,
      messages
    })

    const text = message.content.map(b => b.type === 'text' ? b.text : '').join('')
    const clean = text.replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(clean)

    return res.status(200).json(parsed)
  } catch (err) {
    console.error('Roleplay error:', err)
    return res.status(500).json({ error: 'Role play failed. Please try again.' })
  }
}
