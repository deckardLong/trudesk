#!/usr/bin/env node
/*
 * DEMO END-TO-END (toàn bộ mock data, không cần MongoDB/SMTP/API key):
 *
 *   1. Người dùng tạo ticket            -> Core phát ticket.created
 *   2. AI Agent: che PII, triage, dedup, RAG, soạn nháp -> ghi gợi ý chờ duyệt
 *   3. Agent (người) duyệt từng trường + dùng nháp trả lời
 *   4. Ticket Reply Notifier: người dùng nhận thông báo WEB ngay + EMAIL (gộp, có Reply-To)
 *   5. Người dùng trả lời bằng EMAIL    -> thành comment trong ticket -> agent được báo
 *   6. Các ca "thất bại có kiểm soát": nháp bị guardrail chặn, gợi ý bị từ chối, gợi ý hết hạn
 *
 * Chạy: node demo/e2e-ai-reply-notify.js
 * Email giả lập được ghi ra logs/mock-mailbox/*.eml (mở bằng Outlook/Thunderbird).
 */

const fs = require('fs')
const path = require('path')
const nodemailer = require('nodemailer')

const { createAgent, makeEvent } = require('../ai-agent/src/bootstrap')
const { load } = require('../ai-agent/src/config')
const { MockCore } = require('../ai-agent/src/core/mockCore')
const { createTicketReplyNotifier } = require('../src/notifications/ticketReply')
const { resolveInboundReply } = require('../src/notifications/ticketReply/inboundReply')
const { createMockDeps } = require('./ticket-reply/mockDeps')
const helpdesk = require('./mock-data/helpdesk')
const incoming = require('../ai-agent/mock-data/incoming-tickets.json')

const MAILBOX_DIR = path.resolve(__dirname, '..', 'logs', 'mock-mailbox')
const c = { dim: s => `\x1b[2m${s}\x1b[0m`, b: s => `\x1b[1m${s}\x1b[0m`, g: s => `\x1b[32m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`, m: s => `\x1b[35m${s}\x1b[0m` }
const step = (n, s) => console.log(`\n${c.b(c.m(`== ${n}. ${s}`))}`)

// Người tạo / người xử lý của từng ticket trong demo
const PEOPLE = {
  1042: { owner: 'u-user-hoa', assignee: 'u-agent-minh', subscribers: ['u-agent-lan'] },
  1043: { owner: 'u-user-tuan', assignee: 'u-agent-lan', subscribers: [] },
  1047: { owner: 'u-user-khoa', assignee: 'u-agent-minh', subscribers: [] },
  1049: { owner: 'u-user-hoa', assignee: 'u-agent-minh', subscribers: [] }
}

async function main () {
  fs.mkdirSync(MAILBOX_DIR, { recursive: true })
  const eml = nodemailer.createTransport({ streamTransport: true, buffer: true })

  // ---- Hạ tầng giả lập
  const h = createMockDeps({ online: ['u-user-hoa', 'u-agent-minh'] })
  const savedFiles = []
  const realSend = h.deps.sendEmail
  h.deps.sendEmail = async message => {
    const info = await eml.sendMail({ from: '"IT Helpdesk" <support@acme.vn>', ...message })
    const file = path.join(MAILBOX_DIR, `${h.state.clock}-${message.to.replace(/[^a-z0-9@.]/gi, '_')}.eml`)
    fs.writeFileSync(file, info.message)
    savedFiles.push(file)
    return realSend(message)
  }
  const notifier = createTicketReplyNotifier(h.deps)
  const core = new MockCore({ now: h.deps.now })
  // Demo này minh họa luồng agent DUYỆT nháp, nên tắt tự trả lời (xem demo/e2e-auto-reply-ollama.js)
  const agent = createAgent({ config: load({ AI_PROVIDER: 'mock', AI_AUTO_REPLY: 'false' }), core, now: h.deps.now })
  const users = helpdesk.userMap()

  // Core: comment công khai -> notifier (giống emitter ticket:comment:added trong Trudesk)
  core.on('ticket:comment:added', ({ ticket, comment }) => {
    notifier.onCommentAdded({ ticket, comment }).then(report => {
      for (const r of report) {
        console.log(`   ${c.dim('notify')} ${r.to.padEnd(22)} web=${r.web.padEnd(14)} email=${r.email}${r.notes.length ? c.dim('  (' + r.notes.join(', ') + ')') : ''}`)
      }
    })
  })

  // ---- 1-2. Ticket mới -> AI
  step(1, 'Người dùng tạo ticket, Core trả 201 ngay rồi phát sự kiện cho AI')
  for (const t of incoming.filter(x => PEOPLE[x.uid])) {
    const p = PEOPLE[t.uid]
    core.addTicket({
      _id: `t-${t.uid}`,
      uid: t.uid,
      subject: t.subject,
      issue: t.issue,
      status: helpdesk.statuses.open,
      owner: p.owner,
      assignee: p.assignee,
      subscribers: [p.owner, p.assignee, ...p.subscribers]
    })
    console.log(`   #${t.uid} ${t.subject} ${c.dim('— ' + users.get(p.owner).fullname)}`)
  }

  step(2, 'AI Agent xử lý: che PII -> triage -> dedup -> RAG -> nháp -> guardrails')
  for (const uid of Object.keys(PEOPLE).map(Number)) {
    const t = incoming.find(x => x.uid === uid)
    const res = await agent.pipeline.handle(makeEvent('ticket.created', t, `evt-${uid}`))
    const s = res.suggestion
    console.log(`\n   ${c.b('#' + uid)} ${res.status}`)
    for (const [k, f] of Object.entries(s.fields)) {
      const color = f.decision === 'pending' ? c.g : f.decision === 'auto' ? c.y : c.r
      const v = Array.isArray(f.value) ? f.value.join(',') || '—' : f.value
      console.log(`     ${k.padEnd(9)} ${String(v).padEnd(16)} ${f.confidence.toFixed(2)} ${color(f.decision)}`)
    }
    if (s.similarTickets.length) console.log(`     tương tự ${s.similarTickets.map(x => `${x.ref} (${x.relation})`).join(', ')}`)
    const d = s.replyDraft
    console.log(`     nháp      ${(d.decision === 'pending' ? c.g : c.r)(d.decision)} ${d.confidence.toFixed(2)} nguồn: ${d.citations.join(', ') || '—'}`)
  }
  const masked = agent.audit.find({ kind: 'llm_call', ticketUid: 1042, task: 'triage' })[0]
  console.log(`\n   ${c.dim('Prompt gửi LLM cho #1042 đã che SĐT:')} ${masked.prompt.split('\n').find(l => l.indexOf('Nội dung') === 0)}`)

  // ---- 3-4. Agent duyệt -> người dùng nhận thông báo
  step(3, 'Agent Minh mở #1042, duyệt type/priority/group và gửi nháp trả lời')
  const minh = { id: 'u-agent-minh', name: 'Nguyễn Văn Minh' }
  const sug1042 = core.pendingFor(1042)[0]
  await core.reviewSuggestion(sug1042.id, { agent: minh, acceptFields: ['type', 'priority', 'group'], useDraft: true })
  await new Promise(resolve => setImmediate(resolve))
  const t1042 = await core.getTicket(1042)
  console.log(`   ticket #1042: type=${t1042.type} priority=${t1042.priority} group=${t1042.group}`)
  console.log(`   history: ${t1042.history.map(x => x.description).join(' | ')}`)

  step(4, 'Kênh WEB (ngay lập tức) và EMAIL (sau 60 giây gộp tin)')
  for (const e of h.state.socketEvents) console.log(`   socket -> ${e.to}: ${e.event} "${e.payload.title}" - ${e.payload.preview.slice(0, 60)}...`)
  console.log(`   chuông thông báo đã lưu cho: ${h.state.webNotifications.map(n => n.owner).join(', ')}`)
  console.log(`   email đang chờ: ${notifier.outbox.pending().map(j => j.recipient.email).join(', ')}`)
  h.advance(61 * 1000)
  await notifier.flush()
  const mail = h.state.sentEmails[0]
  console.log(`   ${c.g('đã gửi')} -> ${mail.to}`)
  console.log(`     Subject:  ${mail.subject}`)
  console.log(`     Reply-To: ${mail.replyTo}`)
  console.log(`     Threading: Message-ID ${mail.messageId}, In-Reply-To ${mail.inReplyTo}`)

  // ---- 5. Người dùng trả lời qua email
  step(5, 'Hoa bấm Reply trong Gmail -> IMAP -> ghép vào ticket #1042')
  const inbound = {
    from: 'hoa.le@acme.vn',
    to: [mail.replyTo],
    text: 'Em làm theo bước 2 thì vào được VPN rồi ạ. Cảm ơn anh!\n\nVào 09:01 17/11/2026, IT Helpdesk <support@acme.vn> đã viết:\n> ##- Vui lòng trả lời phía trên dòng này -##\n> Chào anh/chị...'
  }
  const findTicketByUid = async uid => {
    const t = await core.getTicket(uid)
    if (!t) return null
    const pop = id => ({ _id: id, email: users.get(id).email })
    return { ...t, owner: pop(t.owner), assignee: pop(t.assignee), subscribers: t.subscribers.map(pop) }
  }
  const decision = await resolveInboundReply(inbound, { secret: h.state.settings.replySecret, findTicketByUid, now: h.deps.now })
  console.log(`   quyết định: ${c.g(decision.action)} | nội dung giữ lại: "${decision.body}"`)
  const userComment = { _id: 'c-inbound-1', owner: decision.senderId, date: new Date(h.state.clock), comment: `<p>${decision.body}</p>` }
  t1042.comments.push(userComment)
  const report = await notifier.onCommentAdded({ ticket: t1042, comment: userComment })
  for (const r of report) console.log(`   ${c.dim('notify')} ${r.to.padEnd(22)} web=${r.web.padEnd(14)} email=${r.email}${r.notes.length ? c.dim('  (' + r.notes.join(', ') + ')') : ''}`)

  const spoof = await resolveInboundReply({ ...inbound, from: 'attacker@evil.com' }, { secret: h.state.settings.replySecret, findTicketByUid })
  console.log(`   thư giả mạo từ attacker@evil.com: ${c.r(spoof.action)} (${spoof.reason})`)

  // ---- 6. Các ca bị chặn / từ chối / hết hạn
  step(6, 'Ca thất bại có kiểm soát')
  const sug1047 = core.pendingFor(1047)[0]
  console.log(`   #1047 wifi sập: nháp bị guardrail chặn (độ tin cậy ${sug1047.replyDraft.confidence}) - KB chỉ có bài VPN, AI không bịa.`)
  const sug1049 = core.pendingFor(1049)[0]
  const rejected = await core.reviewSuggestion(sug1049.id, { agent: minh, acceptFields: [], useDraft: false, rejectReason: 'Cần điều tra nguyên nhân gốc với đội Network trước khi trả lời' })
  console.log(`   #1049: agent từ chối -> status=${c.r(rejected.status)}, lý do lưu lại: "${rejected.rejectReason}"`)
  h.advance(7 * 60 * 60 * 1000)
  console.log(`   sau 7 giờ không ai duyệt -> hết hạn: ${core.expireSuggestions().join(', ')}`)

  step(7, 'Tổng kết')
  const calls = agent.audit.find({ kind: 'llm_call' })
  const tokens = calls.reduce((s, e) => s + e.usage.input_tokens + e.usage.output_tokens, 0)
  console.log(`   LLM calls: ${calls.length}, tokens ước tính: ${tokens}, audit entries: ${agent.audit.entries.length}`)
  console.log(`   Email đã gửi: ${h.state.sentEmails.length}; file .eml:`)
  for (const f of savedFiles) console.log(`     ${f}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
