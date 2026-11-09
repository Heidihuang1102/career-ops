#!/usr/bin/env node
// job-catcher-import.mjs — pull the jobs a job-catcher watcher already pushed
// into career-ops' inbox (data/pipeline.md), so they flow into
// `/career-ops pipeline` like any scanner result.
//
// job-catcher (a separate GitHub Actions repo) watches NL employer career sites,
// LinkedIn and Adzuna, scores each job against the résumé and pushes the good
// ones to ntfy/email. Every pushed job is logged in its state.json as
// state.log[YYYY-MM-DD].pushed[] = { t: title, c: company, s: score, u: url }.
// This script reads that log; it never writes to the job-catcher repo.
//
//   node job-catcher-import.mjs                         import from ../job-catcher/state.json
//   node job-catcher-import.mjs --pull                  git pull the job-catcher clone first
//   node job-catcher-import.mjs --state path/state.json
//   node job-catcher-import.mjs --since 2026-11-01 --min-score 55
//   node job-catcher-import.mjs --dry-run [--json]
//
// The state path can also come from JOB_CATCHER_STATE. Dedup is against
// pipeline.md, scan-history.tsv and applications.md (same as scan.mjs), and
// data/blacklist.md is respected. Imported rows are also logged in
// scan-history.tsv with portal "job-catcher" so they are not re-added later.

import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { loadSeenUrls, normalizeUrlForDedup, appendToPipeline, appendToScanHistory, loadBlacklist } from './scan.mjs';
import { normalizeCompany } from './tracker-utils.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_STATE = path.resolve(ROOT, '..', 'job-catcher', 'state.json');

/**
 * Flatten state.log into offers, newest day first. Entries without a URL
 * (older job-catcher versions logged only title/company/score) are skipped and
 * counted, since pipeline.md rows need a URL.
 */
export function extractPushed(state, { since = '', minScore = 0 } = {}) {
  const offers = [];
  let noUrl = 0;
  const days = Object.keys(state?.log || {}).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();
  for (const day of days) {
    if (since && day < since) continue;
    for (const p of state.log[day]?.pushed || []) {
      if (!p || typeof p !== 'object') continue;
      const url = typeof p.u === 'string' ? p.u.trim() : '';
      if (!/^https?:\/\//i.test(url)) { noUrl++; continue; }
      const score = Number(p.s);
      if (minScore && !(score >= minScore)) continue;
      offers.push({
        url,
        title: String(p.t || '').trim(),
        company: String(p.c || '').trim(),
        score: Number.isFinite(score) ? score : null,
        day,
        source: 'job-catcher',
        note: `job-catcher ${Number.isFinite(score) ? `score ${score}` : 'pushed'} ${day}`,
      });
    }
  }
  return { offers, noUrl };
}

/** Drop offers already known to career-ops, blacklisted, or repeated within this batch. */
export function selectNew(offers, seen, blacklist = new Map()) {
  const fresh = [];
  const skipped = { duplicate: 0, blacklisted: 0 };
  const batch = new Set();
  for (const o of offers) {
    const key = normalizeUrlForDedup(o.url);
    if (seen.has(key) || batch.has(key)) { skipped.duplicate++; continue; }
    if (blacklist.size && blacklist.has(normalizeCompany(o.company))) { skipped.blacklisted++; continue; }
    batch.add(key);
    fresh.push(o);
  }
  return { fresh, skipped };
}

function parseArgs(argv) {
  const a = { state: process.env.JOB_CATCHER_STATE || DEFAULT_STATE, since: '', minScore: 0, dry: false, json: false, pull: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${k} needs a value`); return v; };
    if (k === '--state') a.state = path.resolve(val());
    else if (k === '--since') { a.since = val(); if (!/^\d{4}-\d{2}-\d{2}$/.test(a.since)) throw new Error('--since must be YYYY-MM-DD'); }
    else if (k === '--min-score') { a.minScore = Number(val()); if (!Number.isFinite(a.minScore)) throw new Error('--min-score must be a number'); }
    else if (k === '--dry-run') a.dry = true;
    else if (k === '--json') a.json = true;
    else if (k === '--pull') a.pull = true;
    else if (k === '-h' || k === '--help') { a.help = true; }
    else throw new Error(`unknown option ${k}`);
  }
  return a;
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`job-catcher-import: ${e.message}`); process.exit(2); }
  if (args.help) {
    console.log('usage: node job-catcher-import.mjs [--state FILE] [--pull] [--since YYYY-MM-DD] [--min-score N] [--dry-run] [--json]');
    return;
  }
  if (args.pull) {
    const dir = path.dirname(args.state);
    try { execFileSync('git', ['-C', dir, 'pull', '--ff-only', '-q'], { stdio: 'inherit' }); }
    catch { console.error(`job-catcher-import: git pull failed in ${dir}; using the local copy`); }
  }
  if (!existsSync(args.state)) {
    console.error(`job-catcher-import: no state file at ${args.state}\n  clone the job-catcher repo next to career-ops, or pass --state / set JOB_CATCHER_STATE`);
    process.exit(1);
  }
  let state;
  try { state = JSON.parse(readFileSync(args.state, 'utf-8')); }
  catch (e) { console.error(`job-catcher-import: cannot parse ${args.state}: ${e.message}`); process.exit(1); }

  const { offers, noUrl } = extractPushed(state, { since: args.since, minScore: args.minScore });
  const { seen } = loadSeenUrls();
  const { fresh, skipped } = selectNew(offers, seen, loadBlacklist());

  if (!args.dry && fresh.length) {
    await appendToPipeline(fresh);
    appendToScanHistory(fresh, new Date().toISOString().slice(0, 10));
  }

  const summary = { state: args.state, pushedFound: offers.length, withoutUrl: noUrl, added: fresh.length, ...skipped, dryRun: args.dry, jobs: fresh.map(({ url, company, title, score, day }) => ({ url, company, title, score, day })) };
  if (args.json) { console.log(JSON.stringify(summary, null, 2)); return; }
  console.log(`job-catcher: ${offers.length} pushed job(s) found, ${fresh.length} new${args.dry ? ' (dry run, nothing written)' : ' → data/pipeline.md'}; ${skipped.duplicate} already known, ${skipped.blacklisted} blacklisted${noUrl ? `, ${noUrl} without URL` : ''}`);
  for (const o of fresh) console.log(`  + ${o.company} — ${o.title}${o.score != null ? ` (${o.score})` : ''}  ${o.url}`);
  if (fresh.length && !args.dry) console.log('Next: run `/career-ops pipeline` to evaluate them.');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
