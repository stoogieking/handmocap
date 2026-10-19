// Run: node tests/run.mjs  (requires `npm install` for three.js; the app itself needs no build)
import { summary } from './harness.mjs';
const suites = process.argv.slice(2).length ? process.argv.slice(2) : ['solver', 'pipeline', 'retarget', 'export'];
for (const s of suites) {
  console.log(`\n== ${s}`);
  const mod = await import(`./${s}.test.mjs`);
  await mod.run();
}
process.exit(summary() ? 0 : 1);
