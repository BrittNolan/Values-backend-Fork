import http from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const PORT = Number(process.env.PORT) || 3000
const ROOT = path.resolve('.')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
}

function bufferReq(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      try {
        req.body = raw.length && req.headers['content-type']?.includes('application/json')
          ? JSON.parse(raw.toString('utf8'))
          : raw.toString('utf8')
      } catch { req.body = raw.toString('utf8') }
      resolve()
    })
    req.on('error', reject)
  })
}

function shimRes(res) {
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => {
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(obj))
    return res
  }
  res.send = (body) => {
    if (typeof body === 'object' && body !== null && !Buffer.isBuffer(body)) return res.json(body)
    res.end(body)
    return res
  }
  return res
}

async function serveStatic(req, res) {
  let rel = decodeURIComponent(req.url.split('?')[0])
  if (rel === '/') rel = '/index.html'
  const full = path.join(ROOT, rel)
  if (!full.startsWith(ROOT)) { res.statusCode = 403; return res.end('Forbidden') }
  try {
    const s = await stat(full)
    if (s.isDirectory()) { res.statusCode = 404; return res.end('Not found') }
    const ext = path.extname(full).toLowerCase()
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream')
    res.end(await readFile(full))
  } catch {
    // SPA fallback to index.html for non-api, non-admin paths (matches vercel.json rewrite)
    if (!rel.startsWith('/api/') && rel !== '/admin.html' && rel !== '/superadmin.html' && rel !== '/setup-password.html') {
      try {
        res.setHeader('Content-Type', MIME['.html'])
        res.end(await readFile(path.join(ROOT, 'index.html')))
      } catch { res.statusCode = 404; res.end('Not found') }
    } else {
      res.statusCode = 404; res.end('Not found')
    }
  }
}

async function resolveApiHandler(apiPath) {
  const candidates = apiPath.endsWith('.js')
    ? [path.join(ROOT, 'api', apiPath)]
    : [path.join(ROOT, 'api', `${apiPath}.js`), path.join(ROOT, 'api', apiPath, 'index.js')]
  for (const file of candidates) {
    try { await stat(file); return file } catch {}
  }
  return null
}

async function callApi(req, res) {
  const apiPath = req.url.split('?')[0].slice('/api/'.length)
  const fnFile = await resolveApiHandler(apiPath)
  if (!fnFile) { res.statusCode = 404; return res.end('Not found') }
  try {
    const mod = await import(pathToFileURL(fnFile).href)
    const handler = mod.default || mod.handler
    if (typeof handler !== 'function') { res.statusCode = 500; return res.end('Handler not a function') }
    await bufferReq(req)
    shimRes(res)
    await handler(req, res)
  } catch (err) {
    console.error(`[api ${req.method} ${req.url}]`, err)
    if (!res.headersSent) {
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ error: err.message || 'Internal error' }))
    } else {
      res.end()
    }
  }
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) return callApi(req, res)
  return serveStatic(req, res)
})

server.listen(PORT, () => {
  const ok = (k) => process.env[k] ? 'set' : 'MISSING'
  console.log(`Dev server: http://localhost:${PORT}`)
  console.log(`Env: SUPABASE_URL=${ok('SUPABASE_URL')}, SUPABASE_SERVICE_ROLE_KEY=${ok('SUPABASE_SERVICE_ROLE_KEY')}, SUPABASE_ANON_KEY=${ok('SUPABASE_ANON_KEY')}`)
})
