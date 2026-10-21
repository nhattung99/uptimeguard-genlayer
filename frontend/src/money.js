const WEI_PER_GEN = 1000000000000000000n;

export const parseGenToWei = (genAmountStr) => {
  if (!genAmountStr) return 0n;
  const str = String(genAmountStr).trim();
  if (!/^\d+(\.\d+)?$/.test(str)) return 0n;
  const [intPart, fracPartRaw = ""] = str.split(".");
  const fracPart = (fracPartRaw + "0".repeat(18)).slice(0, 18);
  const wei = BigInt(intPart + fracPart);
  return wei > 0n ? wei : 0n;
};

export const formatWeiToGen = (val) => {
  if (val === null || val === undefined || val === '') return '0';
  let wei;
  try { wei = BigInt(val); } catch { return String(val); }
  if (wei === 0n) return '0';
  const intPart = wei / WEI_PER_GEN;
  const fracPart = wei % WEI_PER_GEN;
  if (fracPart === 0n) return intPart.toString();
  const fracStr = fracPart.toString().padStart(18, "0").replace(/0+$/, "");
  return fracStr.length > 0 ? `${intPart}.${fracStr}` : intPart.toString();
};

export const computeBreachPreview = (feeWei, refundWei) => {
  const fee = BigInt(feeWei);
  const refund = BigInt(refundWei);
  return { customerGets: refund, providerGets: fee - refund };
};

export const percentOfWei = (feeWei, percentInt) => {
  const fee = BigInt(feeWei);
  const pct = BigInt(percentInt);
  if (pct <= 0n || pct >= 100n) return 0n;
  return (fee * pct) / 100n;
};

export const settlementShares = (kind, feeWei, refundWei) => {
  const fee = BigInt(feeWei);
  const refund = BigInt(refundWei);
  if (kind === 'PROVIDER_FULL') return { providerGets: fee, customerGets: 0n };
  if (kind === 'SPLIT_BREACH') return computeBreachPreview(fee, refund);
  if (kind === 'CUSTOMER_FULL') return { providerGets: 0n, customerGets: fee };
  return { providerGets: 0n, customerGets: 0n };
};

export const isValidRefund = (feeWei, refundWei) => {
  const fee = BigInt(feeWei);
  const refund = BigInt(refundWei);
  return fee > 0n && refund > 0n && refund < fee;
};

export const sanitizeGenInput = (raw) => {
  const str = String(raw ?? '');
  let out = '';
  let seenDot = false;
  let fracCount = 0;
  for (const ch of str) {
    if (ch >= '0' && ch <= '9') {
      if (seenDot) {
        if (fracCount >= 18) continue;
        fracCount += 1;
      }
      out += ch;
    } else if (ch === '.' && !seenDot) {
      seenDot = true;
      out += ch;
    }
  }
  return out;
};

export const toWeiString = (val) => {
  if (val === null || val === undefined || val === '') return '0';
  if (typeof val === 'bigint') return val.toString();
  if (typeof val === 'number') return '0';
  const str = String(val).trim();
  if (!/^\d+$/.test(str)) return '0';
  return str;
};

export const unixNowSeconds = () => BigInt(Date.now()) / 1000n;

export const periodEndFromDays = (days) => unixNowSeconds() + (BigInt(String(days)) * 86400n);

export const secondsFromDays = (days) => BigInt(String(days)) * 86400n;
