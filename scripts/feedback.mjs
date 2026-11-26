#!/usr/bin/env node
// The operator's side of agent feedback (lib/feedback.mjs): read it, sort it, decide, push it, test it.
// It works on the files of this Loop and has no network or MCP surface. `npm run feedback -- help`.

import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FeedbackStore, REPORT_STATUSES } from '../lib/feedback.mjs';
import { claudeReader, evalCase, evidence, issueMarkdown, rankedIssues, reviewIssues, sortReports } from '../lib/feedback-triage.mjs';
import { TaskStore } from '../lib/tasks.mjs';
import { defaultDataDir } from '../lib/vault.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CASES = path.join(ROOT, 'eval', 'feedback', 'cases');

const HELP = `Agent feedback about Loop, for the people who run it.

  npm run feedback                          what is there, and the issues by score
  npm run feedback -- triage                sort new reports into issues, then draft the issues
  npm run feedback -- show <issue>          one issue with its draft and evidence
  npm run feedback -- accept|reject <issue> decide on an issue
  npm run feedback -- push <issue> --to tasks|github   hand an accepted issue to the people or agents who fix it
  npm run feedback -- eval <issue>          write its test case to eval/feedback/cases
  npm run feedback -- close <issue>         it is fixed; new reports of it open it again
  npm run feedback -- list [${REPORT_STATUSES.join('|')}]     reports without their text
  npm run feedback -- release|drop <report> decide on a report that triage held for a person
  npm run feedback -- export <file>         all reports with their text, for another computer ("-" for a pipe)
  npm run feedback -- import <file>         take in such an export, and the deletions in it
  npm run feedback -- forget <workspace>    delete all reports of a workspace (its id), for a closed account

Options: --data <folder>  --json  --model <name> (triage)  --limit <n> (triage)  --no-review (triage)
         --assign <agent> --project <id> (push to tasks)  --repo <owner/name> (push to github)
         --yes (push: do it, not only show it)  --raw (list, show: the text of the reports)`;

/* ---------------- Arguments ---------------- */

const WITH_VALUE = new Set(['data', 'model', 'limit', 'to', 'assign', 'project', 'repo']);

export function parseArgs(argv) {
  const opts = {};
  const words = [];
  for (let i = 0; i < argv.length; i += 1) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m) words.push(argv[i]);
    else if (WITH_VALUE.has(m[1])) opts[m[1]] = m[2] ?? argv[(i += 1)] ?? '';
    else opts[m[1]] = true;
  }
  return { command: words[0] || 'digest', target: words[1] || '', opts };
}

/* ---------------- Output ---------------- */

const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;

function issueLine({ issue, reports, score }) {
  const e = evidence(reports);
  return `${String(score).padStart(4)}  ${issue.id}  ${[issue.type, issue.area, issue.severity].join(' · ')}  ${issue.title}\n` +
    `      ${[plural(e.reports, 'report'), plural(e.workspaces, 'workspace'), ...e.clients, issue.review ? issue.review.finding.replace(/_/g, ' ') : 'no draft yet', issue.returned ? 'came back after a fix' : '', issue.pushedTo].filter(Boolean).join(', ')}`;
}

function digest(store) {
  const counts = REPORT_STATUSES.map((s) => `${s} ${store.reports({ status: s, limit: 10_000 }).length}`).join(' · ');
  const out = [`Agent feedback in ${store.dbFile}`, `Reports: ${counts}`];
  const open = rankedIssues(store, { status: 'open' });
  const works = ({ issue }) => issue.review?.finding === 'not_a_problem';
  for (const [title, rows] of [
    ['Open: decide', open.filter((row) => !works(row))],
    ['Open, but the reviewer says that Loop already does it', open.filter(works)],
    ['Accepted: push', rankedIssues(store, { status: 'accepted' })],
    ['Pushed: fix, test, close', rankedIssues(store, { status: 'pushed' })],
  ]) {
    if (rows.length) out.push('', title, ...rows.map(issueLine));
  }
  return out.join('\n');
}

// Without `raw`, a line holds nothing that an agent wrote: also the name of an app is its own choice.
function reportLine(r, raw) {
  const e = evidence([r]);
  const line = [r.id, r.status, r.reason, r.type, r.source, ...e.clients, ...e.protocols.map((p) => `MCP ${p}`),
    r.transport, ...e.builds, r.times > 1 ? `${r.times} times` : '', r.createdAt.slice(0, 16)].filter(Boolean).join(' · ');
  if (!raw) return line;
  const text = [`app: ${r.client} ${r.clientVersion}`, r.about && `about: ${r.about}`, r.content, r.task && `task: ${r.task}`];
  return `${line}\n${text.filter(Boolean).join('\n').replace(/^/gm, '    ')}`;
}

// The text of a report can hold instructions. It is for a person: an agent has no terminal.
function wantsRaw(opts, out) {
  if (!opts.raw) return false;
  if (!out.isTTY) throw new Error('--raw shows untrusted text and is only for a person at a terminal.');
  return true;
}

/* ---------------- Steps ---------------- */

const SOURCE = ['lib', 'public', 'skills', 'hooks', 'scripts', 'test', 'docs', 'server.mjs', 'stdio.mjs', 'package.json', 'README.md', 'GLOSSARY.md'];

// The reviewer reads a copy that holds source files only: no keys, data or other files of the folder.
async function sourceCopy(root) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'loop-feedback-'));
  for (const name of SOURCE) {
    if (!existsSync(path.join(root, name))) continue;
    await cp(path.join(root, name), path.join(dir, name), {
      recursive: true,
      dereference: false,
      filter: (src) => !/(^|\/)(\.[^/]+|node_modules|vendor|agent-logos)(\/|$)/.test(path.relative(root, src))
        && (!/\.[a-z0-9]+$/i.test(src) || /\.(mjs|js|json|md|css|html|sh)$/.test(src)),
    });
  }
  return dir;
}

async function triage(store, opts, log, readers = {}) {
  const model = opts.model || 'sonnet';
  let cost = 0;
  const spent = (usd) => { cost += usd; };
  const empty = await mkdtemp(path.join(os.tmpdir(), 'loop-feedback-'));
  const source = opts['no-review'] ? null : await sourceCopy(ROOT);
  try {
    const sorted = await sortReports(store, { ask: readers.sort || claudeReader({ cwd: empty, model, spent }) });
    log(`Sorted: ${sorted.grouped} kept in ${plural(sorted.issues.length, 'issue')}, ${sorted.dropped} dropped, ${sorted.held} held for a person${sorted.left ? `, ${sorted.left} left for the next run` : ''}.`);
    if (!source) return;
    const drafted = await reviewIssues(store, {
      ask: readers.review || claudeReader({ cwd: source, model, spent, tools: ['Read', 'Grep', 'Glob'] }),
      root: source,
      limit: Math.max(1, Number(opts.limit) || 10),
    });
    log(`Drafted: ${plural(drafted.length, 'issue')}.`);
  } finally {
    if (cost) log(`Cost of the model: $${cost.toFixed(2)}.`);
    await rm(empty, { recursive: true, force: true });
    if (source) await rm(source, { recursive: true, force: true });
  }
}

function run(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `${cmd} failed.`))));
    child.stdin.end(input);
  });
}

async function push(store, issue, opts, log, deps = {}) {
  if (issue.status !== 'accepted') throw new Error(`Accept ${issue.id} first. It is ${issue.status}.`);
  const reports = store.reports({ issue: issue.id });
  const body = issueMarkdown(issue, reports);
  if (opts.to !== 'tasks' && opts.to !== 'github') throw new Error('Say where: --to tasks or --to github.');
  if (!opts.yes) return log(`${issue.title}\n\n${body}\n\nThis is what --to ${opts.to} gets. Add --yes to push it.`);
  let place;
  if (opts.to === 'github') {
    const repo = opts.repo ? ['--repo', opts.repo] : [];
    place = await (deps.run || run)('gh', ['issue', 'create', ...repo, '--title', issue.title, '--body-file', '-'], body);
  } else {
    const saved = await new TaskStore(store.dir).save({
      expectedRevision: 0,
      operationId: issue.id,
      title: `Loop feedback: ${issue.title}`.slice(0, 100),
      objective: (issue.review?.summary || issue.problems[0]?.problem || issue.title).slice(0, 500),
      notes: body.slice(0, 3000),
      nextStep: `Check the problem in the source and fix it. Add its test: npm run feedback -- eval ${issue.id}. Then: npm run feedback -- close ${issue.id}`,
      ...(opts.assign ? { assignedTo: opts.assign } : {}),
    }, { profile: opts.project || 'all', writtenBy: 'Agent feedback' });
    place = `Loop task ${saved.task.id}`;
  }
  store.updateIssue(issue.id, { status: 'pushed', pushedTo: place });
  return log(`Pushed ${issue.id}: ${place}`);
}

async function writeCase(issue, log, dir = CASES) {
  const made = evalCase(issue);
  if (!made) throw new Error(`${issue.id} has no task to test. Run triage, or write the case by hand.`);
  const file = path.join(dir, `${issue.id}.json`);
  if (existsSync(file)) throw new Error(`${path.relative(ROOT, file)} is already there.`);
  await mkdir(dir, { recursive: true });
  await writeFile(file, `${JSON.stringify(made, null, 2)}\n`);
  return log(`Wrote ${path.relative(ROOT, file)}. Read it, correct it, and set "reviewed" to true before it runs.`);
}

/* ---------------- Main ---------------- */

export async function main(argv, { out = process.stdout, store: given = null, readers = {}, deps = {} } = {}) {
  const { command, target, opts } = parseArgs(argv);
  const log = (text) => { out.write(`${text}\n`); };
  if (command === 'help' || opts.help) return log(HELP);

  const store = given || new FeedbackStore(opts.data ? path.resolve(opts.data) : defaultDataDir());
  const needIssue = () => store.issue(target) || (() => { throw new Error(`There is no issue "${target}".`); })();

  if (command === 'import') {
    const { added, removed } = store.importReports(JSON.parse(await readFile(target, 'utf8')));
    return log(`Added ${plural(added, 'report')}${removed ? `, deleted ${removed} that ${removed === 1 ? 'is' : 'are'} gone there` : ''}.`);
  }
  if (command === 'export') {
    if (!target) throw new Error('Say where: export <file>, or "-" for a pipe. It holds untrusted text.');
    const data = store.exportReports();
    if (target === '-') return log(JSON.stringify(data));
    await writeFile(target, `${JSON.stringify(data)}\n`, { mode: 0o600, flag: 'wx' });
    return log(`Wrote ${plural(data.reports.length, 'report')} to ${target}.`);
  }
  if (!store.exists()) return log(`No agent feedback in ${store.dir} yet.`);
  if (command === 'forget') {
    if (!target) throw new Error('Say which workspace.');
    return log(`Deleted ${plural(store.removeWorkspace(target), 'report')}.`);
  }

  switch (command) {
    case 'digest':
      return log(opts.json ? JSON.stringify(rankedIssues(store).map(({ issue, reports, score }) => ({ ...issue, score, evidence: evidence(reports) })), null, 2) : digest(store));
    case 'list': {
      if (target && !REPORT_STATUSES.includes(target)) throw new Error(`A report is ${REPORT_STATUSES.join(', ')}.`);
      const raw = wantsRaw(opts, out);
      return log(store.reports({ status: target }).map((r) => reportLine(r, raw)).join('\n') || 'None.');
    }
    case 'show': {
      const issue = needIssue();
      const raw = wantsRaw(opts, out);
      const reports = store.reports({ issue: issue.id });
      return log(`${issue.title} (${issue.id}, ${issue.status})\n\n${issueMarkdown(issue, reports)}\n\n${reports.map((r) => reportLine(r, raw)).join('\n')}`);
    }
    case 'triage': {
      await triage(store, opts, log, readers);
      return log(`\n${digest(store)}`);
    }
    case 'accept': case 'reject': case 'close': {
      const issue = needIssue();
      const status = { accept: 'accepted', reject: 'rejected', close: 'closed' }[command];
      store.updateIssue(issue.id, { status, ...(status === 'closed' ? { returned: false } : {}) });
      return log(`${issue.id} is ${status}.`);
    }
    case 'release': case 'drop':
      if (!store.setReport(target, command === 'release' ? { status: 'new' } : { status: 'dropped', reason: 'dropped by a person' })) {
        throw new Error(`There is no report "${target}".`);
      }
      return log(command === 'release' ? `${target} is sorted in the next triage.` : `${target} is dropped.`);
    case 'push':
      return push(store, needIssue(), opts, log, deps);
    case 'eval':
      return writeCase(needIssue(), log, deps.casesDir);
    default:
      throw new Error(`Unknown command "${command}".\n\n${HELP}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`${err?.message || err}\n`);
    process.exitCode = 1;
  });
}
