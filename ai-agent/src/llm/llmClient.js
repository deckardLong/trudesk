/*
 * LLM Client (sơ đồ 3): lớp trừu tượng nhà cung cấp.
 * Các skill (triage, drafter, ...) chỉ gọi client.complete(); đổi provider không phải sửa skill.
 */

const { MockProvider } = require('./providers/mockProvider')

function createProvider (config) {
  if (config.provider === 'ollama') {
    const { OllamaProvider } = require('./providers/ollamaProvider')
    return new OllamaProvider(config.ollama)
  }
  if (config.provider === 'claude') {
    const { ClaudeProvider } = require('./providers/claudeProvider')
    return new ClaudeProvider({ model: config.model })
  }
  return new MockProvider()
}

class LLMClient {
  constructor ({ provider, budget, audit }) {
    this.provider = provider
    this.budget = budget
    this.audit = audit
  }

  /**
   * @param {Object} req { task, system, prompt, schema, input, ticketUid, eventId }
   * @returns {Promise<{ json, usage, model, latencyMs }>}
   */
  async complete (req) {
    const estimate = Math.ceil(((req.system || '').length + (req.prompt || '').length) / 4)
    this.budget.assertCanSpend(estimate)

    const started = Date.now()
    const res = await this.provider.complete(req)
    const latencyMs = Date.now() - started
    const tokens = (res.usage.input_tokens || 0) + (res.usage.output_tokens || 0)
    this.budget.record(tokens)

    this.audit.write({
      kind: 'llm_call',
      eventId: req.eventId,
      ticketUid: req.ticketUid,
      task: req.task,
      provider: this.provider.name,
      model: res.model,
      // Prompt đã được che PII trước khi tới đây; lưu lại để kiểm tra sau.
      prompt: req.prompt,
      response: res.json,
      usage: res.usage,
      latencyMs
    })

    return { ...res, latencyMs }
  }
}

module.exports = { LLMClient, createProvider }
