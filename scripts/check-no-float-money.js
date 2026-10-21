const fs = require('fs');
const path = require('path');

const WINDOW = 12;
const BLOCK_MAX = 40;
const SRC = path.join(__dirname, '..', 'frontend', 'src');

function getFilesRecursively(dir) {
  let results = [];
  for (const file of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) results = results.concat(getFilesRecursively(fullPath));
    else if (file.endsWith('.js') || file.endsWith('.jsx')) results.push(fullPath);
  }
  return results;
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function enclosingBlockRange(lines, index) {
  let start = index;
  let depth = 0;
  for (let i = index; i >= 0 && (index - i) < BLOCK_MAX; i--) {
    const opens = (lines[i].match(/\{/g) || []).length;
    const closes = (lines[i].match(/\}/g) || []).length;
    depth += closes - opens;
    start = i;
    if (depth > 0) continue;
    if (opens > 0) break;
  }
  let end = index;
  depth = 0;
  for (let i = index; i < lines.length && (i - index) < BLOCK_MAX; i++) {
    const opens = (lines[i].match(/\{/g) || []).length;
    const closes = (lines[i].match(/\}/g) || []).length;
    depth += opens - closes;
    end = i;
    if (i > index && depth <= 0 && closes > 0) break;
  }
  return { start, end };
}

function runCheck() {
  console.log('Running prebuild check: Auditing codebase for floating-point money math...');
  if (!fs.existsSync(SRC)) {
    console.error('[BUILD REJECTED] Could not locate frontend/src for the float-money audit.');
    process.exit(1);
  }
  const files = getFilesRecursively(SRC);
  let failed = false;
  let hitCount = 0;
  const floatRegex = /\bparseFloat\s*\(|Math\.round\s*\(|Math\.floor\s*\(|Math\.ceil\s*\(/;
  const moneyRegex = /fee|refund|amount|payout|balance|wei|gen/i;

  files.forEach((file) => {
    const relativePath = path.relative(path.join(__dirname, '..'), file);
    const content = stripComments(fs.readFileSync(file, 'utf-8'));
    const lines = content.split('\n');
    lines.forEach((line, index) => {
      if (!floatRegex.test(line)) return;
      const windowStart = Math.max(0, index - WINDOW);
      const windowEnd = Math.min(lines.length - 1, index + WINDOW);
      const windowText = lines.slice(windowStart, windowEnd + 1).join('\n');
      const block = enclosingBlockRange(lines, index);
      const blockText = lines.slice(block.start, block.end + 1).join('\n');
      const sameLine = moneyRegex.test(line);
      const nearWindow = moneyRegex.test(windowText);
      const nearBlock = moneyRegex.test(blockText);
      if (sameLine || nearWindow || nearBlock) {
        hitCount += 1;
        failed = true;
        const reason = sameLine ? 'same line' : (nearWindow ? `within ±${WINDOW} lines` : 'same code block');
        console.error(`[ERROR] Float operation near monetary identifier (${reason}) in ${relativePath}:${index + 1}`);
        console.error(`  > Line: ${line.trim()}`);
      }
    });
  });

  if (failed) {
    console.error(`[BUILD REJECTED] ${hitCount} floating-point operation(s) detected near monetary variables.`);
    process.exit(1);
  }
  console.log('[PASS] No floating-point operations detected on monetary variables. Strict BigInt integrity verified.');
  process.exit(0);
}

runCheck();
