/*
 * Dựng toàn bộ AI Agent từ config. Dùng chung cho server, demo, eval và test.
 */

const path = require('path')
const { load } = require('./config')
const { MockEmbedder } = require('./rag/embedder')
const { MemoryVectorStore } = require('./rag/vectorStore')
const { KnowledgeBase } = require('./rag/knowledgeBase')
const { LLMClient, createProvider } = require('./llm/llmClient')
const { Budget } = require('./guardrails/guardrails')
const { AuditLog } = require('./audit/auditLog')
const { AgentPipeline } = require('./pipeline')
const { MockCore } = require('./core/mockCore')

const MOCK_DIR = path.resolve(__dirname, '..', 'mock-data')

function createAgent ({ config = load(), core, provider, now = () => Date.now(), seedKnowledge = true } = {}) {
  const embedder = new MockEmbedder()
  const store = new MemoryVectorStore({ embedderId: embedder.id })
  const kb = new KnowledgeBase({ embedder, store, chunkSize: config.rag.chunkSize })
  const audit = new AuditLog({ filePath: config.auditLogPath, now })
  const budget = new Budget(config.budget, now)
  const llm = new LLMClient({ provider: provider || createProvider(config), budget, audit })

  if (!core) {
    if (config.core.mode === 'http') {
      const { HttpCore } = require('./core/httpCore')
      core = new HttpCore(config.core)
    } else {
      core = new MockCore({ now })
    }
  }

  // Nhánh nạp tri thức (sơ đồ 4). Thực tế chạy theo lịch, ở đây nạp khi khởi động từ mock data.
  if (seedKnowledge) {
    kb.ingestArticles(require(path.join(MOCK_DIR, 'kb-articles.json')))
    kb.ingestClosedTickets(require(path.join(MOCK_DIR, 'closed-tickets.json')))
  }

  const pipeline = new AgentPipeline({ config, llm, kb, core, audit, now })
  return { config, kb, llm, audit, budget, core, pipeline }
}

/** Envelope sự kiện thống nhất giữa Core (A) và AI (B). */
function makeEvent (type, ticket, id) {
  return {
    id: id || `${type}:${ticket.uid}:${Date.now()}`,
    type,
    version: 1,
    occurredAt: new Date().toISOString(),
    data: { ticket }
  }
}

module.exports = { createAgent, makeEvent, MOCK_DIR }
