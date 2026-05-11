import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'
import { ORG_HANDBOOK } from './lifemoves-handbook.js'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

const HANDBOOK_BLOCK = `

=== ORGANIZATIONAL HANDBOOK (${ORG_HANDBOOK.handbookVersion}) ===
The following are official ${ORG_HANDBOOK.organization} policies. When a situation directly implicates one of these policies, reference the specific policy section by name in your "behaviorObserved", "staffReality", "correctBehavior", or "recommendedAction.reasoning" fields. Quote the policy language briefly when it strengthens the response. Do NOT force handbook references when they are not relevant — values-based coaching is the primary lens; the handbook is a supporting reference.
${ORG_HANDBOOK.policies}
For complex policy questions or formal complaints, the recommendedAction reasoning may direct the leader to contact HR (${ORG_HANDBOOK.hrContact}).
`

const DEFAULT_SYSTEM_PROMPT = `You are a leadership coach trained in values-based, trauma-informed leadership in a social services organization. Your task is to analyze a staff behavior situation and produce a structured leadership response.

Use the following organizational values and behavior definitions:
ADAPTABILITY
Aligned: adjusts approach, remains solution-oriented, stays regulated under stress
Misaligned: rigid responses, escalates quickly, resists change
CLIENT-CENTERED
Aligned: uses calm regulated tone, prioritizes client dignity, listens before responding
Misaligned: raises voice, dismisses client needs, rushes or avoids interaction
COLLABORATION
Aligned: seeks input, shares information, supports team
Misaligned: isolates, withholds info, undermines others
DEIB
Aligned: demonstrates cultural awareness, avoids assumptions, creates inclusive space
Misaligned: makes biased assumptions, dismisses lived experience, uses exclusionary language
INTEGRITY
Aligned: owns mistakes, follows policy, is honest in communication
Misaligned: blames others, avoids accountability, cuts corners
RESPECT
Aligned: communicates professionally, acknowledges others, follows through
Misaligned: interrupts, ignores, uses harsh or dismissive tone

Constraints: Be specific not generic. Align with trauma-informed care. Do not shame the staff member. Focus on accountability and growth.

Respond ONLY in this JSON format with no markdown, no preamble, no backticks:
{
  "behaviorObserved": "string",
  "valuesAnalysis": [{"value": "string", "status": "Misaligned|Upheld", "explanation": "string"}],
  "staffReality": "string",
  "impact": {"client": "string", "team": "string", "organizational": "string"},
  "correctBehavior": "string",
  "conversationScript": {
    "opening": "string",
    "curiosityQuestion": "string",
    "behaviorImpact": "string",
    "expectation": "string",
    "alignmentStatement": "string"
  },
  "recommendedAction": {"action": "Coach|Document|Escalate", "reasoning": "string"}
}`

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const { situation, pattern, systemPrompt } = req.body
  if (!situation || situation.trim().length < 10) {
    return res.status(400).json({ error: 'Please provide a situation description.' })
  }
  try {
    const basePrompt = systemPrompt || DEFAULT_SYSTEM_PROMPT
    const fullPrompt = basePrompt + HANDBOOK_BLOCK

    const message = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 8000,
      system: fullPrompt,
      messages: [{ role: 'user', content: `Analyze this situation: ${situation.trim()}` }]
    })
    const text = message.content.map(b => b.type === 'text' ? b.text : '').join('')
    const clean = text.replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(clean)

    const misaligned = (parsed.valuesAnalysis || [])
      .filter(v => v.status === 'Misaligned')
      .map(v => v.value)
    const upheld = (parsed.valuesAnalysis || [])
      .filter(v => v.status === 'Upheld')
      .map(v => v.value)

    await supabase.from('sessions').insert({
      behavior: situation.trim(),
      pattern: pattern || 'first',
      misaligned_values: misaligned,
      upheld_values: upheld,
      recommended_action: parsed.recommendedAction?.action || null,
      result_json: parsed
    })

    return res.status(200).json(parsed)
  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Analysis failed. Please try again.' })
  }
}
