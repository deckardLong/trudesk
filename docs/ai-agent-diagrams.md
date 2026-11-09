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
    actor A as Agent (người)

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
        AI->>C: Gửi gợi ý qua API v2 (chờ duyệt)
        C-->>A: Hiển thị gợi ý
        A->>C: Chấp nhận hoặc từ chối
    end
```

> Cần chốt với A: API v2 hiện chưa có endpoint "gợi ý". Gợi ý sẽ ghi dưới dạng internal note hay A thêm endpoint mới? Sơ đồ phải khớp lựa chọn này.

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
