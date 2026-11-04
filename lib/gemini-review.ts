/**
 * gemini-review — the Gemini outside reviewer behind bin/gstack-gemini. The
 * prompt arrives on stdin (the parent appends any diff) and stdout carries one
 * JSON result the generated skill blocks already read (status, result,
 * stderr, model, usage). Two transports, chosen by `gemini_transport`:
 *
 *   antigravity (default): an agent in the user's running Antigravity app, on
 *     their Google plan (lib/antigravity-agent.ts). No API key or billing.
 *   api: one generateContent call with an API key (lib/outside-voice-api.ts).
 *     Key: ~/.gstack/gemini.json, then GEMINI_API_KEY (the design binary's
 *     resolver, so one key serves both).
 *
 * There is no automatic fallback between them: each sends to a different
 * Google service under different data terms, so the user picks one.
 * Model: GSTACK_GEMINI_MODEL, then `gemini_model`, then `flash`. `flash` and
 * `argon` are tier names; any gemini-... ID passes through.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveGeminiKeyInfo } from '../design/src/auth';
import { callModel, DEFAULT_MAX_TOKENS } from './outside-voice-api';
import { antigravityHub, antigravityLanguageServer, runAntigravityAgent } from './antigravity-agent';
import { readConfigKey, type StateRootEnv } from './state-root';

export const DEFAULT_GEMINI_MODEL = 'flash';
/** Tier names per transport: Antigravity resolves its own `flash` tier; Argon is the pro tier there. */
const TIERS: Record<Transport, Record<string, string>> = {
  // Measured live (Antigravity LS 2.29.0, one 200-line review): the plain `flash` tier took 526 s, past the 300 s most
  // gates allow; gemini-3.8-flash-low took 11 s and gemini-4-argon-medium 50 s. agentapi rejects a bare gemini-4-argon.
  antigravity: { flash: 'gemini-3.8-flash-low', argon: 'gemini-4-argon-medium' },
  api: { flash: 'gemini-3.8-flash', argon: 'gemini-4-argon' },
};
export const GEMINI_KEY_REPAIR = 'Run `gstack-gemini setup` (stores ~/.gstack/gemini.json) or export GEMINI_API_KEY; get a key at https://aistudio.google.com/apikey';

type Transport = 'antigravity' | 'api';
type Env = StateRootEnv & { GSTACK_GEMINI_MODEL?: string; GSTACK_GEMINI_TRANSPORT?: string };

export interface GeminiReviewResult {
  status: 'completed' | 'unavailable' | 'error';
  provider: 'gemini';
  result: string;
  transport?: Transport;
  model?: string;
  conversation_id?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { code: string; message: string };
  stderr?: string;
}

const failure = (code: string, message: string, unavailable = false): GeminiReviewResult =>
  ({ status: unavailable ? 'unavailable' : 'error', provider: 'gemini', result: '', error: { code, message }, stderr: message });

export function configuredTransport(env: Env = process.env): Transport | null {
  const value = env.GSTACK_GEMINI_TRANSPORT || readConfigKey('gemini_transport', env) || 'antigravity';
  return value === 'antigravity' || value === 'api' ? value : null;
}

export function configuredGeminiModel(env: Env = process.env, transport: Transport = 'antigravity'): { model: string; source: string } | null {
  const raw = env.GSTACK_GEMINI_MODEL ? { value: env.GSTACK_GEMINI_MODEL, source: 'GSTACK_GEMINI_MODEL' }
    : { value: readConfigKey('gemini_model', env) || DEFAULT_GEMINI_MODEL, source: readConfigKey('gemini_model', env) ? 'config gemini_model' : 'default' };
  const tier = TIERS[transport][raw.value];
  if (tier) return { model: tier, source: `${raw.source} (${raw.value})` };
  return /^gemini-[a-z0-9.-]+$/.test(raw.value) ? { model: raw.value, source: raw.source } : null;
}

export async function runGeminiReview(opts: { prompt: string; cwd: string; timeoutMs: number; env?: Env }): Promise<GeminiReviewResult> {
  const env = opts.env ?? process.env;
  const transport = configuredTransport(env);
  if (!transport) return failure('config', 'gemini_transport must be antigravity or api. Fix: gstack-config set gemini_transport antigravity');
  const selected = configuredGeminiModel(env, transport);
  if (!selected) return failure('model', `gemini_model is not flash, argon or a gemini-... model ID. Fix: gstack-config set gemini_model ${DEFAULT_GEMINI_MODEL}`);
  if (!opts.prompt.trim()) return failure('arguments', 'Empty prompt on stdin.');
  process.stderr.write(`GEMINI_MODEL: ${selected.model} via ${transport} (source: ${selected.source})\n`);
  return transport === 'antigravity' ? reviewViaAntigravity(opts, selected.model, env) : reviewViaApi(opts, selected.model, env);
}

async function reviewViaAntigravity(opts: { prompt: string; cwd: string; timeoutMs: number }, model: string, env: Env): Promise<GeminiReviewResult> {
  const r = await runAntigravityAgent({ prompt: opts.prompt, cwd: opts.cwd, model, timeoutMs: opts.timeoutMs, env });
  const base = { transport: 'antigravity' as const, model, ...(r.conversationId ? { conversation_id: r.conversationId } : {}) };
  if (r.ok) return { status: 'completed', provider: 'gemini', result: r.text, ...base };
  return { ...failure(r.code, r.message, r.unavailable), ...base };
}

async function reviewViaApi(opts: { prompt: string; timeoutMs: number }, model: string, env: Env): Promise<GeminiReviewResult> {
  const key = resolveGeminiKeyInfo();
  if (!key) return failure('authentication', `No Gemini API key (gemini_transport api). ${GEMINI_KEY_REPAIR}`, true);
  if (key.warning) process.stderr.write(`${key.warning}\n`);
  try {
    const res = await callModel({
      model, prompt: opts.prompt, timeoutMs: opts.timeoutMs, maxTokens: DEFAULT_MAX_TOKENS,
      env: { ...env, GEMINI_API_KEY: key.key },
      receipt: { sink: 'outside-voice-gemini', consent: 'codex_reviews allows outside reviews; gstack-gemini (outside_provider gemini, gemini_transport api)', payloadClass: 'review-prompt' },
    });
    const base = { transport: 'api' as const, model: res.model, usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens } };
    if (res.truncated) return { ...failure('truncated', `Gemini stopped at the ${DEFAULT_MAX_TOKENS}-token output limit; the review is cut off.`), ...base };
    if (!res.text.trim()) return { ...failure('empty-response', `Gemini returned no response text${res.stop_reason ? ` (finish reason ${res.stop_reason})` : ''}.`), ...base };
    return { status: 'completed', provider: 'gemini', result: res.text, ...base };
  } catch (error) {
    const message = (error as Error).message;
    if (/^google (401|403)\b|API key not valid|PERMISSION_DENIED|UNAUTHENTICATED/.test(message)) return failure('authentication', `Gemini authentication failed: ${message}. ${GEMINI_KEY_REPAIR}`, true);
    if (/timeout after/.test(message)) return failure('timeout', `Gemini timed out after ${opts.timeoutMs} ms.`, true);
    return failure('provider-error', `Gemini request failed: ${message}`);
  }
}

/** Ready for the configured transport, with the repair on stderr when not. Sends nothing. */
export function probeGemini(env: Env = process.env): { ok: boolean; message: string } {
  const transport = configuredTransport(env);
  if (transport === 'api') return resolveGeminiKeyInfo() ? { ok: true, message: 'api: key found' } : { ok: false, message: `No Gemini API key. ${GEMINI_KEY_REPAIR}` };
  if (transport !== 'antigravity') return { ok: false, message: 'gemini_transport must be antigravity or api.' };
  if (!antigravityLanguageServer(env)) return { ok: false, message: 'Antigravity is not installed (no language_server found).' };
  const hub = antigravityHub(env);
  return hub ? { ok: true, message: `antigravity: running (pid ${hub.pid}, port ${hub.httpPort})` } : { ok: false, message: 'Antigravity is not running. Open the Antigravity app and retry.' };
}

/** Save a key the way `$D setup --provider gemini` does: ~/.gstack/gemini.json, mode 0600. */
export function saveGeminiKey(key: string, home = process.env.HOME || process.env.USERPROFILE || ''): string {
  if (!/^\S{20,}$/.test(key)) throw new Error('That does not look like an API key (expected one token, 20+ characters).');
  const file = path.join(home, '.gstack', 'gemini.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ api_key: key }, null, 2) + '\n', { mode: 0o600 });
  return file;
}

const USAGE = 'Usage: gstack-gemini --cwd <repo> --timeout-ms <n> [--access none|read-only] [--role plan-review] (prompt on stdin)\n       gstack-gemini --probe | setup';

export async function geminiMain(argv: string[]): Promise<number> {
  if (argv[0] === '--probe') {
    const probe = probeGemini();
    process.stderr.write(`${probe.message}\n`);
    return probe.ok ? 0 : 1;
  }
  if (argv[0] === 'setup') {
    process.stderr.write('Paste your Gemini API key (https://aistudio.google.com/apikey) and press Enter. It is used only with gemini_transport api:\n');
    try {
      const file = saveGeminiKey((await Bun.stdin.text()).trim());
      process.stderr.write(`Saved ${file}. Use it: gstack-config set gemini_transport api\n`);
      return 0;
    } catch (error) {
      process.stderr.write(`gstack-gemini setup: ${(error as Error).message}\n`);
      return 1;
    }
  }
  let result: GeminiReviewResult;
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--cwd', '--access', '--timeout-ms', '--role'].includes(argv[i]) || values.has(argv[i]) || argv[i + 1] === undefined) { values.clear(); values.set('bad', argv[i] ?? ''); break; }
    values.set(argv[i], argv[i + 1]);
  }
  const timeoutMs = Number(values.get('--timeout-ms'));
  const role = values.get('--role');
  const access = values.get('--access') ?? 'none';
  const cwd = values.get('--cwd');
  // --access and --role are accepted for parity with gstack-claude-code; the Antigravity agent is told read-only either way.
  if (values.has('bad') || !cwd || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !['none', 'read-only'].includes(access) || (role !== undefined && role !== 'plan-review')) {
    result = failure('arguments', USAGE);
  } else {
    result = await runGeminiReview({ prompt: await Bun.stdin.text(), cwd, timeoutMs });
  }
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(result)}\n`, (error) => error ? reject(error) : resolve());
  });
  return result.status === 'completed' ? 0 : 1;
}
