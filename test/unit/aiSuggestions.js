/* eslint-disable no-unused-expressions */
/* eslint-env mocha */
/*
 * Unit test cho controllers/api/v2/aiSuggestions.js (model được giả lập, không cần MongoDB).
 * Chạy riêng: npx mocha test/unit/aiSuggestions.js
 */
const { expect } = require('chai')

const AISuggestion = require('../../src/models/aisuggestion')
const Ticket = require('../../src/models/ticket')
const ctrl = require('../../src/controllers/api/v2/aiSuggestions')
const { detectKind, KINDS } = require('../../src/notifications/ticketReply/autoReplyKinds')

function mockRes () {
  const res = { statusCode: 200, body: null }
  res.status = code => {
    res.statusCode = code
    return res
  }
  res.json = body => {
    res.body = body
    return res
  }
  res.send = res.json
  return res
}

describe('aiSuggestions controller', function () {
  const saved = {}
  let emitted
  let store

  beforeEach(function () {
    store = []
    emitted = []
    global.io = { sockets: { emit: (ev, data) => emitted.push({ ev, data }) } }
    for (const k of ['create', 'updateMany', 'findById', 'getActiveForTicket']) saved['S' + k] = AISuggestion[k]
    for (const k of ['findOne', 'findById']) saved['T' + k] = Ticket[k]

    const ticket = { _id: 't1', uid: 1042, history: [], save: async function () { return this } }
    Ticket.findOne = () => ({ select: async () => ticket })
    Ticket.findById = async () => ticket
    AISuggestion.updateMany = async (q, u) => {
      store.filter(s => s.status === 'pending').forEach(s => (s.status = u.$set.status))
    }
    AISuggestion.create = async data => {
      const doc = { _id: 's' + (store.length + 1), status: 'pending', ...data, save: async function () { return this } }
      store.push(doc)
      return doc
    }
    AISuggestion.getActiveForTicket = async () => store.filter(s => s.status === 'pending').pop() || null
    AISuggestion.findById = async id => store.find(s => s._id === id) || null
    this.ticket = ticket
  })

  afterEach(function () {
    for (const k of ['create', 'updateMany', 'findById', 'getActiveForTicket']) AISuggestion[k] = saved['S' + k]
    for (const k of ['findOne', 'findById']) Ticket[k] = saved['T' + k]
    delete global.io
  })

  const triagePayload = {
    fields: { type: { value: 'Incident', confidence: 0.9, decision: 'pending' } },
    replyDraft: { text: 'Chào anh/chị', citations: ['KB-101'], confidence: 0.8, decision: 'pending' }
  }

  it('AI ghi gợi ý mới: thay gợi ý cũ đang chờ, phát socket cập nhật', async function () {
    await ctrl.create({ params: { uid: '1042' }, body: triagePayload }, mockRes())
    const res = mockRes()
    await ctrl.create({ params: { uid: '1042' }, body: triagePayload }, res)
    expect(res.body.success).to.be.true
    expect(store.map(s => s.status)).to.deep.equal(['expired', 'pending'])
    expect(emitted[0].ev).to.equal('$trudesk:tickets:ai:suggestion:update')
  })

  it('bản tóm tắt gắn vào gợi ý đang chờ, không thay phần triage', async function () {
    await ctrl.create({ params: { uid: '1042' }, body: triagePayload }, mockRes())
    await ctrl.create({ params: { uid: '1042' }, body: { summary: { text: 'Tóm tắt', confidence: 0.8 } } }, mockRes())
    expect(store).to.have.length(1)
    expect(store[0].summary.text).to.equal('Tóm tắt')
    expect(store[0].fields.type.value).to.equal('Incident')
  })

  it('duyệt: ghi trường đã áp dụng, lịch sử ticket; duyệt lần hai bị từ chối (409)', async function () {
    await ctrl.create({ params: { uid: '1042' }, body: triagePayload }, mockRes())
    const req = { params: { id: 's1' }, body: { acceptedFields: ['type', 'evil'], usedDraft: true }, user: { _id: 'u1' } }
    const res = mockRes()
    await ctrl.review(req, res)
    expect(res.body.success).to.be.true
    expect(store[0]).to.include({ status: 'approved', usedDraft: true })
    expect(store[0].acceptedFields).to.deep.equal(['type'])
    expect(this.ticket.history[0].description).to.equal('Duyệt gợi ý AI: áp dụng type; dùng nháp trả lời')

    const again = mockRes()
    await ctrl.review(req, again)
    expect(again.statusCode).to.equal(409)
  })

  it('bỏ qua: không chọn gì -> rejected', async function () {
    await ctrl.create({ params: { uid: '1042' }, body: triagePayload }, mockRes())
    await ctrl.review({ params: { id: 's1' }, body: { acceptedFields: [] }, user: { _id: 'u1' } }, mockRes())
    expect(store[0].status).to.equal('rejected')
    expect(this.ticket.history[0].description).to.equal('Bỏ qua gợi ý AI')
  })
})

describe('autoReplyKinds (dùng chung server + giao diện)', function () {
  it('mỗi loại có icon email (mdi) và icon web (Material Icons)', function () {
    for (const k of Object.keys(KINDS)) {
      expect(KINDS[k].icon).to.match(/^[a-z-]+$/)
      expect(KINDS[k].webIcon).to.match(/^[a-z_]+$/)
    }
  })

  it('nhận diện comment của AI qua dòng nhãn đầu', function () {
    expect(detectKind('Bộ phận IT · Trả lời tự động\nChào anh/chị')).to.include({ kind: 'answer', webIcon: 'headset_mic' })
    expect(detectKind('Chào anh/chị\nBộ phận IT · Trả lời tự động')).to.be.null
  })
})
