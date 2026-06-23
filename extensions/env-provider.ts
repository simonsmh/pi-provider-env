import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import tls from "node:tls";

/**
 * 将系统证书库（macOS 钥匙串 / Windows 证书存储 / Linux 系统 CA）中的根 CA
 * 合并进 Node 的默认信任集，以便信任系统证书库中的自定义或内部证书。
 *
 * 背景：Node 默认只使用内置的公共 CA 集合，不读取系统证书库，导致内部签发的
 * 证书报 UNABLE_TO_VERIFY_LEAF_SIGNATURE。这里在模块加载时尽早执行，确保不仅
 * 本插件的 fetch，连 pi 框架后续发出的对话请求也能通过 TLS 校验。
 *
 * 相比 NODE_TLS_REJECT_UNAUTHORIZED=0，本方案不降级证书校验，只补充信任来源。
 * 依赖 Node 22.15+ / 23.9+ 的 tls.getCACertificates / setDefaultCACertificates，
 * 旧版本静默跳过。
 */
function ensureSystemCATrusted(): void {
  try {
    if (
      typeof tls.getCACertificates !== "function" ||
      typeof tls.setDefaultCACertificates !== "function"
    ) {
      return;
    }
    const system = tls.getCACertificates("system");
    if (!system || system.length === 0) {
      return;
    }
    const defaults = tls.getCACertificates("default");
    // 去重合并，避免重复注入
    const merged = Array.from(new Set([...defaults, ...system]));
    tls.setDefaultCACertificates(merged);
  } catch {
    // 任意失败都不应阻断插件加载，静默忽略
  }
}

ensureSystemCATrusted();

type PiInputModality = "text" | "image";

type PiModelCompat = {
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  supportsReasoningEffort?: boolean;
  thinkingFormat?: "openai" | "qwen" | "deepseek" | "openrouter";
  requiresReasoningContentOnAssistantMessages?: boolean;
};

type PiModelDefinition = {
  id: string;
  name: string;
  reasoning: boolean;
  input: PiInputModality[];
  /** 单位：元/百万 token */
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  compat?: PiModelCompat;
};

/** OpenAI 兼容 /v1/models 返回的单条模型 */
type ApiModel = {
  id: string;
  name?: string;
  owned_by?: string;
  context_window?: number;
  max_tokens?: number;
  status?: string;
  architecture?: {
    input_modalities?: string[];
  };
  pricing?: {
    prompt?: string | null;
    completion?: string | null;
  };
  capabilities?: string[];
  supported_parameters?: string[];
};

/** 接口 pricing 为 元/token；Pi cost 为 元/百万 token */
function parsePricingPerMillion(value: string | null | undefined): number {
  if (value == null) {
    return 0;
  }
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n * 1_000_000 : 0;
}

function mapInputModalities(modalities?: string[]): PiInputModality[] {
  if (!modalities?.length) {
    return ["text"];
  }
  const input: PiInputModality[] = [];
  if (modalities.includes("text")) {
    input.push("text");
  }
  if (modalities.includes("image")) {
    input.push("image");
  }
  return input.length > 0 ? input : ["text"];
}

/** Pi 模型能力标记：是否支持 extended thinking（非 API 参数名） */
function supportsReasoning(model: ApiModel): boolean {
  return model.capabilities?.includes("deepThinking") === true;
}

/** 按网关实测结果设置 Pi compat，避免传错参 */
function resolveCompat(model: ApiModel): PiModelCompat | undefined {
  const ownedBy = model.owned_by ?? "";
  const id = model.id.toLowerCase();
  const compat: PiModelCompat = {};

  if (ownedBy === "OPENAI" || id.startsWith("gpt")) {
    compat.maxTokensField = "max_completion_tokens";
  }
  if (ownedBy === "AMAZON_AI" || id.startsWith("claude")) {
    // 网关走 Bedrock Converse，Pi 默认 reasoning_effort 会 400
    compat.supportsReasoningEffort = false;
  }
  if (ownedBy === "ALI_QWEN" || id.includes("qwen")) {
    // 网关实测：enable_thinking 可开关思考；reasoning_effort 无法可靠关闭默认思考
    compat.thinkingFormat = "qwen";
    compat.requiresReasoningContentOnAssistantMessages = true;
  }
  if (id.includes("deepseek")) {
    compat.requiresReasoningContentOnAssistantMessages = true;
  }

  return Object.keys(compat).length > 0 ? compat : undefined;
}

function mapApiModelToPiModel(
  model: ApiModel,
  defaults: { contextWindow: number; maxTokens: number },
): PiModelDefinition {
  const compat = resolveCompat(model);
  return {
    id: model.id,
    name: model.id,
    reasoning: supportsReasoning(model),
    input: mapInputModalities(model.architecture?.input_modalities),
    cost: {
      input: parsePricingPerMillion(model.pricing?.prompt),
      output: parsePricingPerMillion(model.pricing?.completion),
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: model.context_window ?? defaults.contextWindow,
    maxTokens: model.max_tokens ?? defaults.maxTokens,
    ...(compat ? { compat } : {}),
  };
}

/**
 * Pi 插件：从环境变量读取 OpenAI 兼容 API 配置
 *
 * 环境变量：
 * - OPENAI_ENV_BASE_URL: API 基础 URL（必填）
 * - OPENAI_ENV_API_KEY: API 密钥（必填）
 * - OPENAI_ENV_MODEL_ID: 模型 ID（可选，不设置则从 /v1/models 获取所有可用模型）
 * - OPENAI_ENV_MODEL_EXTRA: 额外模型配置（JSON 格式，可选）
 * - OPENAI_ENV_PROVIDER_ID: Provider ID（可选，默认 openai-env）
 * - OPENAI_ENV_PROVIDER_NAME: Provider 显示名称（可选，默认 OpenAI (Environment)）
 *
 * 示例：
 * export OPENAI_ENV_BASE_URL="https://api.openai.com/v1"
 * export OPENAI_ENV_API_KEY="sk-xxx"
 * export OPENAI_ENV_MODEL_ID="gpt-4o"
 */
export default async function (pi: ExtensionAPI) {
  const baseUrl = process.env.OPENAI_ENV_BASE_URL;
  const apiKey = process.env.OPENAI_ENV_API_KEY;
  const modelId = process.env.OPENAI_ENV_MODEL_ID;
  const providerId = process.env.OPENAI_ENV_PROVIDER_ID ?? "openai-env";
  const providerName = process.env.OPENAI_ENV_PROVIDER_NAME ?? "OpenAI (Environment)";

  // 如果缺少 API 密钥或基础 URL，跳过注册
  if (!apiKey || !baseUrl) {
    return;
  }

  // 解析额外配置
  let extraConfig: Record<string, unknown> = {};
  if (process.env.OPENAI_ENV_MODEL_EXTRA) {
    try {
      extraConfig = JSON.parse(process.env.OPENAI_ENV_MODEL_EXTRA);
    } catch {
      // 忽略解析错误
    }
  }

  const modelDefaults = {
    contextWindow: (extraConfig.contextWindow as number) ?? 1_000_000,
    maxTokens: (extraConfig.maxTokens as number) ?? 384_000,
  };

  let apiModels: ApiModel[] = [];
  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
    if (response.ok) {
      const data = (await response.json()) as { data: ApiModel[] };
      apiModels = data.data.filter((model) => !model.status || model.status === "online");
    }
  } catch (error) {
    console.error("Failed to fetch models:", error);
  }

  let models: PiModelDefinition[] = [];

  if (modelId) {
    const found = apiModels.find((model) => model.id === modelId);
    models = [mapApiModelToPiModel(found ?? { id: modelId }, modelDefaults)];
  } else {
    models = apiModels.map((model) => mapApiModelToPiModel(model, modelDefaults));
  }

  // 如果没有模型，跳过注册
  if (models.length === 0) {
    return;
  }

  // 注册 provider
  pi.registerProvider(providerId, {
    name: providerName,
    baseUrl,
    apiKey,
    api: "openai-completions",
    models,
  });
}
