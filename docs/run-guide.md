# Hướng dẫn chạy hệ thống (Trudesk + AI Agent + thông báo email)

> Dành cho máy phát triển Windows. Lệnh viết cho PowerShell, chạy ở thư mục gốc repo.
> Kiến trúc và các luồng: xem [ai-agent-expansion.md](ai-agent-expansion.md).

## 0. Thành phần cần có

| Thành phần | Kiểm tra | Ghi chú |
|---|---|---|
| Node.js 16 | `node -v` | Trudesk 1.2.11 chạy Node 16 |
| Docker Desktop + container `trudesk-mongo` | `docker ps` | MongoDB 5, cổng 27017, cấu hình trong `config.yml` |
| Ollama + model `qwen2.5:7b-instruct` | `ollama list` | Cổng 11434. Máy có GPU ≥ 4 GB VRAM thì nhanh hơn nhiều |
| `npm install` đã chạy | có thư mục `node_modules/` | AI Agent dùng chung `node_modules` ở gốc repo |
| Git | `git --version` | |

Elasticsearch không bắt buộc (`config.yml` để trống `elasticsearch`).

## 1. Chạy MongoDB và Ollama

```powershell
docker start trudesk-mongo
ollama list                      # thấy qwen2.5:7b-instruct là được; Ollama chạy nền sau khi cài
```

## 2. Chạy Trudesk Core (terminal 1)

Nếu Trudesk đang chạy sẵn (cổng 8118), dừng nó trước (Ctrl+C ở terminal đó). Biến môi trường phải được đặt **trước** khi khởi động.

```powershell
# Đẩy sự kiện ticket sang AI Agent. Secret phải TRÙNG AI_WEBHOOK_SECRET trong ai-agent/.env
$env:AI_AGENT_WEBHOOK_URL    = 'http://localhost:8200/events'
$env:AI_AGENT_WEBHOOK_SECRET = '<giá trị AI_WEBHOOK_SECRET trong ai-agent/.env>'

# Lần đầu nên chạy thử: email ghi ra logs/mock-mailbox/*.eml thay vì gửi thật.
# Bỏ dòng này khi muốn gửi thật qua SMTP (bước 6).
$env:TICKET_NOTIFY_MAIL_MODE = 'mock'

npm start
```

Mở http://localhost:8118 và đăng nhập bằng tài khoản admin. Nếu terminal in `[aiEventPublisher] forwarding ticket events to http://localhost:8200/events` là Core đã bật chuyển sự kiện sang AI.

## 3. Cấu hình chung trong Trudesk (làm một lần)

1. **Settings → General → Site URL**: `http://localhost:8118` (link "Xem ticket" trong email dùng giá trị này).
2. **Settings → Tickets → Status**: cần có các trạng thái tên `Open`, `Pending`, `Closed` (mặc định đã có). Nếu đặt tên khác, sửa `AI_AUTO_REPLY_*_STATUS` trong `ai-agent/.env`.
3. **Danh mục khớp với AI** (để nút "Áp dụng" trong khu Gợi ý từ AI dùng được). AI gợi ý theo tên trong `ai-agent/mock-data/catalog.json`; giao diện tìm theo **tên** (không phân biệt hoa thường):
   - Settings → Tickets → Ticket Types: tạo `Incident`, `Service Request`, `Problem`, `Change`; mỗi loại gán các mức ưu tiên `Low`, `Normal`, `High`, `Critical` (tạo ở Priorities nếu chưa có).
   - Groups: tạo `Network`, `Access`, `Hardware`, `Email`, `Software`.
   - Muốn dùng tên khác thì sửa `catalog.json` cho trùng với tên trong Trudesk rồi khởi động lại AI Agent. Tên không khớp chỉ làm trường đó hiện mờ; các phần khác vẫn chạy.

## 4. Tạo tài khoản cho AI và lấy access token

1. **Accounts → Create Account**:
   - Username: `ai.assistant` (trùng `AI_BOT_USERNAME`, mặc định là giá trị này)
   - Họ tên: `Trợ lý IT`, email: một địa chỉ bất kỳ không trùng
   - Role: **Support** (cần quyền xem ticket, comment, ghi chú nội bộ, cập nhật ticket)
2. Lấy token. Trang Profile của Trudesk 1.2.11 đã ẩn nút tạo token, nên dùng API có sẵn:
   - Vẫn đăng nhập admin trên trình duyệt, mở **DevTools (F12) → Console**, dán:

   ```js
   const u = await (await fetch('/api/v1/users/ai.assistant')).json()
   const t = await (await fetch('/api/v1/users/' + u.user._id + '/generateapikey', { method: 'POST' })).json()
   console.log(t.token)
   ```

3. Dán token vào `ai-agent/.env`, dòng `TRUDESK_AI_TOKEN=`.

AI chỉ dùng API v1 với header `accesstoken`. API v2 xác thực bằng JWT, và `/api/v2/login`, `/api/v2/token` của bản 1.2.11 có lỗi.

## 5. Chạy AI Agent (terminal 2)

`ai-agent/.env` cần có (đã có mẫu trong [ai-agent/.env.example](../ai-agent/.env.example)):

```ini
AI_PROVIDER=ollama
OLLAMA_MODEL=qwen2.5:7b-instruct
OLLAMA_NUM_CTX=4096
CORE_MODE=http
TRUDESK_URL=http://localhost:8118
TRUDESK_AI_TOKEN=<token ở bước 4>
AI_WEBHOOK_SECRET=<chuỗi bí mật, trùng AI_AGENT_WEBHOOK_SECRET ở bước 2>
AI_AUDIT_LOG=logs/ai-audit.jsonl
```

```powershell
npm run ai-agent
```

Thấy `[ai-agent] listening on :8200 | provider=ollama core=http kb=11 chunks` là chạy đúng. Mỗi sự kiện xử lý xong sẽ in một dòng, ví dụ `[ai-agent] ticket.created #1001 -> suggested, answer 42.3s`.

## 6. Thử hệ thống

### 6.1 Trả lời tự động (chưa cần email thật)

1. Tạo một tài khoản người dùng thường (role **User**, thuộc một Group) rồi đăng nhập bằng tài khoản đó, hoặc tạo ticket ngay bằng admin.
2. Tạo ticket thuộc chủ đề có trong kho tri thức mẫu (`ai-agent/mock-data/`): VPN lỗi 809, tài khoản bị khóa, máy in kẹt giấy, Outlook không gửi/nhận thư. Ví dụ:
   - Tiêu đề: `Không kết nối được VPN từ nhà`
   - Nội dung: `Từ sáng nay em không vào được VPN, báo lỗi 809. Máy laptop Windows 11.`
3. Chờ khoảng 10–90 giây (terminal 2 in kết quả). Mở lại ticket sẽ thấy:
   - comment `Bộ phận IT · Trả lời tự động` của **Trợ lý IT**, trạng thái **Pending**;
   - ghi chú nội bộ "Gợi ý từ AI" (loại, mức ưu tiên, nhóm, nháp);
   - sau 60 giây có file email trong `logs/mock-mailbox/` (mở bằng Outlook để xem).
4. Trả lời ticket bằng tài khoản người tạo:
   - `Em làm theo bước 2 thì vào được rồi, cảm ơn` → AI đóng ticket (**Closed**).
   - `Vẫn lỗi, cho em gặp nhân viên` → AI chuyển nhân viên (**Open**), có ghi chú nội bộ, và từ đó không trả lời thêm.
5. Thử ca không tự trả lời: `Wifi toàn công ty bị sập, khẩn cấp` → chỉ nhận comment `Đã tiếp nhận yêu cầu`.

### 6.2 Gửi email thật qua SMTP

1. **Settings → Mailer**: bật Mailer, rồi điền:
   - Host `smtp.gmail.com`, Port `587`, SSL **tắt** (kết nối tự nâng lên STARTTLS)
   - Username: địa chỉ Gmail của hộp thư helpdesk
   - Password: **mật khẩu ứng dụng** 16 ký tự (không phải mật khẩu Gmail)
   - From: chính địa chỉ đó
   - Bấm nút kiểm tra kết nối trong trang.
2. Dừng Trudesk, chạy lại bước 2 **không có** dòng `TICKET_NOTIFY_MAIL_MODE`.
3. Đặt email của người tạo ticket là địa chỉ bạn đọc được. Mẹo với Gmail: `ten+khach@gmail.com` vẫn về hộp `ten@gmail.com` nhưng là một địa chỉ khác, nên tạo được tài khoản riêng.

### 6.3 Người dùng trả lời bằng email (IMAP)

> **Cảnh báo:** mailCheck biến **mọi thư chưa đọc** trong INBOX thành ticket. Chỉ dùng hộp thư **riêng cho helpdesk**, không dùng Gmail cá nhân.

1. Bật IMAP trong cài đặt Gmail của hộp helpdesk.
2. **Settings → Mailer → Mail Check**: bật, rồi điền:
   - Host `imap.gmail.com`, Port `993`
   - Username và mật khẩu ứng dụng như trên
   - Polling: ví dụ 60000 ms
   - Bật "Create account" nếu muốn người lạ gửi thư cũng tạo được ticket
3. Khi IMAP bật, email thông báo có Reply-To dạng `helpdesk+t1001.<chữ ký>@gmail.com`. Người dùng bấm Reply thì thư thành comment của đúng ticket, và luồng 6.1 bước 4 chạy tương tự.

## 7. Chạy thử không cần Trudesk / MongoDB

```powershell
npm run test:unit                       # 64 test
npm run demo:auto-reply                 # AI tự trả lời với Ollama thật, dữ liệu mock
npm run demo:e2e                        # agent duyệt nháp, thông báo web + email (mock)
node demo/send-real-email.js --to <email>   # gửi 1 email thật qua Gmail (GMAIL_USER, GMAIL_APP_PASSWORD trong ai-agent/.env)
```

## 8. Kịch bản thử từng chức năng

Chuẩn bị: đã làm xong bước 1–5. Tạo thêm một người dùng thử, ví dụ `khach`, role **User**, cho vào một Group (Groups → thêm thành viên). Dùng email đọc được, vd `ten+khach@gmail.com`. Đăng nhập `khach` bằng **cửa sổ ẩn danh** để vừa đóng vai khách vừa đóng vai admin.

| # | Chức năng | Làm gì | Kết quả mong đợi |
|---|---|---|---|
| 1 | AI phân loại, gợi ý cho nhân viên | `khach` tạo ticket bất kỳ; admin mở ticket đó | Sau 10–90 giây, cột trái có khu **Gợi ý từ AI** (icon bóng đèn): loại, mức ưu tiên, nhóm kèm % tin cậy, tag, ticket tương tự, nháp. Chỉ nhân viên thấy; khu tự hiện, không cần tải lại trang |
| 1b | Duyệt gợi ý | Trong khu Gợi ý từ AI: tick các trường muốn dùng → **Áp dụng đã chọn** (hoặc **Bỏ qua**) | Type / Priority / Group của ticket đổi theo; Ticket History có dòng "Duyệt gợi ý AI: áp dụng …"; khu gợi ý biến mất. Trường AI gợi ý mà hệ thống không có (vd loại "Incident" khi Trudesk chỉ có "Issue/Task") hiện mờ, ghi "không có trong hệ thống" |
| 1c | Dùng nháp của AI | Bấm **Xem** để đọc nháp → **Chèn nháp vào ô Comment** | Nháp được đổ vào ô Comment để sửa; nhân viên tự bấm Post Comment. Khi bấm Áp dụng, việc dùng nháp được ghi lại |
| 2 | AI tự trả lời | `khach` tạo: *Không kết nối được VPN từ nhà / Từ sáng nay em không vào được VPN, báo lỗi 809* | Comment của Trợ lý IT có huy hiệu viền xanh, icon tai nghe, chữ **Bộ phận IT · Trả lời tự động**, kèm các bước khắc phục và nguồn KB; trạng thái **Pending**. Khu Gợi ý từ AI ghi "AI đã tự trả lời người dùng" |
| 3 | Không tự trả lời ca rủi ro | `khach` tạo: *Wifi toàn công ty bị sập, khẩn cấp* (Critical); hoặc *Xin cấp quyền thư mục dự án* (Service Request) | Chỉ comment **Đã tiếp nhận yêu cầu**, ticket giữ **Open**, nháp nằm trong ghi chú nội bộ chờ nhân viên |
| 4a | Người dùng xác nhận đã xong | Ở ticket #2, `khach` trả lời *Em làm theo bước 2 thì vào được rồi, cảm ơn* | Comment **Đã đóng ticket**; trạng thái **Closed** |
| 4b | Người dùng cần người thật | Tạo lại ticket VPN; khi AI trả lời, `khach` viết *Vẫn lỗi, cho em gặp nhân viên* | Comment **Đã chuyển nhân viên xử lý**; trạng thái **Open**; ghi chú nội bộ tóm tắt cho nhân viên. AI không trả lời thêm ở ticket này |
| 5 | AI nhường nhân viên | Ở ticket đã được AI trả lời, admin comment trước, sau đó `khach` trả lời | AI không can thiệp (terminal 2 in `ignored`) |
| 6 | Thông báo web | `khach` mở trang danh sách ticket (không mở ticket đó); admin trả lời ticket của `khach` | Góc dưới phải màn hình `khach` hiện **toast** "Ticket #… có phản hồi mới - tên người trả lời" kèm đoạn đầu nội dung và nút **XEM** (mở ticket). Chuông thông báo cũng có mục mới. Đang mở đúng ticket thì không hiện toast vì comment đã tự cập nhật |
| 7 | Thông báo email | Như #6, chế độ `mock` | Sau 60 giây có file `.eml` trong `logs/mock-mailbox/`; mở bằng Outlook thấy icon, tiêu đề `[Ticket #…] Re: …`, link xem ticket |
| 8 | Gộp email | Admin gửi 2 comment liên tiếp trong vòng 60 giây | `khach` nhận **1** email "Ticket của bạn có 2 phản hồi mới" |
| 9 | Ghi chú nội bộ không lộ ra ngoài | Admin thêm Internal Note | `khach` không nhận gì; nhân viên khác theo dõi ticket nhận chuông |
| 10 | Chọn kênh nhận | `khach` vào **Profile → Preferences → Thông báo phản hồi ticket**, chọn **Chỉ trên web**, bấm Save Preferences; admin trả lời ticket | `khach` chỉ có toast + chuông, **không** có email. Thử tương tự "Chỉ email", "Không nhận"; ô "Không gửi email khi tôi đang mở web" chỉ bật được khi chọn "Web và email" |
| 11 | Email thật | Bước 6.2 | Email về hộp Gmail, Reply-To dạng `…+t<số ticket>.<chữ ký>@…` |
| 12 | Trả lời bằng email | Bước 6.3 (chỉ với hộp thư riêng) | Thư trả lời thành comment của đúng ticket; ticket đóng trong vòng 7 ngày thì được mở lại |

Sau mỗi lần cập nhật code giao diện: build lại bằng `npm run webpackdist` (khoảng 1–2 phút), khởi động lại Trudesk, rồi tải lại trình duyệt bằng **Ctrl+F5** để bỏ bản cũ trong cache.

Xem AI đã quyết định gì (vì sao tự trả lời hay không):

```powershell
Select-String '"kind":"auto_reply"' logs\ai-audit.jsonl | Select-Object -Last 5 | ForEach-Object { $_.Line }
Select-String '"kind":"follow_up"'  logs\ai-audit.jsonl | Select-Object -Last 5 | ForEach-Object { $_.Line }
```

Trường `failed` liệt kê các cổng không qua, ví dụ `priority-allowed: Critical` hoặc `grounded: … điểm 0.21`.

AI chỉ trả lời được các chủ đề có trong kho tri thức mẫu (`ai-agent/mock-data/kb-articles.json`, `closed-tickets.json`): VPN lỗi 809, tài khoản bị khóa, máy in kẹt giấy, xin quyền thư mục, Outlook. Muốn AI trả lời thêm chủ đề khác thì bổ sung bài vào hai file đó, rồi khởi động lại AI Agent.

## 9. Xử lý sự cố

| Hiện tượng | Nguyên nhân thường gặp | Cách xử lý |
|---|---|---|
| `[ai-agent] Không khởi động được: … TRUDESK_AI_TOKEN is required` | Chưa điền token | Làm bước 4 |
| Tạo ticket xong terminal 2 không in gì | Core chạy thiếu `AI_AGENT_WEBHOOK_URL`, hoặc AI Agent chưa chạy | Kiểm tra dòng `[aiEventPublisher] forwarding…` ở terminal 1; Core log `not delivered` nghĩa là AI Agent chưa chạy |
| AI nhận 401 khi gọi Trudesk | Token sai, hoặc tài khoản AI bị khóa/xóa | Tạo lại token (bước 4) |
| Core nhận 401 từ `/events` | `AI_AGENT_WEBHOOK_SECRET` (Core) khác `AI_WEBHOOK_SECRET` (AI) | Đặt hai giá trị giống nhau rồi khởi động lại cả hai |
| `-> skipped (network)` hoặc `timeout` | Ollama chưa chạy, hoặc model quá chậm | `ollama list`; giữ `OLLAMA_NUM_CTX=4096` |
| Ticket chỉ nhận "Đã tiếp nhận yêu cầu" | Không qua 9 cổng: không có tài liệu khớp, Critical, Service Request… | Xem `logs/ai-audit.jsonl`, dòng `"kind":"auto_reply"`, trường `failed` |
| `set status Pending: status … không tồn tại` (audit) | Tên trạng thái khác `Open` / `Pending` / `Closed` | Sửa `AI_AUTO_REPLY_PENDING_STATUS`… trong `ai-agent/.env` |
| Không có email | Mailer tắt; đang chạy chế độ `mock`; email gửi sau 60 giây gộp tin; người nhận chọn kênh `web` | Kiểm tra Settings → Mailer, biến `TICKET_NOTIFY_MAIL_MODE`, thư mục `logs/mock-mailbox/` |
| Gmail báo `535 … Username and Password not accepted` | Dùng mật khẩu Gmail thường | Tạo mật khẩu ứng dụng (cần bật xác minh 2 bước) |
| Muốn tắt hoàn toàn | | Bỏ `AI_AGENT_WEBHOOK_URL` khi chạy Core; đặt `TICKET_REPLY_NOTIFY=legacy` để dùng thông báo cũ |
