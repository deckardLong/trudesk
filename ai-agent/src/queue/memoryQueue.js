/*
 * Hàng đợi trong bộ nhớ, ngữ nghĩa giống SQS ở mức cần thiết:
 *  - giao "ít nhất một lần" (consumer phải idempotent, pipeline đã chống trùng theo event.id)
 *  - lỗi tạm thời (retryable) -> thử lại có backoff, quá maxAttempts -> dead-letter
 * Khi lên cloud (người C) thay bằng SQS/Service Bus, giữ nguyên interface publish/start.
 */

class MemoryQueue {
  constructor ({ handler, maxAttempts = 3, backoffMs = [2000, 10000], logger = console } = {}) {
    this.handler = handler
    this.maxAttempts = maxAttempts
    this.backoffMs = backoffMs
    this.logger = logger
    this.items = []
    this.deadLetter = []
    this.running = false
  }

  publish (message) {
    this.items.push({ message, attempts: 0, visibleAt: 0 })
    this.kick()
  }

  kick () {
    if (!this.running) this.loop()
  }

  async loop () {
    this.running = true
    try {
      while (this.items.length) {
        const now = Date.now()
        const idx = this.items.findIndex(i => i.visibleAt <= now)
        if (idx === -1) {
          const wait = Math.min(...this.items.map(i => i.visibleAt)) - now
          await new Promise(resolve => setTimeout(resolve, Math.max(wait, 10)))
          continue
        }
        const item = this.items.splice(idx, 1)[0]
        item.attempts++
        try {
          const result = await this.handler(item.message)
          if (result && result.retryable) throw Object.assign(new Error(result.message || 'retryable'), { retryable: true })
        } catch (err) {
          if (err.retryable && item.attempts < this.maxAttempts) {
            item.visibleAt = Date.now() + this.backoffMs[Math.min(item.attempts - 1, this.backoffMs.length - 1)]
            this.items.push(item)
          } else {
            this.deadLetter.push({ ...item, error: err.message })
            this.logger.warn(`[ai-agent:queue] dead-letter ${item.message.id}: ${err.message}`)
          }
        }
      }
    } finally {
      this.running = false
    }
  }
}

module.exports = { MemoryQueue }
