import { requireAuth } from '../lib/auth.js'
import { parseOr400, speakSchema } from '../lib/validation.js'

const VOICE_ID = '21m00Tcm4TlvDq8ikWAM' // Rachel
const ELEVENLABS_TIMEOUT_MS = 30000

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const ctx = await requireAuth(req, res)
  if (!ctx) return

  const body = parseOr400(speakSchema, req.body, res)
  if (!body) return

  const apiKey = process.env.ELEVENLABS_API_KEY
  if (!apiKey) {
    return res.status(500).json({ error: 'Audio service not configured' })
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ELEVENLABS_TIMEOUT_MS)

  try {
    const elevenRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg'
      },
      body: JSON.stringify({
        text: body.text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 }
      }),
      signal: controller.signal
    })
    clearTimeout(timer)

    if (!elevenRes.ok) {
      const errText = await elevenRes.text()
      console.warn('ElevenLabs error:', elevenRes.status, errText.slice(0, 200))
      return res.status(elevenRes.status).json({ error: 'Audio service error' })
    }

    const audioBuffer = await elevenRes.arrayBuffer()
    res.setHeader('Content-Type', 'audio/mpeg')
    res.setHeader('Cache-Control', 'private, max-age=60')
    return res.status(200).send(Buffer.from(audioBuffer))
  } catch (err) {
    clearTimeout(timer)
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Audio service timed out' })
    }
    console.error('Speak error:', err)
    return res.status(500).json({ error: 'Audio generation failed' })
  }
}
