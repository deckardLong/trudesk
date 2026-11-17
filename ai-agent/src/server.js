/*
 * AI Agent Service – tiến trình chạy thật.
 *
 *   POST /events   nhận sự kiện từ Trudesk Core (webhook, ký HMAC) -> trả 202 ngay -> xếp hàng xử lý
 *   GET  /healthz  kiểm tra sống
 *
 * Chạy:  node ai-agent/src/server.js
 * Biến môi trường chính: PORT (8200), AI_WEBHOOK_SECRET, AI_PROVIDER, CORE_MODE, TRUDESK_URL, TRUDESK_AI_TOKEN
 */

const http = require('http')
const crypto = require('crypto')
const { createAgent } = require('./bootstrap')
const { MemoryQueue } = require('./queue/memoryQueue')

const MAX_BODY = 256 * 1024

function verifySignature (secret, rawBody, header) {
  if (!secret) return true // dev local: cho phép khi chưa đặt secret
  if (!header || header.indexOf('sha256=') !== 0) return false
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  const got = header.slice(7)
  if (got.length !== expected.length) return false
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))
}

function createServer ({ agent = createAgent(), secret = process.env.AI_WEBHOOK_SECRET || '' } = {}) {
  const queue = new MemoryQueue({
    handler: async event => {
      const result = await agent.pipeline.handle(event)
      // Lỗi mạng/giới hạn tốc độ của LLM -> thử lại; lỗi khác -> bỏ qua gợi ý (đã ghi audit)
      if (result.status === 'skipped' && ['rate_limit', 'network', 'server'].indexOf(result.reason) !== -1) {
        agent.pipeline.seenEvents.delete(event.id)
        return { retryable: true, message: result.message }
      }
      return result
    }
  })

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      return res.end('OK')
    }

    if (req.method === 'POST' && req.url === '/events') {
      const chunks = []
      let size = 0
      req.on('data', c => {
        size += c.length
        if (size > MAX_BODY) req.destroy()
        else chunks.push(c)
      })
      req.on('end', () => {
        const raw = Buffer.concat(chunks)
        if (!verifySignature(secret, raw, req.headers['x-trudesk-signature'])) {
          res.writeHead(401)
          return res.end()
        }
        let event
        try {
          event = JSON.parse(raw.toString('utf8'))
        } catch (e) {
          res.writeHead(400)
          return res.end()
        }
        queue.publish(event)
        res.writeHead(202, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ accepted: event.id }))
      })
      return
    }

    res.writeHead(404)
    res.end()
  })

  return { server, queue, agent }
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8200)
  const { server, agent } = createServer()
  server.listen(port, () => {
    console.log(
      `[ai-agent] listening on :${port} | provider=${agent.config.provider} core=${agent.config.core.mode} kb=${agent.kb.store.size()} chunks`
    )
  })
}

module.exports = { createServer, verifySignature }
