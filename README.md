# pi-provider-env

Pi extension that registers an OpenAI-compatible provider from environment variables.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_ENV_BASE_URL` | Yes | — | API base URL |
| `OPENAI_ENV_API_KEY` | Yes | — | API key. If missing, the provider is skipped. |
| `OPENAI_ENV_MODEL_ID` | No | — | Specific model ID. If unset, fetches all models from `/v1/models`. |
| `OPENAI_ENV_MODEL_EXTRA` | No | — | Extra config as JSON (`contextWindow`, `maxTokens`) |

## Install

```bash
pi install npm:pi-provider-env
```

Or try without persisting:

```bash
pi -e npm:pi-provider-env
```

## Usage

```bash
export OPENAI_ENV_BASE_URL="https://api.openai.com/v1"
export OPENAI_ENV_API_KEY="sk-xxx"
export OPENAI_ENV_MODEL_ID="gpt-4o"  # optional
pi
```

The provider `openai-env` will appear in model selection (`/model` or `Ctrl+P`).

## System CA Trust

On Node 22.15+ / 23.9+, this extension also merges system root CAs (macOS Keychain / Windows cert store / Linux system CA) into Node's default trust set. This enables TLS verification for internally-signed or custom certificates without disabling verification entirely (`NODE_TLS_REJECT_UNAUTHORIZED=0`).