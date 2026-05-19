import { z } from 'zod'

export const analyzeSchema = z.object({
  situation: z.string().min(10).max(4000),
  pattern: z.enum(['first', 'repeated', 'pattern']).optional().default('first')
}).strict()

export const roleplaySchema = z.object({
  scenario: z.string().min(10).max(4000),
  mode: z.enum(['defensive', 'receptive', 'shutdown']),
  valuesAnalysis: z.string().max(8000).optional(),
  conversation: z.array(z.object({
    role: z.enum(['leader', 'staff']),
    text: z.string().max(2000)
  })).max(40).optional().default([])
}).strict()

export const speakSchema = z.object({
  text: z.string().min(1).max(2000)
}).strict()

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
