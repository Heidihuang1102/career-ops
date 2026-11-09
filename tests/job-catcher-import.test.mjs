// tests/job-catcher-import.test.mjs — job-catcher state.json → pipeline.md importer.
import { pass, fail, NODE, ROOT } from './helpers.mjs';
import { writeFileSync, readFileSync, mkdirSync, rmSync, mkdtempSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { pathToFileURL } from 'url';

console.log('\njob-catcher-import.mjs — import pushed jobs into pipeline.md');

const check = (desc, cond, details = '') => (cond ? pass(desc) : fail(`${desc}${details ? ` (${details})` : ''}`));
const { extractPushed, selectNew } = await import(pathToFileURL(join(ROOT, 'job-catcher-import.mjs')).href);
const { parseBlacklist } = await import(pathToFileURL(join(ROOT, 'scan.mjs')).href);

const state = {
  seen: {},
  log: {
    '2026-11-08': { pushed: [
      { t: 'Buyer', c: 'Coolblue', s: 58, u: 'https://coolblue.example/jobs/1' },
      { t: 'Old entry', c: 'NoUrl BV', s: 70 },
    ] },
    '2026-11-09': { pushed: [
      { t: 'Demand Planner', c: 'HelloFresh', s: 81, u: 'https://hellofresh.example/jobs/2' },
      { t: 'Analyst', c: 'Low Score BV', s: 43, u: 'https://low.example/jobs/3' },
      { t: 'Demand Planner', c: 'HelloFresh', s: 81, u: 'https://hellofresh.example/jobs/2' },
    ] },
    notADay: { pushed: [{ t: 'x', c: 'y', s: 99, u: 'https://x.example/1' }] },
  },
};

const all = extractPushed(state);
check('reads pushed jobs, newest day first, skipping non-date keys', all.offers.length === 4 && all.offers[0].day === '2026-11-09', JSON.stringify(all.offers.map((o) => o.day)));
check('counts entries without a URL instead of importing them', all.noUrl === 1);
check('note carries score and day', all.offers[0].note === 'job-catcher score 81 2026-11-09', all.offers[0].note);
check('--min-score filters', extractPushed(state, { minScore: 50 }).offers.every((o) => o.score >= 50));
check('--since filters by day', extractPushed(state, { since: '2026-11-09' }).offers.every((o) => o.day === '2026-11-09'));

const { fresh, skipped } = selectNew(all.offers, new Set(['https://coolblue.example/jobs/1']), parseBlacklist('| Company | Since | Scope | Reason |\n|---|---|---|---|\n| Low Score BV | 2026-11 | all | test |\n'));
check('dedups against known URLs and within the batch', skipped.duplicate === 2 && fresh.length === 1 && fresh[0].company === 'HelloFresh', JSON.stringify(skipped));
check('respects the blacklist', skipped.blacklisted === 1);

// End to end in a temp project dir: writes pipeline.md + scan-history, second run adds nothing.
const dir = mkdtempSync(join(tmpdir(), 'cops-jobcatcher-'));
try {
  mkdirSync(join(dir, 'data'), { recursive: true });
  const statePath = join(dir, 'state.json');
  writeFileSync(statePath, JSON.stringify(state));
  const run = (...extra) => execFileSync(NODE, [join(ROOT, 'job-catcher-import.mjs'), '--state', statePath, '--json', ...extra], { cwd: dir, encoding: 'utf-8' });
  const dry = JSON.parse(run('--dry-run'));
  check('dry run reports but writes nothing', dry.added === 3 && !existsSync(join(dir, 'data', 'pipeline.md')));
  const first = JSON.parse(run());
  const pipeline = readFileSync(join(dir, 'data', 'pipeline.md'), 'utf-8');
  check('real run appends pending rows with company, title and note', first.added === 3 && pipeline.includes('- [ ] https://hellofresh.example/jobs/2 | HelloFresh | Demand Planner | note: job-catcher score 81 2026-11-09'), pipeline);
  check('real run logs the rows in scan-history.tsv', readFileSync(join(dir, 'data', 'scan-history.tsv'), 'utf-8').includes('\tjob-catcher\t'));
  const second = JSON.parse(run());
  check('second run is idempotent', second.added === 0 && second.duplicate === 4, JSON.stringify(second));
} catch (e) {
  fail(`end-to-end run failed: ${e.message}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
