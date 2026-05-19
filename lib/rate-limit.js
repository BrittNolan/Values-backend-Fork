import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'

let redis = null
function getRedis() {
  if (redis) return redis
  redis = Redis.fromEnv()
  return redis
}

// Tuned for "Isabella demos to small groups today; one customer rollout later."
// 60/min per IP means one user clicking through the app fast won't hit it,
// but a scripted loop hits the wall in seconds.

export const analyzeLimiter = new Ratelimit({
  redis: getRedis(),
  limiter: Ratelimit.slidingWindow(60, '60 s'),
  analytics: true,
  prefix: 'rl:analyze'
})

export const roleplayLimiter = new Ratelimit({
  redis: getRedis(),
  limiter: Ratelimit.slidingWindow(120, '60 s'),
  analytics: true,
  prefix: 'rl:roleplay'
})

export const speakLimiter = new Ratelimit({
  redis: getRedis(),
  limiter: Ratelimit.slidingWindow(60, '60 s'),
  analytics: true,
  prefix: 'rl:speak'
})

// Auth is stricter — protects against credential stuffing.
export const authLimiter = new Ratelimit({
  redis: getRedis(),
  limiter: Ratelimit.slidingWindow(10, '60 s'),
  analytics: true,
  prefix: 'rl:auth'
})

export function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for']
  if (typeof fwd === 'string' && fwd.length > 0) {
    return fwd.split(',')[0].trim()
  }
  return req.socket?.remoteAddress || 'unknown'
}

export async function checkLimit(limiter, ip) {
  const result = await limiter.limit(ip)
  const headers = {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(result.reset)
  }
  if (!result.success) {
    headers['Retry-After'] = String(Math.ceil((result.reset - Date.now()) / 1000))
  }
  return { ok: result.success, headers }
}
