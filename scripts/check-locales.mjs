#!/usr/bin/env node
/**
 * check-locales.mjs
 *
 * Validates that all locale files under src/locales/ are in sync with the
 * canonical reference (en.ts) at three levels:
 *
 *   1. Line count       – every file must have exactly the same number of lines.
 *   2. Key set          – every file must contain the same set of keys (no more,
 *                         no fewer).
 *   3. Key order        – keys must appear in the same *sequence* across all
 *                         files.  When a divergence is found the report pinpoints
 *                         the exact line where the order first breaks.
 *
 * en.ts is treated as the canonical reference.
 *
 * Usage:
 *   node scripts/check-locales.mjs
 */

import { readFileSync, readdirSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = resolve(__dirname, '../src/locales');
const REFERENCE_LOCALE = 'en';

// ── Colour helpers ──────────────────────────────────────────────────────────

const C = {
  reset:  '\x1b[0m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
};

// ── 1. Collect all *.ts locale files ────────────────────────────────────────

const files = readdirSync(LOCALES_DIR)
  .filter(f => f.endsWith('.ts'))
  .sort();

if (files.length === 0) {
  console.error(`${C.red}No locale files found in ${LOCALES_DIR}${C.reset}`);
  process.exit(1);
}

const filePaths = /** @type {Map<string, string>} */ new Map();
for (const f of files) {
  filePaths.set(f.replace(/\.ts$/, ''), join(LOCALES_DIR, f));
}

// ── 2. Parse helpers ────────────────────────────────────────────────────────

const KEY_RE = /^\s*['"]([^'"]+)['"]\s*:/;

/**
 * Parse a locale file and return:
 *   lineCount  – total lines
 *   keys       – ordered array of key names (definition order)
 *   keyLines   – Map<key, lineNumber>  (1-indexed)
 *   keySet     – Set<string>
 *
 * @param {string} filePath
 */
function parseLocaleFile(filePath) {
  const raw = readFileSync(filePath, 'utf8');
  const lines = raw.split('\n');
  /** @type {string[]} */
  const keys = [];
  /** @type {Map<string, number>} */
  const keyLines = new Map();
  /** @type {Set<string>} */
  const keySet = new Set();

  for (let i = 0; i < lines.length; i++) {
    const m = KEY_RE.exec(lines[i]);
    if (m) {
      const key = m[1];
      keys.push(key);
      keyLines.set(key, i + 1); // 1-indexed
      keySet.add(key);
    }
  }

  return { lines, keys, keyLines, keySet, lineCount: lines.length };
}

// ── 3. Parse reference (en.ts) ──────────────────────────────────────────────

const refPath = filePaths.get(REFERENCE_LOCALE);
if (!refPath) {
  console.error(`${C.red}Reference locale "${REFERENCE_LOCALE}" not found.${C.reset}`);
  process.exit(1);
}

const ref = parseLocaleFile(refPath);
const localeNamePad = Math.max(...[...filePaths.keys()].map(n => n.length)) + 1;

console.log(`\n${C.bold}Locale consistency check${C.reset}`);
console.log(`${C.dim}Directory : ${LOCALES_DIR}${C.reset}`);
console.log(`${C.dim}Reference : ${REFERENCE_LOCALE}.ts  (${ref.lineCount} lines, ${ref.keySet.size} keys)${C.reset}`);
console.log(`${C.dim}Files     : ${[...filePaths.keys()].join(', ')}${C.reset}\n`);

// ── 4. Validate each locale against reference ───────────────────────────────

let totalErrors = 0;

for (const [locale, path] of filePaths) {
  if (locale === REFERENCE_LOCALE) continue;

  const t = parseLocaleFile(path);
  const errors = [];

  // --- 4a. Line count check ---
  if (t.lineCount !== ref.lineCount) {
    const diff = t.lineCount - ref.lineCount;
    errors.push(
      `${C.yellow}Line count${C.reset}: ${t.lineCount} vs reference ${ref.lineCount} ` +
      `(diff: ${diff > 0 ? '+' : ''}${diff})`,
    );
  }

  // --- 4b. Key set check ---
  const refOnly = [...ref.keySet].filter(k => !t.keySet.has(k)).sort();
  const targetOnly = [...t.keySet].filter(k => !ref.keySet.has(k)).sort();

  if (refOnly.length > 0) {
    const label = refOnly.length === 1 ? 'key missing' : 'keys missing';
    errors.push(
      `${C.red}${refOnly.length} ${label}${C.reset}:` +
      refOnly.map(k => `\n    ${C.dim}${k}${C.reset}`).join(''),
    );
  }
  if (targetOnly.length > 0) {
    const label = targetOnly.length === 1 ? 'extra key' : 'extra keys';
    errors.push(
      `${C.yellow}${targetOnly.length} ${label}${C.reset}:` +
      targetOnly.map(k => `\n    ${C.dim}${k}${C.reset}`).join(''),
    );
  }

  // --- 4c. Key order check ---
  // Walk both ordered key arrays side by side and find the first divergence.
  if (refOnly.length === 0 && targetOnly.length === 0) {
    // Only check order if the key sets are identical
    const maxLen = Math.max(ref.keys.length, t.keys.length);
    /** @type {Array<{idx: number, refKey: string, targetKey: string}>} */
    const orderErrors = [];
    for (let i = 0; i < maxLen; i++) {
      const rk = ref.keys[i];
      const tk = t.keys[i];
      if (rk !== tk) {
        orderErrors.push({ idx: i, refKey: rk, targetKey: tk });
      }
    }

    // Report first divergence with context
    if (orderErrors.length > 0) {
      const first = orderErrors[0];
      // Use 1-based position in the key sequence
      const pos = first.idx + 1;
      const refLine = ref.keyLines.get(first.refKey);
      const targetLine = t.keyLines.get(first.targetKey);

      errors.push(
        `${C.cyan}Key order diverges at position #${pos}${C.reset}\n` +
        `    reference has "${first.refKey}" (line ${refLine})\n` +
        `    ${locale.padEnd(2)} has "${first.targetKey}" (line ${targetLine})`,
      );

      // Summarise remaining differences
      const remaining = orderErrors.length - 1;
      if (remaining > 0) {
        errors.push(
          `    ${C.dim}…and ${remaining} more key(s) are out of order after this point${C.reset}`,
        );
      }
    }
  }

  // --- Report ---
  if (errors.length > 0) {
    totalErrors += errors.length;
    console.log(`${C.bold}${C.red}── ${locale.padEnd(localeNamePad)} ✘ ${errors.length} issue(s) ──${C.reset}`);
    for (const e of errors) {
      console.log(`  ${e}`);
    }
    console.log('');
  } else {
    console.log(`${C.bold}${C.green}── ${locale.padEnd(localeNamePad)} ✔ OK${C.reset}  (${t.lineCount} lines, ${t.keySet.size} keys, ordering matches)`);
  }
}

// ── 5. Final summary ────────────────────────────────────────────────────────

console.log('');
if (totalErrors > 0) {
  console.error(
    `${C.red}${C.bold}✘ Locale check failed:${C.reset} ${C.red}${totalErrors} issue(s) found.${C.reset}\n`,
  );
  process.exit(1);
} else {
  console.log(`${C.green}${C.bold}✔ All locale files are fully consistent.${C.reset}\n`);
}
