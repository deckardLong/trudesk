/* eslint-disable no-unused-expressions */
/* eslint-env mocha */
/* Chạy: npx mocha ai-agent/test */
const { expect } = require('chai')
const http = require('http')
const crypto = require('crypto')

const { mask, unmask } = require('../src/preprocess/piiMasker')
const { decide, decideTriageFields, Budget, BudgetExceeded } = require('../src/guardrails/guardrails')
const { validate, triageSchema } = require('../src/llm/schemas')
const { createAgent, makeEvent } = require('../src/bootstrap')
const { load } = require('../src/config')
const { MockProvider } = require('../src/llm/providers/mockProvider')
const { formatNote } = require('../src/core/httpCore')
const { createServer } = require('../src/server')
const incoming = require('../mock-data/incoming-tickets.json')

const cfg = load({})

function freshAgent (overrides = {}, provider) {
  const agent = createAgent({ config: load(overrides), provider })
  for (const t of incoming) agent.core.addTicket({ uid: t.uid, subject: t.subject, issue: t.issue })
  return agent
}

describe('ai-agent / PII masker', function () {
  it('che email, SĐT, mật khẩu, CCCD, IP và khôi phục được (trừ mật khẩu)', function () {
    const src = 'Gọi 0912345678 hoặc +84987654321, mail a.b@acme.vn, CCCD 012345678901, IP 10.0.0.5, mật khẩu: Abc@123'
    const { text, vault, found } = mask(src)
    expect(text).to.not.match(/0912345678|a\.b@acme\.vn|012345678901|10\.0\.0\.5|Abc@123/)
    expect(found).to.include({ EMAIL: 1, PHONE: 2, NATIONAL_ID: 1, IP: 1, SECRET: 1 })
    const back = unmask(text, vault)
    expect(back).to.include('0912345678').and.include('a.b@acme.vn')
    expect(back).to.not.include('Abc@123')
  })
})

describe('ai-agent / guardrails', function () {
  it('ngưỡng: dropped / pending / auto (chỉ khi bật autoApply)', function () {
    const g = cfg.guardrails
    expect(decide(0.5, g)).to.equal('dropped')
    expect(decide(0.97, g)).to.equal('pending')
    expect(decide(0.97, { ...g, autoApply: true })).to.equal('auto')
  })

  it('schema validator bắt giá trị ngoài danh mục và thiếu trường', function () {
    const errs = validate(triageSchema(), { type: { value: 'Bug', confidence: 2 }, priority: {} })
    expect(errs.join(' ')).to.include('not in enum').and.include('> 1').and.include('required')
  })

  it('hạn mức chi phí chặn khi vượt số lần gọi/giờ', function () {
    const b = new Budget({ maxCallsPerHour: 1, maxTokensPerDay: 1000 })
    b.record(10)
    expect(() => b.assertCanSpend(10)).to.throw(BudgetExceeded)
  })

  it('tags rỗng luôn bị bỏ', function () {
    const f = decideTriageFields(
      { type: { value: 'Incident', confidence: 0.9 }, priority: { value: 'Normal', confidence: 0.9 }, group: { value: 'Network', confidence: 0.9 }, tags: { value: [], confidence: 0.9 } },
      cfg.guardrails
    )
    expect(f.tags.decision).to.equal('dropped')
  })
})

describe('ai-agent / RAG', function () {
  it('không nạp bài KB chưa Published; tìm đúng bài VPN cho ticket VPN', function () {
    const agent = freshAgent()
    expect(agent.kb.store.docs.has('KB-199#0')).to.be.false
    const top = agent.kb.search('VPN báo lỗi 809 khi làm ở nhà', { k: 2 })
    expect(top.map(r => r.refId)).to.include('KB-101')
  })
})

describe('ai-agent / pipeline', function () {
  it('ticket mới -> gợi ý chờ duyệt có triage, nháp có trích nguồn, không lộ PII ra LLM', async function () {
    const agent = freshAgent()
    const t = incoming.find(x => x.uid === 1042)
    const res = await agent.pipeline.handle(makeEvent('ticket.created', t, 'e1'))
    expect(res.status).to.equal('suggested')
    const s = res.suggestion
    expect(s.status).to.equal('pending')
    expect(s.fields.group).to.include({ value: 'Network', decision: 'pending' })
    expect(s.replyDraft.citations).to.include('KB-101')
    for (const call of agent.audit.find({ kind: 'llm_call' })) expect(call.prompt).to.not.include('0987654321')
  })

  it('sự kiện giao lại (cùng id) không xử lý lần hai', async function () {
    const agent = freshAgent()
    const ev = makeEvent('ticket.created', incoming[0], 'same-id')
    await agent.pipeline.handle(ev)
    const again = await agent.pipeline.handle(ev)
    expect(again.status).to.equal('duplicate')
    expect(agent.core.suggestions.size).to.equal(1)
  })

  it('LLM lỗi -> bỏ gợi ý, ghi audit, không ném lỗi ra ngoài', async function () {
    const broken = new MockProvider()
    broken.complete = async () => {
      throw Object.assign(new Error('timeout'), { kind: 'network', retryable: true })
    }
    const agent = freshAgent({}, broken)
    const res = await agent.pipeline.handle(makeEvent('ticket.created', incoming[0], 'e-broken'))
    expect(res).to.include({ status: 'skipped', reason: 'network' })
    expect(agent.core.suggestions.size).to.equal(0)
    expect(agent.audit.find({ kind: 'skipped' })).to.have.length(1)
  })

  it('LLM trả JSON sai định dạng -> bị guardrail chặn', async function () {
    const liar = new MockProvider()
    liar.complete = async () => ({ json: { type: 'Bug' }, usage: { input_tokens: 1, output_tokens: 1 }, model: 'x' })
    const agent = freshAgent({}, liar)
    const res = await agent.pipeline.handle(makeEvent('ticket.created', incoming[0], 'e-liar'))
    expect(res).to.include({ status: 'skipped', reason: 'invalid_output' })
  })

  it('phát hiện ticket liên quan đã mở trước đó (#1049 ~ #1042)', async function () {
    const agent = freshAgent()
    await agent.pipeline.handle(makeEvent('ticket.created', incoming.find(x => x.uid === 1042), 'a'))
    const res = await agent.pipeline.handle(makeEvent('ticket.created', incoming.find(x => x.uid === 1049), 'b'))
    expect(res.suggestion.similarTickets.map(s => s.ref)).to.include('#1042')
  })

  it('AI_AUTO_APPLY bật -> chỉ trường >= 0.95 được tự ghi, nháp vẫn chờ duyệt', async function () {
    const agent = freshAgent({ AI_AUTO_APPLY: 'true', AI_AUTO_REPLY: 'false' })
    const res = await agent.pipeline.handle(makeEvent('ticket.created', incoming.find(x => x.uid === 1043), 'auto'))
    const ticket = await agent.core.getTicket(1043)
    expect(res.suggestion.fields.group.decision).to.equal('auto')
    expect(ticket.group).to.equal('Access')
    expect(res.suggestion.replyDraft.decision).to.equal('pending')
  })

  it('agent duyệt một phần + dùng nháp -> ticket cập nhật, phát ticket:comment:added', async function () {
    const agent = freshAgent({ AI_AUTO_REPLY: 'false' })
    const res = await agent.pipeline.handle(makeEvent('ticket.created', incoming[0], 'r'))
    let emitted = null
    agent.core.on('ticket:comment:added', e => (emitted = e))
    const doc = await agent.core.reviewSuggestion(res.suggestion.id, {
      agent: { id: 'u-agent-minh', name: 'Minh' },
      acceptFields: ['type', 'group'],
      useDraft: true
    })
    const t = await agent.core.getTicket(incoming[0].uid)
    expect(doc).to.include({ status: 'approved' })
    expect(t.group).to.equal('Network')
    expect(t.priority).to.be.undefined
    expect(emitted.comment.comment).to.include('KB-101')
  })

  it('format internal note cho chế độ HTTP chỉ chứa trường không bị bỏ', function () {
    const note = formatNote({
      fields: { type: { value: 'Incident', confidence: 0.8, decision: 'pending' }, group: { value: 'X', confidence: 0.2, decision: 'dropped' } },
      similarTickets: [],
      replyDraft: { decision: 'pending', text: 'Nháp', citations: ['KB-1'] }
    })
    expect(note).to.include('Incident').and.include('Nháp').and.not.include('**group**')
  })
})

describe('ai-agent / HttpCore', function () {
  it('chỉ gọi API v1 (accesstoken), đổi trạng thái bằng PUT /api/v1/tickets/:id', async function () {
    const { HttpCore } = require('../src/core/httpCore')
    const calls = []
    const http = {
      get: async url => {
        calls.push('GET ' + url)
        if (url === '/api/v1/tickets/status') return { data: { success: true, status: [{ _id: 's3', name: 'Closed', isResolved: true }] } }
        return { data: { success: true, ticket: { _id: 'oid1', uid: 1042 } } }
      },
      post: async (url, body) => calls.push('POST ' + url + ' ' + Object.keys(body).join(',')),
      put: async (url, body) => calls.push('PUT ' + url + ' ' + body.status + ' ' + (body.closedDate ? 'date' : 'null'))
    }
    const core = new HttpCore({ baseUrl: 'http://x', accessToken: 't', http })
    await core.postComment(1042, 'hi')
    await core.setStatus(1042, 'closed')
    expect(calls).to.include('POST /api/v1/tickets/addcomment _id,comment')
    expect(calls).to.include('PUT /api/v1/tickets/oid1 s3 date')
    expect(calls.some(c => c.indexOf('/api/v2/') !== -1)).to.be.false
  })
})

describe('ai-agent / webhook server', function () {
  it('từ chối chữ ký sai, nhận chữ ký đúng (202) và xử lý bất đồng bộ', async function () {
    const secret = 'whsec'
    const agent = freshAgent()
    const { server } = createServer({ agent, secret })
    await new Promise(resolve => server.listen(0, resolve))
    const port = server.address().port
    const post = (body, sig) =>
      new Promise((resolve, reject) => {
        const req = http.request({ port, path: '/events', method: 'POST', headers: { 'x-trudesk-signature': sig } }, res => resolve(res.statusCode))
        req.on('error', reject)
        req.end(body)
      })

    const body = JSON.stringify(makeEvent('ticket.created', incoming[0], 'wh-1'))
    const good = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
    expect(await post(body, 'sha256=deadbeef')).to.equal(401)
    expect(await post(body, good)).to.equal(202)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(agent.core.suggestions.size).to.equal(1)
    server.close()
  })
})
