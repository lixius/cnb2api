// Live model catalog for GET /v1/models.
//
// The ai-ide gateway publishes the models it can actually route to via
// `<repo>/-/ai-ide/v3/config` (the same payload the CodeBuddy client reads to build
// its model picker). We cache it and refresh in the background, so /v1/models
// reflects the account's real catalog instead of a hand-maintained list.
//
// Degradation is deliberate: a failed fetch never takes /v1/models down — it keeps
// serving the last good catalog, or the static PROXY_MODELS list on a cold start.
import { config } from './config.mjs';
import { log } from './log.mjs';

const STATIC_SOURCE = 'static';
const LIVE_SOURCE = 'cnb';

let cache = { list: [], fetchedAt: 0, source: STATIC_SOURCE };
let inflight = null;

// OpenAI model objects, plus the CNB metadata that clients like to surface.
export function normalize(raw) {
  return raw
    .filter((m) => m && typeof m.id === 'string' && m.id)
    .map((m) => {
      const out = { id: m.id, object: 'model', owned_by: 'cnb' };
      if (m.name) out.name = m.name;
      if (m.maxInputTokens) out.context_length = m.maxInputTokens;
      if (m.maxOutputTokens) out.max_output_tokens = m.maxOutputTokens;
      if (m.credits) out.credits = m.credits;
      const desc = m.descriptionZh || m.descriptionEn;
      if (desc) out.description = desc;
      out.supports_tool_call = !!m.supportsToolCall;
      out.supports_images = !!m.supportsImages;
      out.supports_reasoning = !!m.supportsReasoning;
      return out;
    });
}

export function staticList() {
  return config.models.map((id) => ({ id, object: 'model', owned_by: 'cnb' }));
}

// GET the product config and pull `data.models` out of it. `fetchImpl` is
// injectable so tests can run without a network.
export async function fetchCatalog({
  url = config.modelsUrl,
  token = config.upstreamToken,
  version = config.codebuddyVersion,
  timeoutMs = config.modelsTimeoutMs,
  fetchImpl = fetch,
} = {}) {
  if (!url) throw new Error('model catalog URL is empty (set CNB_REPO_SLUG or PROXY_MODELS_URL)');
  const r = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      // The endpoint rejects requests that do not look like the CodeBuddy client.
      'User-Agent': `CLI/${version} CodeBuddy/${version}`,
      'X-Product': 'SaaS',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  const body = await r.json().catch(() => null);
  const raw = body?.data?.models;
  if (!Array.isArray(raw)) throw new Error('unexpected catalog shape (expected data.models[])');
  return normalize(raw);
}

// Last good catalog, else the static fallback list.
export function list() {
  return cache.list.length ? cache.list : staticList();
}

export function isLoaded() {
  return cache.list.length > 0;
}

export function state() {
  return { source: isLoaded() ? cache.source : STATIC_SOURCE, count: list().length, fetched_at: cache.fetchedAt || null };
}

// Fetch once, coalescing concurrent callers onto a single request.
export function refresh() {
  if (!config.modelsDynamic) return Promise.resolve(list());
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const next = await fetchCatalog();
      if (next.length) {
        cache = { list: next, fetchedAt: Date.now(), source: LIVE_SOURCE };
        log.info('-', 'model catalog loaded', { count: next.length });
      } else {
        log.warn('-', 'model catalog was empty, keeping fallback', { fallback: config.models.length });
      }
    } catch (e) {
      log.warn('-', 'model catalog fetch failed, keeping fallback', { err: String(e).slice(0, 160) });
    } finally {
      inflight = null;
    }
    return list();
  })();
  return inflight;
}

// Bounded wait for a cold cache: a request should never hang on the catalog.
export async function ensure(waitMs = config.modelsWaitMs) {
  if (isLoaded() || !config.modelsDynamic) return list();
  let timer;
  const cap = new Promise((resolve) => { timer = setTimeout(resolve, waitMs); if (timer.unref) timer.unref(); });
  try { await Promise.race([refresh(), cap]); } finally { clearTimeout(timer); }
  return list();
}

// Kick off the first fetch immediately and keep it fresh in the background.
export function start() {
  if (!config.modelsDynamic) {
    log.info('-', 'model catalog: dynamic disabled', { models: config.models.length });
    return;
  }
  refresh();
  const timer = setInterval(refresh, config.modelsTtlMs);
  if (timer.unref) timer.unref();
}
