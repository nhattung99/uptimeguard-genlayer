import {
  parseGenToWei,
  formatWeiToGen,
  computeBreachPreview,
  percentOfWei,
  settlementShares,
  isValidRefund
} from '../money.js';

function runUnitConversionTests() {
  console.log('Starting Precision Unit Conversion Tests...');

  const smallestWei = parseGenToWei('0.000000000000000001');
  if (smallestWei !== 1n) throw new Error(`Test 1 Failed: expected 1n, got ${smallestWei}`);
  if (formatWeiToGen(1n) !== '0.000000000000000001') throw new Error(`Test 1 Format Failed: got ${formatWeiToGen(1n)}`);

  const pointOneWei = parseGenToWei('0.1');
  if (pointOneWei !== 100000000000000000n) throw new Error(`Test 2 Failed: got ${pointOneWei}`);
  if (formatWeiToGen(100000000000000000n) !== '0.1') throw new Error(`Test 2 Format Failed: got ${formatWeiToGen(100000000000000000n)}`);

  const millionWei = parseGenToWei('1000000');
  if (millionWei !== 1000000000000000000000000n) throw new Error(`Test 3 Failed: got ${millionWei}`);
  if (formatWeiToGen(1000000000000000000000000n) !== '1000000') throw new Error('Test 3 Format Failed');

  const testValues = ['1', '0.5', '100.25', '0.000001', '30000', '123.456'];
  for (const val of testValues) {
    const formatted = formatWeiToGen(parseGenToWei(val));
    if (formatted !== val) throw new Error(`Round-trip Failed for ${val}: got ${formatted}`);
  }

  const stewardWei = parseGenToWei('123.456');
  if (stewardWei !== 123456000000000000000n) throw new Error(`Test 5 Failed: got ${stewardWei}`);
  if (formatWeiToGen(stewardWei) !== '123.456') throw new Error('Test 5 Format Failed');

  const fee = parseGenToWei('4');
  const quarter = percentOfWei(fee, 25);
  const half = percentOfWei(fee, 50);
  const three = percentOfWei(fee, 75);
  if (quarter !== parseGenToWei('1')) throw new Error(`25% chip failed: ${quarter}`);
  if (half !== parseGenToWei('2')) throw new Error(`50% chip failed: ${half}`);
  if (three !== parseGenToWei('3')) throw new Error(`75% chip failed: ${three}`);
  if (percentOfWei(3n, 25) !== 0n) throw new Error('Integer division of a tiny fee must not round up');

  const preview = computeBreachPreview(fee, quarter);
  if (preview.customerGets !== quarter || preview.providerGets !== fee - quarter) {
    throw new Error('Breach preview does not match contract split');
  }
  const shares = settlementShares('SPLIT_BREACH', fee, quarter);
  if (shares.customerGets !== preview.customerGets || shares.providerGets !== preview.providerGets) {
    throw new Error('settlementShares diverged from computeBreachPreview');
  }
  const full = settlementShares('PROVIDER_FULL', fee, quarter);
  if (full.providerGets !== fee || full.customerGets !== 0n) throw new Error('PROVIDER_FULL share failed');
  const refundAll = settlementShares('CUSTOMER_FULL', fee, quarter);
  if (refundAll.customerGets !== fee || refundAll.providerGets !== 0n) throw new Error('CUSTOMER_FULL share failed');
  if (!isValidRefund(fee, quarter) || isValidRefund(fee, fee) || isValidRefund(fee, 0n)) {
    throw new Error('isValidRefund bounds failed');
  }

  console.log('All Precision Unit Conversion Tests Passed 100%!');
}

runUnitConversionTests();
