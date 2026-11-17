/* eslint-disable no-unused-expressions */
/* eslint-env mocha */
const { expect } = require('chai')

const { createAgent, makeEvent } = require('../src/bootstrap')
const { load } = require('../src/config')
const { checkDraftSafety } = require('../src/autoreply/policy')
const templates = require('../src/autoreply/templates')
const { OllamaProvider, normalize, sanitizeForModel } = require('../src/llm/providers/ollamaProvider')
const incoming = require('../mock-data/incoming-tickets.json')

const byUid = uid => incoming.find(t => t.uid === uid)

function setup () {
  const agent = createAgent({ config: load({}) })
  for (const t of incoming) agent.core.addTicket({ uid: t.uid, subject: t.subject, issue: t.issue, owner: 'u-user', group: 'Network' })
  return agent
}

describe('ai-agent / auto-reply policy', function () {
  const ctx = [{ refId: 'KB-102', text: 'Truy cập https://passwordreset.acme.vn để đặt lại mật khẩu.' }]

  it('chặn nháp đòi mật khẩu, tự nhận đã làm, hoặc có link lạ', function () {
    expect(checkDraftSafety('Anh/chị vui lòng gửi cho IT biết mật khẩu hiện tại để kiểm tra giúp nhé, cảm ơn anh chị nhiều.', ctx).join()).to.include('mật khẩu')
    expect(checkDraftSafety('IT đã cấp quyền thư mục cho anh/chị, anh chị đăng xuất rồi đăng nhập lại là dùng được ngay nhé.', ctx).join()).to.include('tự nhận')
    expect(checkDraftSafety('Anh/chị vào https://evil.example.com/reset để đặt lại mật khẩu theo hướng dẫn của IT nhé.', ctx).join()).to.include('link')
    expect(checkDraftSafety('Anh/chị vào https://passwordreset.acme.vn để đặt lại mật khẩu theo hướng dẫn của IT nhé.', ctx)).to.deep.equal([])
  })

  it('chặn nháp nhắc lại nhãn PII (vd model tưởng [PHONE_1] là số của IT)', function () {
    const draft = 'Chào anh/chị, nếu cần hỗ trợ thêm anh/chị có thể gọi IT qua số [PHONE_1] trong giờ hành chính nhé.'
    expect(checkDraftSafety(draft, ctx).join()).to.include('thông tin cá nhân')
  })

  it('không chặn nhầm câu mô tả "nhập sai mật khẩu"', function () {
    const draft = 'Tài khoản bị khóa sau 5 lần nhập sai mật khẩu. Anh/chị cập nhật mật khẩu mới trên điện thoại để tránh bị khóa lại nhé.'
    expect(checkDraftSafety(draft, ctx)).to.deep.equal([])
  })
})

describe('ai-agent / làm sạch dữ liệu cho model nhỏ', function () {
  const { dropTags } = require('../src/preprocess/piiMasker')

  it('bỏ hẳn câu chứa nhãn PII (kho tri thức và đầu vào soạn nháp)', function () {
    expect(dropTags('Lỗi 809. Số điện thoại em [PHONE_1]. Đã thêm registry.')).to.equal('Lỗi 809. Đã thêm registry.')
    expect(dropTags('Bị khóa. Mật khẩu: [SECRET_1]')).to.equal('Bị khóa.')
  })

  it('kho tri thức không còn nhãn PII của người cũ', function () {
    const agent = setup()
    for (const d of agent.kb.store.docs.values()) expect(d.text).to.not.match(/\[(PHONE|EMAIL|SECRET)_\d+\]/)
  })

  it('bỏ dòng siêu dữ liệu model tự chèn vào thân thư', function () {
    const out = templates.cleanDraft('Chào anh/chị,\nBước 1: ...\n\n[Citation: #980, KB-101]\nConfidence: High\nNote: abc\nTrân trọng')
    expect(out).to.equal('Chào anh/chị,\nBước 1: ...\n\nTrân trọng')
  })
})

describe('ai-agent / cổng single-user', function () {
  it('model gán nhầm sự cố diện rộng là Incident 0.95 -> vẫn không tự trả lời', async function () {
    const { MockProvider } = require('../src/llm/providers/mockProvider')
    const p = new MockProvider()
    const orig = p.complete.bind(p)
    p.complete = async req => {
      const res = await orig(req)
      if (req.task === 'triage') res.json.type = { value: 'Incident', confidence: 0.95 } // giống lỗi thật của qwen 7B
      return res
    }
    const agent = createAgent({ config: load({}), provider: p })
    agent.core.addTicket({ uid: 1049, subject: 'x', issue: 'y', owner: 'u' })
    const res = await agent.pipeline.handle(makeEvent('ticket.created', byUid(1049), 'wide'))
    expect(res.suggestion.fields.type.value).to.equal('Incident')
    expect(res.autoReply.kind).to.equal('ack')
    expect(res.autoReply.checks.find(c => c.name === 'single-user')).to.include({ ok: false })
  })
})

describe('ai-agent / auto-reply theo loại ticket', function () {
  it('Service Request -> chỉ xác nhận, ticket giữ Open cho IT thao tác', async function () {
    const agent = setup()
    const res = await agent.pipeline.handle(makeEvent('ticket.created', byUid(1043), 'sr'))
    expect(res.autoReply.kind).to.equal('ack')
    const t = await agent.core.getTicket(1043)
    expect(t.status).to.be.undefined
  })
})

describe('ai-agent / auto-reply pipeline', function () {
  it('ticket có tài liệu rõ ràng -> tự gửi câu trả lời, chuyển Pending', async function () {
    const agent = setup()
    const res = await agent.pipeline.handle(makeEvent('ticket.created', byUid(1042), 'a1'))
    expect(res.autoReply).to.include({ sent: true, kind: 'answer' })
    const t = await agent.core.getTicket(1042)
    expect(t.status.name).to.equal('Pending')
    const text = t.comments[0].comment
    expect(text).to.include(templates.MARKERS.answer).and.include('KB-101')
    expect(res.suggestion.replyDraft.decision).to.equal('auto_sent')
  })

  it('Critical hoặc Problem -> không tự trả lời, chỉ gửi xác nhận tiếp nhận', async function () {
    const agent = setup()
    const critical = await agent.pipeline.handle(makeEvent('ticket.created', byUid(1047), 'c1'))
    const problem = await agent.pipeline.handle(makeEvent('ticket.created', byUid(1049), 'p1'))
    expect(critical.autoReply.kind).to.equal('ack')
    expect(critical.autoReply.checks.find(c => c.name === 'priority-allowed').ok).to.be.false
    expect(problem.autoReply.kind).to.equal('ack')
    expect(problem.autoReply.checks.find(c => c.name === 'type-allowed').ok).to.be.false
    const t = await agent.core.getTicket(1047)
    expect(t.comments[0].comment).to.include(templates.MARKERS.ack).and.include('#1047')
  })

  it('người dùng xác nhận đã được -> AI đóng ticket', async function () {
    const agent = setup()
    await agent.pipeline.handle(makeEvent('ticket.created', byUid(1042), 'a2'))
    await agent.core.addUserComment(1042, 'u-user', 'Em làm theo bước 2 thì vào được VPN rồi, cảm ơn anh!')
    const res = await agent.pipeline.handle(agent.core.toUpdatedEvent(1042))
    expect(res).to.include({ status: 'closed', label: 'resolved' })
    const t = await agent.core.getTicket(1042)
    expect(t.status).to.include({ name: 'Closed', isResolved: true })
  })

  it('người dùng báo vẫn lỗi -> chuyển nhân viên, ghi note, sau đó AI im lặng', async function () {
    const agent = setup()
    await agent.pipeline.handle(makeEvent('ticket.created', byUid(1045), 'b1'))
    await agent.core.addUserComment(1045, 'u-user', 'Em đổi mật khẩu trên điện thoại rồi mà vẫn bị khóa ạ')
    const res = await agent.pipeline.handle(agent.core.toUpdatedEvent(1045))
    expect(res).to.include({ status: 'handoff', label: 'not_resolved' })
    const t = await agent.core.getTicket(1045)
    expect(t.status.name).to.equal('Open')
    expect(t.notes[0].note).to.include('not_resolved')

    await agent.core.addUserComment(1045, 'u-user', 'Còn ai ở đó không ạ?')
    const again = await agent.pipeline.handle(agent.core.toUpdatedEvent(1045))
    expect(again.status).to.not.equal('handoff')
    expect(agent.audit.find({ kind: 'follow_up' })).to.have.length(1)
  })

  it('nhân viên đã tham gia sau câu trả lời AI -> AI không xen vào', async function () {
    const agent = setup()
    await agent.pipeline.handle(makeEvent('ticket.created', byUid(1042), 'h1'))
    await agent.core.addUserComment(1042, 'u-agent-minh', 'Anh gọi cho em nhé')
    await agent.core.addUserComment(1042, 'u-user', 'Dạ vâng')
    const res = await agent.pipeline.handle(agent.core.toUpdatedEvent(1042))
    expect(['closed', 'handoff']).to.not.include(res.status)
  })

  it('tắt AI_AUTO_REPLY -> không gửi gì cho người dùng', async function () {
    const agent = createAgent({ config: load({ AI_AUTO_REPLY: 'false' }) })
    agent.core.addTicket({ uid: 1042, subject: 'x', issue: 'y', owner: 'u-user' })
    const res = await agent.pipeline.handle(makeEvent('ticket.created', byUid(1042), 'off'))
    expect(res.autoReply.sent).to.be.false
    expect((await agent.core.getTicket(1042)).comments).to.have.length(0)
  })
})

describe('ai-agent / Ollama provider', function () {
  it('chuẩn hóa confidence 0-100 và citations kèm tiêu đề', function () {
    const out = normalize({ draft: 'x', citations: ['[KB-101] Lỗi VPN 809', 'không rõ', '#980'], confidence: 100, type: { value: 'Incident', confidence: 85 } })
    expect(out).to.deep.equal({ draft: 'x', citations: ['KB-101', '#980'], confidence: 1, type: { value: 'Incident', confidence: 0.85 } })
  })

  it('gửi format = JSON schema tới /api/chat và trả usage', async function () {
    let sent = null
    const http = {
      post: async (url, body) => {
        sent = { url, body }
        return { data: { message: { content: '{"label":"resolved","confidence":90}' }, prompt_eval_count: 50, eval_count: 7 } }
      }
    }
    const p = new OllamaProvider({ model: 'qwen2.5:7b-instruct', http })
    const res = await p.complete({ system: 's', prompt: 'p', schema: { type: 'object' } })
    expect(sent.url).to.equal('/api/chat')
    expect(sent.body).to.include({ model: 'qwen2.5:7b-instruct', stream: false })
    expect(sent.body.format).to.deep.equal({ type: 'object' })
    expect(res.json).to.deep.equal({ label: 'resolved', confidence: 0.9 })
    expect(res.usage).to.deep.equal({ input_tokens: 50, output_tokens: 7 })
  })

  it('đổi chuỗi "\\\\" (đường dẫn UNC) trước khi gửi model để tránh vòng lặp escape', function () {
    expect(sanitizeForModel('thư mục \\\\fileserver\\projects')).to.equal('thư mục //fileserver\\projects')
  })

  it('Ollama tắt -> lỗi network có thể thử lại', async function () {
    const http = { post: async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) } }
    const p = new OllamaProvider({ http })
    try {
      await p.complete({ system: '', prompt: '', schema: {} })
      throw new Error('should fail')
    } catch (e) {
      expect(e).to.include({ kind: 'network', retryable: true })
    }
  })
})
