/**
 * antigravity-agent — one outside review through the user's own Antigravity
 * app (their Google account and plan; no API key, no API billing). The app's
 * language server exposes `agentapi new-conversation`, the call Antigravity's
 * own agents use to start another agent. It needs the running app's loopback
 * address and CSRF token, which the app publishes in
 * ~/.gemini/antigravity/daemon/hub_<port>.json.
 *
 * agentapi returns only a conversation id, so the agent is told to write its
 * full answer to a file this process names, then a `.done` marker; we wait for
 * the marker. The agent has tools, so read-only is an instruction, not a
 * sandbox: the repository is fingerprinted before and after, and any change
 * fails the review (repo-modified) instead of passing it.
 *
 * agentapi is an internal Antigravity interface; a changed reply shape or a
 * stopped app is reported as unavailable, never as a clean review.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { sha256Hex, writeReceipt } from './egress-receipt';

type Env = Record<string, string | undefined>;

export interface AntigravityHub { pid: number; httpPort: number; csrfToken: string; lsVersion?: string; file: string }
export interface AgentRunResult { ok: true; text: string; conversationId: string }
export interface AgentRunFailure { ok: false; code: string; message: string; unavailable: boolean; conversationId?: string }

const homeOf = (env: Env) => env.USERPROFILE || env.HOME || os.homedir();

/** The language server binary: GSTACK_ANTIGRAVITY_LS, Antigravity's own ANTIGRAVITY_AGENTAPI_EXE, then the per-user install path. */
export function antigravityLanguageServer(env: Env = process.env): string | null {
  const candidates = [
    env.GSTACK_ANTIGRAVITY_LS,
    env.ANTIGRAVITY_AGENTAPI_EXE,
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'antigravity', 'resources', 'bin', 'language_server.exe'),
    '/Applications/Antigravity.app/Contents/Resources/bin/language_server',
  ];
  return candidates.find((c): c is string => !!c && fs.existsSync(c)) ?? null;
}

// pid 0 or a negative pid would signal a process group, so only positive pids count.
const alive = (pid: number) => { if (pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
const mtime = (file: string) => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } };

/** The running app's hub file (live pid, port and token), newest first; null when the app is not running. */
export function antigravityHub(env: Env = process.env): AntigravityHub | null {
  const dir = path.join(env.ANTIGRAVITY_GEMINI_DIR || path.join(homeOf(env), '.gemini'), 'antigravity', 'daemon');
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter(f => /^hub_\d+\.json$/.test(f)); } catch { return null; }
  const hubs = files.map(f => path.join(dir, f)).sort((a, b) => mtime(b) - mtime(a));
  for (const file of hubs) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Number.isInteger(j.pid) && Number.isInteger(j.httpPort) && j.httpPort > 0 && j.httpPort < 65536 && typeof j.csrfToken === 'string' && j.csrfToken && alive(j.pid)) {
        return { pid: j.pid, httpPort: j.httpPort, csrfToken: j.csrfToken, lsVersion: j.lsVersion, file };
      }
    } catch { /* a half-written or foreign file is not a hub */ }
  }
  return null;
}

/** Hash one path framed by name and kind: a symlink by its target (never followed), a regular file by content, anything else by kind. */
function hashEntry(h: ReturnType<typeof createHash>, label: string, file: string): void {
  let st: fs.Stats | null = null;
  try { st = fs.lstatSync(file); } catch { /* hashed as missing */ }
  const kind = !st ? 'missing' : st.isSymbolicLink() ? 'link' : st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other';
  h.update(`\0${label}\0${kind}:${st?.size ?? 0}\0`);
  if (kind === 'link') { try { h.update(fs.readlinkSync(file)); } catch { h.update('unreadable'); } return; }
  if (kind === 'dir') { for (const name of (() => { try { return fs.readdirSync(file).sort(); } catch { return []; } })()) hashEntry(h, `${label}/${name}`, path.join(file, name)); return; }
  if (kind !== 'file') return;
  // A FIFO never reaches here (it would block a read); a huge file counts by size and mtime.
  if (st!.size > 64 * 1024 * 1024) { h.update(String(st!.mtimeMs)); return; }
  try { h.update(fs.readFileSync(file)); } catch { h.update('unreadable'); }
}

/**
 * Everything a read-only agent could change that git can see: HEAD and all refs, status, the
 * worktree and index diffs, untracked contents, and the repository's hooks and config. Gitignored
 * files (such as .env) are not covered.
 */
export function repoFingerprint(cwd: string): string | null {
  const git = (...args: string[]) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
  const parts = [
    git('rev-parse', 'HEAD'), git('for-each-ref', '--format=%(refname) %(objectname)'), git('status', '--porcelain=v1', '-uall'),
    git('diff', 'HEAD', '--binary'), git('diff', '--cached', '--binary'), git('ls-files', '-z', '--others', '--exclude-standard'),
    git('rev-parse', '--git-path', 'hooks'), git('rev-parse', '--git-path', 'config'),
  ];
  // p.error covers a spawn failure or ENOBUFS truncation that still reports no status.
  if (parts.some(p => p.error || p.status !== 0)) return null;
  const h = createHash('sha256');
  for (const p of parts.slice(0, 5)) h.update(p.stdout);
  for (const rel of parts[5].stdout.toString('utf8').split('\0').filter(Boolean)) hashEntry(h, rel, path.join(cwd, rel));
  for (const p of parts.slice(6)) {
    const rel = p.stdout.toString('utf8').trim();
    hashEntry(h, rel, path.resolve(cwd, rel));
  }
  return h.digest('hex');
}

export function agentPrompt(requestFile: string, outFile: string, cwd: string): string {
  // A live run showed an unconstrained agent spends its whole budget running experiments; the request already holds the code.
  return [
    'You are an independent outside code reviewer called by gstack. This is a READ-ONLY, NO-EXECUTION task.',
    `Read the review request in this file: ${requestFile}`,
    'Everything you need, including the code or diff under review, is in that file. Review by reading and reasoning only.',
    `Do not run any terminal command, script, test, build or git command, and do not start other agents or conversations. You may read files in ${cwd} for context, but never modify, create, delete, stage or commit anything there.`,
    'Answer the review request exactly as it asks, in its required format, and finish promptly.',
    // gstack reads a clean claim followed by commentary as unverified (lib/outside-review-result.ts), as a live Argon review showed.
    'If you find no defects, write the line NO_FINDINGS by itself instead of describing what the code does well, then any line the request requires (such as Recommendation: ...).',
    `Write your complete answer, and nothing else, to this file: ${outFile}`,
    `When that file is fully written, create the empty file ${outFile}.done`,
    'Those two files are the only files you may create.',
  ].join('\n');
}

export interface AgentRunOptions { prompt: string; cwd: string; model: string; timeoutMs: number; env?: Env; pollMs?: number }

/** Start one agent conversation and wait for its answer file. */
export async function runAntigravityAgent(opts: AgentRunOptions): Promise<AgentRunResult | AgentRunFailure> {
  const env = opts.env ?? process.env;
  const ls = antigravityLanguageServer(env);
  if (!ls) return { ok: false, code: 'not-installed', unavailable: true, message: 'Antigravity is not installed (no language_server). Install Antigravity, or set GSTACK_ANTIGRAVITY_LS to its language_server path.' };
  const hub = antigravityHub(env);
  if (!hub) return { ok: false, code: 'not-running', unavailable: true, message: 'Antigravity is not running. Open the Antigravity app (signed in to your Google account) and retry.' };

  let prefix: unknown = null;
  try { prefix = env.GSTACK_ANTIGRAVITY_LS_ARGS ? JSON.parse(env.GSTACK_ANTIGRAVITY_LS_ARGS) : []; } catch { /* null: rejected below */ }
  if (!Array.isArray(prefix) || !prefix.every(a => typeof a === 'string')) return { ok: false, code: 'config', unavailable: true, message: 'GSTACK_ANTIGRAVITY_LS_ARGS must be a JSON array of strings.' };
  // Without a before-fingerprint an edit could not be detected, so no review starts.
  const before = repoFingerprint(opts.cwd);
  if (before === null) return { ok: false, code: 'fingerprint', unavailable: true, message: `Could not fingerprint ${opts.cwd} with git, so a read-only review cannot be verified. Run the review inside a git repository.` };

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-agy-'));
  try {
    fs.chmodSync(work, 0o700);
    const requestFile = path.join(work, 'request.md');
    const outFile = path.join(work, 'answer.md');
    fs.writeFileSync(requestFile, opts.prompt, { mode: 0o600 });
    const fwd = (p: string) => p.replaceAll('\\', '/');
    const prompt = agentPrompt(fwd(requestFile), fwd(outFile), fwd(opts.cwd));
    try {
      writeReceipt({
        env, sink: 'outside-voice-antigravity', host: `antigravity (local agent, port ${hub.httpPort})`, payloadClass: 'review-prompt',
        bytes: Buffer.byteLength(opts.prompt), sha256: sha256Hex(opts.prompt),
        consent: 'codex_reviews allows outside reviews; gstack-gemini (outside_provider gemini, gemini_transport antigravity)',
      });
    } catch (err) {
      process.stderr.write(`[gstack-gemini] egress receipt could not be written (${(err as Error).message}); proceeding (fail-open)\n`);
    }
    const started = Date.now();
    const title = `gstack outside review (${path.basename(opts.cwd)})`;
    // GSTACK_ANTIGRAVITY_LS_ARGS (a JSON array) prefixes the argv, as GSTACK_CLAUDE_BIN_ARGS does: tests run a script as the server.
    const res = spawnSync(ls, [...(prefix as string[]), 'agentapi', 'new-conversation', `--model=${opts.model}`, `--title=${title}`, prompt], {
      encoding: 'utf8', timeout: 60_000,
      env: { ...env, ANTIGRAVITY_LS_ADDRESS: `127.0.0.1:${hub.httpPort}`, ANTIGRAVITY_CSRF_TOKEN: hub.csrfToken },
    });
    let reply: any = null;
    try { reply = JSON.parse(res.stdout); } catch { /* reported below */ }
    const conversationId = reply?.response?.newConversation?.conversationId;
    if (typeof conversationId !== 'string' || !conversationId) {
      const raw = reply?.error ?? (res.stdout || res.stderr || res.error?.message || '');
      const detail = (typeof raw === 'string' ? raw : JSON.stringify(raw)).trim().slice(0, 2000);
      // agentapi's own wording for a model it does not offer.
      const unknownModel = /no available model/i.test(detail);
      return { ok: false, code: unknownModel ? 'model' : 'agentapi', unavailable: true, message: `Antigravity did not start the agent${detail ? `: ${detail}` : ''}.${unknownModel ? ' Fix: gstack-config set gemini_model flash' : ''}` };
    }
    process.stderr.write(`ANTIGRAVITY_CONVERSATION: ${conversationId}\n`);
    const modified = (): AgentRunFailure | null => {
      const after = repoFingerprint(opts.cwd);
      if (after === null) return { ok: false, code: 'fingerprint', unavailable: true, conversationId, message: `Could not re-fingerprint ${opts.cwd} after the review, so its read-only claim is unverified; the review is not used.` };
      return after === before ? null
        : { ok: false, code: 'repo-modified', unavailable: false, conversationId, message: `The Antigravity agent changed the repository during a read-only review (conversation ${conversationId}). Its review is not used; inspect the changes with git status / git diff.` };
    };
    const deadline = started + opts.timeoutMs;
    while (!fs.existsSync(`${outFile}.done`)) {
      // agentapi has no cancel: a timed-out agent may keep running in the app, so say where to stop it.
      // An early exit still checks the repository: an edit outranks the timeout.
      if (Date.now() >= deadline) return modified() ?? { ok: false, code: 'timeout', unavailable: true, conversationId, message: `Antigravity agent did not finish within ${Math.round(opts.timeoutMs / 1000)} s (conversation ${conversationId}); stop it in the Antigravity app if it is still running.` };
      if (!alive(hub.pid)) return modified() ?? { ok: false, code: 'not-running', unavailable: true, conversationId, message: `Antigravity exited during the review (conversation ${conversationId}).` };
      await Bun.sleep(opts.pollMs ?? 1000);
    }
    const text = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
    const changed = modified();
    if (changed) return changed;
    if (!text.trim()) return { ok: false, code: 'empty-response', unavailable: false, conversationId, message: `The Antigravity agent wrote an empty answer (conversation ${conversationId}).` };
    return { ok: true, text, conversationId };
  } finally {
    // Windows can hold the agent's files briefly; cleanup is best-effort and never replaces the result.
    try { fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* left in the temp dir */ }
  }
}
