/* Lỗi chung của lớp LLM. retryable=true -> queue sẽ thử lại (mạng, rate limit, server 5xx). */
class LLMError extends Error {
  constructor (message, { retryable = false, kind = 'error' } = {}) {
    super(message)
    this.retryable = retryable
    this.kind = kind
  }
}

module.exports = { LLMError }
