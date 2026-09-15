const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
test('context window limits apply independently to both providers', async () => {
  const js = ts.transpileModule(fs.readFileSync('extensions/env-provider.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const { default: register } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
  const saved = { ...process.env }, originalFetch = globalThis.fetch;
  try {
    for (const key of Object.keys(process.env)) if (/^(OPENAI|ANTHROPIC)_ENV_/.test(key)) delete process.env[key];
    for (const prefix of ['OPENAI', 'ANTHROPIC']) {
      process.env[`${prefix}_ENV_BASE_URL`] = 'https://mock.invalid';
      process.env[`${prefix}_ENV_API_KEY`] = 'test';
    }
    let advertised;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [
      { id: 'DeepSeek-V4.1-Flash', context_window: advertised },
    ] }) });
    for (const [window, limit, expected] of [
      [undefined, undefined, 1000000], [128000, undefined, 128000],
      [undefined, 200000, 200000], [1000000, 200000, 200000], [128000, 200000, 128000],
    ]) {
      advertised = window;
      process.env.OPENAI_ENV_MODEL_EXTRA = JSON.stringify({ contextWindow: limit });
      process.env.ANTHROPIC_ENV_MODEL_EXTRA = JSON.stringify({ contextWindow: 100000 });
      const providers = new Map();
      await register({ registerProvider: (id, config) => providers.set(id, config) });
      assert.equal(providers.get('openai-env').models[0].contextWindow, expected);
      assert.equal(providers.get('anthropic-env').models[0].contextWindow, 100000);
    }
    for (const invalid of [0, -1, 1.5, '200000', null, Number.MAX_SAFE_INTEGER + 1]) {
      process.env.OPENAI_ENV_MODEL_EXTRA = JSON.stringify({ contextWindow: invalid });
      await assert.rejects(register({ registerProvider() {} }), /positive safe integer/);
    }
    process.env.OPENAI_ENV_MODEL_EXTRA = '{invalid';
    await assert.rejects(register({ registerProvider() {} }), SyntaxError);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
