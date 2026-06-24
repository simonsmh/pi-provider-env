# pi-provider-env

Pi extension that registers up to **two independent providers** from environment variables:

- **`OPENAI_ENV_*`** → an OpenAI Chat Completions compatible provider (default id `openai-env`). Standard `openai-completions` streaming (no custom stream handler). Opus 4.7/4.8 and GPT reasoning models are exposed here **without thinking** (Opus thinking needs the Anthropic adaptive endpoint; GPT `reasoning_effort` + function tools is rejected on this gateway's `/v1/chat/completions`). Use `anthropic-env` if you want Opus reasoning.
- **`ANTHROPIC_ENV_*`** → an Anthropic Messages compatible provider (default id `anthropic-env`). All models go through pi's built-in `anthropic-messages` API (streaming, thinking, prompt caching handled natively — no custom stream handler).

The two providers are fully independent: each reads only its own variables (no cross-fallback) and is registered only when its `BASE_URL` + credential are present. Set one, the other, or both at the same time.

## Environment Variables

### OpenAI-completions provider (`OPENAI_ENV_*`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_ENV_BASE_URL` | Yes | — | Gateway base URL (with or without `/v1`) |
| `OPENAI_ENV_API_KEY` | Yes | — | Gateway API key (sent as `Authorization: Bearer`). If missing, this provider is skipped. |
| `OPENAI_ENV_MODEL_ID` | No | — | Specific model ID. If unset, fetches all models from `/v1/models`. |
| `OPENAI_ENV_MODEL_EXTRA` | No | — | Extra config as JSON (`contextWindow`, `maxTokens`) |
| `OPENAI_ENV_PROVIDER_ID` | No | `openai-env` | Provider ID |
| `OPENAI_ENV_PROVIDER_NAME` | No | `OpenAI (Environment)` | Provider display name |

### Anthropic-messages provider (`ANTHROPIC_ENV_*`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_ENV_BASE_URL` | Yes | — | Gateway base URL (with or without `/v1`; the SDK appends `/v1/messages`) |
| `ANTHROPIC_ENV_AUTH_TOKEN` | Yes | — | Gateway auth token (alias: `ANTHROPIC_ENV_API_KEY`). If missing, this provider is skipped. |
| `ANTHROPIC_ENV_MODEL_ID` | No | — | Specific model ID. If unset, fetches all models from `/v1/models`. |
| `ANTHROPIC_ENV_MODEL_EXTRA` | No | — | Extra config as JSON (`contextWindow`, `maxTokens`) |
| `ANTHROPIC_ENV_PROVIDER_ID` | No | `anthropic-env` | Provider ID |
| `ANTHROPIC_ENV_PROVIDER_NAME` | No | `Anthropic (Environment)` | Provider display name |

## Auth

- **OpenAI provider:** `Authorization: Bearer <OPENAI_ENV_API_KEY>` (pi's built-in OpenAI auth).
- **Anthropic provider:** the token is sent two ways so it works with gateways that expect either scheme:
  - `x-api-key: <token>` — pi's built-in Anthropic auth (from `apiKey`)
  - `Authorization: Bearer <token>` — added via custom headers

## Model Discovery

Both providers discover models from the OpenAI-compatible `GET {base}/v1/models` endpoint (authenticated with `Authorization: Bearer`).

Claude Opus 4.7/4.8 are special-cased: the **Anthropic provider** uses adaptive thinking with `maxTokens` capped at 128000 (gateway returns 400 above this) and the `off`/`minimal` thinking levels suppressed; the **OpenAI provider** exposes them as non-reasoning models (their thinking can't be expressed over `openai-completions` on this gateway). The OpenAI provider additionally carries per-vendor `compat`/`thinkingLevelMap` tuning (Qwen, DeepSeek, Kimi, MiniMax, GPT) for Chat Completions quirks.

### max_tokens caps (per endpoint × vendor / category)

The gateway does not report `max_tokens` in `/v1/models`, and the output-token ceiling differs **both by vendor and by endpoint**. Each provider applies its own endpoint-specific cap table as the default upper limit (all values measured against the live gateway):

| Vendor / category (`owned_by` / id) | OpenAI (Chat Completions) | Anthropic (Messages) |
|-------------------------------------|---------------------------|----------------------|
| Claude Opus 4.7/4.8 | 128000 | 128000 |
| Claude (other, `AMAZON_AI`) | 65536 | 65536 |
| GPT (id contains `gpt`) | 128000 | — (skipped) |
| DeepSeek-Pro | 65536 | 8192 |
| DeepSeek (other, e.g. Flash) | 65536 | 65536 |
| GLM (`OTHER`) | 65536 | 8192 |
| Qwen (`ALI_QWEN`) | 65536 | 65536 |
| Kimi (`MOONSHOT_AI`) | 65536 | 65536 |
| MiniMax (`MINIMAX`) | 65536 | 65536 |
| unmatched | `*_ENV_MODEL_EXTRA.maxTokens` or 65536 | same |

Only **DeepSeek-Pro** and **GLM** actually differ by endpoint (the Anthropic endpoint caps them at ~8192, while Chat Completions accepts 65536). Claude is capped at 65536 on the Anthropic endpoint because above that the gateway drops `usage` and crashes the client. If the gateway ever reports a positive `max_tokens` for a model, that value takes priority. `*_ENV_MODEL_EXTRA={"maxTokens":N}` sets the fallback for *unmatched* vendors only.

GPT models are **skipped** by the Anthropic provider: this gateway's Anthropic adapter returns empty content and omits `usage`, which crashes the client. Use the OpenAI provider (`OPENAI_ENV_*`) for GPT instead.

## Install

```bash
pi install npm:pi-provider-env
```

Or try without persisting:

```bash
pi -e npm:pi-provider-env
```

## Usage

OpenAI-completions provider:

```bash
export OPENAI_ENV_BASE_URL="https://gateway.example.com"
export OPENAI_ENV_API_KEY="sk-xxx"
export OPENAI_ENV_MODEL_ID="gpt-4o"        # optional
pi
```

Anthropic-messages provider:

```bash
export ANTHROPIC_ENV_BASE_URL="https://gateway.example.com"
export ANTHROPIC_ENV_AUTH_TOKEN="sk-xxx"
export ANTHROPIC_ENV_MODEL_ID="claude-opus-4-8"  # optional
pi
```

Both at once (two providers appear in `/model` or `Ctrl+P`):

```bash
export OPENAI_ENV_BASE_URL="https://gateway.example.com"
export OPENAI_ENV_API_KEY="sk-xxx"
export ANTHROPIC_ENV_BASE_URL="https://gateway.example.com"
export ANTHROPIC_ENV_AUTH_TOKEN="sk-xxx"
pi
```

## System CA Trust

On Node 22.15+ / 23.9+, this extension also merges system root CAs (macOS Keychain / Windows cert store / Linux system CA) into Node's default trust set. This enables TLS verification for internally-signed or custom certificates without disabling verification entirely (`NODE_TLS_REJECT_UNAUTHORIZED=0`).
