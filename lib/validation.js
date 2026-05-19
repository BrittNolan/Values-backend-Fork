import { z } from 'zod'

// NOTE: not using .strict() because the frontend sends some legacy fields
// (like orgId, which now comes from the JWT instead). Unknown fields are silently ignored.
//
// systemPrompt is accepted from the client because the frontend builds rich
// prompts dynamically (sector, tone, language, impairment handling, quickView
// schema, etc.) that the server doesn't know how to construct on its own.
// Safety: /api/analyze requires a valid JWT (so randos can't hit it), and we
// cap the prompt at 30KB so no one can stuff a novel.
export const analyzeSchema = z.object({
  situation: z.string().min(10).max(4000),
  pattern: z.enum(['first', 'repeated', 'pattern']).optional().default('first'),
  sector: z.string().max(100).optional(),
  tone: z.enum(['supportive', 'direct']).optional(),
  systemPrompt: z.string().max(30000).optional()
})

export const roleplaySchema = z.object({
  scenario: z.string().min(10).max(4000),
  mode: z.enum(['defensive', 'receptive', 'shutdown']),
  valuesAnalysis: z.string().max(8000).optional(),
  conversation: z.array(z.object({
    role: z.enum(['leader', 'staff']),
    text: z.string().max(2000)
  })).max(40).optional().default([])
})

export const speakSchema = z.object({
  text: z.string().min(1).max(2000)
})

export function parseOr400(schema, body, res) {
  const result = schema.safeParse(body)
  if (!result.success) {
    res.status(400).json({
      error: 'Invalid request',
      issues: result.error.issues.map(i => ({ path: i.path, message: i.message }))
    })
    return null
  }
  return result.data
}
