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
  { id: 'down-30m', label: 'Total downtime ≤ 30 minutes', terms: 'Total downtime <= 30 minutes in the period' },
  { id: 'down-2h', label: 'Total downtime ≤ 2 hours', terms: 'Total downtime <= 2 hours in the period' },
  { id: 'down-4h', label: 'Total downtime ≤ 4 hours', terms: 'Total downtime <= 4 hours in the period' },
  { id: 'inc-15', label: 'No single incident longer than 15 minutes', terms: 'No single incident lasts longer than 15 minutes' },
  { id: 'inc-30', label: 'No single incident longer than 30 minutes', terms: 'No single incident lasts longer than 30 minutes' },
  { id: 'inc-60', label: 'No single incident longer than 60 minutes', terms: 'No single incident lasts longer than 60 minutes' },
  { id: 'custom', label: 'Other terms', terms: '' }
];

const PERIODS = [
  { days: '7', label: '7 days' },
  { days: '30', label: '30 days' },
  { days: '90', label: '90 days' }
];

const WINDOWS = [
  { days: '3', label: '3 days' },
  { days: '7', label: '7 days' },
  { days: '14', label: '14 days' }
];

const CONFIRMED_STATUSES = {
  accept_agreement: ['ACTIVE'],
  cancel_unaccepted: ['PAYOUT_PENDING', 'PAYOUT_FAILED', 'CANCELLED_REFUNDED'],
  file_claim: ['CLAIM_FILED'],
  replace_claim_evidence: ['CLAIM_FILED'],
  resolve_claim: ['DISPUTED', 'PAYOUT_PENDING', 'PAYOUT_FAILED', 'RESOLVED_SLA_MET', 'RESOLVED_SLA_BREACHED'],
  settle_unclaimed: ['PAYOUT_PENDING', 'PAYOUT_FAILED', 'SETTLED_NO_CLAIM'],
  settle_stale_dispute: ['PAYOUT_PENDING', 'PAYOUT_FAILED', 'SETTLED_STALE_DISPUTE'],
  settle_inconclusive: ['PAYOUT_PENDING', 'PAYOUT_FAILED', 'SETTLED_INCONCLUSIVE'],
  reconcile_payout: ['PAYOUT_PENDING', 'PAYOUT_FAILED', 'RESOLVED_SLA_MET', 'RESOLVED_SLA_BREACHED', 'SETTLED_NO_CLAIM', 'SETTLED_STALE_DISPUTE', 'SETTLED_INCONCLUSIVE', 'CANCELLED_REFUNDED'],
  retry_resolution: ['PAYOUT_PENDING', 'PAYOUT_FAILED', 'RESOLVED_SLA_MET', 'RESOLVED_SLA_BREACHED', 'SETTLED_NO_CLAIM', 'SETTLED_STALE_DISPUTE', 'SETTLED_INCONCLUSIVE', 'CANCELLED_REFUNDED']
};

const FEE_CHIPS = ['0.5', '1', '2', '5', '10'];
const REFUND_PCTS = [25, 50, 75];

const STATUS_META = {
  PENDING_ACCEPTANCE: { label: 'Waiting for the provider', tone: 'wait' },
  ACTIVE: { label: 'Active', tone: 'live' },
  CLAIM_FILED: { label: 'Claim filed', tone: 'claim' },
  DISPUTED: { label: 'Needs clearer evidence', tone: 'warn' },
  RESOLVED_SLA_MET: { label: 'SLA met — provider paid in full', tone: 'ok' },
  RESOLVED_SLA_BREACHED: { label: 'SLA breached — fee split', tone: 'bad' },
  SETTLED_NO_CLAIM: { label: 'No claim — provider paid in full', tone: 'ok' },
  SETTLED_STALE_DISPUTE: { label: 'Dispute expired — provider paid in full', tone: 'ok' },
  CANCELLED_REFUNDED: { label: 'Cancelled — customer refunded in full', tone: 'muted' },
  PAYOUT_FAILED: { label: 'Payout incomplete', tone: 'bad' },
  PAYOUT_PENDING: { label: 'Payout emitted, delivery unconfirmed', tone: 'warn' },
  SETTLED_INCONCLUSIVE: { label: 'Unresolved claim timed out — provider paid in full', tone: 'ok' }
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
    settled: Boolean(raw.settled),
    provider_in_flight: Boolean(raw.provider_in_flight),
    customer_in_flight: Boolean(raw.customer_in_flight),
    provider_credit: toWeiString(raw.provider_credit),
    customer_credit: toWeiString(raw.customer_credit)
  };
};

function PasteButton({ onPaste }) {
  return (
    <button type="button" className="btn btn-ghost" onClick={onPaste} title="Paste from clipboard">
      <ClipboardPaste size={16} /> Paste
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
        Add link
      </button>
    </div>
  );
}

function PayoutLines({ row }) {
  const shares = settlementShares(row.settlement_kind, row.fee_amount, row.breach_refund_amount);
  const line = (label, owed, paid, inFlight) => {
    if (owed === 0n) return `${label}: nothing to receive`;
    const shown = `${formatWeiToGen(owed)} GEN`;
    if (paid) return `${label}: received ${shown}`;
    if (inFlight) return `${label}: emitted ${shown}, delivery not confirmed`;
    return `${label}: waiting on ${shown}`;
  };
  return (
    <div className="preview">
      <p>{line('Provider', shares.providerGets, row.provider_paid, row.provider_in_flight)}</p>
      <p>{line('Customer', shares.customerGets, row.customer_refunded, row.customer_in_flight)}</p>
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
      setNotice({ kind: 'err', text: 'The browser blocked clipboard access. Paste the text yourself.' });
    }
  };

  const loadAgreements = useCallback(async () => {
    if (!configured) {
      setAgreements([]);
      return [];
    }
    const countRaw = await readContractState('get_agreement_count', []);
    const count = toCount(countRaw);
    const rows = [];
    for (let i = 0n; i < count; i += 1n) {
      const raw = await readContractState('get_agreement', [i.toString()]);
      const row = normalizeAgreement(raw, i.toString());
      if (row) rows.push(row);
    }
    const ordered = rows.reverse();
    setAgreements(ordered);
    return ordered;
  }, [configured]);

  useEffect(() => {
    loadAgreements().catch((err) => {
      console.warn(err);
      setNotice({ kind: 'err', text: 'Could not read the agreement list.' });
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
      setNotice({ kind: 'err', text: 'MetaMask is not available in this browser.' });
      return;
    }
    await switchToGenlayerStudionet();
    const accs = await window.ethereum.request({ method: 'eth_requestAccounts' });
    setAccount(accs && accs[0] ? accs[0] : '');
  };

  const runWrite = async (key, title, functionName, args, valueWei = 0n) => {
    const beforeIds = new Set(agreements.map((item) => item.id));
    setBusy(key);
    setNotice({ kind: 'ok', text: `${title}: waiting for your signature, then for consensus acceptance…` });
    try {
      const hash = await sendContractTransaction({
        from: account,
        functionName,
        args,
        value: valueWei
      });
      setNotice({ kind: 'ok', text: `${title}: consensus accepted it. Waiting until the transaction is finalized…` });
      await waitForFinalizedTx(hash);
      const rows = await loadAgreements();
      const targetId = functionName === 'create_agreement' ? '' : String(args[0] || '');
      const row = targetId ? (rows || []).find((item) => item.id === targetId) : null;
      const allowed = CONFIRMED_STATUSES[functionName];
      const confirmed = functionName === 'create_agreement'
        ? (rows || []).some((item) => !beforeIds.has(item.id) && item.status === 'PENDING_ACCEPTANCE')
        : Boolean(row) && (!allowed || allowed.includes(row.status));
      if (!confirmed) {
        setNotice({
          kind: 'err',
          text: `${title} is finalized, but the contract state is ${row ? row.status : 'not the expected agreement'}. Completion is not confirmed.`
        });
        return;
      }
      if (row && row.status === 'PAYOUT_PENDING') {
        setNotice({
          kind: 'ok',
          text: `${title} is finalized. The transfer was emitted, and delivery is not confirmed yet. Click Reconcile delivery.`
        });
        return;
      }
      setNotice({
        kind: 'ok',
        text: row
          ? `${title} is finalized and the contract status is ${row.status}.`
          : `${title} is finalized and the new agreement is on the contract.`
      });
    } catch (err) {
      setNotice({ kind: 'err', text: formatWriteError(err) });
    } finally {
      setBusy('');
    }
  };

  const onCreate = async (e) => {
    e.preventDefault();
    if (!isAddress(provider)) {
      setNotice({ kind: 'err', text: 'The provider address must be 0x followed by 40 hex characters.' });
      return;
    }
    if (!description.trim()) {
      setNotice({ kind: 'err', text: 'The service description cannot be empty.' });
      return;
    }
    if (!terms) {
      setNotice({ kind: 'err', text: 'Choose an SLA preset or enter other terms.' });
      return;
    }
    if (!refundOk) {
      setNotice({ kind: 'err', text: 'The refund must be greater than 0 and less than the period fee.' });
      return;
    }
    if (sameAddress(provider, account)) {
      setNotice({ kind: 'err', text: 'The customer and the provider must be different addresses.' });
      return;
    }
    await runWrite(
      'create',
      'Create agreement',
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
            <p>Hosting and API fee escrow — a binary SLA verdict on GenLayer</p>
          </div>
        </div>
        <div className="nav-actions">
          <span className="chain-pill">{studionet.name || 'Studionet'} · {String(studionet.id)}</span>
          {account ? <span className="addr-pill">{shortAddr(account)}</span> : null}
          <button className="btn btn-primary" onClick={connectWallet}>
            <Wallet size={16} /> {account ? 'Switch wallet' : 'Connect MetaMask'}
          </button>
        </div>
      </header>

      <div className="banner banner-free">
        <Shield size={18} />
        <p>Free to use — you only pay GenLayer network gas when you sign a transaction. There is no other platform fee.</p>
      </div>

      {!configured && (
        <div className="banner banner-warn">
          <div>
            <strong>No contract address yet</strong>
            <p>You can still preview the fee and the refund. Signing stays locked until a Studionet deploy succeeds and <code>VITE_CONTRACT_ADDRESS</code> is set. The page does not go blank.</p>
          </div>
        </div>
      )}

      {notice && <div className={`notice notice-${notice.kind === 'err' ? 'err' : 'ok'}`}>{notice.text}</div>}

      <div className="layout">
        <form className="panel stack" onSubmit={onCreate}>
          <h2>Create this period&apos;s agreement</h2>
          <p className="hint">The provider must accept the terms before the period ends. The terms, the refund, and the end date cannot be changed after creation.</p>

          <label>
            <span>Provider address</span>
            <div className="row">
              <input value={provider} onChange={(e) => setProvider(e.target.value.trim())} placeholder="0x…" />
              <PasteButton onPaste={() => pasteInto(setProvider)} />
            </div>
          </label>

          <label>
            <span>Service description</span>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Payments API, region sg, hostname api.example.com" />
          </label>

          <label>
            <span>SLA terms</span>
            <select value={slaId} onChange={(e) => setSlaId(e.target.value)}>
              {SLA_PRESETS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
          {preset.id === 'custom' && (
            <label>
              <span>Other terms (short)</span>
              <input value={customTerms} onChange={(e) => setCustomTerms(e.target.value)} placeholder="Total downtime <= 60 minutes in the period" />
            </label>
          )}
          <p className="hint">Simpler, objective terms produce a more reliable verdict.</p>
          {terms && <p className="terms-preview">{terms}</p>}

          <label>
            <span>Period length</span>
            <select value={periodDays} onChange={(e) => setPeriodDays(e.target.value)}>
              {PERIODS.map((item) => <option key={item.days} value={item.days}>{item.label}</option>)}
            </select>
          </label>
          <label>
            <span>Claim window after the period ends</span>
            <select value={windowDays} onChange={(e) => setWindowDays(e.target.value)}>
              {WINDOWS.map((item) => <option key={item.days} value={item.days}>{item.label}</option>)}
            </select>
          </label>

          <div>
            <span className="field-label">Period fee (GEN)</span>
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
            <span className="field-label">Refund if the SLA is breached</span>
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
                Other amount
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
              If the SLA is breached: you get {formatWeiToGen(preview.customerGets)} GEN back, and the provider gets {formatWeiToGen(preview.providerGets)} GEN. Otherwise the provider receives the full fee.
            </div>
          )}

          <button className="btn btn-primary" type="submit" disabled={locked || busy === 'create' || !refundOk}>
            {busy === 'create' ? <Loader2 className="spin" size={16} /> : <Shield size={16} />}
            Send the fee and create the agreement
          </button>
          {locked && <p className="hint">{configured ? 'Connect a Studionet wallet to sign.' : 'Set the contract address before signing.'}</p>}
        </form>

        <section>
          <div className="list-head">
            <h2>Agreements</h2>
            <button className="btn btn-ghost" onClick={() => loadAgreements()} disabled={!configured || Boolean(busy)}>
              <RefreshCw size={16} /> Refresh
            </button>
          </div>
          {!configured && <div className="card"><p className="hint">No contract address, so there is no on-chain list yet.</p></div>}
          {configured && agreements.length === 0 && <div className="card"><p className="hint">No agreements yet.</p></div>}
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
                  setNotice({ kind: 'ok', text: 'Copied.' });
                } catch {
                  setNotice({ kind: 'err', text: 'Could not copy. Select the text and copy it yourself.' });
                }
              }}
            />
          ))}
        </section>
      </div>

      <details className="card limits">
        <summary>Honest limits</summary>
        <ol>
          <li>Only publicly recorded incidents can be checked. If the provider never publishes an incident and no monitor or archive recorded it, there is nothing to compare.</li>
          <li>The provider controls its own status page and can omit or delete incidents. A real independent source is a third-party monitor or a timestamped archive.</li>
          <li>An LLM can misread total downtime from incident logs. Keep the SLA terms simple and objective.</li>
          <li>Missing, contradictory, or untimestamped evidence is treated as the SLA being met. That leans toward the provider.</li>
          <li>Many status pages render with JavaScript or block automated access. If a page cannot be read, the transaction reverts and can be retried.</li>
          <li>The contract only holds the fee and adjudicates. The service itself happens off-chain.</li>
          <li>The prompt-injection defense only reduces risk.</li>
          <li>Each agreement covers one period. The next period needs a new agreement.</li>
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
      setFormError('Provide at least 1 evidence link and 2 reference links.');
      return;
    }
    if (![...evidenceUrls, ...referenceUrls].every(isHttp)) {
      setFormError('Every link must start with http:// or https://.');
      return;
    }
    setFormError('');
    if (row.status === 'CLAIM_FILED') {
      onWrite(key('replace'), 'Replace evidence', 'replace_claim_evidence', [row.id, evidenceUrls, referenceUrls]);
      return;
    }
    onWrite(key('file'), 'File claim', 'file_claim', [row.id, evidenceUrls, referenceUrls]);
  };

  const share = `UptimeGuard agreement #${row.id}\nProvider: ${row.provider}\nSLA: ${row.sla_terms}\nFee: ${formatWeiToGen(row.fee_amount)} GEN`;

  return (
    <article className="card agreement">
      <div className="meta">
        <span className="id">#{row.id}</span>
        <span className={`pill tone-${meta.tone}`}>{meta.label}</span>
      </div>
      <div className="kv">
        <div><b>{row.service_description}</b></div>
        <div className="terms-preview">{row.sla_terms}</div>
        <div>Fee {formatWeiToGen(row.fee_amount)} GEN · refund {formatWeiToGen(row.breach_refund_amount)} GEN</div>
        <div className="hint">Customer {shortAddr(row.customer)} · Provider {shortAddr(row.provider)}</div>
        <div className="hint">Period ends {formatUnix(row.period_end)} · claim deadline {formatUnix(row.claim_deadline)}</div>
      </div>
      {row.verdict && (
        <div className="preview">
          <b>{row.verdict}</b> · confidence {row.confidence}
          <p>{row.verdict_reason}</p>
        </div>
      )}
      {row.settlement_kind && <PayoutLines row={row} />}

      <div className="actions">
        <button type="button" className="btn btn-ghost" onClick={() => onCopy(share)}><Copy size={14} /> Share</button>
        {row.status === 'PENDING_ACCEPTANCE' && mineProvider && (
          <button className="btn btn-primary" disabled={locked || busy === key('accept')} onClick={() => onWrite(key('accept'), 'Accept', 'accept_agreement', [row.id])}>
            Accept terms
          </button>
        )}
        {row.status === 'PENDING_ACCEPTANCE' && mineCustomer && (
          <button className="btn btn-danger" disabled={locked || busy === key('cancel')} onClick={() => onWrite(key('cancel'), 'Cancel', 'cancel_unaccepted', [row.id])}>
            Cancel and refund the fee
          </button>
        )}
        {row.status === 'CLAIM_FILED' && !disputeClosed && (
          <button className="btn btn-primary" disabled={locked || busy === key('resolve')} onClick={() => onWrite(key('resolve'), 'Resolve', 'resolve_claim', [row.id])}>
            {busy === key('resolve') ? <Loader2 className="spin" size={16} /> : <Activity size={16} />}
            Ask the AI to adjudicate
          </button>
        )}
        {row.status === 'CLAIM_FILED' && disputeClosed && (
          <button className="btn btn-warn" disabled={locked || busy === key('inconclusive')} onClick={() => onWrite(key('inconclusive'), 'Settle unresolved claim', 'settle_inconclusive', [row.id])}>
            Settle unresolved claim
          </button>
        )}
        {row.status === 'ACTIVE' && claimClosed && (
          <button className="btn btn-warn" disabled={locked || busy === key('unclaimed')} onClick={() => onWrite(key('unclaimed'), 'Settle', 'settle_unclaimed', [row.id])}>
            Settle payout
          </button>
        )}
        {row.status === 'DISPUTED' && disputeClosed && (
          <button className="btn btn-warn" disabled={locked || busy === key('stale')} onClick={() => onWrite(key('stale'), 'Settle', 'settle_stale_dispute', [row.id])}>
            Settle payout
          </button>
        )}
        {row.status === 'PAYOUT_PENDING' && (
          <button className="btn btn-primary" disabled={locked || busy === key('reconcile')} onClick={() => onWrite(key('reconcile'), 'Reconcile delivery', 'reconcile_payout', [row.id])}>
            Reconcile delivery
          </button>
        )}
        {row.status === 'PAYOUT_FAILED' && (
          <button className="btn btn-primary" disabled={locked || busy === key('retry')} onClick={() => onWrite(key('retry'), 'Retry', 'retry_resolution', [row.id])}>
            Try again
          </button>
        )}
      </div>

      {row.status === 'DISPUTED' && !disputeClosed && (
        <p className="hint"><Clock size={14} /> {formatDuration(staleDeadline - nowSec)} left to refile, until {formatUnix(row.stale_deadline)}.</p>
      )}
      {row.status === 'CLAIM_FILED' && !disputeClosed && (
        <p className="hint"><Clock size={14} /> Evidence can be replaced until {formatUnix(row.stale_deadline)}. After that, anyone can settle the unresolved claim.</p>
      )}

      {mineCustomer && ((row.status === 'ACTIVE' && inClaimWindow) || ((row.status === 'DISPUTED' || row.status === 'CLAIM_FILED') && !disputeClosed)) && (
        <div className="stack">
          <p className="hint">Use at least one independent monitor or a timestamped archive, not only the provider&apos;s status page. Evidence that is not clear enough is treated as the SLA being met.</p>
          <UrlEditor label="Incident evidence links (at least 1)" urls={evidence} onChange={setEvidence} />
          <UrlEditor label="Reference sources (at least 2)" urls={refs} onChange={setRefs} />
          {formError && <p className="notice notice-err">{formError}</p>}
          <button className="btn btn-primary" disabled={locked || busy === key('file') || busy === key('replace')} onClick={file}>
            {row.status === 'DISPUTED' ? 'Refile the claim' : row.status === 'CLAIM_FILED' ? 'Replace evidence links' : 'File a claim'}
          </button>
        </div>
      )}
      {row.status === 'ACTIVE' && nowSec < periodEnd && (
        <p className="hint">The service period has not ended. Claims open after {formatUnix(row.period_end)}.</p>
      )}
    </article>
  );
}
