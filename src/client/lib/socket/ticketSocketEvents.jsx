/* global History */
import React, { useEffect } from 'react'
import { useSelector } from 'react-redux'
import { TICKETS_CREATED, TICKETS_REPLY_NOTIFY } from 'serverSocket/socketEventConsts'
import helpers from 'lib/helpers'
import { escapeHtml } from 'lib2/aiReply'

const TicketSocketEvents = () => {
  const socket = useSelector(state => state.shared.socket)
  const viewdata = useSelector(state => state.common.viewdata)

  useEffect(() => {
    if (socket) {
      ticketCreated()
      ticketReply()
    }

    return function cleanup () {
      if (socket) {
        socket.removeAllListeners(TICKETS_CREATED)
        socket.removeAllListeners(TICKETS_REPLY_NOTIFY)
      }
    }
  }, [socket, viewdata])

  const ticketCreated = () => {
    socket.removeAllListeners(TICKETS_CREATED)
    socket.on(TICKETS_CREATED, ticket => {
      if (viewdata) {
        if (viewdata.get('ticketSettings') && viewdata.get('ticketSettings').get('playNewTicketSound'))
          helpers.UI.playSound('TICKET_CREATED')
      } else {
        helpers.UI.playSound('TICKET_CREATED')
      }
    })
  }

  // Phản hồi mới ở ticket mình tạo / được giao / theo dõi (gửi riêng từ src/notifications/ticketReply).
  // Đang mở đúng ticket đó thì không hiện, vì comment đã tự cập nhật trên màn hình.
  const ticketReply = () => {
    socket.removeAllListeners(TICKETS_REPLY_NOTIFY)
    socket.on(TICKETS_REPLY_NOTIFY, data => {
      if (!data || !data.ticketUid) return
      if (window.location.pathname === `/tickets/${data.ticketUid}`) return

      const preview = data.preview ? `<br><span style="opacity:.8">${escapeHtml(data.preview)}</span>` : ''
      helpers.UI.showSnackbar({
        text: `<strong>${escapeHtml(data.title)}</strong> - ${escapeHtml(data.author)}${preview}`,
        actionText: 'XEM',
        actionTextColor: '#4CAF50',
        duration: 8000,
        pos: 'bottom-right',
        onActionClick: element => {
          element.style.opacity = 0
          History.pushState(null, null, `/tickets/${data.ticketUid}`)
        }
      })
    })
  }

  return <div />
}

export default TicketSocketEvents
