/* eslint-disable no-unused-expressions */
/* eslint-env mocha */
/*
 * Unit test cho src/notifications/ticketReply (không cần MongoDB).
 * Chạy riêng: npx mocha test/unit/ticketReply.js
 */
const { expect } = require('chai')

const { createTicketReplyNotifier, SOCKET_EVENT } = require('../../src/notifications/ticketReply')
const { decideChannels } = require('../../src/notifications/ticketReply/channelPolicy')
const { resolveRecipients } = require('../../src/notifications/ticketReply/recipientResolver')
const replyToken = require('../../src/notifications/ticketReply/replyToken')
const { composeReplyEmail } = require('../../src/notifications/ticketReply/emailComposer')
const { resolveInboundReply, extractReplyText } = require('../../src/notifications/ticketReply/inboundReply')
const { createMockDeps } = require('../../demo/ticket-reply/mockDeps')
const mock = require('../../demo/mock-data/helpdesk')

const SECRET = 'unit-test-secret'

function staffComment (ticket, text, owner = 'u-agent-minh', id = 'c-' + Math.random().toString(36).slice(2)) {
  const comment = { _id: id, owner, date: new Date('2026-11-17T09:05:00+07:00'), comment: `<p>${text}</p>` }
  ticket.comments.push(comment)
  return comment
}

describe('ticketReply / recipientResolver', function () {
  it('báo cho owner + subscribers, bỏ người viết, bỏ tài khoản đã xóa, không trùng', function () {
    const ticket = mock.cloneTicket(1042)
    const r = resolveRecipients({ ticket, authorId: 'u-agent-minh', isInternal: false, users: mock.userMap() })
    const ids = r.map(x => x.user._id)
    expect(ids).to.have.members(['u-user-hoa', 'u-agent-lan'])
    expect(ids).to.not.include('u-agent-minh')
    expect(ids).to.not.include('u-user-old')
  })

  it('internal note chỉ tới nhân viên, không tới người dùng cuối', function () {
    const ticket = mock.cloneTicket(1042)
    const r = resolveRecipients({ ticket, authorId: 'u-agent-minh', isInternal: true, users: mock.userMap() })
    expect(r.map(x => x.user._id)).to.deep.equal(['u-agent-lan'])
  })
})

describe('ticketReply / channelPolicy', function () {
  const users = mock.userMap()

  it('mặc định gửi cả web và email', function () {
    const c = decideChannels(users.get('u-user-hoa'), { mailEnabled: true, isOnline: false })
    expect(c.web).to.be.true
    expect(c.email).to.be.true
  })

  it('người dùng không có quyền vào web -> chỉ email', function () {
    const c = decideChannels(users.get('u-user-tuan'), { mailEnabled: true, isOnline: false })
    expect(c).to.include({ web: false, email: true })
  })

  it('skipEmailWhenOnline + đang online -> bỏ email', function () {
    const c = decideChannels(users.get('u-user-khoa'), { mailEnabled: true, isOnline: true })
    expect(c).to.include({ web: true, email: false })
    expect(c.reasons).to.include('online:email-skipped')
  })

  it('chọn email nhưng mailer tắt -> dự phòng sang web', function () {
    const u = { _id: 'x', email: 'x@acme.vn', preferences: { notifications: { channel: 'email' } } }
    const c = decideChannels(u, { mailEnabled: false, isOnline: false })
    expect(c).to.include({ web: true, email: false })
    expect(c.reasons).to.include('fallback:web')
  })

  it("channel 'none' -> không gửi gì", function () {
    const u = { _id: 'x', email: 'x@acme.vn', preferences: { notifications: { channel: 'none' } } }
    expect(decideChannels(u, { mailEnabled: true, isOnline: false })).to.include({ web: false, email: false })
  })
})

describe('ticketReply / replyToken', function () {
  it('tạo và đọc lại địa chỉ Reply-To', function () {
    const addr = replyToken.buildReplyAddress({ uid: 1042, mailbox: 'support@acme.vn', secret: SECRET })
    expect(addr).to.match(/^support\+t1042\.[a-f0-9]{10}@acme\.vn$/)
    expect(replyToken.parseReplyAddress(addr, SECRET)).to.deep.equal({ uid: 1042 })
  })

  it('từ chối token bị sửa (đổi số ticket hoặc sai chữ ký)', function () {
    const addr = replyToken.buildReplyAddress({ uid: 1042, mailbox: 'support@acme.vn', secret: SECRET })
    expect(replyToken.parseReplyAddress(addr.replace('t1042', 't1043'), SECRET)).to.be.null
    expect(replyToken.parseReplyAddress(addr, 'other-secret')).to.be.null
    expect(replyToken.parseReplyAddress('support@acme.vn', SECRET)).to.be.null
  })
})

describe('ticketReply / emailComposer', function () {
  it('có threading header, Reply-To, link ticket và escape HTML ở tiêu đề', function () {
    const msg = composeReplyEmail({
      ticket: { _id: 't', uid: 7, subject: '<script>x</script> VPN', status: { name: 'Open' } },
      comments: [{ _id: 'c1', authorName: 'Minh', date: new Date(), html: '<p>Đã xử lý</p>' }],
      recipient: { email: 'a@acme.vn', fullname: 'A' },
      siteUrl: 'https://helpdesk.acme.vn/',
      replyTo: 'support+t7.abc@acme.vn',
      mailbox: 'support@acme.vn'
    })
    expect(msg.subject).to.equal('[Ticket #7] Re: <script>x</script> VPN')
    expect(msg.html).to.not.include('<script>x</script>')
    expect(msg.html).to.include('https://helpdesk.acme.vn/tickets/7')
    expect(msg.inReplyTo).to.equal('<ticket-7@acme.vn>')
    expect(msg.replyTo).to.equal('support+t7.abc@acme.vn')
    expect(msg.text).to.include('Đã xử lý')
  })
})

describe('ticketReply / icon từ thư viện Material của Trudesk', function () {
  const { iconPng, codepointOf } = require('../../src/notifications/ticketReply/icons')
  const { KINDS } = require('../../src/notifications/ticketReply/autoReplyKinds')
  const { MARKERS } = require('../../ai-agent/src/autoreply/templates')

  it('tra tên lớp mdi-* ra mã glyph và vẽ được PNG hợp lệ', function () {
    expect(codepointOf('hardware-headset-mic')).to.equal('e7be')
    const png = iconPng('action-check-circle', { size: 40 })
    expect(png.slice(0, 8).toString('hex')).to.equal('89504e470d0a1a0a')
    expect(png.readUInt32BE(16)).to.equal(40)
    expect(() => iconPng('khong-ton-tai')).to.throw(/không có icon/)
  })

  it('nhãn phản hồi tự động của Core khớp với AI Agent, không chứa emoji', function () {
    for (const k of Object.keys(MARKERS)) {
      expect(KINDS[k].label).to.equal(MARKERS[k])
      expect(MARKERS[k]).to.not.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u)
    }
  })

  it('email: nhãn tự động được thay bằng icon CID, không có link ảnh ngoài', function () {
    const msg = composeReplyEmail({
      ticket: { _id: 't', uid: 9, subject: 'VPN', status: { name: 'Pending' } },
      comments: [{ _id: 'c1', authorName: 'Trợ lý IT', date: new Date(), html: '<p>Bộ phận IT · Trả lời tự động</p><p>Chào anh/chị,</p>' }],
      recipient: { email: 'a@acme.vn', fullname: 'A' },
      siteUrl: 'https://helpdesk.acme.vn',
      replyTo: null,
      mailbox: 'support@acme.vn'
    })
    const cids = msg.attachments.map(a => a.cid)
    expect(cids).to.include('mdi-hardware-headset-mic@helpdesk').and.include('mdi-action-assignment@helpdesk')
    expect(msg.html).to.include('src="cid:mdi-hardware-headset-mic@helpdesk"')
    expect(msg.html).to.not.match(/<img[^>]+src="https?:/)
    expect(msg.html.match(/Trả lời tự động/g)).to.have.length(1) // dòng nhãn gốc đã được thay
    expect(msg.text).to.include('Bộ phận IT · Trả lời tự động')
  })
})

describe('ticketReply / notifier (end-to-end với mock)', function () {
  it('agent trả lời -> người dùng nhận web ngay, email sau thời gian gộp', async function () {
    const h = createMockDeps({ online: ['u-user-hoa'] })
    const notifier = createTicketReplyNotifier(h.deps)
    const ticket = mock.cloneTicket(1042)
    const comment = staffComment(ticket, 'Anh đã reset tài khoản VPN, em thử lại nhé.')

    const report = await notifier.onCommentAdded({ ticket, comment })
    const hoa = report.find(r => r.to === 'hoa.le')
    expect(hoa).to.include({ web: 'sent:realtime', email: 'queued' })
    expect(h.state.socketEvents[0]).to.include({ to: 'hoa.le', event: SOCKET_EVENT })
    expect(h.state.webNotifications.map(n => n.owner)).to.include('u-user-hoa')

    // Chưa tới hạn -> chưa gửi
    await notifier.flush()
    expect(h.state.sentEmails).to.have.length(0)

    h.advance(61 * 1000)
    await notifier.flush()
    expect(h.state.sentEmails.map(m => m.to)).to.deep.equal(['hoa.le@acme.vn'])
    expect(h.state.sentEmails[0].replyTo).to.match(/^support\+t1042\./)
  })

  it('nhiều comment liên tiếp được gộp thành một email', async function () {
    const h = createMockDeps()
    const notifier = createTicketReplyNotifier(h.deps)
    const ticket = mock.cloneTicket(1042)

    await notifier.onCommentAdded({ ticket, comment: staffComment(ticket, 'Bước 1: gỡ VPN client') })
    h.advance(20 * 1000)
    await notifier.onCommentAdded({ ticket, comment: staffComment(ticket, 'Bước 2: cài lại bản 5.2') })
    h.advance(61 * 1000)
    await notifier.flush()

    const toHoa = h.state.sentEmails.filter(m => m.to === 'hoa.le@acme.vn')
    expect(toHoa).to.have.length(1)
    expect(toHoa[0].text).to.include('Bước 1').and.include('Bước 2')
    expect(toHoa[0].text).to.include('2 phản hồi mới')
  })

  it('sự kiện bị phát lại không gửi trùng email', async function () {
    const h = createMockDeps()
    const notifier = createTicketReplyNotifier(h.deps)
    const ticket = mock.cloneTicket(1042)
    const comment = staffComment(ticket, 'Xong rồi', 'u-agent-minh', 'c-fixed')

    await notifier.onCommentAdded({ ticket, comment })
    h.advance(61 * 1000)
    await notifier.flush()
    const again = await notifier.onCommentAdded({ ticket, comment })
    h.advance(61 * 1000)
    await notifier.flush()

    expect(again.find(r => r.to === 'hoa.le').email).to.equal('duplicate')
    expect(h.state.sentEmails.filter(m => m.to === 'hoa.le@acme.vn')).to.have.length(1)
  })

  it('SMTP lỗi tạm thời -> thử lại theo backoff rồi gửi được', async function () {
    const h = createMockDeps({ smtpFailures: 1 })
    const notifier = createTicketReplyNotifier(h.deps)
    const ticket = mock.cloneTicket(1043)
    await notifier.onCommentAdded({ ticket, comment: staffComment(ticket, 'Đã cấp quyền', 'u-agent-lan') })

    h.advance(61 * 1000)
    await notifier.flush()
    expect(h.state.sentEmails).to.have.length(0)
    expect(notifier.outbox.pending()[0]).to.include({ status: 'retrying', attempts: 1 })

    h.advance(61 * 1000)
    await notifier.flush()
    expect(h.state.sentEmails.map(m => m.to)).to.deep.equal(['tuan.pham@partner.com'])
  })

  it('bot AI trả lời -> người dùng nhận email, nhân viên chỉ nhận web', async function () {
    const h = createMockDeps()
    const notifier = createTicketReplyNotifier(h.deps)
    const ticket = mock.cloneTicket(1042)
    const report = await notifier.onCommentAdded({ ticket, comment: staffComment(ticket, 'Bộ phận IT · Trả lời tự động', 'u-ai-bot') })
    expect(report.find(r => r.to === 'hoa.le')).to.include({ email: 'queued' })
    const minh = report.find(r => r.to === 'minh.nguyen')
    expect(minh).to.include({ email: 'skipped' })
    expect(minh.web).to.match(/^sent/)
    expect(minh.notes).to.include('bot-reply:staff-web-only')
  })

  it('người dùng trả lời -> agent được báo, người dùng không tự nhận lại', async function () {
    const h = createMockDeps()
    const notifier = createTicketReplyNotifier(h.deps)
    const ticket = mock.cloneTicket(1042)
    const report = await notifier.onCommentAdded({ ticket, comment: staffComment(ticket, 'Vẫn lỗi 809 ạ', 'u-user-hoa') })
    const to = report.map(r => r.to)
    expect(to).to.include('minh.nguyen')
    expect(to).to.not.include('hoa.le')
    // Lan chọn chỉ nhận web
    expect(report.find(r => r.to === 'lan.tran')).to.include({ email: 'skipped' })
  })
})

describe('ticketReply / inboundReply', function () {
  const findTicketByUid = async uid => {
    const t = mock.tickets.find(x => x.uid === uid)
    return t ? mock.populateTicket(mock.cloneTicket(uid)) : null
  }
  const now = () => new Date('2026-11-17T10:00:00+07:00').getTime()
  const to = uid => [replyToken.buildReplyAddress({ uid, mailbox: 'support@acme.vn', secret: SECRET })]
  const deps = { secret: SECRET, findTicketByUid, now }

  it('cắt phần trích dẫn và chữ ký', function () {
    const text = 'Em thử lại được rồi ạ.\nCảm ơn anh!\n\nVào 09:05 17/11/2026, IT Helpdesk đã viết:\n> Anh đã reset...'
    expect(extractReplyText(text)).to.equal('Em thử lại được rồi ạ.\nCảm ơn anh!')
  })

  it('owner trả lời ticket đang mở -> comment', async function () {
    const d = await resolveInboundReply({ from: 'Hoa.Le@acme.vn', to: to(1042), text: 'Được rồi ạ' }, deps)
    expect(d).to.include({ action: 'comment', ticketUid: 1042, senderId: 'u-user-hoa', body: 'Được rồi ạ' })
  })

  it('người lạ dùng đúng địa chỉ -> reject', async function () {
    const d = await resolveInboundReply({ from: 'hacker@evil.com', to: to(1042), text: 'spam' }, deps)
    expect(d).to.include({ action: 'reject', reason: 'sender-not-participant' })
  })

  it('ticket đóng 3 ngày trước -> reopen; thư tự động -> ignore; không token -> new_ticket', async function () {
    const reopen = await resolveInboundReply({ from: 'khoa.vo@acme.vn', to: to(1044), text: 'Lại kẹt giấy' }, deps)
    expect(reopen.action).to.equal('reopen')

    const auto = await resolveInboundReply(
      { from: 'khoa.vo@acme.vn', to: to(1044), text: 'Tôi đang nghỉ phép', headers: { 'auto-submitted': 'auto-replied' } },
      deps
    )
    expect(auto.action).to.equal('ignore')

    const fresh = await resolveInboundReply({ from: 'khoa.vo@acme.vn', to: ['support@acme.vn'], text: 'Máy mới hỏng' }, deps)
    expect(fresh.action).to.equal('new_ticket')
  })

  it('ticket đóng quá 7 ngày -> tạo ticket mới tham chiếu ticket cũ', async function () {
    const later = () => new Date('2026-11-30T10:00:00+07:00').getTime()
    const d = await resolveInboundReply({ from: 'khoa.vo@acme.vn', to: to(1044), text: 'Lại kẹt' }, { ...deps, now: later })
    expect(d).to.include({ action: 'new_ticket', relatedTicketUid: 1044 })
  })
})
