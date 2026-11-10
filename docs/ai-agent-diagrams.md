# Sơ đồ AI Agent Service

> Xem trước: VS Code (extension "Markdown Preview Mermaid Support") hoặc GitHub. Xuất ảnh: https://mermaid.live → Actions → SVG/PNG.
> Quy ước màu: xanh dương = Trudesk Core, tím = AI Agent, cam = hệ thống ngoài, hình trụ = nơi lưu dữ liệu.
> Lưu ý: tên module là đề xuất, cần khớp với code thực tế của người B và hợp đồng sự kiện đã chốt với A.

## 1. Ngữ cảnh và vị trí của AI trong hệ thống

```mermaid
flowchart LR
    U([Người dùng / Agent]) --> Core
    Core["Trudesk Core"] -- "event: ticket.created / updated" --> Q[("Queue")]
    Q --> AI["AI Agent Service"]
    AI -- "API v2 + token riêng" --> Core
    AI -- "vector search" --> ES[("Elasticsearch 8")]
    AI -- "HTTPS" --> LLM["LLM API"]
    Core --- Mongo[("MongoDB")]
    AI -. "không truy cập trực tiếp" .-> Mongo

    classDef core fill:#cfe2ff,stroke:#2b5ea7,color:#000
    classDef ai fill:#e2d9f3,stroke:#6f42c1,color:#000
    classDef ext fill:#ffe5b4,stroke:#d97706,color:#000
    class Core core
    class AI ai
    class LLM ext
```

## 2. Tuần tự xử lý ticket mới

```mermaid
sequenceDiagram
    autonumber
    actor U as Người dùng
    participant C as Trudesk Core
    participant Q as Queue
    participant AI as AI Agent
    participant ES as Elasticsearch
    participant L as LLM API
    participant B as Browser/UI
    actor AG as Agent (người)

    U->>C: Tạo ticket
    C-->>U: 201 Created (không chờ AI)
    C->>Q: Phát event ticket.created
    Q->>AI: Giao event
    AI->>AI: Che PII
    AI->>ES: Tìm ticket/KB tương tự
    ES-->>AI: Top-k kết quả
    AI->>L: Prompt + ngữ cảnh
    alt LLM lỗi hoặc timeout
        L--xAI: Lỗi
        AI->>AI: Ghi log, bỏ qua gợi ý
    else Thành công
        L-->>AI: Gợi ý (JSON)
        AI->>AI: Kiểm tra định dạng + ngưỡng tin cậy
        AI->>C: POST /api/v2/tickets/:id/ai-suggestions
        C->>C: Lưu gợi ý vào MongoDB (status=pending)
        C->>B: Socket.io: ai:suggestion:new
        B-->>AG: Hiển thị gợi ý trong ticket
        AG->>B: Click [✓ Dùng] hoặc [✗ Bỏ qua]
        B->>C: PATCH /api/v2/tickets/:id<br/>(áp dụng gợi ý hoặc từ chối)
        C->>C: Cập nhật ticket + history + audit log
        C-->>B: 200 OK
        B-->>AG: Ticket đã cập nhật
    end
```

> **Cơ chế hiển thị gợi ý:**
> - Core lưu gợi ý → phát Socket.io event (real-time)
> - Trình duyệt Agent lắng nghe → hiển thị cảnh báo ngay
> - Agent duyệt (click button) → gửi PATCH request về Core
> - Core áp dụng gợi ý → cập nhật ticket + ghi audit log
>
> **Endpoint cần thêm (người A):**
> - `POST /api/v2/tickets/:id/ai-suggestions` (AI gửi gợi ý)
> - `PATCH /api/v2/tickets/:id` (Agent duyệt, phần body có flag `applyAISuggestions`)
> - Socket event: `ai:suggestion:new` (Core phát khi có gợi ý mới)

## 3. Kiến trúc bên trong AI Agent Service

```mermaid
flowchart TB
    subgraph IN["Đầu vào"]
        EC["Event Consumer<br/>event → job"]
        PP["Pre-processor<br/>văn bản → văn bản đã che PII"]
    end
    subgraph CORE_AI["Xử lý"]
        TR["Triage<br/>ticket → type, priority, group, tag"]
        DD["Dedup<br/>ticket → ticket tương tự"]
        RG["Retriever (RAG)<br/>câu hỏi → đoạn tri thức + nguồn"]
        RD["Reply Drafter<br/>ticket + tri thức → nháp"]
        SM["Summarizer<br/>thread → tóm tắt"]
    end
    subgraph OUT["Đầu ra và kiểm soát"]
        GR["Guardrails<br/>validate, ngưỡng, giới hạn chi phí"]
        AP["API v2 Client<br/>ghi gợi ý chờ duyệt"]
        AU["Audit Log<br/>prompt, phản hồi, quyết định"]
    end
    LC["LLM Client<br/>lớp trừu tượng nhà cung cấp"]

    EC --> PP
    PP --> TR
    PP --> DD
    PP --> SM
    PP --> RG
    RG --> RD
    TR --> LC
    DD --> LC
    RD --> LC
    SM --> LC
    LC --> GR
    GR --> AP
    GR --> AU

    classDef ai fill:#e2d9f3,stroke:#6f42c1,color:#000
    class EC,PP,TR,DD,RG,RD,SM,GR,AP,AU,LC ai
```

## 4. Luồng dữ liệu RAG

```mermaid
flowchart LR
    subgraph ING["Nhánh nạp tri thức (theo lịch)"]
        S1["Ticket đã đóng"] --> CL["Làm sạch + che PII"]
        S2["Bài KB (của A)"] --> CL
        CL --> CH["Chia đoạn"]
        CH --> EM1["Embedding"]
        EM1 --> VS[("ES dense_vector")]
    end
    subgraph QRY["Nhánh truy vấn (mỗi ticket)"]
        NT["Ticket mới"] --> EM2["Embedding"]
        EM2 --> SR["Tìm top-k"]
        VS --> SR
        SR --> PR["Ghép prompt<br/>(ticket + đoạn tìm được)"]
        PR --> LLM["LLM"]
        LLM --> ANS["Nháp trả lời<br/>kèm trích nguồn"]
    end
```

> Hai bước Embedding phải dùng cùng một mô hình, nếu không kết quả tìm kiếm sai.

## 5. Guardrails và human-in-the-loop

```mermaid
flowchart TD
    A([Ticket mới]) --> B["Che PII"]
    B --> C{"Còn trong<br/>hạn mức chi phí?"}
    C -- Không --> X1(["Bỏ qua, ghi log"])
    C -- Có --> D["Gọi LLM"]
    D --> E{"Phản hồi hợp lệ<br/>(đúng định dạng JSON)?"}
    E -- Không --> X1
    E -- Có --> F{"Độ tin cậy<br/>≥ ngưỡng?"}
    F -- Không --> X1
    F -- Có --> G{"Chế độ tự động ghi<br/>đang bật?"}
    G -- "Có (mặc định TẮT)" --> H["Ghi thẳng vào ticket"]
    G -- Không --> I["Đưa vào hàng chờ duyệt"]
    I --> J{"Người duyệt"}
    J -- Chấp nhận --> H
    J -- Từ chối --> X2(["Lưu lý do từ chối"])
    H --> K["Ghi audit log"]
    X2 --> K
    X1 --> K
```

> Ngưỡng tin cậy cụ thể (ví dụ 0.7) cần điền sau khi đo trên bộ test 30–50 ticket có nhãn.

## 6. Ba cách duyệt gợi ý AI (chốt với A, B, C)

> **Người duyệt gợi ý là ai?** Hiện tại sơ đồ 2 chọn **Agent duyệt khi xem ticket** (Cách 1). Hai cách khác nêu dưới để tham khảo.

### Cách 1 (MVP - khuyến khích): Agent duyệt khi xem ticket

```
Agent mở ticket #123
    ↓
Thấy section "🤖 AI Gợi ý" trong ticket
    ├─ Type: Incident (0.92) ✓
    ├─ Priority: High (0.88) ✓
    └─ Gợi ý gán: John (0.87) ✓
    
Nhấp [✓ Dùng tất cả] hoặc [Chọn riêng từng field]
    ↓
Ticket cập nhật ngay
Ghi history: "agent_name duyệt gợi ý AI"
Ghi audit: "timestamp, agent, fields duyệt"
```

**Ưu:** ✅ Đơn giản, nhanh, agent quyết định trực tiếp
**Nhược:** ❌ Nếu agent không duyệt thì gợi ý hết hạn (tự xóa sau 1-6 giờ)

**Lưu trữ:**
```javascript
AIsuggestion {
  ticketId: ObjectId,
  suggestions: {
    type: { value, confidence },
    priority: { value, confidence },
    assignee: { value, confidence },
    ...
  },
  status: "pending",        // pending / approved / rejected / expired
  createdAt: Date,
  expiresAt: Date,          // 1-6 giờ
  approvedAt: Date,         // lúc agent duyệt
  approvedBy: ObjectId,     // user_id
  appliedAt: Date           // lúc áp dụng vào ticket
}
```

---

### Cách 2 (Giai đoạn 2): Mod/Admin duyệt tập trung

```
Trang riêng: "Gợi ý chờ duyệt" (admin dashboard)

GET /api/v2/admin/ai-suggestions?status=pending
    ↓
Mod Sarah thấy 5 gợi ý từ AI
    ├─ Ticket #123: Type: Incident
    ├─ Ticket #124: Priority: High
    └─ ...
    
Batch duyệt / từ chối:
  [✓ Duyệt tất cả] [Duyệt riêng lẻ] [Từ chối]
    ↓
Core cập nhật ticket + gợi ý
Ghi audit: "sarah (admin) duyệt gợi ý #123, #124, ..."
```

**Ưu:** ✅ Tập trung kiểm soát, có audit trail đầy đủ
**Nhược:** ❌ Bottleneck (1-2 mod phải duyệt tất cả), delay ticket

---

### Cách 3 (Aggressive): Tự động nếu confidence cao

```
Quy tắc:
  confidence >= 0.95: áp dụng ngay, không cần duyệt ✅
  0.7 <= confidence < 0.95: chờ agent duyệt ⏳
  confidence < 0.7: bỏ qua ❌

Ticket #123:
  Type: Incident (0.97) → áp dụng ngay ✓
  Priority: High (0.85) → chờ agent duyệt
  Assignee: John (0.68) → bỏ qua
```

**Ưu:** ✅ Nhanh nhất, giảm công việc duyệt
**Nhược:** ❌ Rủi ro cao (nếu AI sai, khó rollback), cần monitor

---

### Kiến nghị cho 3 ngày

**Chọn Cách 1 (Agent duyệt):**
- ✅ MVP đơn giản nhất
- ✅ Agent kiểm soát trực tiếp
- ✅ Dễ vẽ UI
- ❌ Cần handle: gợi ý hết hạn sau bao lâu?

**Điểm cần chốt:**
1. Hạn hết gợi ý: 1 giờ, 6 giờ, hay mãi mãi?
2. Agent có chọn field riêng lẻ không? (dùng Type + Priority, bỏ Assignee)
3. Gợi ý nào được áp dụng thì có thêm endpoint `/api/v2/tickets/:id/ai-suggestions` hay xài endpoint `/api/v2/tickets/:id` hiện có?
