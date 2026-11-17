/*
 * Cấu hình AI Agent Service (đọc từ biến môi trường, có mặc định an toàn để chạy mock).
 */

function num (v, d) {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

function load (env = process.env) {
  return {
    // 'mock' = luật từ khóa, không gọi mạng | 'ollama' = model local | 'claude' = Claude API
    provider: env.AI_PROVIDER || 'mock',
    model: env.AI_MODEL || 'claude-opus-5-5',
    ollama: {
      baseUrl: env.OLLAMA_URL || 'http://localhost:11434',
      model: env.OLLAMA_MODEL || 'qwen2.5:7b-instruct',
      timeoutMs: num(env.OLLAMA_TIMEOUT_MS, 180000),
      numPredict: num(env.OLLAMA_NUM_PREDICT, 1024),
      numCtx: num(env.OLLAMA_NUM_CTX, 4096)
    },

    // Trả lời tự động cho người dùng (xem src/autoreply/policy.js)
    autoReply: {
      enabled: env.AI_AUTO_REPLY !== 'false',
      // Chỉ Incident: người dùng tự khắc phục theo hướng dẫn được. Service Request vẫn cần IT thao tác
      // (cấp quyền, cài đặt) nên chỉ nhận email xác nhận, ticket giữ Open cho nhân viên.
      allowedTypes: (env.AI_AUTO_REPLY_TYPES || 'Incident').split(',').map(s => s.trim()),
      blockedPriorities: (env.AI_AUTO_REPLY_BLOCKED_PRIORITIES || 'Critical').split(',').map(s => s.trim()),
      minConfidence: num(env.AI_AUTO_REPLY_MIN_CONFIDENCE, 0.7),
      // Điểm truy xuất tối thiểu của nguồn được trích (hiệu chỉnh cho MockEmbedder)
      minGroundingScore: num(env.AI_AUTO_REPLY_MIN_GROUNDING, 0.3),
      // Không tự trả lời được thì vẫn gửi email xác nhận đã tiếp nhận
      sendAcknowledgement: env.AI_AUTO_REPLY_ACK !== 'false',
      // Sau khi AI trả lời: chuyển ticket sang Pending (dừng đồng hồ SLA, chờ người dùng xác nhận)
      pendingStatus: env.AI_AUTO_REPLY_PENDING_STATUS || 'Pending',
      openStatus: env.AI_AUTO_REPLY_OPEN_STATUS || 'Open',
      closedStatus: env.AI_AUTO_REPLY_CLOSED_STATUS || 'Closed'
    },

    guardrails: {
      // Sơ đồ 5: dưới ngưỡng thì bỏ qua gợi ý
      confidenceThreshold: num(env.AI_CONFIDENCE_THRESHOLD, 0.7),
      // Sơ đồ 6, Cách 3: chỉ khi bật AI_AUTO_APPLY mới tự ghi trường có độ tin cậy rất cao
      autoApply: env.AI_AUTO_APPLY === 'true',
      autoApplyThreshold: num(env.AI_AUTO_APPLY_THRESHOLD, 0.95),
      // Gợi ý hết hạn nếu agent không duyệt (điểm cần chốt #1 trong sơ đồ 6)
      suggestionTtlMs: num(env.AI_SUGGESTION_TTL_MS, 6 * 60 * 60 * 1000)
    },

    budget: {
      maxCallsPerHour: num(env.AI_MAX_CALLS_PER_HOUR, 300),
      maxTokensPerDay: num(env.AI_MAX_TOKENS_PER_DAY, 2000000)
    },

    rag: {
      topK: num(env.AI_RAG_TOP_K, 3),
      minScore: num(env.AI_RAG_MIN_SCORE, 0.12),
      chunkSize: num(env.AI_RAG_CHUNK_SIZE, 600)
    },

    dedup: {
      // Ngưỡng hiệu chỉnh cho MockEmbedder; khi đổi sang mô hình embedding thật phải đo và chỉnh lại.
      similarThreshold: num(env.AI_DEDUP_SIMILAR, 0.2),
      duplicateThreshold: num(env.AI_DEDUP_DUPLICATE, 0.55)
    },

    core: {
      // 'mock' = Core giả trong bộ nhớ | 'http' = gọi Trudesk API thật
      mode: env.CORE_MODE || 'mock',
      baseUrl: env.TRUDESK_URL || 'http://localhost:8118',
      accessToken: env.TRUDESK_AI_TOKEN || '',
      // 'endpoint' = POST /api/v2/tickets/:uid/ai-suggestions (đề xuất, người A thêm)
      // 'internal-note' = ghi gợi ý thành internal note qua API v1 có sẵn (chạy được ngay)
      suggestionSink: env.AI_SUGGESTION_SINK || 'internal-note'
    },

    auditLogPath: env.AI_AUDIT_LOG || ''
  }
}

module.exports = { load }
