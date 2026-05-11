import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

function buildHandbookBlock(handbook) {
  if (!handbook) return ''
  return `

=== ORGANIZATIONAL HANDBOOK (${handbook.handbook_version || 'current version'}) ===
The following are official ${handbook.org_name || 'organizational'} policies.

CRITICAL SCHEMA ADDITION: In addition to whatever JSON fields are specified elsewhere in this prompt, you MUST also add a top-level field called "handbookReference" to your JSON response. This field is REQUIRED even if no policies apply (return [] in that case).

RULES FOR handbookReference:
- It MUST be an array. If at least one policy is even tangentially related to the situation, you MUST include it. An empty array [] is only appropriate for truly off-topic situations (e.g. "How do I write a thank-you note to a donor?").
- For ANY workplace behavior situation — attendance, performance, conflict, accommodation, leave, conduct, scheduling, time-keeping, communication — you MUST find at least 1-3 applicable policies in the handbook.
- Mandatory matches:
  * Late arrival, tardiness, no-call/no-show, absence patterns → Attendance, Punctuality, Absenteeism
  * Caregiving, eldercare, childcare affecting work → FMLA/CFRA + Reasonable Accommodation
  * Medical condition or health affecting work → FMLA/CFRA + Reasonable Accommodation + Paid Sick Leave
  * Holiday-adjacent absence → Holiday Pay + Paid Sick Leave + Attendance
  * Suspected impairment (drugs, alcohol, behavior changes) → Drug and Alcohol Policy
  * Repeated behavior requiring documentation → Discipline / Performance Improvement
  * Timekeeping issues, missed timesheet, off-the-clock work → Timekeeping / Wage & Hour
  * Break or meal period concerns → Meal & Rest Breaks
  * Pregnancy, lactation, postpartum → Pregnancy Disability Leave + Lactation Accommodation
  * Bereavement, death in family → Bereavement Leave
  * Jury duty, court appearance → Jury Duty / Court Appearance
  * Romantic relationship at work → Non-Fraternization
  * Work injury → Workers' Compensation
  * Resignation, termination, final pay → Leaving LifeMoves
- Maximum 3 policies per response. Pick the most central ones.
- Use the EXACT policy names from the handbook section headers (the ones in CAPS LIKE THIS).
- Do NOT mix handbook language into the other coaching fields. Keep handbook references ONLY in the handbookReference array.

Each policy object in the array MUST have exactly these three fields:
{
  "policyName": "the exact section name from the handbook, e.g. 'Paid Sick Leave' or 'Holiday Pay'",
  "policySummary": "1-2 sentence summary of what the policy says",
  "whyRelevant": "1 sentence on why this policy applies to THIS specific situation"
}

Example of how handbookReference fits in your response (combined with all other fields from the schema above):
{
  ...all other fields the schema requires...,
  "handbookReference": [
    {"policyName": "Paid Sick Leave", "policySummary": "...", "whyRelevant": "..."},
    {"policyName": "Holiday Pay", "policySummary": "...", "whyRelevant": "..."}
  ]
}

${handbook.policies}

For complex policy questions or formal complaints, one of the handbookReference items may direct the leader to contact HR (${handbook.hr_contact || 'their HR department'}).
`
}

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

Respond ONLY in this JSON format with no markdown, no preamble, no backticks. The handbookReference field MUST always be an array, even if empty:

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
  "recommendedAction": {"action": "Coach|Document|Escalate", "reasoning": "string"},
  "handbookReference": [
    {
      "policyName": "string",
      "policySummary": "string",
      "whyRelevant": "string"
    }
  ]
}`

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const { situation, pattern, systemPrompt, orgId } = req.body
  if (!situation || situation.trim().length < 10) {
    return res.status(400).json({ error: 'Please provide a situation description.' })
  }
  try {
    // Look up handbook for this org, if one exists and is active
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
    const handbookBlock = buildHandbookBlock(handbook)
    const fullPrompt = basePrompt + handbookBlock

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
