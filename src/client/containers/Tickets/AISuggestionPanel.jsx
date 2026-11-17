/*
 * Khu "Gợi ý từ AI" trong màn hình ticket (sơ đồ 6, Cách 1: agent duyệt khi xem ticket).
 *
 * - Lấy gợi ý còn hiệu lực: GET /api/v2/tickets/:uid/ai-suggestions; tự tải lại khi có TICKETS_AI_SUGGESTION_UPDATE.
 * - Áp dụng từng trường bằng các socket event CÓ SẴN của Trudesk (TICKETS_TYPE_SET, ...), lần lượt từng cái:
 *   chờ server xác nhận (TICKETS_UI_*_UPDATE) rồi mới gửi cái tiếp theo, vì mỗi handler đọc-sửa-lưu cùng
 *   một ticket, gửi đồng thời dễ ghi đè nhau.
 * - Ghi kết quả duyệt: PUT /api/v2/ai-suggestions/:id (lịch sử ticket ghi "Duyệt gợi ý AI ...").
 * - Nháp trả lời: chèn vào ô Comment để agent sửa rồi tự bấm gửi; AI không bao giờ gửi thay.
 */

import React from 'react'
import PropTypes from 'prop-types'
import axios from 'axios'

import {
  TICKETS_AI_SUGGESTION_UPDATE,
  TICKETS_TYPE_SET,
  TICKETS_UI_TYPE_UPDATE,
  TICKETS_PRIORITY_SET,
  TICKETS_UI_PRIORITY_UPDATE,
  TICKETS_GROUP_SET,
  TICKETS_UI_GROUP_UPDATE
} from 'serverSocket/socketEventConsts'

import helpers from 'lib/helpers'
import Log from '../../logger'

const FIELD_LABELS = { type: 'Loại', priority: 'Mức ưu tiên', group: 'Nhóm' }
const AUTO_INFO = {
  answer: { icon: 'headset_mic', text: 'AI đã tự trả lời người dùng (xem comment bên phải).' },
  ack: { icon: 'assignment_turned_in', text: 'AI đã gửi xác nhận tiếp nhận; ticket chờ nhân viên xử lý.' }
}

const lower = s => String(s || '').toLowerCase()
const pct = n => Math.round((n || 0) * 100) + '%'
const confColor = n => (n >= 0.85 ? '#2f855a' : n >= 0.7 ? '#b7791f' : '#c53030')

function findByName (list, name) {
  if (!list) return null
  return list.find(i => lower(i.get ? i.get('name') : i.name) === lower(name)) || null
}

function idOf (item) {
  return item ? (item.get ? item.get('_id') : item._id) : null
}

class AISuggestionPanel extends React.Component {
  constructor (props) {
    super(props)
    this.state = { suggestion: null, checked: {}, usedDraft: false, busy: false, showDraft: false }
    this.onSocketUpdate = this.onSocketUpdate.bind(this)
  }

  componentDidMount () {
    this.props.socket.on(TICKETS_AI_SUGGESTION_UPDATE, this.onSocketUpdate)
    this.fetch()
  }

  componentWillUnmount () {
    this.props.socket.off(TICKETS_AI_SUGGESTION_UPDATE, this.onSocketUpdate)
    this.unmounted = true
  }

  onSocketUpdate (data) {
    if (data && String(data.ticketId) === String(this.props.ticket._id)) this.fetch()
  }

  fetch () {
    axios
      .get(`/api/v2/tickets/${this.props.ticket.uid}/ai-suggestions`)
      .then(res => {
        if (this.unmounted) return
        const suggestion = res.data && res.data.suggestion
        this.setState({ suggestion, checked: this.defaultChecked(suggestion), usedDraft: false })
      })
      .catch(err => Log.error(err))
  }

  /** Dòng gợi ý cho từng trường: giá trị, độ tin cậy, có ánh xạ được sang dữ liệu thật không. */
  rows (suggestion, checked) {
    if (!suggestion || !suggestion.fields) return []
    const { ticket, ticketTypes, groups } = this.props
    const rows = []

    const typeF = suggestion.fields.type
    const resolvedType = typeF ? findByName(ticketTypes, typeF.value) : null
    const typeWillChange = !!(checked && checked.type && resolvedType)
    const prioritySource = typeWillChange ? resolvedType.get('priorities') : ticket.type && ticket.type.priorities

    const resolve = {
      type: v => findByName(ticketTypes, v),
      priority: v => findByName(prioritySource, v),
      group: v => findByName(groups, v)
    }

    for (const key of ['type', 'priority', 'group']) {
      const f = suggestion.fields[key]
      if (!f || f.decision === 'dropped') continue
      const target = resolve[key](f.value)
      const current = ticket[key] && ticket[key].name
      const same = lower(current) === lower(f.value)
      rows.push({
        key,
        value: f.value,
        confidence: f.confidence,
        current,
        targetId: idOf(target),
        same,
        disabled: !target || same,
        note: !target ? 'không có trong hệ thống' : same ? 'trùng giá trị hiện tại' : null
      })
    }
    return rows
  }

  defaultChecked (suggestion) {
    const checked = {}
    for (const r of this.rows(suggestion, {})) checked[r.key] = !r.disabled && r.confidence >= 0.7
    return checked
  }

  /** Gửi socket event rồi chờ server phát sự kiện cập nhật tương ứng (tối đa 5 giây). */
  emitAndWait (setEvent, updateEvent, value) {
    const { socket, ticket } = this.props
    return new Promise(resolve => {
      let done = false
      const handler = data => {
        if (data && String(data._id) === String(ticket._id) && !done) {
          done = true
          socket.off(updateEvent, handler)
          resolve(true)
        }
      }
      socket.on(updateEvent, handler)
      socket.emit(setEvent, { _id: ticket._id, value })
      setTimeout(() => {
        if (!done) {
          done = true
          socket.off(updateEvent, handler)
          resolve(false)
        }
      }, 5000)
    })
  }

  // Không dùng async/await: bundle giao diện không nạp regeneratorRuntime cho file .jsx
  apply () {
    const { suggestion, checked, usedDraft } = this.state
    const rows = this.rows(suggestion, checked).filter(r => checked[r.key] && !r.disabled)
    const byKey = {}
    rows.forEach(r => (byKey[r.key] = r))
    this.setState({ busy: true })

    const steps = []
    if (byKey.type) {
      steps.push(() => this.emitAndWait(TICKETS_TYPE_SET, TICKETS_UI_TYPE_UPDATE, byKey.type.targetId))
      // Loại mới không có mức ưu tiên hiện tại và agent không chọn mức ưu tiên AI gợi ý -> về mức đầu tiên của loại
      if (!byKey.priority) {
        const newType = findByName(this.props.ticketTypes, byKey.type.value)
        const priorities = newType ? newType.get('priorities') : null
        const curP = this.props.ticket.priority && this.props.ticket.priority._id
        if (priorities && priorities.size && !priorities.find(p => p.get('_id') === curP)) {
          const firstId = priorities.first().get('_id')
          steps.push(() => this.emitAndWait(TICKETS_PRIORITY_SET, TICKETS_UI_PRIORITY_UPDATE, firstId))
        }
      }
    }
    if (byKey.priority) {
      steps.push(() => this.emitAndWait(TICKETS_PRIORITY_SET, TICKETS_UI_PRIORITY_UPDATE, byKey.priority.targetId))
    }
    if (byKey.group) steps.push(() => this.emitAndWait(TICKETS_GROUP_SET, TICKETS_UI_GROUP_UPDATE, byKey.group.targetId))
    steps.push(() =>
      axios.put(`/api/v2/ai-suggestions/${suggestion._id}`, { acceptedFields: rows.map(r => r.key), usedDraft })
    )

    steps
      .reduce((chain, step) => chain.then(step), Promise.resolve())
      .then(() => {
        helpers.UI.showSnackbar(rows.length || usedDraft ? 'Đã áp dụng gợi ý AI' : 'Đã bỏ qua gợi ý AI')
        if (!this.unmounted) this.setState({ suggestion: null })
      })
      .catch(err => {
        Log.error(err)
        const msg = (err.response && err.response.data && err.response.data.error) || err.message
        helpers.UI.showSnackbar('Không áp dụng được gợi ý: ' + msg, true)
      })
      .then(() => {
        if (!this.unmounted) this.setState({ busy: false })
      })
  }

  dismiss () {
    const { suggestion } = this.state
    this.setState({ busy: true })
    axios
      .put(`/api/v2/ai-suggestions/${suggestion._id}`, { acceptedFields: [], usedDraft: false, rejectReason: 'Agent bỏ qua' })
      .then(() => {
        helpers.UI.showSnackbar('Đã bỏ qua gợi ý AI')
        this.setState({ suggestion: null })
      })
      .catch(err => {
        Log.error(err)
        helpers.UI.showSnackbar('Không lưu được: ' + err.message, true)
      })
      .then(() => !this.unmounted && this.setState({ busy: false }))
  }

  insertDraft () {
    this.props.onInsertDraft(this.state.suggestion.replyDraft.text)
    this.setState({ usedDraft: true })
    helpers.UI.showSnackbar('Đã chèn nháp vào ô Comment. Kiểm tra lại trước khi gửi.')
  }

  render () {
    const { suggestion, checked, busy, usedDraft, showDraft } = this.state
    if (!suggestion) return null

    const rows = this.rows(suggestion, checked)
    const tags = suggestion.fields && suggestion.fields.tags && suggestion.fields.tags.decision !== 'dropped' ? suggestion.fields.tags.value : []
    const draft = suggestion.replyDraft
    const auto = suggestion.autoReply && suggestion.autoReply.sent ? AUTO_INFO[suggestion.autoReply.kind] : null
    const canApply = rows.some(r => checked[r.key] && !r.disabled) || usedDraft

    return (
      <div className='uk-width-1-1 padding-left-right-15'>
        <div className='tru-card ticket-details uk-clearfix ai-suggestion-panel' style={{ borderTop: '3px solid #6f42c1' }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
            <i className='material-icons' style={{ color: '#6f42c1', fontSize: 20, marginRight: 6 }}>
              lightbulb
            </i>
            <strong style={{ fontSize: 14 }}>Gợi ý từ AI</strong>
            {suggestion.expiresAt && (
              <span style={{ marginLeft: 'auto', fontSize: 11, color: '#888' }}>
                hết hạn {helpers.calendarDate(suggestion.expiresAt)}
              </span>
            )}
          </div>

          {auto && (
            <div style={{ display: 'flex', alignItems: 'center', fontSize: 12, color: '#555', marginBottom: 8 }}>
              <i className='material-icons' style={{ fontSize: 16, marginRight: 4, color: '#2b5ea7' }}>
                {auto.icon}
              </i>
              {auto.text}
            </div>
          )}

          {rows.map(r => (
            <label
              key={r.key}
              style={{ display: 'flex', alignItems: 'center', fontSize: 13, margin: '4px 0', opacity: r.disabled ? 0.55 : 1 }}
              title={r.current ? `Hiện tại: ${r.current}` : ''}
            >
              <input
                type='checkbox'
                style={{ marginRight: 6 }}
                disabled={r.disabled || busy}
                checked={!!checked[r.key] && !r.disabled}
                onChange={e => this.setState({ checked: Object.assign({}, checked, { [r.key]: e.target.checked }) })}
              />
              <span style={{ width: 82, color: '#777' }}>{FIELD_LABELS[r.key]}</span>
              <strong>{r.value}</strong>
              <span style={{ marginLeft: 'auto', fontSize: 11, color: confColor(r.confidence) }}>{pct(r.confidence)}</span>
              {r.note && <span style={{ display: 'block', fontSize: 11, color: '#999', marginLeft: 6 }}>({r.note})</span>}
            </label>
          ))}

          {tags && tags.length > 0 && (
            <div style={{ fontSize: 12, margin: '6px 0' }}>
              <span style={{ color: '#777' }}>Tag gợi ý: </span>
              {tags.map(t => (
                <span key={t} className='uk-badge uk-badge-small' style={{ marginRight: 4, background: '#e2d9f3', color: '#4a2a86' }}>
                  {t}
                </span>
              ))}
            </div>
          )}

          {suggestion.similarTickets && suggestion.similarTickets.length > 0 && (
            <div style={{ fontSize: 12, margin: '6px 0' }}>
              <span style={{ color: '#777' }}>Ticket tương tự: </span>
              {suggestion.similarTickets.map(s => (
                <a key={s.ref} href={`/tickets/${String(s.ref).replace('#', '')}`} style={{ marginRight: 6 }}>
                  {s.ref} ({s.relation === 'duplicate' ? 'trùng' : 'liên quan'})
                </a>
              ))}
            </div>
          )}

          {suggestion.summary && suggestion.summary.text && (
            <div style={{ fontSize: 12, margin: '6px 0', padding: 6, background: '#f6f8fb', borderRadius: 3 }}>
              <strong>Tóm tắt: </strong>
              {suggestion.summary.text}
            </div>
          )}

          {draft && draft.decision === 'pending' && (
            <div style={{ margin: '8px 0' }}>
              <div style={{ display: 'flex', alignItems: 'center', fontSize: 12 }}>
                <span style={{ color: '#777' }}>
                  Nháp trả lời ({pct(draft.confidence)}; nguồn {(draft.citations || []).join(', ') || '—'})
                </span>
                <a role='button' style={{ marginLeft: 'auto' }} onClick={() => this.setState({ showDraft: !showDraft })}>
                  {showDraft ? 'Thu gọn' : 'Xem'}
                </a>
              </div>
              {showDraft && (
                <div
                  style={{
                    whiteSpace: 'pre-wrap',
                    fontSize: 12,
                    maxHeight: 180,
                    overflowY: 'auto',
                    padding: 6,
                    marginTop: 4,
                    background: '#f6f8fb',
                    borderRadius: 3
                  }}
                >
                  {draft.text}
                </div>
              )}
              <button
                type='button'
                className='uk-button uk-button-small'
                style={{ marginTop: 6 }}
                disabled={busy}
                onClick={() => this.insertDraft()}
              >
                <i className='material-icons' style={{ fontSize: 16, verticalAlign: 'middle', marginRight: 4 }}>
                  edit
                </i>
                {usedDraft ? 'Đã chèn vào ô Comment' : 'Chèn nháp vào ô Comment'}
              </button>
            </div>
          )}

          <div style={{ display: 'flex', marginTop: 10 }}>
            <button
              type='button'
              className='uk-button uk-button-small uk-button-accent'
              disabled={busy || !canApply}
              onClick={() => this.apply()}
            >
              <i className='material-icons' style={{ fontSize: 16, verticalAlign: 'middle', marginRight: 4 }}>
                done
              </i>
              Áp dụng đã chọn
            </button>
            <button type='button' className='uk-button uk-button-small' style={{ marginLeft: 6 }} disabled={busy} onClick={() => this.dismiss()}>
              Bỏ qua
            </button>
          </div>
        </div>
      </div>
    )
  }
}

AISuggestionPanel.propTypes = {
  ticket: PropTypes.object.isRequired,
  ticketTypes: PropTypes.object,
  groups: PropTypes.object,
  socket: PropTypes.object.isRequired,
  onInsertDraft: PropTypes.func.isRequired
}

export default AISuggestionPanel
