import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

const root = resolve('dist/client')
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }

// Browser tests intercept every API request; this server only serves the built SPA.
createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    const file = resolve(root, `.${/^\/admin(?:\/|$)/.test(path) ? '/index.html' : path}`)
    if (!file.startsWith(root + sep)) throw new Error('outside asset directory')
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(body)
  } catch {
    res.writeHead(404).end('Not found')
  }
}).listen(Number(process.env.E2E_PORT ?? 6176), '127.0.0.1')
