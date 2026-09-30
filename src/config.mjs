// Central env loading + fail-fast validation.
// The proxy refuses to start with a missing/weak key instead of running exposed.
const CNB_API = 'https://api.cnb.cool';

// CNB repo slug (org/repo). CNB_REPO_SLUG or CNB_BUILD_REPO are built-in
// variables present in CNB pipelines/workspaces, so you rarely need to set this by hand.
const repo = process.env.CNB_REPO_SLUG || process.env.CNB_BUILD_REPO || '';

// CNB exposes TWO AI upstreams with very different behaviour:
//   workspace  /-/ai/chat/completions       — pinned to one model, ignores the
//                                             request's `model` field entirely.
//   ai-ide     /-/ai-ide/v2/chat/completions — the CodeBuddy gateway: validates
//                                             `model` against a real catalog and
//                                             routes to that vendor's backend.
// `ai-ide` is the default because it is the only one that can serve more than one
// model; set UPSTREAM_KIND=workspace for the old single-model behaviour.
const ideBase = repo ? `${CNB_API}/${repo}/-/ai-ide` : '';
const UPSTREAM_KINDS = {
  ide: ideBase ? `${ideBase}/v2/chat/completions` : '',
  workspace: repo ? `${CNB_API}/${repo}/-/ai/chat/completions` : '',
};
const upstreamKind = (process.env.UPSTREAM_KIND || 'ide').trim().toLowerCase();

// Model catalog lives behind the ai-ide product config endpoint. It only accepts
// requests whose User-Agent looks like the CodeBuddy client, hence the CLI/<v>
// CodeBuddy/<v> string below (the version need not be a real release).
const modelsUrl = process.env.PROXY_MODELS_URL || (ideBase ? `${ideBase}/v3/config` : '');

// Dynamic catalog on by default in production. The test hook UPSTREAM_OVERRIDE
// points the upstream at a local mock, so we must not reach out to CNB there —
// unless the test explicitly opts in via PROXY_MODELS_DYNAMIC=1.
const dynamicDefault = process.env.UPSTREAM_OVERRIDE ? '0' : '1';
const modelsDynamic = (process.env.PROXY_MODELS_DYNAMIC ?? dynamicDefault) !== '0' && !!modelsUrl;

export const config = {
  port: Number(process.env.PROXY_PORT || 9001),
  repo,
  upstreamKind,
  proxyKey: process.env.PROXY_KEY || '',
  upstreamToken: process.env.CNB_TOKEN || '',
  // Static fallback for /v1/models, used until the live catalog loads and whenever
  // it cannot be fetched. Actual routing is done by the CNB gateway.
  models: (process.env.PROXY_MODELS || 'deepseek-v4.1-flash,glm-5.3-flash,kimi-k3-2').split(',').map((s) => s.trim()).filter(Boolean),
  // Live model catalog (ai-ide /v3/config): drives /v1/models.
  modelsUrl,
  modelsDynamic,
  modelsTtlMs: Number(process.env.PROXY_MODELS_TTL_MS || 3_600_000),   // background refresh cadence
  modelsTimeoutMs: Number(process.env.PROXY_MODELS_TIMEOUT_MS || 8_000), // catalog fetch timeout
  modelsWaitMs: Number(process.env.PROXY_MODELS_WAIT_MS || 1_500),       // max a request waits for a cold cache
  codebuddyVersion: process.env.CODEBUDDY_VERSION || '2.160.0',
  maxBodyBytes: 4 * 1024 * 1024,
  upstreamTimeoutMs: Number(process.env.PROXY_UPSTREAM_TIMEOUT_MS || 15_000), // connect + first byte
  idleTimeoutMs: Number(process.env.PROXY_IDLE_TIMEOUT_MS || 300_000),        // per-stream idle cap (reset each chunk)
  authFailWindowMs: 60_000,
  authFailMax: 10,
  upstreamUrl: '',
};

// UPSTREAM_OVERRIDE is a test-only hook (point the upstream at a local mock).
// In production the upstream is a CNB in-network AI endpoint for this repo.
config.upstreamUrl = process.env.UPSTREAM_OVERRIDE || UPSTREAM_KINDS[upstreamKind] || '';

if (!config.proxyKey) {
  console.error('[config] PROXY_KEY is required (env). Refusing to start with a default key.');
  process.exit(1);
}
if (!config.upstreamToken) {
  console.error('[config] CNB_TOKEN is required (env, injected by the pipeline stage). Refusing to start.');
  process.exit(1);
}
if (!config.upstreamUrl) {
  console.error(`[config] upstream URL is empty: set CNB_REPO_SLUG (org/repo) or UPSTREAM_OVERRIDE, and UPSTREAM_KIND to one of ${Object.keys(UPSTREAM_KINDS).join('|')} (got ${JSON.stringify(upstreamKind)}).`);
  process.exit(1);
}
