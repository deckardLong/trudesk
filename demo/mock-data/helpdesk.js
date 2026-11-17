/*
 * Mock data dùng chung cho demo và test (không cần MongoDB).
 * Mô phỏng: 1 công ty, 2 nhân viên IT, 3 người dùng cuối với các tùy chọn nhận thông báo khác nhau.
 */

const users = [
  {
    // Tài khoản dịch vụ của AI Agent (role support). Không nhận thông báo.
    _id: 'u-ai-bot',
    username: 'ai.assistant',
    fullname: 'Trợ lý IT',
    email: 'ai.assistant@acme.vn',
    isStaff: true,
    isBot: true,
    preferences: { notifications: { channel: 'none' } }
  },
  {
    _id: 'u-agent-minh',
    username: 'minh.nguyen',
    fullname: 'Nguyễn Văn Minh',
    email: 'minh.nguyen@acme.vn',
    isStaff: true,
    preferences: { notifications: { channel: 'both' } }
  },
  {
    _id: 'u-agent-lan',
    username: 'lan.tran',
    fullname: 'Trần Thị Lan',
    email: 'lan.tran@acme.vn',
    isStaff: true,
    preferences: { notifications: { channel: 'web' } }
  },
  {
    // Người dùng mặc định: nhận cả web lẫn email
    _id: 'u-user-hoa',
    username: 'hoa.le',
    fullname: 'Lê Thị Hoa',
    email: 'hoa.le@acme.vn',
    isStaff: false,
    preferences: { notifications: { channel: 'both' } }
  },
  {
    // Gửi ticket qua email, chưa từng đăng nhập web -> chỉ nhận email
    _id: 'u-user-tuan',
    username: 'tuan.pham@partner.com',
    fullname: 'Phạm Anh Tuấn',
    email: 'tuan.pham@partner.com',
    isStaff: false,
    hasWebAccess: false,
    preferences: {}
  },
  {
    // Đang online thì không cần email
    _id: 'u-user-khoa',
    username: 'khoa.vo',
    fullname: 'Võ Đăng Khoa',
    email: 'khoa.vo@acme.vn',
    isStaff: false,
    preferences: { notifications: { channel: 'both', skipEmailWhenOnline: true } }
  },
  {
    _id: 'u-user-old',
    username: 'old.user',
    fullname: 'Tài khoản đã nghỉ việc',
    email: 'old.user@acme.vn',
    isStaff: false,
    deleted: true,
    preferences: {}
  }
]

const statuses = {
  open: { _id: 's-open', uid: 1, name: 'Open', isResolved: false },
  pending: { _id: 's-pending', uid: 2, name: 'Pending', isResolved: false },
  closed: { _id: 's-closed', uid: 3, name: 'Closed', isResolved: true }
}

const tickets = [
  {
    _id: 't-1042',
    uid: 1042,
    subject: 'Không kết nối được VPN từ nhà',
    issue: 'Từ sáng nay em không vào được VPN, báo lỗi 809. Máy laptop Dell, Windows 11.',
    owner: 'u-user-hoa',
    assignee: 'u-agent-minh',
    subscribers: ['u-user-hoa', 'u-agent-minh', 'u-agent-lan', 'u-user-old'],
    status: statuses.open,
    comments: [],
    notes: []
  },
  {
    _id: 't-1043',
    uid: 1043,
    subject: 'Xin cấp quyền thư mục dự án Alpha',
    issue: 'Nhờ IT cấp quyền đọc/ghi thư mục \\\\fileserver\\projects\\alpha cho tôi.',
    owner: 'u-user-tuan',
    assignee: 'u-agent-lan',
    subscribers: ['u-user-tuan', 'u-agent-lan'],
    status: statuses.open,
    comments: [],
    notes: []
  },
  {
    _id: 't-1044',
    uid: 1044,
    subject: 'Máy in tầng 3 kẹt giấy liên tục',
    issue: 'Máy in HP tầng 3 cứ in 2-3 tờ là kẹt.',
    owner: 'u-user-khoa',
    assignee: 'u-agent-minh',
    subscribers: ['u-user-khoa', 'u-agent-minh'],
    status: statuses.closed,
    closedDate: new Date('2026-11-14T09:00:00+07:00'),
    comments: [],
    notes: []
  }
]

function userMap () {
  return new Map(users.map(u => [u._id, { ...u }]))
}

function cloneTicket (uid) {
  const t = tickets.find(x => x.uid === uid)
  return JSON.parse(JSON.stringify(t), (k, v) => (k === 'closedDate' && v ? new Date(v) : v))
}

/** Gắn thông tin user (email) vào owner/assignee/subscribers như Ticket.getTicketByUid() của Trudesk. */
function populateTicket (ticket) {
  const map = userMap()
  const pop = id => {
    const u = map.get(id)
    return u ? { _id: u._id, email: u.email, fullname: u.fullname, username: u.username } : null
  }
  return {
    ...ticket,
    owner: pop(ticket.owner),
    assignee: pop(ticket.assignee),
    subscribers: ticket.subscribers.map(pop).filter(Boolean)
  }
}

module.exports = { users, statuses, tickets, userMap, cloneTicket, populateTicket }
