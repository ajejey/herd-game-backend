/*
  One-off repair + permanent guard for a bug class that has now bitten twice.

  `new RegExp(`\\b${x}\\b`)` inside a TEMPLATE LITERAL does not build a word
  boundary. The template literal turns \b into an actual backspace character
  (U+0008), so the regex looks for backspace-x-backspace and never matches
  anything. The assertion still runs, still reads correctly, and can never fail
  — which is the worst possible state for a test guarding a secret.

  Correct source is `\\b${x}\\b`.

  Run with --fix to repair, without to report. Scans the backend scripts folder
  and the e2e tree.
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOTS = [here, path.join(here, '..', '..', 'e2e')];
const FIX = process.argv.includes('--fix');

const files = [];
const walk = (dir) => {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'test-results' || e.name === 'screenshots') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (/\.(js|mjs)$/.test(e.name)) files.push(full);
  }
};
ROOTS.forEach(walk);

/* Inside a template literal, a lone \b is a backspace. Match the broken form
   without matching the correct \\b one. */
const BROKEN = /(?<!\\)\\b(?=\$\{)|(?<!\\)\\b(?=`)/g;

let touched = 0;
const hits = [];

for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  if (!src.includes('RegExp(`')) continue;

  const lines = src.split('\n');
  const fixedLines = lines.map((line) => {
    if (!line.includes('RegExp(`')) return line;
    // A comment DESCRIBING the bug is not the bug. This file is the example.
    const t = line.trim();
    if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return line;
    if (!BROKEN.test(line)) { BROKEN.lastIndex = 0; return line; }
    BROKEN.lastIndex = 0;
    hits.push(`${path.relative(path.join(here, '..', '..'), f)}  ${line.trim().slice(0, 76)}`);
    return line.replace(BROKEN, '\\\\b');
  });

  const out = fixedLines.join('\n');
  if (out !== src && FIX) { fs.writeFileSync(f, out); touched += 1; }
}

if (!hits.length) {
  console.log('word-boundary regexes — every template-literal \\b is escaped correctly');
  process.exit(0);
}

console.error(`${hits.length} template-literal regex(es) build a BACKSPACE, not a word boundary:\n`);
hits.forEach((h, i) => console.error(`  ${i + 1}. ${h}`));
if (FIX) {
  console.error(`\nrepaired ${touched} file(s). Re-run without --fix to confirm.`);
  process.exit(0);
}
console.error('\nThese assertions can never fail. Run with --fix.');
process.exit(1);
