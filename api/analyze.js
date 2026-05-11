import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

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

async function getHandbookMatches(situation, handbook) {
  if (!handbook || !handbook.policies) return []
  try {
    const prompt = `You are a workplace policy expert. Given the situation below and the organizational handbook, return up to 3 policies from the handbook that apply to this situation.

SITUATION:
${situation}

HANDBOOK:
${handbook.policies}

Respond ONLY with a JSON array. No preamble, no markdown, no backticks. Format:
[
  {"policyName": "exact section name from handbook", "policySummary": "1-2 sentences", "whyRelevant": "1 sentence on why this applies to this situation"}
]

Rules:
- Use EXACT section names from the handbook headers (e.g. "PAID SICK LEAVE", "HOLIDAY PAY", "ATTENDANCE, PUNCTUALITY, ABSENTEEISM").
- For attendance/tardiness situations: include Attendance, Punctuality, Absenteeism.
- For caregiving or family health: include FMLA/CFRA and Reasonable Accommodation.
- For repeated patterns warranting documentation: include Discipline / Performance Improvement.
- For any other workplace situation, find 1-3 most relevant policies.
- Return [] only for truly off-topic queries.
- Maximum 3 policies.`

    const message = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    })
    const text = message.content.map(b => b.type === 'text' ? b.text : '').join('')
    const clean = text.replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(clean)
    return Array.isArray(parsed) ? parsed.slice(0, 3) : []
  } catch (err) {
    console.error('Handbook match error:', err)
    return []
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const { situation, pattern, systemPrompt, orgId } = req.body
  if (!situation || situation.trim().length < 10) {
    return res.status(400).json({ error: 'Please provide a situation description.' })
  }
  try {
    let handbook = null
    if (orgId) {
      const { data, error } = await supabase
        .from('handbooks')
        .select('org_name, handbook_version, hr_contact, policies')
        .eq('org_id', orgId)
        .eq('is_active', true)
        .maybeSingle()
      if (!error && data) handbook = data
    }

    const basePrompt = systemPrompt || DEFAULT_SYSTEM_PROMPT

    // Run analysis and handbook matching in parallel for speed
    const [message, handbookMatches] = await Promise.all([
      client.messages.create({
        model: 'claude-opus-4-5',
        max_tokens: 8000,
        system: basePrompt,
        messages: [{ role: 'user', content: `Analyze this situation: ${situation.trim()}` }]
      }),
      getHandbookMatches(situation.trim(), handbook)
    ])

    const text = message.content.map(b => b.type === 'text' ? b.text : '').join('')
    const clean = text.replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(clean)

    // Merge handbook
