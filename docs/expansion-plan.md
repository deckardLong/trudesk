# Kế hoạch mở rộng Modular ITSM (nền tảng Trudesk 1.2.11)

> Tài liệu này mô tả hiện trạng, đề xuất mở rộng, kiến trúc đích và phân công cho 3 người.
> Căn cứ: khảo sát có chọn lọc các module chính (model, API v2, emitter, mailer, socket, cache, Docker, K8s, CI). Không phải rà soát toàn bộ 290 file.
> Giả định: hạn báo cáo là **thứ Tư 11/11/2026** (còn khoảng 3 ngày kể từ 8/11). Nếu khác, cần điều chỉnh mục 7.

---

## 1. Hiện trạng

Monolith Node/Express + MongoDB + Socket.io, frontend React 17 kết hợp jQuery cũ, Elasticsearch tùy chọn.

**Đã có**
- Ticket với comment, note, history, attachment, subscriber.
- Group, team, department; 4 role cố định (admin, mod, support, user) với permission theo action.
- API v2 có token, MFA, LDAP, báo cáo, chat nội bộ.
- Tạo ticket từ email qua IMAP.
- K8s manifest cơ bản.

**Điểm mạnh để mở rộng**
- `src/emitter/events.js` đã phát `ticket:created`, `ticket:updated`: điểm gắn AI không cần sửa lõi.
- API v2 đã có `/tickets`, `/groups`, `/es/search`.
- Elasticsearch 8 có `dense_vector`: làm tìm kiếm ngữ nghĩa mà không cần thêm hạ tầng vector.

## 2. Khoảng trống (kèm bằng chứng trong code)

### Chức năng
| Khoảng trống | Bằng chứng |
|---|---|
| SLA sơ sài | Chỉ có `overdueIn` theo priority (`src/models/ticketpriority.js`) và cờ `slatimer` theo status. Không có SLA phản hồi, giờ làm việc, escalation. Quá hạn chỉ tính khi gọi `getOverdue`, không có job nền. |
| Ticket type nghèo | `src/models/tickettype.js` chỉ có `name` và `priorities`. Không có Incident/Problem/Change/Request, không có liên kết ticket. |
| Thiếu KB, Service Catalog, phê duyệt, Asset/CMDB | Không thấy trong code ứng dụng. |
| Chưa có plugin thật | `plugins/` chỉ có `.gitkeep`. |
| Tích hợp hard-code | `transferToThirdParty` trong `src/controllers/api/v2/tickets.js`. |

### Chặn deploy cloud và scale ngang
| Vấn đề | Bằng chứng |
|---|---|
| Upload lưu đĩa cục bộ | `public/uploads` trong `controllers/accounts.js`, `controllers/editor.js` |
| Trạng thái socket trong RAM, không có Redis adapter | `src/socketio/index.js` (`shared.sockets`, `usersOnline`) |
| IMAP polling bằng `setInterval` trong tiến trình | `src/mailer/mailCheck.js`: chạy 2 instance sẽ tạo ticket trùng |
| Redis cache hard-code `127.0.0.1:32819` (gần như code chết) | `src/cache/rediscache.js` |
| Node 16 hết hỗ trợ, `node-sass` deprecated | `Dockerfile`, `package.json` |
| K8s thiếu ingress/secret; Mongo là Deployment đơn | `kubernetes/` |
| CI chỉ test + build, không deploy | `.circleci/config.yml` |

## 3. Đề xuất mở rộng (theo ưu tiên)

| # | Hạng mục | Lý do | Giá trị |
|---|---|---|---|
| 1 | SLA engine + escalation | Lõi ITSM, đang thiếu nhất | Cao |
| 2 | Loại ticket ITIL + liên kết ticket | Nền cho báo cáo và AI phân loại | Cao |
| 3 | Knowledge Base | Nguồn tri thức cho RAG, giảm ticket | Cao |
| 4 | AI Agent: triage, trùng lặp, gợi ý trả lời, tóm tắt | Tận dụng emitter + ES | Cao |
| 5 | Tách trạng thái ra ngoài (S3/Blob, Redis, lock job) | Bắt buộc để chạy cloud nhiều instance | Bắt buộc |
| 6 | Service Catalog + phê duyệt, Asset/CMDB-lite | Giai đoạn 2 | Trung bình |

**Không đề xuất:** viết lại frontend, tách toàn bộ thành microservice, làm lại mobile. Tốn công lớn, không giải quyết điểm yếu cốt lõi.

## 4. Kiến trúc đích

```
                        Người dùng / Agent / Email
                                   │
                         ┌─────────▼─────────┐
                         │  CDN / WAF / ALB  │  (C)
                         └─────────┬─────────┘
                                   │
   ┌───────────────────────────────▼────────────────────────────────┐
   │           TRUDESK CORE (monolith, chạy ≥2 instance)  (A + C)   │
   │  Express + Socket.io + React                                   │
   │  ┌───────────┐ ┌────────────┐ ┌─────────┐ ┌─────────────────┐  │
   │  │ Ticket/   │ │ SLA engine │ │   KB    │ │ Event emitter   │  │
   │  │ ITIL types│ │ (job nền)  │ │ module  │ │ → Webhook/Queue │  │
   │  └───────────┘ └────────────┘ └─────────┘ └────────┬────────┘  │
   └───┬───────────┬───────────┬──────────┬──────────────┼──────────┘
       │           │           │          │              │ ticket.created / ticket.updated
  ┌────▼───┐  ┌────▼────┐ ┌────▼────┐ ┌───▼───────┐ ┌────▼─────────────┐
  │MongoDB │  │  Redis  │ │ S3/Blob │ │Elastic-   │ │ Queue (SQS /     │ (C)
  │managed │  │sessions,│ │ uploads │ │search 8   │ │ Service Bus)     │
  │        │  │socket   │ │         │ │text+vector│ └────┬─────────────┘
  └────────┘  │adapter, │ └─────────┘ └───▲───────┘      │
              │job lock │                 │              │
              └─────────┘                 │      ┌───────▼──────────────┐
                                          │      │  AI AGENT SERVICE (B)│
                                          │      │  ┌────────────────┐  │
                                          └──────┼──┤ Retriever (RAG)│  │
                           đọc KB + ticket cũ    │  ├────────────────┤  │
                                                 │  │ Triage / Dedup │  │
        Trudesk API v2 (token) ◄─────────────────┼──┤ Reply drafter  │  │
        (tool: get/update/comment ticket)        │  │ Summarizer     │  │
                                                 │  ├────────────────┤  │
                                                 │  │ Guardrails:    │  │
                                                 │  │ PII mask, audit│  │
                                                 │  │ human-approve  │  │
                                                 │  └───────┬────────┘  │
                                                 └──────────┼───────────┘
                                                            ▼
                                                      LLM API (Claude/…)

  Cross-cutting (C): Terraform · CI/CD · Secrets Manager · CloudWatch/Grafana · backup
```

**Nguyên tắc**
- AI Agent là service riêng, chỉ giao tiếp với Core qua **event** và **API v2**, không đọc trực tiếp MongoDB. AI lỗi không làm sập hệ thống ticket.
- AI mặc định chỉ **đề xuất** (priority, nháp trả lời). Chỉ tự ghi vào ticket sau khi đánh giá chất lượng đạt.

## 5. Phân công

Tiêu chí chia: ba người sửa ba vùng file khác nhau, hợp đồng giao tiếp chốt từ buổi đầu.

### Người A: Chức năng (ITSM core)
**Vùng sở hữu:** `src/models/ticket*`, `tickettype`, `ticketpriority`, `src/controllers/api/v2/tickets.js`, module KB mới, `src/client/containers/`.

1. **SLA engine:** SLA phản hồi + giải quyết theo priority, giờ làm việc, job nền phát hiện sắp/đã vi phạm, thông báo escalation, hiển thị dashboard.
2. **Loại ticket ITIL:** Incident, Service Request, Problem, Change; liên kết cha/con và Problem↔Incident.
3. **Knowledge Base:** model + API (CRUD, tag, trạng thái xuất bản), giao diện soạn bài, gắn bài vào ticket, đánh dấu "bài giải quyết ticket".
4. **Báo cáo:** SLA compliance, MTTR (nếu còn thời gian).

Lưu ý: `src/models/ticket.js` dài 1457 dòng. Thêm module mới (SLA, KB) thay vì sửa chồng lên file này.

### Người B: AI Agent
**Vùng sở hữu:** thư mục mới `ai-agent/` và một hook nhỏ trong `src/emitter`.

1. **Triage:** gợi ý type, priority, group, tag từ nội dung ticket.
2. **Phát hiện ticket trùng/tương tự:** embedding lưu trong ES (`dense_vector`).
3. **RAG gợi ý trả lời:** truy xuất từ KB (A) và ticket đã đóng, soạn nháp cho agent duyệt.
4. **Tóm tắt** thread dài.
5. **Guardrails và đánh giá:** che PII trước khi gửi LLM, log prompt/response, giới hạn chi phí, bộ test 30–50 ticket có nhãn để đo độ chính xác triage (số liệu dùng cho báo cáo).

Phụ thuộc A (KB): bắt đầu bằng ticket đã đóng làm kho tri thức, cắm KB vào khi A xong.

### Người C: Deploy (đề xuất AWS)
**Vùng sở hữu:** `Dockerfile`, `docker-compose.yml`, `infra/` (Terraform), CI/CD, và các thay đổi nhỏ có kiểm soát ở upload, socketio, session.

1. **Chạy nhiều instance:** upload sang S3; Redis adapter cho Socket.io; lock để chỉ một instance chạy IMAP; thay `rediscache.js` bằng cấu hình qua biến môi trường.
2. **Container hóa, nâng Node 16 → 20** (kiểm tra build `node-sass`, `bcrypt`).
3. **Terraform:** ECS Fargate (Core + AI Agent), ALB + HTTPS, ElastiCache Redis, S3, Secrets Manager, SQS, CloudWatch.
4. **CI/CD:** GitHub Actions build image, test, deploy (hiện chỉ có CircleCI test + build).
5. **Quan sát và sao lưu:** dùng `/healthz` có sẵn, dashboard, alarm, backup.

Lưu ý kỹ thuật:
- DocumentDB không tương thích đầy đủ với Mongoose 6: cần kiểm tra trước. Phương án an toàn: MongoDB Atlas trên AWS.
- Không dùng OpenSearch thay Elasticsearch: client `@elastic/elasticsearch` 8 từ chối kết nối OpenSearch. Dùng Elastic Cloud hoặc tự chạy ES 8 trong container.
- Nếu chọn Azure, ánh xạ: Container Apps, Blob Storage, Azure Cache for Redis, Service Bus, Key Vault, Cosmos DB for MongoDB vCore hoặc Atlas.

### Hợp đồng chốt ngay buổi đầu
- Payload sự kiện `ticket.created`, `ticket.updated` (A, B).
- Danh sách endpoint API mà AI được gọi và token riêng cho service AI (B, C).
- Tên biến môi trường và secret (C với A, B).
- Quy tắc nhánh: mỗi người một nhánh, chỉ sửa trong vùng sở hữu; muốn sửa vùng khác phải báo trước.

## 6. Ma trận phụ thuộc

| Người | Cần từ | Cần gì | Cách giảm chặn |
|---|---|---|---|
| B | A | KB, schema event | Dùng ticket đóng làm corpus trước |
| B | C | Môi trường chạy service, secret LLM | Chạy local bằng docker-compose trước |
| A | C | Job nền chạy đúng 1 instance | Dùng lock; dev local chạy 1 instance |
| C | A, B | Danh sách biến môi trường | Chốt ở buổi đầu |

## 7. Lịch tới báo cáo (3 ngày)

| Ngày | A | B | C |
|---|---|---|---|
| Thứ 2 | Chốt hợp đồng; SLA model + job nền | Chốt hợp đồng; dựng service, triage chạy với 1 LLM | Dockerfile Node 20; S3 + Redis adapter; compose chạy được |
| Thứ 3 | ITIL type + KB (CRUD + gắn ticket) | Dedup + RAG + guardrails; đo độ chính xác | Terraform dựng môi trường; deploy bản đầu; CI/CD |
| Thứ 4 | Chốt demo, chụp màn hình | Số liệu đánh giá, demo AI | Chạy thử 2 instance; dashboard giám sát; chuẩn bị báo cáo |

Cam kết **MVP chạy được** cho hạng mục 1–5. Hạng mục 6 (Service Catalog, CMDB, plugin system) nêu trong báo cáo như **lộ trình giai đoạn 2**.

## 8. Rủi ro

| Rủi ro | Ảnh hưởng | Giảm thiểu |
|---|---|---|
| Test ít (14 file), phụ thuộc MongoDB | A và B làm hỏng nhau mà không biết | C giữ CI xanh, chạy test trên mỗi PR |
| AI trả lời sai | Mất niềm tin khi demo | Người duyệt bắt buộc + số liệu độ chính xác, trình bày cả ca thất bại |
| `ticket.js` quá lớn | Xung đột merge, khó test | A thêm module mới, tránh sửa rộng |
| Nâng Node 20 làm hỏng build | Trễ C, kéo theo B | Thử build ngay ngày đầu; lùi Node 18 nếu cần |
| DocumentDB/OpenSearch không tương thích | Phải đổi thiết kế muộn | Chốt Atlas + ES 8 từ đầu |
| Chỉ 3 ngày | Làm dở nhiều thứ | Giữ phạm vi MVP, đẩy hạng mục 6 sang giai đoạn 2 |

## 9. Tiêu chí hoàn thành cho buổi báo cáo

- **A:** demo ticket vi phạm SLA và có cảnh báo; tạo Incident liên kết Problem; một bài KB gắn vào ticket.
- **B:** demo ticket mới được gợi ý type/priority/group, gợi ý ticket trùng và nháp trả lời có trích nguồn; bảng độ chính xác trên bộ test.
- **C:** hệ thống chạy trên cloud với ≥2 instance Core, upload qua S3, chat realtime đúng giữa hai instance, pipeline CI/CD chạy, có dashboard giám sát.
