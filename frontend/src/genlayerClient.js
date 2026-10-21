import { createClient } from 'genlayer-js';
import { studionet as officialStudionet } from 'genlayer-js/chains';
import { ExecutionResult, TransactionStatus } from 'genlayer-js/types';
import { toHex, toRlp } from 'viem';
import { toWeiString } from './money.js';

export const studionet = officialStudionet || {
  id: 61999,
  name: 'GenLayer Studionet',
  rpcUrl: 'https://studio.genlayer.com/api',
  nativeCurrency: {
    name: 'GenLayer Token',
    symbol: 'GEN',
    decimals: 18
  }
};

const envAddress = String(import.meta.env.VITE_CONTRACT_ADDRESS || '').trim();
export const CONTRACT_ADDRESS = /^0x[0-9a-fA-F]{40}$/.test(envAddress) ? envAddress : '';

export const isContractConfigured = (addr = CONTRACT_ADDRESS) => /^0x[0-9a-fA-F]{40}$/.test(String(addr || '').trim());

const toAddress = (account) => {
  if (!account) return '';
  if (typeof account === 'string') return account;
  return account.address || '';
};

const toWriteAccount = (account) => {
  const address = toAddress(account);
  if (!address) return null;
  return { address };
};

export const getGenlayerClient = (account) => {
  try {
    const cfg = { chain: officialStudionet || studionet };
    const address = toAddress(account);
    if (address) cfg.account = address;
    if (typeof window !== 'undefined' && window.ethereum) cfg.provider = window.ethereum;
    return createClient(cfg);
  } catch (err) {
    console.warn('GenLayer client initialization fallback:', err);
    return null;
  }
};

const asPlain = (val) => {
  if (val instanceof Map) {
    const obj = {};
    for (const [k, v] of val.entries()) obj[String(k)] = asPlain(v);
    return obj;
  }
  if (Array.isArray(val)) return val.map(asPlain);
  return val;
};

export const formatWriteError = (err) => {
  const msg = String(err?.shortMessage || err?.details || err?.message || err || '');
  const low = msg.toLowerCase();
  if (low.includes('user rejected') || low.includes('user denied') || low.includes('rejected the request')) {
    return 'Bạn đã huỷ giao dịch trong MetaMask.';
  }
  if (low.includes('insufficient') || low.includes('funds')) {
    return 'Không đủ GEN cho phí kỳ cộng gas. Nạp ví từ GenLayer Studio → Accounts.';
  }
  if (low.includes('invalid address') || (low.includes('undefined') && low.includes('address'))) {
    return 'Chưa gắn được địa chỉ ví. Kết nối lại MetaMask trên GenLayer Studionet rồi thử lại.';
  }
  return msg || 'Giao dịch ghi thất bại.';
};

const toValueBigInt = (value) => {
  if (typeof value === 'bigint') return value < 0n ? 0n : value;
  if (typeof value === 'number') return 0n;
  const raw = String(value || '0x0').trim();
  if (raw === '' || raw === '0x' || raw === '0x0') return 0n;
  try {
    return BigInt(raw);
  } catch {
    return 0n;
  }
};

const isHexStub = (val) => typeof val === 'string' && /^0x[0-9a-fA-F]+$/.test(val);

const studionetChainIdHex = () => {
  const id = Number((officialStudionet || studionet).id || 61999);
  return `0x${id.toString(16)}`;
};

export const switchToGenlayerStudionet = async () => {
  if (typeof window === 'undefined' || !window.ethereum) return;
  const chainIdHex = studionetChainIdHex();
  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: chainIdHex }]
    });
  } catch (switchError) {
    if (switchError.code === 4902) {
      try {
        const chain = officialStudionet || studionet;
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: chainIdHex,
            chainName: chain.name || 'GenLayer Studionet',
            nativeCurrency: chain.nativeCurrency || { name: 'GenLayer Token', symbol: 'GEN', decimals: 18 },
            rpcUrls: chain.rpcUrls?.default?.http || ['https://studio.genlayer.com/api'],
            blockExplorerUrls: ['https://explorer-studio.genlayer.com']
          }]
        });
      } catch (addError) {
        console.warn('Could not add GenLayer Studionet to MetaMask:', addError);
      }
    }
  }
};

export const encodeGenLayerCalldata = (method, args = []) => {
  const BITS = 3, T_SPECIAL = 0, T_PINT = 1, T_NINT = 2, T_STR = 4, T_ARR = 5, T_MAP = 6;
  const SPECIAL_NULL = 0, SPECIAL_FALSE = 1 << BITS, SPECIAL_TRUE = 2 << BITS;

  function writeNum(to, n) {
    if (n === 0n) { to.push(0); return; }
    while (n > 0) {
      let cur = Number(n & 0x7fn); n >>= 7n;
      if (n > 0) cur |= 128;
      to.push(cur);
    }
  }
  function encodeNumWithType(to, n, type) { writeNum(to, (n << BigInt(BITS)) | BigInt(type)); }
  function encodeImpl(to, data) {
    if (data === null || data === undefined) { to.push(SPECIAL_NULL); return; }
    if (data === true) { to.push(SPECIAL_TRUE); return; }
    if (data === false) { to.push(SPECIAL_FALSE); return; }
    if (typeof data === 'number' || typeof data === 'bigint') {
      const n = BigInt(data);
      encodeNumWithType(to, n >= 0n ? n : -n - 1n, n >= 0n ? T_PINT : T_NINT);
      return;
    }
    if (typeof data === 'string') {
      const str = new TextEncoder().encode(data);
      encodeNumWithType(to, BigInt(str.length), T_STR);
      for (const c of str) to.push(c);
      return;
    }
    if (Array.isArray(data)) {
      encodeNumWithType(to, BigInt(data.length), T_ARR);
      for (const c of data) encodeImpl(to, c);
      return;
    }
    if (typeof data === 'object') {
      const keys = Object.keys(data);
      const entries = keys.map((k) => [new TextEncoder().encode(k), data[k]]);
      entries.sort((a, b) => {
        for (let i = 0; i < a[0].length && i < b[0].length; i++) {
          const diff = a[0][i] - b[0][i];
          if (diff !== 0) return diff;
        }
        return a[0].length - b[0].length;
      });
      encodeNumWithType(to, BigInt(entries.length), T_MAP);
      for (const [k, v] of entries) {
        writeNum(to, BigInt(k.length));
        for (const c of k) to.push(c);
        encodeImpl(to, v);
      }
    }
  }

  const arr = [];
  encodeImpl(arr, { method, args });
  return toRlp([toHex(new Uint8Array(arr))]);
};

const STUDIO_RPC = 'https://studio.genlayer.com/api';

const studioRpc = async (method, params = []) => {
  const res = await fetch(STUDIO_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
  }).then((r) => r.json());
  if (res?.error) throw new Error(res.error.message || JSON.stringify(res.error));
  return res?.result;
};

const waitForStudioEvmReceipt = async (txHash, maxRetries = 24, intervalMs = 2000) => {
  for (let i = 0; i < maxRetries; i++) {
    const receipt = await studioRpc('eth_getTransactionReceipt', [txHash]).catch(() => null);
    if (receipt) {
      const status = receipt.status;
      if (status === '0x0' || status === 0 || status === '0') {
        throw new Error('Giao dịch Studionet bị revert. Trạng thái contract không đổi.');
      }
      await new Promise((r) => setTimeout(r, 1500));
      return receipt;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Hết thời gian chờ biên nhận Studionet ${txHash}.`);
};

export const sendContractTransaction = async ({ from, to = CONTRACT_ADDRESS, functionName, args = [], value = '0x0' }) => {
  if (!isContractConfigured(to)) {
    throw new Error('Chưa có địa chỉ contract. Deploy trên GenLayer Studio, rồi đặt VITE_CONTRACT_ADDRESS.');
  }
  if (typeof window === 'undefined' || !window.ethereum) {
    throw new Error('Cần MetaMask để ký giao dịch GenLayer.');
  }
  const accs = await window.ethereum.request({ method: 'eth_requestAccounts' });
  const sender = toAddress(from) || (accs && accs[0]);
  if (!sender) throw new Error('Chưa kết nối ví. Hãy kết nối MetaMask trước.');
  await switchToGenlayerStudionet();
  const client = getGenlayerClient(sender);
  if (!client || !client.writeContract) throw new Error('Client ghi GenLayer không sẵn sàng.');
  try {
    return await client.writeContract({
      account: toWriteAccount(sender),
      address: to,
      functionName,
      args,
      value: toValueBigInt(value)
    });
  } catch (err) {
    throw new Error(formatWriteError(err));
  }
};

export const waitForFinalizedTx = async (txHash, maxRetries = 24, intervalMs = 2000) => {
  if (!txHash) throw new Error('Thiếu mã giao dịch.');
  let evmReceipt = null;
  try {
    evmReceipt = await waitForStudioEvmReceipt(txHash, maxRetries, intervalMs);
  } catch (studioErr) {
    const studioMsg = String(studioErr?.message || '').toLowerCase();
    if (studioMsg.includes('revert')) throw studioErr;
  }
  const client = getGenlayerClient();
  if (client && client.waitForTransactionReceipt) {
    try {
      const receipt = await client.waitForTransactionReceipt({
        hash: txHash,
        status: TransactionStatus.ACCEPTED,
        retries: Math.min(maxRetries, 16),
        interval: intervalMs
      });
      const execName = receipt?.txExecutionResultName || receipt?.executionResult || receipt?.txExecutionResult;
      const execStr = String(execName || '').toUpperCase();
      if (execName === ExecutionResult.FINISHED_WITH_ERROR || execStr.includes('FINISHED_WITH_ERROR')) {
        const detail = receipt?.txExecutionError || receipt?.stderr || '';
        throw new Error('Contract chạy lỗi (không ACCEPTED). Trạng thái không đổi. ' + String(detail));
      }
      return receipt;
    } catch (err) {
      const msg = String(err?.message || '');
      if (msg.includes('không ACCEPTED') || msg.includes('not ACCEPTED') || msg.includes('chạy lỗi')) throw err;
    }
  }
  if (evmReceipt) return evmReceipt;
  throw new Error('Hết thời gian chờ trạng thái ACCEPTED trên GenLayer.');
};

export const readContractState = async (functionName, args = [], targetAddress = CONTRACT_ADDRESS) => {
  const addr = targetAddress || CONTRACT_ADDRESS;
  if (!isContractConfigured(addr)) return null;
  try {
    const client = getGenlayerClient();
    if (client && client.readContract) {
      const result = await client.readContract({
        address: addr,
        functionName,
        args,
        stateStatus: 'accepted',
        jsonSafeReturn: true
      });
      if (isHexStub(result)) return null;
      return asPlain(result);
    }
  } catch (err) {
    console.warn(`readContract ${functionName} note:`, err);
  }
  try {
    const calldata = encodeGenLayerCalldata(functionName, args);
    const res = await fetch(STUDIO_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: addr, data: calldata }, 'latest']
      })
    }).then((r) => r.json());
    return res?.result;
  } catch (err) {
    console.warn('eth_call RPC error:', err);
    return null;
  }
};

export const toCount = (val) => {
  if (typeof val === 'bigint') return val < 0n ? 0n : val;
  if (typeof val === 'number' && Number.isInteger(val) && val >= 0) return BigInt(val);
  const str = String(val ?? '').trim();
  if (/^\d+$/.test(str)) return BigInt(str);
  const asWei = toWeiString(val);
  return /^\d+$/.test(asWei) ? BigInt(asWei) : 0n;
};
