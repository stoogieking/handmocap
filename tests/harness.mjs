// Minimal test harness (no dependencies besides three for the code under test).
export const results = [];
let current = null;

export async function test(name, fn) {
  current = { name, checks: 0, failures: [] };
  const t0 = performance.now();
  try {
    await fn();
  } catch (e) {
    current.failures.push('threw: ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e));
  }
  current.ms = performance.now() - t0;
  results.push(current);
  const ok = current.failures.length === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${current.checks} checks, ${current.ms.toFixed(0)} ms)`);
  for (const f of current.failures.slice(0, 8)) console.log('      - ' + f);
  if (current.failures.length > 8) console.log(`      ... ${current.failures.length - 8} more`);
}

export function check(cond, msg) {
  current.checks++;
  if (!cond) current.failures.push(msg);
}

export function near(a, b, tol, msg) {
  current.checks++;
  if (!(Math.abs(a - b) <= tol)) current.failures.push(`${msg}: ${a} vs ${b} (tol ${tol})`);
}

export function note(msg) {
  console.log('      · ' + msg);
}

export function summary() {
  const failed = results.filter((r) => r.failures.length);
  const checks = results.reduce((s, r) => s + r.checks, 0);
  console.log(`\n${results.length - failed.length}/${results.length} tests passed, ${checks} checks.`);
  return failed.length === 0;
}

// Deterministic PRNG for reproducible fixtures.
export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
