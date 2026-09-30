// 模型目录测试：纯函数 + mock 目录服务，不打真实 CNB API。
// 运行：node --test test/models.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';

// config.mjs 在 import 时做 fail-fast 校验并可能 process.exit；先补好环境再动态 import。
process.env.PROXY_KEY ||= 'test-key-12345';
process.env.CNB_TOKEN ||= 'test-token';
process.env.CNB_REPO_SLUG ||= 'test/repo';
process.env.PROXY_MODELS = 'static-a,static-b';
process.env.PROXY_MODELS_DYNAMIC = '0'; // 单元测试不触网
const models = await import('../src/models.mjs');

const LIVE_PORT = 19131;
const BROKEN_PORT = 19133;
const PROXY_PORT = 19132;
const KEY = 'test-key-12345';

// ---- 单元：normalize ----
test('normalize: 映射 CNB 元数据并过滤脏数据', () => {
  const out = models.normalize([
    {
      id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', maxInputTokens: 1000000, maxOutputTokens: 131072,
      credits: 'x0.06 credits', supportsToolCall: true, supportsImages: true, supportsReasoning: true,
      descriptionZh: '原生多模态模型', descriptionEn: 'multimodal',
    },
    { id: '', name: 'empty id' },
    null,
    { name: 'no id' },
  ]);
  assert.equal(out.length, 1);
  const m = out[0];
  assert.equal(m.id, 'glm-5.3-flash');
  assert.equal(m.object, 'model');
  assert.equal(m.owned_by, 'cnb');
  assert.equal(m.name, 'GLM-5.3-Flash');
  assert.equal(m.context_length, 1000000);
  assert.equal(m.max_output_tokens, 131072);
  assert.equal(m.credits, 'x0.06 credits');
  assert.equal(m.description, '原生多模态模型');
  assert.equal(m.supports_tool_call, true);
  assert.equal(m.supports_images, true);
  assert.equal(m.supports_reasoning, true);
});

test('normalize: 缺字段时补 false，不产生 undefined 能力位', () => {
  const [m] = models.normalize([{ id: 'x' }]);
  assert.equal(m.supports_tool_call, false);
  assert.equal(m.supports_images, false);
  assert.equal(m.supports_reasoning, false);
  assert.ok(!('context_length' in m));
});

// ---- 单元：fetchCatalog ----
test('fetchCatalog: 带 CodeBuddy UA 取 data.models', async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, headers: init.headers };
    return {
      ok: true,
      json: async () => ({ code: 0, data: { models: [{ id: 'glm-5.3', supportsToolCall: true }] } }),
    };
  };
  const out = await models.fetchCatalog({ url: 'http://catalog.local/v3/config', token: 'tok', fetchImpl });
  assert.equal(out[0].id, 'glm-5.3');
  assert.equal(seen.url, 'http://catalog.local/v3/config');
  assert.equal(seen.headers.Authorization, 'Bearer tok');
  assert.match(seen.headers['User-Agent'], /^CLI\/[\d.]+ CodeBuddy\/[\d.]+$/);
  assert.equal(seen.headers['X-Product'], 'SaaS');
});

test('fetchCatalog: 非 200 抛错', async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({}) });
  await assert.rejects(
    () => models.fetchCatalog({ url: 'http://catalog.local/v3/config', token: 't', fetchImpl }),
    /HTTP 400/,
  );
});

test('fetchCatalog: 结构不符抛错', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ code: 0, data: {} }) });
  await assert.rejects(
    () => models.fetchCatalog({ url: 'http://catalog.local/v3/config', token: 't', fetchImpl }),
    /unexpected catalog shape/,
  );
});

test('fetchCatalog: URL 为空抛错', async () => {
  await assert.rejects(() => models.fetchCatalog({ url: '', token: 't' }), /URL is empty/);
});

// ---- 单元：冷启动降级 ----
test('list: 目录未加载时降级到 PROXY_MODELS', () => {
  const l = models.list();
  assert.deepEqual(l.map((m) => m.id), ['static-a', 'static-b']);
  assert.equal(models.state().source, 'static');
});

// ---- 集成：真实代理进程 + mock 目录服务 ----
const liveCatalog = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    code: 0,
    data: {
      models: [
        { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', maxInputTokens: 1000000, supportsToolCall: true },
        { id: 'kimi-k3-2', name: 'Kimi-K3-2', supportsToolCall: true },
        { id: 'step-5-preview', name: 'Step-5', supportsImages: true },
      ],
    },
  }));
});

const brokenCatalog = http.createServer((req, res) => {
  res.writeHead(500, { 'Content-Type': 'application/json' });
  res.end('{"code":500,"msg":"boom"}');
});

function startProxy(env) {
  return spawn(process.execPath, ['src/server.mjs'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      PROXY_PORT: String(PROXY_PORT),
      PROXY_KEY: KEY,
      CNB_TOKEN: 'test-token',
      CNB_REPO_SLUG: 'test/repo',
      // 仅满足配置校验；本文件不发聊天请求，不会真的打这个地址
      UPSTREAM_OVERRIDE: 'http://127.0.0.1:9/upstream',
      PROXY_MODELS: 'fallback-a,fallback-b',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForModels() {
  let lastErr;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/models`, { headers: { Authorization: `Bearer ${KEY}` } });
      if (r.status === 200) return await r.json();
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw lastErr || new Error('proxy /v1/models unreachable');
}

test('集成：/v1/models 暴露实时目录而不是 PROXY_MODELS', async (t) => {
  await new Promise((r) => liveCatalog.listen(LIVE_PORT, '127.0.0.1', r));
  const proxy = startProxy({
    PROXY_MODELS_DYNAMIC: '1',
    PROXY_MODELS_URL: `http://127.0.0.1:${LIVE_PORT}/v3/config`,
  });
  t.after(() => { proxy.kill('SIGTERM'); liveCatalog.close(); });

  const body = await waitForModels();
  assert.equal(body.object, 'list');
  assert.deepEqual(body.data.map((m) => m.id), ['glm-5.3-flash', 'kimi-k3-2', 'step-5-preview']);

  const glm = body.data.find((m) => m.id === 'glm-5.3-flash');
  assert.equal(glm.object, 'model');
  assert.equal(glm.owned_by, 'cnb');
  assert.equal(glm.name, 'GLM-5.3-Flash');
  assert.equal(glm.context_length, 1000000);
  assert.equal(glm.supports_tool_call, true);
});

test('集成：目录接口故障时 /v1/models 降级到静态列表', async (t) => {
  await new Promise((r) => brokenCatalog.listen(BROKEN_PORT, '127.0.0.1', r));
  const proxy = startProxy({
    PROXY_MODELS_DYNAMIC: '1',
    PROXY_MODELS_URL: `http://127.0.0.1:${BROKEN_PORT}/v3/config`,
    PROXY_MODELS_TIMEOUT_MS: '1000',
    PROXY_MODELS_WAIT_MS: '300',
  });
  t.after(() => { proxy.kill('SIGTERM'); brokenCatalog.close(); });

  const body = await waitForModels();
  assert.deepEqual(body.data.map((m) => m.id), ['fallback-a', 'fallback-b']);
});
