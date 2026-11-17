/*
 * Pipeline AI Agent: ghép các khối của sơ đồ 3 theo đúng trình tự sơ đồ 2.
 *
 *   Event Consumer -> Pre-processor (che PII)
 *        -> Triage + Dedup + Retriever(RAG) -> Reply Drafter
 *        -> Guardrails (định dạng, ngưỡng, chi phí) -> API v2 Client (ghi gợi ý chờ duyệt) + Audit
 *
 * Nguyên tắc: mọi lỗi ở đây chỉ làm MẤT GỢI Ý, không bao giờ chặn/sửa ticket (Core đã trả 201 từ trước).
 */

const { mask, unmask, dropTags } = require('./preprocess/piiMasker')
const { decideTriageFields, decide } = require('./guardrails/guardrails')
const skills = require('./skills')
const { stripHtml } = require('./rag/text')
const { evaluateAutoReply } = require('./autoreply/policy')
const templates = require('./autoreply/templates')

const SUPPORTED_EVENTS = ['ticket.created', 'ticket.updated']

const stripPiiTags = dropTags

class AgentPipeline {
  constructor ({ config, llm, kb, core, audit, now = () => Date.now() }) {
    this.config = config
    this.llm = llm
    this.kb = kb
    this.core = core
    this.audit = audit
    this.now = now
    this.seenEvents = new Set()
  }

  /** Event Consumer: kiểm tra envelope + chống xử lý trùng (queue giao "ít nhất một lần"). */
  async handle (event) {
    if (!event || !event.id || SUPPORTED_EVENTS.indexOf(event.type) === -1) {
      this.audit.write({ kind: 'event_rejected', eventId: event && event.id, reason: 'invalid envelope' })
      return { status: 'rejected' }
    }
    if (this.seenEvents.has(event.id)) return { status: 'duplicate' }
    this.seenEvents.add(event.id)

    try {
      if (event.type === 'ticket.created') return await this.onTicketCreated(event)
      return await this.onTicketUpdated(event)
    } catch (err) {
      // Sơ đồ 2 nhánh "LLM lỗi hoặc timeout": ghi log, bỏ qua gợi ý.
      this.audit.write({
        kind: 'skipped',
        eventId: event.id,
        ticketUid: event.data && event.data.ticket && event.data.ticket.uid,
        reason: err.kind || 'error',
        message: err.message
      })
      return { status: 'skipped', reason: err.kind || 'error', message: err.message }
    }
  }

  async onTicketCreated (event) {
    const raw = event.data.ticket
    const meta = { eventId: event.id, ticketUid: raw.uid }
    const g = this.config.guardrails

    // 1. Pre-processor: che PII. vault ở lại trong job này.
    const subject = mask(stripHtml(raw.subject))
    const issue = mask(stripHtml(raw.issue))
    const vault = { ...subject.vault, ...issue.vault }
    const ticket = { uid: raw.uid, subject: subject.text, issue: issue.text }
    const queryText = `${ticket.subject}\n${ticket.issue}`
    this.audit.write({ kind: 'pii_masked', ...meta, found: { ...subject.found, ...issue.found } })

    // 2. Truy xuất một lần, dùng cho cả triage (ticket cũ có nhãn) và nháp (KB + ticket cũ).
    const similarClosed = this.kb.search(queryText, { k: 3, source: 'ticket' })
    const contexts = this.kb.search(queryText, { k: this.config.rag.topK, minScore: this.config.rag.minScore })

    // 3. Triage
    const triage = await skills.triage(this.llm, { ticket, similar: similarClosed, meta })
    const fields = decideTriageFields(triage, g)

    // 4. Dedup: so với ticket ĐANG MỞ gần đây (đã được index ở bước 7 của các ticket trước).
    const openCandidates = this.kb
      .search(queryText, { k: 3, source: 'open' })
      .filter(c => c.refId !== `#${raw.uid}` && c.score >= this.config.dedup.similarThreshold)
    const dedup = await skills.dedup(this.llm, { ticket, candidates: openCandidates, thresholds: this.config.dedup, meta })
    const similarTickets = dedup.verdicts
      .filter(v => v.relation !== 'unrelated' && v.confidence >= g.confidenceThreshold)
      .map(v => ({ ref: v.ref, relation: v.relation, confidence: v.confidence }))

    // 5. RAG + Reply Drafter
    // Người soạn nháp không cần SĐT/email để hướng dẫn sửa lỗi: bỏ hẳn nhãn PII khỏi đầu vào,
    // để model nhỏ không chép lại (vd hiểu nhầm [PHONE_1] là số của IT).
    const draft = await skills.draftReply(this.llm, {
      ticket: { ...ticket, subject: stripPiiTags(ticket.subject), issue: stripPiiTags(ticket.issue) },
      contexts,
      meta
    })
    const draftDecision = decide(draft.confidence, { ...g, autoApply: false }) // nháp KHÔNG BAO GIỜ tự gửi
    const replyDraft = {
      text: unmask(draft.draft, vault),
      citations: draft.citations,
      confidence: draft.confidence,
      decision: draft.citations.length === 0 && draftDecision === 'pending' ? 'dropped' : draftDecision
    }

    // 6. Tự động trả lời người dùng nếu qua mọi cổng kiểm tra (autoreply/policy.js)
    const ar = this.config.autoReply
    // Kiểm tra trên bản CÒN CHE PII: model nhắc tới [PHONE_1]/[EMAIL_1]... -> không tự gửi.
    // Nhờ vậy nội dung tự gửi không bao giờ chứa thông tin cá nhân được khôi phục từ vault.
    const autoText = draft.draft
    const verdict = evaluateAutoReply({
      fields,
      contexts,
      draft: { ...replyDraft, text: autoText },
      priorAiAnswers: 0,
      cfg: ar,
      confidenceThreshold: g.confidenceThreshold,
      ticketText: queryText
    })
    let autoReply = { sent: false, kind: null, checks: verdict.checks }
    if (verdict.send) {
      await this.core.postComment(raw.uid, templates.answer({ draft: autoText, citations: replyDraft.citations }))
      await this.safeSetStatus(raw.uid, ar.pendingStatus, meta)
      replyDraft.decision = 'auto_sent'
      autoReply = { sent: true, kind: 'answer', checks: verdict.checks }
    } else if (ar.enabled && ar.sendAcknowledgement) {
      const known = f => (f.decision !== 'dropped' ? f.value : null)
      await this.core.postComment(
        raw.uid,
        templates.acknowledgement({ uid: raw.uid, group: known(fields.group), priority: known(fields.priority) })
      )
      autoReply = { sent: true, kind: 'ack', checks: verdict.checks }
    }
    this.audit.write({
      kind: 'auto_reply',
      ...meta,
      action: autoReply.kind || 'none',
      failed: verdict.checks.filter(c => !c.ok).map(c => `${c.name}: ${c.detail}`)
    })

    // 7. Ghi gợi ý vào Core (agent xem được AI đã làm gì; phần còn pending thì chờ duyệt)
    const suggestion = {
      fields,
      similarTickets,
      replyDraft,
      autoReply,
      rationale: triage.rationale,
      model: this.llm.provider.model,
      expiresAt: this.now() + g.suggestionTtlMs
    }
    const hasSomething =
      Object.values(fields).some(f => f.decision !== 'dropped') || similarTickets.length > 0 || replyDraft.decision !== 'dropped'

    let saved = null
    if (hasSomething) saved = await this.core.postSuggestion(raw.uid, suggestion)

    // 8. Index ticket mới (đã che PII) để phát hiện trùng cho các ticket đến sau.
    this.kb.store.upsert([
      {
        id: `OPEN-${raw.uid}`,
        source: 'open',
        refId: `#${raw.uid}`,
        title: ticket.subject,
        text: ticket.issue,
        embedding: this.kb.embedder.embed(queryText)
      }
    ])

    this.audit.write({
      kind: 'decision',
      ...meta,
      fields: Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, `${f.value}:${f.confidence}:${f.decision}`])),
      similarTickets: similarTickets.map(s => s.ref),
      replyDraft: `${replyDraft.decision}:${replyDraft.confidence}`,
      posted: !!saved
    })

    return { status: saved ? 'suggested' : 'nothing-to-suggest', suggestion: saved || suggestion, autoReply }
  }

  async safeSetStatus (uid, name, meta) {
    try {
      await this.core.setStatus(uid, name)
    } catch (err) {
      this.audit.write({ kind: 'warn', ...meta, message: `set status ${name}: ${err.message}` })
    }
  }

  /**
   * ticket.updated:
   *  (a) người dùng phản hồi câu trả lời tự động -> phân loại -> đóng ticket / chuyển nhân viên
   *  (b) thread dài -> tóm tắt cho agent
   */
  async onTicketUpdated (event) {
    const raw = event.data.ticket
    const comments = raw.comments || []

    const followUp = this.findPendingFollowUp(comments)
    if (followUp && this.config.autoReply.enabled) return this.onFollowUp(event, raw, followUp)

    // Chỉ tóm tắt ở mốc 4, 8, 12... comment để không sinh gợi ý sau mỗi tin nhắn.
    if (comments.length < 4 || comments.length % 4 !== 0) return { status: 'ignored', reason: 'not a summary checkpoint' }

    const thread = {
      subject: mask(raw.subject).text,
      issue: mask(stripHtml(raw.issue)).text,
      comments: comments.map(c => ({ author: c.authorRole || 'user', text: mask(stripHtml(c.text || c.comment)).text }))
    }
    const meta = { eventId: event.id, ticketUid: raw.uid }
    const res = await skills.summarize(this.llm, { thread, meta })
    const decision = decide(res.confidence, { ...this.config.guardrails, autoApply: false })
    if (decision === 'dropped') return { status: 'nothing-to-suggest' }

    const saved = await this.core.postSuggestion(raw.uid, {
      fields: {},
      summary: { text: res.summary, confidence: res.confidence, decision },
      model: this.llm.provider.model,
      expiresAt: this.now() + this.config.guardrails.suggestionTtlMs
    })
    return { status: 'suggested', suggestion: saved }
  }

  /**
   * Chỉ xử lý khi: comment cuối là của người dùng, AI đã gửi câu trả lời (answer), và sau đó
   * chưa có nhân viên nào chen vào, chưa bàn giao/đóng. Có nhân viên tham gia -> AI im lặng.
   */
  findPendingFollowUp (comments) {
    if (!comments.length) return null
    const last = comments[comments.length - 1]
    if (last.authorRole !== 'user') return null

    let answerIdx = -1
    for (let i = comments.length - 1; i >= 0; i--) {
      const kind = templates.kindOf(stripHtml(comments[i].text))
      if (kind === 'handoff' || kind === 'closed') return null
      if (kind === 'answer') {
        answerIdx = i
        break
      }
    }
    if (answerIdx === -1) return null

    const after = comments.slice(answerIdx + 1)
    const humanJoined = after.some(c => c.authorRole === 'agent' && !templates.kindOf(stripHtml(c.text)))
    if (humanJoined) return null

    return {
      aiAnswer: stripHtml(comments[answerIdx].text),
      userText: after
        .filter(c => c.authorRole === 'user')
        .map(c => stripHtml(c.text))
        .join('\n')
    }
  }

  async onFollowUp (event, raw, { aiAnswer, userText }) {
    const meta = { eventId: event.id, ticketUid: raw.uid }
    const ar = this.config.autoReply
    const masked = mask(userText)
    const res = await skills.classifyFollowUp(this.llm, { aiAnswer, userText: masked.text, meta })

    // Chỉ đóng khi chắc chắn; mọi trường hợp còn lại giao cho người.
    const resolved = res.label === 'resolved' && res.confidence >= this.config.guardrails.confidenceThreshold
    const citations = (aiAnswer.match(/KB-\d+|#\d+/g) || []).filter((v, i, a) => a.indexOf(v) === i)

    if (resolved) {
      await this.core.postComment(raw.uid, templates.closed({ uid: raw.uid }))
      await this.safeSetStatus(raw.uid, ar.closedStatus, meta)
    } else {
      await this.core.postComment(raw.uid, templates.handoff({ group: raw.group, reason: res.label }))
      await this.safeSetStatus(raw.uid, ar.openStatus, meta)
      await this.core.addNote(raw.uid, templates.handoffNote({ label: res.label, userText: masked.text, aiCitations: citations }))
    }

    const action = resolved ? 'closed' : 'handoff'
    this.audit.write({ kind: 'follow_up', ...meta, label: res.label, confidence: res.confidence, action })
    return { status: action, label: res.label, confidence: res.confidence }
  }
}

module.exports = { AgentPipeline, SUPPORTED_EVENTS }
