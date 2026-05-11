import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'
import { ORG_HANDBOOK } from './lifemoves-handbook.js'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

const HANDBOOK_BLOCK = `

=== ORGANIZATIONAL HANDBOOK (${ORG_HANDBOOK.handbookVersion}) ===
The following are official ${ORG_HANDBOOK.organization} policies. Use them to populate the "handbookReference" field in your JSON response.

RULES FOR handbookReference:
- It MUST be an array (use [] if no policies apply, never null, never an object).
- Each item in the array represents ONE policy that directly applies to the situation.
- Include up to 3 most relevant policies. If only one applies, return an array with one item.
- If no policy directly applies, return an empty array: []
- Do NOT mix handbook language into the coaching fields (behaviorObserved, staffReality, correctBehavior, conversationScript, recommendedAction.reasoning). Keep handbook references ONLY in the handbookReference array.

Each policy object in the array MUST have exactly these three fields:
{
  "policyName": "the exact section name from the handbook, e.g. 'Paid Sick Leave' or 'Holiday Pay'",
  "policySummary": "1-2 sentence summary of what the policy says",
  "whyRelevant": "1 sentence on why this policy applies to THIS specific situation"
}

${ORG_HANDBOOK.policies}

For complex policy questions or formal complaints, one of the handbookReference items may direct the leader to contact HR (${ORG_HANDBOOK.hrContact}).
`

const DEFAULT_SYSTEM_PROMPT = `You are a leadership coach trained in values-based, trauma-informed leadership in a social services organization. Your task is to analyze a staff behavior situation and produce a structured leadership response.

Use the following organizational values and behavior definitions:
ADAPTABILI
