# UptimeGuard

Escrow phí kỳ hosting / API trên **một** Intelligent Contract GenLayer. Customer khoá phí bằng GEN. Provider phải chấp nhận điều khoản. Hết kỳ, customer có thể nộp khiếu nại kèm bằng chứng và ít nhất hai nguồn tham chiếu. Đồng thuận AI (`gl.vm.run_nondet`) trả về đúng một trong hai kết quả: `SLA_MET` hoặc `SLA_BREACHED`. Mức bồi hoàn là số cố định hai bên đã chốt, validator so **tuyệt đối** (`==`), không có dung sai phần trăm trên số tiền.

> UptimeGuard chết nếu không có GenLayer: không có smart contract EVM nào đọc hiểu được lịch sử sự cố phi cấu trúc trên các trang status và monitor để đối chiếu với điều khoản SLA bằng ngôn ngữ tự nhiên, và không có bên trọng tài nào đủ rẻ cho từng hợp đồng hosting/API nhỏ — chỉ có đồng thuận AI phi tập trung của GenLayer mới làm được với chi phí gần bằng 0.

**Mạng:** Studionet. Không chuyển sang testnet hay chain khác.

Miễn phí sử dụng — chỉ tốn phí gas mạng GenLayer khi ký giao dịch. Không có phí nền tảng nào khác.

## Contract đã deploy

Chưa có. Sau khi deploy tay trên Studio và thấy `Result: SUCCESS`, điền:

- **Địa chỉ:** _(chưa có)_
- **Explorer:** `https://explorer-studio.genlayer.com/address/<address>`

```env
VITE_CONTRACT_ADDRESS=
```

Khi biến này trống, frontend vẫn chạy: banner vàng báo chưa có địa chỉ, form xem trước số tiền vẫn dùng được, nút ký bị khoá, trang không trắng.

## Bài toán

Khách trả phí tháng cho nhà cung cấp hosting hoặc API nhỏ, kèm cam kết uptime. Khi có sự cố, nhà cung cấp thường tự đo và tự quyết bồi hoàn. Hai bên thiếu một trọng tài rẻ, nhanh, khách quan cho từng hợp đồng nhỏ.

UptimeGuard giữ phí kỳ trong contract:

1. Customer tạo thoả thuận: địa chỉ provider, mô tả dịch vụ, điều khoản SLA, mức bồi hoàn cố định (`0 < breach_refund_amount < fee_amount`), ngày kết thúc kỳ, thời hạn khiếu nại. GEN gửi kèm giao dịch là `fee_amount`.
2. Provider gọi `accept_agreement` trước khi kỳ kết thúc. Nếu không, customer gọi `cancel_unaccepted` và nhận lại toàn bộ phí.
3. Trong `[period_end, claim_deadline]`, customer nộp ít nhất 1 link bằng chứng và 2 link tham chiếu.
4. Ai cũng có thể gọi `resolve_claim`. AI đối chiếu điều khoản với các trang đã đọc.
5. `confidence < 60` → `DISPUTED`. Customer nộp lại được cho tới `stale_deadline`.
6. Hết hạn khiếu nại mà vẫn `ACTIVE` → ai cũng gọi `settle_unclaimed`, provider nhận đủ phí.
7. Hết hạn tranh chấp mà vẫn `DISPUTED` → ai cũng gọi `settle_stale_dispute`, provider nhận đủ phí.

Gánh nặng chứng minh thuộc về customer. Bằng chứng không đủ, mâu thuẫn, hoặc không có timestamp để xác định thời gian ngừng thì kết quả là `SLA_MET`. Đây là lựa chọn thiết kế nghiêng về provider.

## Kiến trúc

Một contract, [`contracts/uptime_guard.py`](contracts/uptime_guard.py), giữ GEN trực tiếp. Không có contract thứ hai, không chuyển value qua cross-contract call.

Header Studio:

```python
# v0.2.16
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
```

| Việc | API dùng |
|---|---|
| Người gọi | `gl.message.sender_address` |
| Chuyển GEN | `gl.get_contract_at(address).emit_transfer(value=u256(amount))` |
| Nhận GEN lúc tạo thoả thuận | `@gl.public.write.payable` rồi đọc `gl.message.value` |
| Thời gian | `gl.message_raw["datetime"]` (ISO-8601), dự phòng `gl.message.datetime`, rồi `datetime.now` đã được GenVM ghim vào timestamp giao dịch |
| Map | `TreeMap.get(key, default)` khi cần default |

`@gl.public.write.payable` có trong `genlayer/gl/annotations.py` của đúng hash trên. Runner từ chối value khác 0 trên method không payable (`called non-payable method ... with non-zero value`). Vì vậy `create_agreement` bắt buộc dùng `.payable`. Ghi chú cũ "decorator payable không tồn tại" không còn đúng với SDK này.

`gl.vm.Return` của SDK này giữ kết quả ở `.calldata`, không có `.value`. Validator so `verdict` bằng `==`, và cùng một phía của ngưỡng `confidence >= 60`, để hai validator không cùng nói `SLA_MET` rồi một bên giải ngân còn bên kia để `DISPUTED`.

`DynArray()` không khởi tạo được (`this class can't be instantiated by user`). Mảng URL rỗng ghi bằng `[]`; storage tự đưa về `DynArray`.

## Luồng resolve

```
PENDING_ACCEPTANCE
  ├─ accept_agreement (trước period_end) → ACTIVE
  └─ cancel_unaccepted → CUSTOMER_FULL → CANCELLED_REFUNDED

ACTIVE
  ├─ file_claim trong [period_end, claim_deadline] → CLAIM_FILED
  └─ sau claim_deadline: settle_unclaimed → PROVIDER_FULL → SETTLED_NO_CLAIM

CLAIM_FILED
  └─ resolve_claim
       ├─ confidence < 60 → DISPUTED
       ├─ SLA_MET → PROVIDER_FULL → RESOLVED_SLA_MET
       └─ SLA_BREACHED → SPLIT_BREACH → RESOLVED_SLA_BREACHED

DISPUTED
  ├─ file_claim lại trước stale_deadline → CLAIM_FILED
  └─ sau stale_deadline: settle_stale_dispute → PROVIDER_FULL → SETTLED_STALE_DISPUTE

PAYOUT_FAILED → retry_resolution (không chạy lại AI, chỉ trả phần còn thiếu)
```

Mốc thời gian:

- `claim_deadline = period_end + claim_window_seconds`
- `stale_deadline = claim_deadline + claim_window_seconds`
- Cửa sổ khiếu nại là đoạn đóng `[period_end, claim_deadline]`
- `settle_unclaimed` chỉ khi `now > claim_deadline`
- `settle_stale_dispute` chỉ khi `now > stale_deadline`

Mọi lần chuyển tiền đi qua `_settle(kind, success_status)`. Loại giải ngân được ghi **trước** khi chuyển: `PROVIDER_FULL`, `SPLIT_BREACH`, hoặc `CUSTOMER_FULL`. Hai cờ `provider_paid` và `customer_refunded` khiến `retry_resolution` không trả trùng.

`SLA_BREACHED`: provider nhận `fee - breach_refund_amount`, customer nhận đúng `breach_refund_amount`.

## Giới hạn trung thực

1. Chỉ xác minh được những sự cố **được ghi nhận công khai**. Nếu provider không công bố sự cố và không có monitor hoặc archive nào ghi lại thì không có gì để đối chiếu.
2. Trang status của provider **do provider kiểm soát**, có thể bỏ sót hoặc xoá sự cố. Nguồn độc lập thật sự là monitor bên thứ ba và bản lưu trữ archive có timestamp; UI phải nhắc customer ưu tiên các nguồn này.
3. LLM ước lượng tổng thời gian ngừng từ log sự cố có thể sai. Vì vậy điều khoản SLA nên đơn giản và khách quan (ngưỡng phút ngừng cụ thể), tránh công thức phức tạp.
4. Nguyên tắc "thiếu bằng chứng → `SLA_MET`" nghiêng về provider (mục thiết kế về gánh nặng chứng minh).
5. Nhiều trang status render bằng JavaScript hoặc chặn truy cập tự động, `web.render` có thể không đọc được. Một số trang dùng dịch vụ status phổ biến có endpoint dữ liệu công khai; **kiểm tra thực tế khi dev, không giả định**. Trang không đọc được → giao dịch revert, thử lại được.
6. Contract chỉ giữ tiền và phân xử; **việc cung cấp dịch vụ diễn ra ngoài chuỗi** và contract không kiểm soát được.
7. Chống prompt injection chỉ giảm rủi ro.
8. Mỗi thoả thuận chỉ đại diện **1 kỳ**; kỳ tiếp theo tạo thoả thuận mới.

### Trang status đã thử bằng HTTP GET (21 Oct 2026)

Đây là GET thường, chưa phải `gl.nondet.web.render` trên Studionet. `web.render` chỉ kiểm được khi có giao dịch resolve thật sau khi contract được deploy.

| URL | HTTP | Ghi chú |
|---|---|---|
| `https://www.githubstatus.com/api/v2/summary.json` | 200 `application/json` | Summary Statuspage, có `updated_at`. Nên dùng làm reference URL. |
| `https://www.cloudflarestatus.com/api/v2/summary.json` | 200 `application/json` | Cùng kiểu summary JSON. |
| `https://www.githubstatus.com/` | 200 `text/html` | Vỏ HTML. Nội dung sự cố có thể chỉ xuất hiện sau JavaScript — `web.render` có thể đọc được hoặc không. |
| `https://status.aws.amazon.com/` | 200 `text/html` | HTML tĩnh hơn, vẫn chưa xác nhận bằng `web.render`. |

Ưu tiên URL JSON hoặc archive có timestamp. Nếu `web.render` không đọc được một URL, `resolve_claim` revert và gọi lại được.

## Bảng đối chiếu xử lý tiền

Mọi số tiền là số nguyên wei (`1 GEN = 10^18`). Không có `float`, `parseFloat`, `Math.round`, `Math.floor`, `Math.ceil` trên đường đi của tiền.

| # | Chỗ xử lý | File | Ghi hay đọc | Cách xử lý | Đơn vị |
|---|---|---|---|---|---|
| 1 | Phí kỳ gửi kèm lúc tạo | `create_agreement` ← `gl.message.value` | WRITE `fee_amount` | `bigint(gl.message.value)` | wei |
| 2 | Mức bồi hoàn cố định | `create_agreement` tham số | WRITE `breach_refund_amount` | `bigint`, ràng buộc `0 < x < fee` | wei |
| 3 | Provider nhận đủ phí | `_execute_settlement` `PROVIDER_FULL` | READ `fee_amount` | `emit_transfer(value=u256(fee))` | wei |
| 4 | Chia khi SLA vi phạm | `_execute_settlement` `SPLIT_BREACH` | READ cả hai | provider `fee - refund`, customer `refund` | wei |
| 5 | Customer nhận lại toàn bộ | `_execute_settlement` `CUSTOMER_FULL` | READ `fee_amount` | `emit_transfer` cho customer | wei |
| 6 | Thử lại phần còn thiếu | `retry_resolution` | READ cờ `provider_paid` / `customer_refunded` và `settlement_kind` đã lưu | không tính lại, không chạy lại AI | wei |
| 7 | Ô nhập GEN | `frontend/src/money.js` `sanitizeGenInput` | WRITE chuỗi nhập | chỉ chữ số và một dấu `.`, tối đa 18 số lẻ | chuỗi GEN |
| 8 | GEN → wei trước khi ký | `parseGenToWei` | WRITE `value` của giao dịch và `breach_refund_amount` | ghép phần nguyên + 18 chữ số lẻ thành `BigInt` | wei |
| 9 | Chip 25% / 50% / 75% | `percentOfWei` | WRITE gợi ý bồi hoàn | `fee * pct / 100n`, chia nguyên | wei |
| 10 | Preview trước khi ký | `computeBreachPreview` | READ | customer = refund, provider = `fee - refund` | wei |
| 11 | Hiển thị số dư / payout | `formatWeiToGen` | READ | `wei / 10^18` và `%` bằng `BigInt` | chuỗi GEN |
| 12 | Ba kiểu giải ngân trên UI | `settlementShares` | READ `settlement_kind`, fee, refund | cùng công thức với contract | wei |
| 13 | `value` gửi MetaMask | `toValueBigInt` | WRITE | `bigint` hoặc chuỗi hex → `BigInt`; `number` JS thành `0n` | wei |
| 14 | Field đọc từ contract | `toWeiString` | READ | chỉ chuỗi chữ số; `typeof number` → `"0"` để không nuốt wei lớn | chuỗi wei |
| 15 | Chặn float lúc build | `scripts/check-no-float-money.js`, gắn `prebuild` | — | fail nếu `parseFloat` / `Math.round` / `floor` / `ceil` đứng gần `fee\|refund\|amount\|payout\|balance\|wei\|gen` | — |

## Test

```bash
pip install -r requirements.txt
pytest tests/test_uptime_guard.py -q
```

Trước mỗi giao dịch nondet, test gọi `sim_installMocks` (và `mock_web` / `mock_llm`). Thời gian được đẩy bằng cách thay `_current_unix_timestamp`.

`emit_transfer` được spy theo địa chỉ nhận: có thể ép riêng provider, riêng customer, hoặc cả hai ném exception.

Frontend:

```bash
cd frontend
npm install
npm run test:money
npm run build
```

`npm run build` chạy `prebuild` → `scripts/check-no-float-money.js`.

## Deploy contract trên Studionet

1. Mở [GenLayer Studio → Run & Debug](https://studio.genlayer.com/run-debug).
2. Dán `contracts/uptime_guard.py`, giữ nguyên hai dòng header.
3. Deploy. Mở giao dịch và xác nhận **`Result: SUCCESS`**.
4. Đặt `VITE_CONTRACT_ADDRESS` trong `frontend/.env` và trên Vercel.

Không tự deploy từ agent. Không đổi mạng.

## Frontend

```bash
cd frontend
npm install
npm run dev
```

Mở `http://localhost:3000`. Chain là `studionet` từ `genlayer-js/chains`. Ví cần GEN từ Studio → Accounts.

Điều khoản SLA chọn từ mẫu (câu tiếng Anh cố định). Có ô "điều khoản khác". Kỳ 7/30/90 ngày và hạn khiếu nại 3/7/14 ngày tự tính `period_end` và `claim_window_seconds`. Chip phí và chip bồi hoàn 25/50/75% tính bằng `BigInt`. Preview nói rõ mỗi bên nhận bao nhiêu nếu SLA vi phạm và nếu không.

Ở bước nộp khiếu nại, UI nhắc dùng monitor độc lập hoặc archive có timestamp. Thiếu bằng chứng đủ rõ được tính là SLA được đáp ứng.
