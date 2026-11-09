/**
 * outside_provider gemini: the Google transport in lib/outside-voice-api.ts,
 * bin/gstack-gemini, and the Claude render that dispatches to it. A local fake
 * Gemini server answers every API call (GEMINI_BASE_URL) and a fake
 * Antigravity language server answers agentapi: no network, no spend.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { callModel } from '../lib/outside-voice-api';
import { agentPrompt } from '../lib/antigravity-agent';
import { classifyOutsideReview } from '../lib/outside-review-result';
import { outsideVoiceCommand, outsideVoiceFor, outsideVoicePreflight, generateOutsideVoiceRouting } from '../scripts/resolvers/outside-voice';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';

const ROOT = path.resolve(import.meta.dir, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-outside-'));
const REVIEW = 'High: changed.txt drops the retry guard.\nRecommendation: restore the guard because retries lose data.';

type Seen = { path: string; key: string | null; body: any };
const seen: Seen[] = [];
let reply: (body: any) => { status: number; json: unknown } = () => ({ status: 200, json: {} });
const server = Bun.serve({
  port: 0, hostname: '127.0.0.1',
  async fetch(req) {
    const body = await req.json();
    seen.push({ path: new URL(req.url).pathname, key: req.headers.get('x-goog-api-key'), body });
    const r = reply(body);
    return Response.json(r.json, { status: r.status });
  },
});
const BASE = `http://127.0.0.1:${server.port}/v1beta`;
const ok = (text: string, finishReason = 'STOP') => ({ status: 200, json: {
  candidates: [{ content: { parts: [{ text: 'private reasoning', thought: true }, { text }] }, finishReason }],
  usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7 }, modelVersion: 'gemini-3.8-flash',
} });
afterAll(() => { server.stop(true); fs.rmSync(TMP, { recursive: true, force: true }); });

/** A HOME with a stored key and its own state root, so receipts and config stay in the fixture. */
function home(name: string, opts: { key?: boolean; config?: string } = {}) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(path.join(dir, '.gstack'), { recursive: true });
  if (opts.key !== false) fs.writeFileSync(path.join(dir, '.gstack', 'gemini.json'), JSON.stringify({ api_key: 'AIza-fake-key-for-tests-0000' }));
  if (opts.config) fs.writeFileSync(path.join(dir, '.gstack', 'config.yaml'), opts.config);
  return {
    dir,
    env: { ...process.env, HOME: dir, USERPROFILE: dir, GSTACK_HOME: path.join(dir, '.gstack'), GSTACK_STATE_ROOT: path.join(dir, '.gstack'), GEMINI_BASE_URL: BASE, GEMINI_API_KEY: '', GSTACK_GEMINI_MODEL: '', GSTACK_GEMINI_TRANSPORT: 'api' },
    receipts: () => { const f = path.join(dir, '.gstack', 'security', 'egress.jsonl'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []; },
  };
}

async function gemini(env: NodeJS.ProcessEnv, args: string[], stdin: string) {
  const child = Bun.spawn([process.execPath, path.join(ROOT, 'bin', 'gstack-gemini'), ...args], { env, stdin: new Blob([stdin]), stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stderr, json: stdout.trim() ? JSON.parse(stdout.trim().split('\n').at(-1)!) : null };
}

describe('Google transport (callModel)', () => {
  test('sends generateContent with the key in a header, drops thought parts, reports usage and a receipt', async () => {
    const h = home('transport');
    reply = () => ok(REVIEW);
    seen.length = 0;
    const res = await callModel({ model: 'gemini-3.8-flash', prompt: 'review this', timeoutMs: 5000, env: { ...h.env, GEMINI_API_KEY: 'AIza-env-key' }, maxTokens: 900 });
    expect(seen[0].path).toBe('/v1beta/models/gemini-3.8-flash:generateContent');
    expect(seen[0].key).toBe('AIza-env-key');
    expect(seen[0].body).toEqual({ contents: [{ role: 'user', parts: [{ text: 'review this' }] }], generationConfig: { maxOutputTokens: 900 } });
    expect(res).toMatchObject({ provider: 'google', text: REVIEW, truncated: false, usage: { input_tokens: 12, output_tokens: 7 } });
    expect(h.receipts().map(r => r.sink)).toEqual(['outside-voice-api']);
  });
  test('MAX_TOKENS marks the text truncated; an HTTP error throws the provider message', async () => {
    const h = home('transport-errors');
    reply = () => ok('cut', 'MAX_TOKENS');
    expect((await callModel({ model: 'gemini-3.8-flash', prompt: 'p', timeoutMs: 5000, env: { ...h.env, GEMINI_API_KEY: 'k' } })).truncated).toBe(true);
    reply = () => ({ status: 400, json: { error: { message: 'API key not valid' } } });
    await expect(callModel({ model: 'gemini-3.8-flash', prompt: 'p', timeoutMs: 5000, env: { ...h.env, GEMINI_API_KEY: 'k' } })).rejects.toThrow('google 400: API key not valid');
  });
});

describe('bin/gstack-gemini over gemini_transport api', () => {
  test('a stored key and configured model produce a completed result with its own receipt', async () => {
    const h = home('wrapper', { config: 'gemini_model: gemini-3.1-pro-preview\n' });
    reply = () => ok(REVIEW);
    seen.length = 0;
    const r = await gemini(h.env, ['--cwd', TMP, '--timeout-ms', '5000'], 'the prompt');
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ status: 'completed', provider: 'gemini', result: REVIEW });
    expect(seen[0].path).toBe('/v1beta/models/gemini-3.1-pro-preview:generateContent');
    expect(seen[0].key).toBe('AIza-fake-key-for-tests-0000');
    expect(r.stderr).toContain('GEMINI_MODEL: gemini-3.1-pro-preview via api (source: config gemini_model)');
    expect(h.receipts().map(x => x.sink)).toEqual(['outside-voice-gemini']);
  });
  test('no key: unavailable with the repair, nothing sent; --probe agrees', async () => {
    const h = home('nokey', { key: false });
    seen.length = 0;
    const r = await gemini(h.env, ['--cwd', TMP, '--timeout-ms', '5000'], 'the prompt');
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ status: 'unavailable', error: { code: 'authentication' } });
    expect(r.json.error.message).toContain('gstack-gemini setup');
    expect(seen).toHaveLength(0);
    expect((await gemini(h.env, ['--probe'], '')).code).toBe(1);
    expect((await gemini(home('probe-ok').env, ['--probe'], '')).code).toBe(0);
  });
  test('codex_reviews disabled refuses before any send; --user-invoked still runs', async () => {
    const h = home('consent', { config: 'codex_reviews: disabled\n' });
    reply = () => ok(REVIEW);
    seen.length = 0;
    const refused = await gemini(h.env, ['--cwd', TMP, '--timeout-ms', '5000'], 'the prompt');
    expect(refused.code).toBe(3);
    expect(refused.json).toMatchObject({ status: 'not_run', reason: 'consent_missing' });
    expect(seen).toHaveLength(0);
    expect((await gemini(h.env, ['--user-invoked', '--cwd', TMP, '--timeout-ms', '5000'], 'the prompt')).code).toBe(0);
  });
  test('setup stores the key where the reviewer reads it', async () => {
    const h = home('setup', { key: false });
    expect((await gemini(h.env, ['setup'], 'AIza-pasted-key-1234567890\n')).code).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(h.dir, '.gstack', 'gemini.json'), 'utf8')).api_key).toBe('AIza-pasted-key-1234567890');
  });
});

describe('Claude render with outsideProvider gemini', () => {
  const ctx = (outsideProvider?: 'gemini'): TemplateContext => ({ skillName: 'review', tmplPath: 'review/SKILL.md.tmpl', host: 'claude', paths: HOST_PATHS.claude, ...(outsideProvider ? { outsideProvider } : {}) });

  test('Gemini replaces Codex only when selected, and never on the Codex host', () => {
    expect(outsideVoiceFor(ctx()).id).toBe('codex');
    expect(outsideVoiceFor(ctx('gemini')).id).toBe('gemini');
    expect(outsideVoiceFor({ host: 'codex', outsideProvider: 'gemini' }).id).toBe('claude-code');
    expect(generateOutsideVoiceRouting(ctx('gemini'))).toContain('gstack-gemini');
    expect(outsideVoicePreflight(ctx('gemini'), { disabledBehavior: 'codex-only' })).toContain('gstack-gemini" --probe');
  });

  test('the generated review command sends prompt plus caller diff through gstack-gemini and validates the result', async () => {
    const repo = path.join(TMP, 'repo');
    fs.mkdirSync(repo);
    const g = (...a: string[]) => spawnSync('git', a, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.invalid' } });
    g('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'changed.txt'), 'base\n');
    g('add', '.'); g('commit', '-qm', 'base');
    fs.appendFileSync(path.join(repo, 'changed.txt'), 'seeded change\n');
    const prompt = path.join(TMP, "prompt '$(touch NEVER)'.txt");
    fs.writeFileSync(prompt, 'Review the diff. $(touch NEVER)\n');
    // HOST_PATHS.codex reads GSTACK_BIN/GSTACK_ROOT, so the command runs this checkout's bin (as outside-voice-invocation does).
    const command = outsideVoiceCommand({ ...ctx('gemini'), paths: HOST_PATHS.codex }, { promptFile: prompt, timeoutMs: 5000, diffCommand: 'git diff' });
    expect(command).not.toMatch(/codex (exec|review)/);
    const h = home('render');
    reply = () => ok(REVIEW);
    seen.length = 0;
    const child = Bun.spawn(['bash', '-c', command], { cwd: repo, env: { ...h.env, GSTACK_ROOT: ROOT, GSTACK_BIN: path.join(ROOT, 'bin'), CLAUDECODE: '1', GSTACK_ACTIVE_HOST: 'claude', CODEX_THREAD_ID: '', CODEX_SANDBOX: '' }, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, stderr: code ? stderr : '' }).toEqual({ code: 0, stderr: '' });
    expect(stdout).toContain(REVIEW);
    expect(stdout).toContain('OUTSIDE_STATUS: completed provider=gemini host=claude');
    const sent = seen[0].body.contents[0].parts[0].text as string;
    expect(sent).toContain('Review the diff. $(touch NEVER)');
    expect(sent).toContain('+seeded change');
    expect(fs.existsSync(path.join(repo, 'NEVER'))).toBe(false);
  });
});

describe('gen-skill-docs --outside-provider', () => {
  test('gemini is refused for the committed tree and for non-Claude hosts', () => {
    const run = (...a: string[]) => spawnSync(process.execPath, ['run', 'scripts/gen-skill-docs.ts', ...a, '--dry-run'], { cwd: ROOT, encoding: 'utf8' });
    expect(run('--host', 'claude', '--outside-provider', 'gemini').stderr).toContain('outside the checkout root');
    expect(run('--host', 'codex', '--outside-provider', 'gemini', '--out-dir', path.join(TMP, 'x')).stderr).toContain('outside the checkout root');
    expect(run('--host', 'claude', '--outside-provider', 'grok', '--out-dir', path.join(TMP, 'x')).stderr).toContain('Unknown outside provider');
  });
});

describe('bin/gstack-gemini over gemini_transport antigravity (the default)', () => {
  // A fake language_server: `agentapi new-conversation` reads the answer path from the prompt and acts per FAKE_AGY_MODE.
  const FAKE_LS = path.join(TMP, 'fake-ls.ts');
  fs.writeFileSync(FAKE_LS, `
import * as fs from 'node:fs';
const args = process.argv.slice(2);
const log = process.env.FAKE_AGY_LOG!;
fs.appendFileSync(log, JSON.stringify({ args, address: process.env.ANTIGRAVITY_LS_ADDRESS, csrf: process.env.ANTIGRAVITY_CSRF_TOKEN }) + '\\n');
const mode = process.env.FAKE_AGY_MODE ?? 'ok';
// agentapi's live wording (Antigravity LS 2.29.0) for a model it does not offer.
if (mode === 'error') { console.log(JSON.stringify({ response: {}, error: 'no available model for "gemini-9": it is neither a model ID in the available model catalog nor a tier (flash_lite, flash, pro) with an available model' })); process.exit(0); }
const prompt = args.at(-1)!;
const out = prompt.match(/to this file: (\\S+)/)![1];
const request = fs.readFileSync(prompt.match(/review request in this file: (\\S+)/)![1], 'utf8');
if (mode !== 'silent') {
  fs.writeFileSync(out, process.env.FAKE_AGY_TEXT + '\\n<!-- saw: ' + request.length + ' bytes -->');
  if (mode === 'modify') fs.appendFileSync(process.env.FAKE_AGY_REPO_FILE!, 'agent edit\\n');
  fs.writeFileSync(out + '.done', '');
}
console.log(JSON.stringify({ response: { newConversation: { prompt, conversationId: 'conv-123' } } }));
`);
  const repo = path.join(TMP, 'agy-repo');
  fs.mkdirSync(repo);
  const g = (...a: string[]) => spawnSync('git', a, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.invalid' } });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n');
  g('add', '.'); g('commit', '-qm', 'base');

  function agy(name: string, opts: { running?: boolean; config?: string } = {}) {
    const h = home(name, { key: false, config: opts.config });
    const daemon = path.join(h.dir, '.gemini', 'antigravity', 'daemon');
    fs.mkdirSync(daemon, { recursive: true });
    // A live pid (this test process) marks the app as running; a dead one as stopped.
    if (opts.running !== false) fs.writeFileSync(path.join(daemon, 'hub_4242.json'), JSON.stringify({ pid: process.pid, httpPort: 4242, csrfToken: 'csrf-secret', lsVersion: 'test' }));
    else fs.writeFileSync(path.join(daemon, 'hub_4242.json'), JSON.stringify({ pid: 2 ** 22 + 12345, httpPort: 4242, csrfToken: 'csrf-secret' }));
    const log = path.join(h.dir, 'agy.jsonl');
    const env = { ...h.env, GSTACK_GEMINI_TRANSPORT: '', ANTIGRAVITY_GEMINI_DIR: path.join(h.dir, '.gemini'), GSTACK_ANTIGRAVITY_LS: process.execPath, GSTACK_ANTIGRAVITY_LS_ARGS: JSON.stringify([FAKE_LS]), FAKE_AGY_LOG: log, FAKE_AGY_TEXT: REVIEW, FAKE_AGY_REPO_FILE: path.join(repo, 'a.txt') };
    return { ...h, env, calls: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [] };
  }

  test('flash by default (gemini-3.8-flash-low, the variant that fits review gates): starts one agent with the app address and token, returns its answer, writes a receipt', async () => {
    const a = agy('agy-ok');
    const r = await gemini(a.env, ['--cwd', repo, '--timeout-ms', '10000'], 'the review prompt');
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ status: 'completed', provider: 'gemini', transport: 'antigravity', model: 'gemini-3.8-flash-low', conversation_id: 'conv-123' });
    expect(r.json.result).toContain(REVIEW);
    expect(r.json.result).toContain(`saw: ${'the review prompt'.length} bytes`);
    const [call] = a.calls();
    expect(call.args.slice(0, 3)).toEqual(['agentapi', 'new-conversation', '--model=gemini-3.8-flash-low']);
    expect(call.address).toBe('127.0.0.1:4242');
    expect(call.csrf).toBe('csrf-secret');
    expect(call.args.at(-1)).toContain('READ-ONLY');
    expect(r.stderr).not.toContain('csrf-secret');
    expect(a.receipts().map(x => x.sink)).toEqual(['outside-voice-antigravity']);
  });
  test('argon selects gemini-4-argon-medium, the variant agentapi accepts', async () => {
    const a = agy('agy-argon', { config: 'gemini_model: argon\n' });
    expect((await gemini(a.env, ['--cwd', repo, '--timeout-ms', '10000'], 'p')).code).toBe(0);
    expect(a.calls()[0].args[2]).toBe('--model=gemini-4-argon-medium');
  });
  test('an agent that edits the repository fails the review instead of passing it', async () => {
    const a = agy('agy-modify');
    const r = await gemini({ ...a.env, FAKE_AGY_MODE: 'modify' }, ['--cwd', repo, '--timeout-ms', '10000'], 'p');
    g('checkout', '--', 'a.txt');
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ status: 'error', error: { code: 'repo-modified' }, result: '' });
    // git status shows an untracked path but not its contents; an edit to one is still caught.
    const untracked = path.join(repo, 'notes.txt');
    fs.writeFileSync(untracked, 'mine\n');
    const r2 = await gemini({ ...a.env, FAKE_AGY_MODE: 'modify', FAKE_AGY_REPO_FILE: untracked }, ['--cwd', repo, '--timeout-ms', '10000'], 'p');
    fs.rmSync(untracked);
    expect(r2.json).toMatchObject({ status: 'error', error: { code: 'repo-modified' } });
  });
  test('not running, a rejected start, and a silent agent are unavailable, never completed', async () => {
    const stopped = agy('agy-stopped', { running: false });
    const r1 = await gemini(stopped.env, ['--cwd', repo, '--timeout-ms', '10000'], 'p');
    expect(r1.json).toMatchObject({ status: 'unavailable', error: { code: 'not-running' } });
    expect(stopped.calls()).toHaveLength(0);
    expect(stopped.receipts()).toHaveLength(0);
    expect((await gemini(stopped.env, ['--probe'], '')).code).toBe(1);
    const a = agy('agy-errors');
    expect((await gemini(a.env, ['--probe'], '')).code).toBe(0);
    const r2 = await gemini({ ...a.env, FAKE_AGY_MODE: 'error' }, ['--cwd', repo, '--timeout-ms', '10000'], 'p');
    expect(r2.json).toMatchObject({ status: 'unavailable', error: { code: 'model' } });
    const r3 = await gemini({ ...a.env, FAKE_AGY_MODE: 'silent' }, ['--cwd', repo, '--timeout-ms', '1500'], 'p');
    expect(r3.json).toMatchObject({ status: 'unavailable', error: { code: 'timeout' }, conversation_id: 'conv-123' });
  });
});

describe('the answer format the Antigravity agent is told to write', () => {
  // The daily fork sync runs this file, so an upstream parser change that stops accepting this format fails before it deploys.
  const clean = 'NO_FINDINGS\nRecommendation: ship because no defects were found.\nVERDICT: CLEAN';
  test('reads clean only with the last-line verdict the prompt asks for', () => {
    expect(agentPrompt('/req', '/out', '/repo')).toContain('NO_FINDINGS');
    expect(agentPrompt('/req', '/out', '/repo')).toContain('VERDICT line');
    for (const gate of ['review', 'structured'] as const) {
      expect(classifyOutsideReview({ text: clean, gate }).verdict).toBe('clean');
      expect(classifyOutsideReview({ text: clean.replace('\nVERDICT: CLEAN', ''), gate }).verdict).toBe('unverified');
    }
  });
  test('tagged findings with VERDICT: FINDINGS block the gate', () => {
    expect(classifyOutsideReview({ text: `[P1] a.ts:3 drops the guard.\nRecommendation: restore it because data is lost.\nVERDICT: FINDINGS`, gate: 'structured' }).verdict).toBe('findings');
  });
});

describe('repoFingerprint (the read-only guard)', () => {
  test('catches the edits git status alone misses: hooks, config, the index, refs and untracked contents', async () => {
    const { repoFingerprint } = await import('../lib/antigravity-agent');
    const d = fs.mkdtempSync(path.join(TMP, 'fp-'));
    const g = (...a: string[]) => spawnSync('git', ['-C', d, '-c', 'user.email=t@t.invalid', '-c', 'user.name=t', ...a]);
    g('init', '-q'); fs.writeFileSync(path.join(d, 'a'), '1'); fs.writeFileSync(path.join(d, 'u'), 'x'); g('add', 'a'); g('commit', '-qm', 'x');
    const base = repoFingerprint(d)!;
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    const config = path.join(d, '.git', 'config');
    const original = fs.readFileSync(config);
    const cases: Array<[string, () => void, () => void]> = [
      ['hook', () => fs.writeFileSync(path.join(d, '.git', 'hooks', 'pre-commit'), 'evil'), () => fs.rmSync(path.join(d, '.git', 'hooks', 'pre-commit'))],
      ['config', () => fs.appendFileSync(config, '\n[x]\n\ty = 1\n'), () => fs.writeFileSync(config, original)],
      ['index', () => { fs.writeFileSync(path.join(d, 'a'), '2'); g('add', 'a'); fs.writeFileSync(path.join(d, 'a'), '1'); }, () => g('reset', '-q', 'a')],
      ['ref', () => g('branch', 'evil'), () => g('branch', '-q', '-D', 'evil')],
      ['untracked contents', () => fs.writeFileSync(path.join(d, 'u'), 'y'), () => fs.writeFileSync(path.join(d, 'u'), 'x')],
    ];
    for (const [name, change, undo] of cases) {
      change();
      expect({ name, changed: repoFingerprint(d) !== base }).toEqual({ name, changed: true });
      undo();
      expect({ name, restored: repoFingerprint(d) === base }).toEqual({ name, restored: true });
    }
    expect(repoFingerprint(path.join(TMP))).toBeNull();
  });
});
