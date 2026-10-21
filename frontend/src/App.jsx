import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ClipboardPaste,
  Clock,
  Copy,
  Loader2,
  RefreshCw,
  Shield,
  Wallet
} from 'lucide-react';
import {
  CONTRACT_ADDRESS,
  formatWriteError,
  isContractConfigured,
  readContractState,
  sendContractTransaction,
  studionet,
  switchToGenlayerStudionet,
  toCount,
  waitForFinalizedTx
} from './genlayerClient';
import {
  computeBreachPreview,
  formatWeiToGen,
  isValidRefund,
  parseGenToWei,
  percentOfWei,
  periodEndFromDays,
  sanitizeGenInput,
  secondsFromDays,
  settlementShares,
  toWeiString,
  unixNowSeconds
} from './money.js';

const SLA_PRESETS = [
  { id: 'down-30m', label: 'Tổng thời gian ngừng ≤ 30 phút', terms: 'Total downtime <= 30 minutes in the period' },
  { id: 'down-2h', label: 'Tổng thời gian ngừng ≤ 2 giờ', terms: 'Total downtime <= 2 hours in the period' },
  { id: 'down-4h', label: 'Tổng thời gian ngừng ≤ 4 giờ', terms: 'Total downtime <= 4 hours in the period' },
  { id: 'inc-15', label: 'Không có sự cố đơn lẻ nào kéo dài hơn 15 phút', terms: 'No single incident lasts longer than 15 minutes' },
  { id: 'inc-30', label: 'Không có sự cố đơn lẻ nào kéo dài hơn 30 phút', terms: 'No single incident lasts longer than 30 minutes' },
  { id: 'inc-60', label: 'Không có sự cố đơn lẻ nào kéo dài hơn 60 phút', terms: 'No single incident lasts longer than 60 minutes' },
  { id: 'custom', label: 'Điều khoản khác', terms: '' }
];

const PERIODS = [
  { days: '7', label: '7 ngày' },
  { days: '30', label: '30 ngày' },
  { days: '90', label: '90 ngày' }
];

const WINDOWS = [
  { days: '3', label: '3 ngày' },
  { days: '7', label: '7 ngày' },
  { days: '14', label: '14 ngày' }
];

const FEE_CHIPS = ['0.5', '1', '2', '5', '10'];
const REFUND_PCTS = [25, 50, 75];

const STATUS_META = {
  PENDING_ACCEPTANCE: { label: 'Chờ provider chấp nhận', tone: 'wait' },
  ACTIVE: { label: 'Đang hiệu lực', tone: 'live' },
  CLAIM_FILED: { label: 'Đã nộp khiếu nại', tone: 'claim' },
  DISPUTED: { label: 'Cần bằng chứng rõ hơn', tone: 'warn' },
  RESOLVED_SLA_MET: { label: 'SLA đạt — provider nhận đủ', tone: 'ok' },
  RESOLVED_SLA_BREACHED: { label: 'SLA vi phạm — đã chia', tone: 'bad' },
  SETTLED_NO_CLAIM: { label: 'Không khiếu nại — provider nhận đủ', tone: 'ok' },
  SETTLED_STALE_DISPUTE: { label: 'Hết hạn tranh chấp — provider nhận đủ', tone: 'ok' },
  CANCELLED_REFUNDED: { label: 'Đã huỷ — customer nhận lại đủ', tone: 'muted' },
  PAYOUT_FAILED: { label: 'Giải ngân còn thiếu', tone: 'bad' }
};

const canonAddr = (a) => String(a || '').trim().toLowerCase().replace(/^0x/, '');
const sameAddress = (a, b) => {
  const left = canonAddr(a);
  const right = canonAddr(b);
  return left.length >= 40 && right.length >= 40 && left.slice(-40) === right.slice(-40);
};
const shortAddr = (addr) => {
  const s = String(addr || '');
  if (s.length < 12) return s || '—';
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
};
const isAddress = (addr) => /^0x[0-9a-fA-F]{40}$/.test(String(addr || '').trim());

const toStringList = (val) => {
  if (Array.isArray(val)) return val.map(String);
  if (val && typeof val === 'object') {
    const keys = Object.keys(val);
    if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
      return keys.sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)).map((k) => String(val[k]));
    }
  }
  return [];
};

const toPercentInt = (val) => {
  try {
    const asInt = typeof val === 'bigint' ? val : BigInt(String(val ?? '0').split('.')[0] || '0');
    if (asInt < 0n) return 0;
    if (asInt > 100n) return 100;
    return Number(asInt);
  } catch {
    return 0;
  }
};

const formatUnix = (unixStr) => {
  try {
    const sec = BigInt(String(unixStr || '0'));
    const d = new Date(Number(sec * 1000n));
    if (Number.isNaN(d.getTime())) return String(unixStr);
    return d.toLocaleString();
  } catch {
    return String(unixStr || '—');
  }
};

const formatDuration = (total) => {
  let s = BigInt(total);
  if (s < 0n) s = 0n;
  const days = s / 86400n;
  s %= 86400n;
  const hours = s / 3600n;
  s %= 3600n;
  const mins = s / 60n;
  const secs = s % 60n;
  return `${days.toString()}d ${hours.toString()}h ${mins.toString()}m ${secs.toString()}s`;
};

const normalizeAgreement = (raw, id) => {
  if (!raw || typeof raw !== 'object') return null;
  return {
    id: String(id),
    customer: String(raw.customer || ''),
    provider: String(raw.provider || ''),
    service_description: String(raw.service_description || ''),
    sla_terms: String(raw.sla_terms || ''),
    fee_amount: toWeiString(raw.fee_amount),
    breach_refund_amount: toWeiString(raw.breach_refund_amount),
    period_end: String(raw.period_end || '0'),
    claim_window_seconds: String(raw.claim_window_seconds || '0'),
    claim_deadline: String(raw.claim_deadline || '0'),
    stale_deadline: String(raw.stale_deadline || '0'),
    claim_evidence_urls: toStringList(raw.claim_evidence_urls),
    reference_urls: toStringList(raw.reference_urls),
    status: String(raw.status || ''),
    verdict: String(raw.verdict || ''),
    verdict_reason: String(raw.verdict_reason || ''),
    confidence: toPercentInt(raw.confidence),
    settlement_kind: String(raw.settlement_kind || ''),
    settlement_success_status: String(raw.settlement_success_status || ''),
    provider_paid: Boolean(raw.provider_paid),
    customer_refunded: Boolean(raw.customer_refunded),
    settled: Boolean(raw.settled)
  };
};

function PasteButton({ onPaste }) {
  return (
    <button type="button" className="btn btn-ghost" onClick={onPaste} title="Dán từ clipboard">
      <ClipboardPaste size={16} /> Dán
    </button>
  );
}

function UrlEditor({ label, urls, onChange }) {
  const update = (index, value) => {
    const next = urls.slice();
    next[index] = value;
    onChange(next);
  };
  return (
    <div className="stack">
      <span className="field-label">{label}</span>
      {urls.map((url, index) => (
        <div className="row" key={`${label}-${index}`}>
          <input
            value={url}
            placeholder="https://"
            onChange={(e) => update(index, e.target.value)}
          />
          <PasteButton onPaste={async () => {
            try {
              const text = await navigator.clipboard.readText();
              update(index, String(text || '').trim());
            } catch {
              onChange(urls);
            }
          }} />
        </div>
      ))}
      <button type="button" className="btn btn-ghost" onClick={() => onChange(urls.concat(['']))}>
        Thêm link
      </button>
    </div>
  );
}

function PayoutLines({ row }) {
  const shares = settlementShares(row.settlement_kind, row.fee_amount, row.breach_refund_amount);
  const line = (label, owed, paid) => {
    if (owed === 0n) return `${label}: không có khoản phải nhận`;
    const shown = `${formatWeiToGen(owed)} GEN`;
    return paid ? `${label}: đã nhận ${shown}` : `${label}: đang chờ ${shown}`;
  };
  return (
    <div className="preview">
      <p>{line('Provider', shares.providerGets, row.provider_paid)}</p>
      <p>{line('Customer', shares.customerGets, row.customer_refunded)}</p>
    </div>
  );
}

export default function App() {
  const configured = isContractConfigured();
  const [account, setAccount] = useState('');
  const [agreements, setAgreements] = useState([]);
  const [nowSec, setNowSec] = useState(() => unixNowSeconds());
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState(null);
  const [provider, setProvider] = useState('');
  const [description, setDescription] = useState('');
  const [slaId, setSlaId] = useState(SLA_PRESETS[0].id);
  const [customTerms, setCustomTerms] = useState('');
  const [periodDays, setPeriodDays] = useState('30');
  const [windowDays, setWindowDays] = useState('7');
  const [feeGen, setFeeGen] = useState('1');
  const [refundPct, setRefundPct] = useState(50);
  const [customRefund, setCustomRefund] = useState('');
  const [useCustomRefund, setUseCustomRefund] = useState(false);

  const preset = SLA_PRESETS.find((item) => item.id === slaId) || SLA_PRESETS[0];
  const terms = preset.id === 'custom' ? customTerms.trim() : preset.terms;
  const feeWei = useMemo(() => parseGenToWei(feeGen), [feeGen]);
  const refundWei = useMemo(() => {
    if (useCustomRefund) return parseGenToWei(customRefund);
    return percentOfWei(feeWei, refundPct);
  }, [useCustomRefund, customRefund, feeWei, refundPct]);
  const refundOk = isValidRefund(feeWei, refundWei);
  const preview = refundOk ? computeBreachPreview(feeWei, refundWei) : null;

  const pasteInto = async (setter) => {
    try {
      const text = await navigator.clipboard.readText();
      setter(String(text || '').trim());
    } catch {
      setNotice({ kind: 'err', text: 'Trình duyệt đã chặn quyền đọc clipboard. Hãy dán thủ công.' });
    }
  };

  const loadAgreements = useCallback(async () => {
    if (!configured) {
      setAgreements([]);
      return;
    }
    const countRaw = await readContractState('get_agreement_count', []);
    const count = toCount(countRaw);
    const rows = [];
    for (let i = 0n; i < count; i += 1n) {
      const raw = await readContractState('get_agreement', [i.toString()]);
      const row = normalizeAgreement(raw, i.toString());
      if (row) rows.push(row);
    }
    setAgreements(rows.reverse());
  }, [configured]);

  useEffect(() => {
    loadAgreements().catch((err) => {
      console.warn(err);
      setNotice({ kind: 'err', text: 'Chưa đọc được danh sách thoả thuận.' });
    });
  }, [loadAgreements]);

  useEffect(() => {
    const id = setInterval(() => setNowSec(unixNowSeconds()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.ethereum) return undefined;
    window.ethereum.request({ method: 'eth_accounts' }).then((accs) => {
      if (accs && accs[0]) setAccount(accs[0]);
    }).catch(() => {});
    const onAccounts = (accs) => setAccount(accs && accs[0] ? accs[0] : '');
    window.ethereum.on?.('accountsChanged', onAccounts);
    return () => window.ethereum.removeListener?.('accountsChanged', onAccounts);
  }, []);

  const connectWallet = async () => {
    if (!window.ethereum) {
      setNotice({ kind: 'err', text: 'Không thấy MetaMask trên trình duyệt này.' });
      return;
    }
    await switchToGenlayerStudionet();
    const accs = await window.ethereum.request({ method: 'eth_requestAccounts' });
    setAccount(accs && accs[0] ? accs[0] : '');
  };

  const runWrite = async (key, title, functionName, args, valueWei = 0n) => {
    setBusy(key);
    setNotice({ kind: 'ok', text: `${title}: đang chờ bạn ký, rồi chờ GenLayer ACCEPTED…` });
    try {
      const hash = await sendContractTransaction({
        from: account,
        functionName,
        args,
        value: valueWei
      });
      await waitForFinalizedTx(hash);
      await loadAgreements();
      setNotice({ kind: 'ok', text: `${title} đã được chấp nhận.` });
    } catch (err) {
      setNotice({ kind: 'err', text: formatWriteError(err) });
    } finally {
      setBusy('');
    }
  };

  const onCreate = async (e) => {
    e.preventDefault();
    if (!isAddress(provider)) {
      setNotice({ kind: 'err', text: 'Địa chỉ provider phải là 0x và đủ 40 ký tự hex.' });
      return;
    }
    if (!description.trim()) {
      setNotice({ kind: 'err', text: 'Mô tả dịch vụ không được để trống.' });
      return;
    }
    if (!terms) {
      setNotice({ kind: 'err', text: 'Hãy chọn điều khoản SLA hoặc nhập điều khoản khác.' });
      return;
    }
    if (!refundOk) {
      setNotice({ kind: 'err', text: 'Mức bồi hoàn phải lớn hơn 0 và nhỏ hơn phí kỳ.' });
      return;
    }
    if (sameAddress(provider, account)) {
      setNotice({ kind: 'err', text: 'Customer và provider không được là cùng một địa chỉ.' });
      return;
    }
    await runWrite(
      'create',
      'Tạo thoả thuận',
      'create_agreement',
      [provider.trim(), description.trim(), terms, refundWei, periodEndFromDays(periodDays), secondsFromDays(windowDays)],
      feeWei
    );
  };

  const locked = !configured || !account;

  return (
    <div className="app">
      <header className="nav">
        <div className="brand">
          <div className="mark"><Activity size={22} /></div>
          <div>
            <h1>UptimeGuard</h1>
            <p>Escrow phí hosting / API — phán quyết SLA nhị phân trên GenLayer</p>
          </div>
        </div>
        <div className="nav-actions">
          <span className="chain-pill">{studionet.name || 'Studionet'} · {String(studionet.id)}</span>
          {account ? <span className="addr-pill">{shortAddr(account)}</span> : null}
          <button className="btn btn-primary" onClick={connectWallet}>
            <Wallet size={16} /> {account ? 'Đổi ví' : 'Kết nối MetaMask'}
          </button>
        </div>
      </header>

      <div className="banner banner-free">
        <Shield size={18} />
        <p>Miễn phí sử dụng — chỉ tốn phí gas mạng GenLayer khi ký giao dịch. Không có phí nền tảng nào khác.</p>
      </div>

      {!configured && (
        <div className="banner banner-warn">
          <div>
            <strong>Chưa có địa chỉ contract</strong>
            <p>App vẫn mở để xem trước phí và mức bồi hoàn. Nút ký bị khoá cho tới khi deploy Studionet thành công và đặt <code>VITE_CONTRACT_ADDRESS</code>. Trang không bị trắng.</p>
          </div>
        </div>
      )}

      {notice && <div className={`notice notice-${notice.kind === 'err' ? 'err' : 'ok'}`}>{notice.text}</div>}

      <div className="layout">
        <form className="panel stack" onSubmit={onCreate}>
          <h2>Tạo thoả thuận kỳ này</h2>
          <p className="hint">Provider phải chấp nhận điều khoản trước khi kỳ kết thúc. Điều khoản, mức bồi hoàn và ngày kết thúc không sửa được sau khi tạo.</p>

          <label>
            <span>Địa chỉ provider</span>
            <div className="row">
              <input value={provider} onChange={(e) => setProvider(e.target.value.trim())} placeholder="0x…" />
              <PasteButton onPaste={() => pasteInto(setProvider)} />
            </div>
          </label>

          <label>
            <span>Mô tả dịch vụ</span>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="API thanh toán, region sg, hostname api.example.com" />
          </label>

          <label>
            <span>Điều khoản SLA</span>
            <select value={slaId} onChange={(e) => setSlaId(e.target.value)}>
              {SLA_PRESETS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
          {preset.id === 'custom' && (
            <label>
              <span>Điều khoản khác (tiếng Anh, ngắn)</span>
              <input value={customTerms} onChange={(e) => setCustomTerms(e.target.value)} placeholder="Total downtime <= 60 minutes in the period" />
            </label>
          )}
          <p className="hint">Điều khoản càng đơn giản, khách quan thì kết quả càng đáng tin.</p>
          {terms && <p className="terms-preview">{terms}</p>}

          <label>
            <span>Độ dài kỳ</span>
            <select value={periodDays} onChange={(e) => setPeriodDays(e.target.value)}>
              {PERIODS.map((item) => <option key={item.days} value={item.days}>{item.label}</option>)}
            </select>
          </label>
          <label>
            <span>Thời hạn khiếu nại sau khi kỳ kết thúc</span>
            <select value={windowDays} onChange={(e) => setWindowDays(e.target.value)}>
              {WINDOWS.map((item) => <option key={item.days} value={item.days}>{item.label}</option>)}
            </select>
          </label>

          <div>
            <span className="field-label">Phí kỳ (GEN)</span>
            <div className="chips">
              {FEE_CHIPS.map((chip) => (
                <button type="button" key={chip} className={`chip ${feeGen === chip ? 'active' : ''}`} onClick={() => setFeeGen(chip)}>
                  {chip}
                </button>
              ))}
            </div>
            <input
              style={{ marginTop: 8 }}
              value={feeGen}
              onChange={(e) => setFeeGen(sanitizeGenInput(e.target.value))}
              inputMode="decimal"
            />
          </div>

          <div>
            <span className="field-label">Mức bồi hoàn nếu SLA bị vi phạm</span>
            <div className="chips">
              {REFUND_PCTS.map((pct) => (
                <button
                  type="button"
                  key={pct}
                  className={`chip ${!useCustomRefund && refundPct === pct ? 'active' : ''}`}
                  onClick={() => { setUseCustomRefund(false); setRefundPct(pct); }}
                >
                  {pct}%
                </button>
              ))}
              <button type="button" className={`chip ${useCustomRefund ? 'active' : ''}`} onClick={() => setUseCustomRefund(true)}>
                Số khác
              </button>
            </div>
            {useCustomRefund && (
              <div className="row" style={{ marginTop: 8 }}>
                <input value={customRefund} onChange={(e) => setCustomRefund(sanitizeGenInput(e.target.value))} inputMode="decimal" placeholder="GEN" />
              </div>
            )}
          </div>

          {preview && (
            <div className="preview">
              Nếu SLA bị vi phạm: bạn nhận lại {formatWeiToGen(preview.customerGets)} GEN, provider nhận {formatWeiToGen(preview.providerGets)} GEN. Nếu không: provider nhận toàn bộ.
            </div>
          )}

          <button className="btn btn-primary" type="submit" disabled={locked || busy === 'create' || !refundOk}>
            {busy === 'create' ? <Loader2 className="spin" size={16} /> : <Shield size={16} />}
            Gửi phí và tạo thoả thuận
          </button>
          {locked && <p className="hint">{configured ? 'Kết nối ví trên Studionet để ký.' : 'Đặt địa chỉ contract trước khi ký.'}</p>}
        </form>

        <section>
          <div className="list-head">
            <h2>Thoả thuận</h2>
            <button className="btn btn-ghost" onClick={() => loadAgreements()} disabled={!configured || Boolean(busy)}>
              <RefreshCw size={16} /> Làm mới
            </button>
          </div>
          {!configured && <div className="card"><p className="hint">Chưa có contract nên chưa có danh sách trên chuỗi.</p></div>}
          {configured && agreements.length === 0 && <div className="card"><p className="hint">Chưa có thoả thuận nào.</p></div>}
          {agreements.map((row) => (
            <AgreementCard
              key={row.id}
              row={row}
              account={account}
              nowSec={nowSec}
              busy={busy}
              locked={locked}
              onWrite={runWrite}
              onCopy={async (text) => {
                try {
                  await navigator.clipboard.writeText(text);
                  setNotice({ kind: 'ok', text: 'Đã chép.' });
                } catch {
                  setNotice({ kind: 'err', text: 'Không chép được. Hãy chọn và copy thủ công.' });
                }
              }}
            />
          ))}
        </section>
      </div>

      <details className="card limits">
        <summary>Giới hạn trung thực</summary>
        <ol>
          <li>Chỉ xác minh được những sự cố được ghi nhận công khai. Nếu provider không công bố sự cố và không có monitor hoặc archive nào ghi lại thì không có gì để đối chiếu.</li>
          <li>Trang status của provider do provider kiểm soát, có thể bỏ sót hoặc xoá sự cố. Nguồn độc lập thật sự là monitor bên thứ ba và bản lưu trữ archive có timestamp.</li>
          <li>LLM ước lượng tổng thời gian ngừng từ log sự cố có thể sai. Điều khoản SLA nên đơn giản và khách quan.</li>
          <li>Thiếu bằng chứng, mâu thuẫn, hoặc không có timestamp thì kết quả là SLA được đáp ứng — nghiêng về provider.</li>
          <li>Nhiều trang status render bằng JavaScript hoặc chặn truy cập tự động. Trang không đọc được thì giao dịch revert, thử lại được.</li>
          <li>Contract chỉ giữ tiền và phân xử. Việc cung cấp dịch vụ diễn ra ngoài chuỗi.</li>
          <li>Chống prompt injection chỉ giảm rủi ro.</li>
          <li>Mỗi thoả thuận chỉ đại diện 1 kỳ. Kỳ tiếp theo tạo thoả thuận mới.</li>
        </ol>
      </details>
    </div>
  );
}

function AgreementCard({ row, account, nowSec, busy, locked, onWrite, onCopy }) {
  const meta = STATUS_META[row.status] || { label: row.status, tone: 'muted' };
  const mineCustomer = sameAddress(account, row.customer);
  const mineProvider = sameAddress(account, row.provider);
  const periodEnd = BigInt(row.period_end || '0');
  const claimDeadline = BigInt(row.claim_deadline || '0');
  const staleDeadline = BigInt(row.stale_deadline || '0');
  const inClaimWindow = nowSec >= periodEnd && nowSec <= claimDeadline;
  const claimClosed = nowSec > claimDeadline;
  const disputeClosed = nowSec > staleDeadline;
  const [evidence, setEvidence] = useState(['']);
  const [refs, setRefs] = useState(['', '']);
  const [formError, setFormError] = useState('');
  const key = (name) => `${name}:${row.id}`;
  const isHttp = (url) => {
    const lower = url.toLowerCase();
    return lower.startsWith('http://') || lower.startsWith('https://');
  };

  const file = () => {
    const evidenceUrls = evidence.map((u) => u.trim()).filter(Boolean);
    const referenceUrls = refs.map((u) => u.trim()).filter(Boolean);
    if (evidenceUrls.length < 1 || referenceUrls.length < 2) {
      setFormError('Cần ít nhất 1 link bằng chứng và 2 link tham chiếu.');
      return;
    }
    if (![...evidenceUrls, ...referenceUrls].every(isHttp)) {
      setFormError('Mỗi link phải bắt đầu bằng http:// hoặc https://.');
      return;
    }
    setFormError('');
    onWrite(key('file'), 'Nộp khiếu nại', 'file_claim', [row.id, evidenceUrls, referenceUrls]);
  };

  const share = `UptimeGuard thoả thuận #${row.id}\nProvider: ${row.provider}\nSLA: ${row.sla_terms}\nPhí: ${formatWeiToGen(row.fee_amount)} GEN`;

  return (
    <article className="card agreement">
      <div className="meta">
        <span className="id">#{row.id}</span>
        <span className={`pill tone-${meta.tone}`}>{meta.label}</span>
      </div>
      <div className="kv">
        <div><b>{row.service_description}</b></div>
        <div className="terms-preview">{row.sla_terms}</div>
        <div>Phí {formatWeiToGen(row.fee_amount)} GEN · bồi hoàn {formatWeiToGen(row.breach_refund_amount)} GEN</div>
        <div className="hint">Customer {shortAddr(row.customer)} · Provider {shortAddr(row.provider)}</div>
        <div className="hint">Kết thúc kỳ {formatUnix(row.period_end)} · hạn khiếu nại {formatUnix(row.claim_deadline)}</div>
      </div>
      {row.verdict && (
        <div className="preview">
          <b>{row.verdict}</b> · độ tin cậy {row.confidence}
          <p>{row.verdict_reason}</p>
        </div>
      )}
      {row.settlement_kind && <PayoutLines row={row} />}

      <div className="actions">
        <button type="button" className="btn btn-ghost" onClick={() => onCopy(share)}><Copy size={14} /> Chia sẻ</button>
        {row.status === 'PENDING_ACCEPTANCE' && mineProvider && (
          <button className="btn btn-primary" disabled={locked || busy === key('accept')} onClick={() => onWrite(key('accept'), 'Chấp nhận', 'accept_agreement', [row.id])}>
            Chấp nhận điều khoản
          </button>
        )}
        {row.status === 'PENDING_ACCEPTANCE' && mineCustomer && (
          <button className="btn btn-danger" disabled={locked || busy === key('cancel')} onClick={() => onWrite(key('cancel'), 'Huỷ', 'cancel_unaccepted', [row.id])}>
            Huỷ và nhận lại phí
          </button>
        )}
        {row.status === 'CLAIM_FILED' && (
          <button className="btn btn-primary" disabled={locked || busy === key('resolve')} onClick={() => onWrite(key('resolve'), 'Phân xử', 'resolve_claim', [row.id])}>
            {busy === key('resolve') ? <Loader2 className="spin" size={16} /> : <Activity size={16} />}
            Yêu cầu AI phân xử
          </button>
        )}
        {row.status === 'ACTIVE' && claimClosed && (
          <button className="btn btn-warn" disabled={locked || busy === key('unclaimed')} onClick={() => onWrite(key('unclaimed'), 'Chốt thanh toán', 'settle_unclaimed', [row.id])}>
            Chốt thanh toán
          </button>
        )}
        {row.status === 'DISPUTED' && disputeClosed && (
          <button className="btn btn-warn" disabled={locked || busy === key('stale')} onClick={() => onWrite(key('stale'), 'Chốt thanh toán', 'settle_stale_dispute', [row.id])}>
            Chốt thanh toán
          </button>
        )}
        {row.status === 'PAYOUT_FAILED' && (
          <button className="btn btn-primary" disabled={locked || busy === key('retry')} onClick={() => onWrite(key('retry'), 'Thử lại', 'retry_resolution', [row.id])}>
            Thử lại
          </button>
        )}
      </div>

      {row.status === 'DISPUTED' && !disputeClosed && (
        <p className="hint"><Clock size={14} /> Còn {formatDuration(staleDeadline - nowSec)} để nộp lại, tới {formatUnix(row.stale_deadline)}.</p>
      )}

      {mineCustomer && ((row.status === 'ACTIVE' && inClaimWindow) || (row.status === 'DISPUTED' && !disputeClosed)) && (
        <div className="stack">
          <p className="hint">Hãy dùng ít nhất 1 monitor độc lập hoặc bản lưu trữ archive có timestamp, không chỉ trang status của provider. Thiếu bằng chứng đủ rõ sẽ được tính là SLA được đáp ứng.</p>
          <UrlEditor label="Link bằng chứng sự cố (ít nhất 1)" urls={evidence} onChange={setEvidence} />
          <UrlEditor label="Nguồn tham chiếu (ít nhất 2)" urls={refs} onChange={setRefs} />
          {formError && <p className="notice notice-err">{formError}</p>}
          <button className="btn btn-primary" disabled={locked || busy === key('file')} onClick={file}>
            {row.status === 'DISPUTED' ? 'Nộp lại khiếu nại' : 'Nộp khiếu nại'}
          </button>
        </div>
      )}
      {row.status === 'ACTIVE' && nowSec < periodEnd && (
        <p className="hint">Kỳ dịch vụ chưa kết thúc. Khiếu nại mở sau {formatUnix(row.period_end)}.</p>
      )}
    </article>
  );
}
