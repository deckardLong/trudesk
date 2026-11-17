/*
 * Outbox cho email thông báo: gộp (debounce), chống gửi trùng (idempotency), thử lại (retry).
 *
 * Vì sao cần:
 *  - Agent thường gửi 2-3 comment liên tiếp -> gộp thành 1 email sau DEBOUNCE_MS, tránh spam.
 *  - Sự kiện có thể bị phát lại (retry, nhiều instance) -> khóa idempotency
 *    `${commentId}:${recipientId}:email` bảo đảm mỗi comment chỉ gửi một lần cho mỗi người.
 *  - SMTP lỗi tạm thời -> thử lại theo backoff, quá số lần thì đánh dấu failed và ghi log.
 *    Kênh web không phụ thuộc kênh email: email lỗi không làm mất thông báo web.
 *
 * Store mặc định là bộ nhớ (đủ cho 1 instance và demo). Khi chạy nhiều instance (người C),
 * thay bằng store trên MongoDB/Redis có cùng interface + khóa phân tán khi flush.
 */

const DEFAULTS = {
  debounceMs: 60 * 1000,
  maxDelayMs: 5 * 60 * 1000,
  backoffMs: [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000],
  maxAttempts: 4,
  sentKeyTtlMs: 7 * 24 * 60 * 60 * 1000
}

class MemoryOutboxStore {
  constructor () {
    this.jobs = new Map() // groupKey -> job (pending / retrying)
    this.sentKeys = new Map() // idempotency key -> timestamp
    this.history = [] // job đã xong (sent / failed), phục vụ demo và kiểm tra
  }
}

class Outbox {
  /**
   * @param {Object}   opts
   * @param {Function} opts.deliver  async (job) => void; ném lỗi nếu gửi thất bại
   * @param {Function} [opts.now]    () => số mili-giây, cho phép test dùng đồng hồ giả
   * @param {Object}   [opts.logger]
   */
  constructor ({ deliver, now, logger, store, ...options } = {}) {
    if (typeof deliver !== 'function') throw new Error('Outbox: deliver is required')
    this.deliver = deliver
    this.now = now || (() => Date.now())
    this.logger = logger || { debug () {}, warn () {}, info () {} }
    this.store = store || new MemoryOutboxStore()
    this.options = { ...DEFAULTS, ...options }
    this.timer = null
    this.flushing = false
  }

  /**
   * Đưa một comment vào hàng chờ gửi cho một người nhận.
   * @param {Object} item { idempotencyKey, groupKey, recipient, ticket, comment }
   * @returns {'queued'|'merged'|'duplicate'}
   */
  enqueue ({ idempotencyKey, groupKey, recipient, ticket, comment }) {
    const { jobs, sentKeys } = this.store

    if (sentKeys.has(idempotencyKey)) return 'duplicate'

    const sameGroup = Array.from(jobs.values()).filter(j => j.baseKey === groupKey)
    if (sameGroup.some(j => j.keys.indexOf(idempotencyKey) !== -1)) return 'duplicate'

    // Chỉ gộp vào job còn 'pending'. Job đang 'retrying' giữ nguyên nội dung đã soạn.
    const pendingJob = sameGroup.find(j => j.status === 'pending')
    if (pendingJob) {
      pendingJob.keys.push(idempotencyKey)
      pendingJob.comments.push(comment)
      pendingJob.ticket = ticket // luôn dùng trạng thái ticket mới nhất
      // Dời hạn gửi thêm debounceMs, nhưng không quá maxDelayMs kể từ comment đầu tiên.
      pendingJob.dueAt = Math.min(
        this.now() + this.options.debounceMs,
        pendingJob.createdAt + this.options.maxDelayMs
      )
      return 'merged'
    }

    const jobKey = sameGroup.length === 0 ? groupKey : `${groupKey}#${this.now()}`
    jobs.set(jobKey, {
      groupKey: jobKey,
      baseKey: groupKey,
      keys: [idempotencyKey],
      recipient,
      ticket,
      comments: [comment],
      attempts: 0,
      status: 'pending',
      createdAt: this.now(),
      dueAt: this.now() + this.options.debounceMs,
      lastError: null
    })
    return 'queued'
  }

  /** Gửi mọi job đã đến hạn. Trả về danh sách job vừa xử lý. */
  async flushDue () {
    if (this.flushing) return []
    this.flushing = true
    const processed = []

    try {
      const { jobs, sentKeys, history } = this.store
      const now = this.now()

      for (const [groupKey, job] of Array.from(jobs.entries())) {
        if (job.dueAt > now) continue

        job.attempts++
        try {
          await this.deliver(job)
          job.status = 'sent'
          job.sentAt = this.now()
          for (const k of job.keys) sentKeys.set(k, job.sentAt)
          jobs.delete(groupKey)
          history.push(job)
          this.logger.debug(`[ticketReply:outbox] sent ${job.keys.length} comment(s) to ${job.recipient.email}`)
        } catch (err) {
          job.lastError = err && err.message ? err.message : String(err)
          if (job.attempts >= this.options.maxAttempts) {
            job.status = 'failed'
            jobs.delete(groupKey)
            history.push(job)
            this.logger.warn(
              `[ticketReply:outbox] giving up after ${job.attempts} attempts to ${job.recipient.email}: ${job.lastError}`
            )
          } else {
            job.status = 'retrying'
            const backoff = this.options.backoffMs[Math.min(job.attempts - 1, this.options.backoffMs.length - 1)]
            job.dueAt = this.now() + backoff
            this.logger.warn(
              `[ticketReply:outbox] attempt ${job.attempts} failed for ${job.recipient.email}, retry in ${backoff}ms: ${job.lastError}`
            )
          }
        }
        processed.push(job)
      }

      this.pruneSentKeys()
    } finally {
      this.flushing = false
    }

    return processed
  }

  pruneSentKeys () {
    const cutoff = this.now() - this.options.sentKeyTtlMs
    for (const [k, ts] of this.store.sentKeys) if (ts < cutoff) this.store.sentKeys.delete(k)
  }

  pending () {
    return Array.from(this.store.jobs.values())
  }

  start (intervalMs = 15 * 1000) {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.flushDue().catch(err => this.logger.warn('[ticketReply:outbox] flush error: ' + err))
    }, intervalMs)
    if (this.timer.unref) this.timer.unref()
  }

  stop () {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

module.exports = { Outbox, MemoryOutboxStore, DEFAULTS }
