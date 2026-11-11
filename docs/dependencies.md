# Thư viện và module cần thiết để chạy hệ thống

> Tài liệu này dựa trên việc **đã thực sự cài đặt và chạy** Trudesk trên Windows (xem log quá trình trong lịch sử trao đổi), không chỉ chép lại README — nên các con số version và lưu ý sự cố ở đây đã được xác minh thật, chính xác hơn tài liệu gốc của dự án.

## 1. Yêu cầu bắt buộc (không thể thiếu)

| Thành phần | Version đã xác nhận hoạt động | Ghi chú |
|---|---|---|
| **Node.js** | **16.20.2** | ⚠️ README ghi "Node 16+" nhưng **sai** — Node 18 và Node 24 đều **không chạy được** vì `node-sass@7.0.1` build thành công nhưng runtime từ chối (`unsupportedEnvironment`) do không nhận diện ABI của Node 18/24. Phải dùng đúng Node 16.x |
| **MongoDB** | 5.0 | Dùng image `mongo:5.0-focal` nếu chạy qua Docker. Yêu cầu **có user/password thật** — URI với username/password rỗng khiến driver cố xác thực và thất bại |
| **Yarn** | 3.2.1 | Cài qua **Corepack** (đi kèm Node), không cài global `npm install -g yarn` |
| **Python** | 3.11.x | Cần cho `node-gyp` biên dịch module native. Python 3.12+ cũng có thể dùng được nhưng chưa xác minh với bản này |

## 2. Yêu cầu bắt buộc chỉ trên Windows

| Thành phần | Vì sao cần |
|---|---|
| **Visual Studio 2022** (hoặc Build Tools), workload **"Desktop development with C++"** | `node-gyp` cần trình biên dịch C++ (MSVC) để build `bcrypt`, `node-sass` |
| **Windows SDK** (ví dụ `Windows11SDK.22621`) | Đây là phần **hay bị thiếu nhất** — có VS với C++ toolset vẫn báo lỗi `could not find any Windows SDK` nếu không cài riêng component này qua Visual Studio Installer |

Trên Linux/macOS, tương đương là `build-essential` (Debian/Ubuntu) hoặc Xcode Command Line Tools (macOS) — chưa được xác minh trực tiếp trong lần triển khai này.

## 3. Tùy chọn (hệ thống vẫn chạy nếu bỏ qua)

| Thành phần | Dùng để | Nếu không có |
|---|---|---|
| **Elasticsearch 8** | Tìm kiếm ticket toàn văn (xem [docs/system-architecture.md](system-architecture.md) mục 9) | Tính năng tìm kiếm qua ES tắt, các chức năng khác không ảnh hưởng |
| **SMTP server** | Gửi email thông báo | Hệ thống chạy, chỉ không gửi được email (`mailer:enable` tắt) |
| **Docker** | Chạy MongoDB/Elasticsearch không cần cài trực tiếp vào máy | Có thể cài MongoDB trực tiếp vào hệ điều hành thay thế |

## 4. Thư viện chính trong `package.json`, theo nhóm chức năng

### Lớp máy chủ và định tuyến
| Thư viện | Vai trò |
|---|---|
| `express` | Framework web chính |
| `express-hbs`, `handlebars` | Template HTML phía server (trang login, install, email) |
| `express-session`, `connect-mongo` | Quản lý phiên đăng nhập, lưu session trong MongoDB |
| `cookie-parser`, `cookie-signature` | Xử lý cookie |
| `csrf` | Chống giả mạo yêu cầu (CSRF) |
| `compression`, `express-static-gzip` | Nén response |
| `socket.io`, `socket.io-client` | Giao tiếp thời gian thực |

### Cơ sở dữ liệu
| Thư viện | Vai trò |
|---|---|
| `mongoose` | ORM cho MongoDB |
| `mongoose-autopopulate`, `mongoose-lean-virtuals` | Plugin mở rộng cho Mongoose |
| `@elastic/elasticsearch` | Client Elasticsearch 8 |
| `redis` | Có trong dependency nhưng [theo câu hỏi trước](../docs/system-architecture.md), cấu hình thật trong `src/cache/rediscache.js` đang **hard-code địa chỉ cục bộ**, gần như code chết |

### Xác thực và bảo mật
| Thư viện | Vai trò |
|---|---|
| `passport`, `passport-local`, `passport-http`, `passport-jwt`, `passport-totp`, `passport.socketio` | Các chiến lược đăng nhập: form, HTTP Basic, JWT (API), TOTP (MFA), Socket.io |
| `bcrypt` | Hash mật khẩu — **module native, cần build** |
| `jsonwebtoken` | Sinh/kiểm JWT cho API v2 |
| `ldapjs` | Tích hợp LDAP |
| `rate-limiter-flexible` | Giới hạn số request |
| `check-password-strength` | Kiểm độ mạnh mật khẩu |
| `svg-captcha` | CAPTCHA cho form công khai |
| `sanitize-html`, `xss` | Lọc nội dung HTML nguy hiểm |

### Email
| Thư viện | Vai trò |
|---|---|
| `nodemailer` | Gửi email qua SMTP |
| `email-templates` | Render template email (kết hợp Handlebars) |
| `imap`, `mailparser` | Đọc và phân tích email để tạo ticket tự động (`mailCheck.js`) |

### Xử lý ticket, báo cáo, file
| Thư viện | Vai trò |
|---|---|
| `marked` | Chuyển Markdown sang HTML (nội dung ticket) |
| `csv`, `fast-csv` | Xuất báo cáo CSV (xem câu hỏi "Generate Report") |
| `pdfkit` | Xuất ticket ra PDF |
| `archiver`, `adm-zip`, `unzipper`, `tar` | Nén/giải nén (sao lưu, import) |
| `busboy` | Xử lý upload file dạng multipart |

### Giao diện (client-side)
| Thư viện | Vai trò |
|---|---|
| `react`, `react-dom` | Thư viện UI chính (v17, cũ hơn bản mới nhất) |
| `redux`, `react-redux`, `redux-saga` | Quản lý trạng thái và tác vụ bất đồng bộ |
| `mobx`, `mobx-react` | Quản lý trạng thái (dùng ở một số phần khác, song song với Redux) |
| `react-markdown`, `remark-gfm`, `rehype-raw` | Render Markdown trong giao diện |
| `moment`, `moment-timezone` | Xử lý ngày giờ |

### Hạ tầng và vận hành
| Thư viện | Vai trò |
|---|---|
| `pm2` | Giữ tiến trình Node sống, dùng trong `runner.js` |
| `winston` | Ghi log |
| `nconf`, `nconf-yaml`, `yaml` | Đọc cấu hình từ `config.yml` |

## 5. Module cần biên dịch native (hay gây lỗi nhất khi cài)

| Package | Vấn đề đã gặp thật | Cách giải quyết |
|---|---|---|
| `node-sass@7.0.1` | Build xong nhưng Node 18/24 bị từ chối runtime (`unsupportedEnvironment`, ABI 108 không được hỗ trợ) | Dùng đúng **Node 16.x** — binding tạo ra là `win32-x64-93` (ABI của Node 16), khớp bảng hỗ trợ của package |
| `bcrypt@5.0.1` | Cần Windows SDK để build, nếu thiếu báo `could not find any Windows SDK` | Cài Windows SDK qua Visual Studio Installer |
| `core-js@2.6.12` | Build cùng lúc với 2 package trên, ít gây lỗi riêng | — |

**Bài học quan trọng:** package.json ghi `"node": ">=16.0.0"` nhưng đây **chỉ đúng một nửa** — Node 16 bắt buộc, không phải "16 hoặc cao hơn". `node-sass` là package đã deprecated (dự án nên thay bằng `sass` — dart-sass, đã có sẵn trong `devDependencies` nhưng chưa được dùng để build chính) để không bị khóa cứng vào Node 16.

## 6. Quy trình cài đặt tóm tắt (đã kiểm chứng thật)

```bash
# 1. Cài đúng Node 16.x (qua nvm/nvm-windows, không dùng bản mới hơn)
nvm install 16.20.2
nvm use 16.20.2

# 2. Cài Python 3.11 (cho node-gyp)

# 3. (Chỉ Windows) Cài Visual Studio + Windows SDK qua VS Installer

# 4. Kích hoạt Yarn qua Corepack
corepack enable
corepack prepare yarn@3.2.1 --activate

# 5. Chạy MongoDB (ví dụ qua Docker) và tạo user thật
docker run -d --name trudesk-mongo -p 27017:27017 mongo:5.0-focal
# rồi tạo user qua mongosh (tránh URI có username/password rỗng)

# 6. Cài dependency (build native module diễn ra ở bước này)
yarn install

# 7. Build frontend
yarn build

# 8. Chạy lần đầu (vào chế độ Install Server vì chưa có config.yml)
node app.js
# Mở http://localhost:8118/install hoặc gọi API /install để hoàn tất
# (tạo config.yml, admin account, dữ liệu mặc định)

# 9. Chạy lại — lần này vào app thật
node app.js
```

## 7. Sự cố thường gặp (đã gặp thật, không phải suy đoán)

| Lỗi | Nguyên nhân | Cách sửa |
|---|---|---|
| `node-sass ... unsupportedEnvironment` | Dùng Node 18/20/22/24 thay vì 16 | Chuyển hẳn sang Node 16.x, xóa `node_modules`, `yarn install` lại |
| `could not find any Windows SDK` | Visual Studio thiếu Windows SDK component | Visual Studio Installer → Modify → thêm Windows SDK |
| `yarn: command not found` sau khi đổi Node version | Corepack shim gắn theo version Node cũ, bị mất khi `nvm use` đổi symlink | Chạy lại `corepack enable && corepack prepare yarn@3.2.1 --activate` sau mỗi lần đổi Node version |
| `Couldn't find the node_modules state file` | `yarn install` trước đó thực ra thất bại thầm lặng (ví dụ do yarn chưa sẵn sàng) nhưng báo exit code 0 sai | Luôn xác nhận `node_modules` thực sự tồn tại và có binding `.node` sau khi install, không chỉ tin vào exit code |
| MongoDB connect lỗi, `error: {}` không rõ ràng | URI nối `user:pass@host` dù username/password rỗng vẫn tạo "userinfo", khiến driver cố xác thực và thất bại | Tạo user MongoDB thật, dùng đúng username/password đó |
| `TypeError: callback is not a function` khi gọi `/api/v2/login` | Bug thật trong code: `commonV2.login` dùng `await` trên hàm `generateJWTToken` vẫn viết theo kiểu callback cũ | Xem ghi chú ở [docs/system-architecture.md](system-architecture.md) — cần sửa trước khi AI Agent dùng API này để lấy token |

## 8. Liên quan

- [docs/system-architecture.md](system-architecture.md) — tổng quan kiến trúc và hoạt động hệ thống
- [docs/expansion-plan.md](expansion-plan.md) — kế hoạch mở rộng
- `docker-compose.yml`, `Dockerfile` — cấu hình container chính thức của dự án (dùng Node 16.14-alpine, khớp với phát hiện ở mục 5)
