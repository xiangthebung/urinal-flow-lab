import { runAllTests, summariseResults } from './suite';

// Narrowly declared rather than pulling in @types/node, which would put Node's
// globals into scope for the browser build as well.
declare const process: { exit(code: number): never };

/**
 * Command-line validation runner: `npm run validate`.
 *
 * Exits non-zero on any failure so it can gate a build. The output states the
 * reference for every case, because a passing number is only meaningful if you can
 * see what it was compared against.
 */

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

function main(): void {
  const t0 = Date.now();
  console.log(`${BOLD}Urinal Flow Lab — physics validation${RESET}`);
  console.log(`${DIM}Each case is checked against a closed-form result, a conservation`);
  console.log(`law, or a published correlation.${RESET}\n`);

  const results = runAllTests();
  let currentGroup = '';

  for (const r of results) {
    if (r.group !== currentGroup) {
      currentGroup = r.group;
      console.log(`\n${BOLD}${currentGroup}${RESET}`);
      console.log('─'.repeat(74));
    }
    const mark = r.passed ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
    console.log(`  ${mark}  ${r.name}`);
    console.log(`        ${DIM}expected${RESET}  ${r.expected}`);
    console.log(`        ${DIM}actual  ${RESET}  ${r.actual}`);
    const errCol = r.passed ? DIM : YELLOW;
    console.log(
      `        ${DIM}error   ${RESET}  ${errCol}${r.error}${RESET} ${DIM}(tolerance ${r.tolerance})${RESET}`
    );
    console.log(`        ${DIM}reference ${r.reference}${RESET}`);
    if (r.notes) console.log(`        ${DIM}note      ${r.notes}${RESET}`);
  }

  const s = summariseResults(results);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n${'─'.repeat(74)}`);
  const colour = s.failed === 0 ? GREEN : RED;
  console.log(
    `${colour}${BOLD}${s.passed}/${s.total} passed${RESET}` +
      (s.failed > 0 ? ` ${RED}${s.failed} failed${RESET}` : '') +
      ` ${DIM}in ${secs}s${RESET}`
  );

  if (s.failed > 0) {
    console.log(`\n${RED}Failing cases:${RESET}`);
    for (const r of results.filter((x) => !x.passed)) {
      console.log(`  · ${r.group} — ${r.name}: got ${r.actual}, expected ${r.expected}`);
    }
    process.exit(1);
  }
}

main();
