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

// =============================================================================
// 共享类型与工具
// =============================================================================

type PiInputModality = "text" | "image";
type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type PiThinkingLevelMap = Partial<Record<PiThinkingLevel, string | null>>;

/** 同时覆盖 openai-completions 与 anthropic-messages 两套 API 的兼容标记 */
type PiModelCompat = {
  // ---- openai-completions ----
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  thinkingFormat?: "openai" | "qwen" | "deepseek" | "openrouter";
  requiresReasoningContentOnAssistantMessages?: boolean;
  // ---- anthropic-messages ----
  /** 上游模型要求 adaptive thinking（thinking.type=adaptive + output_config.effort） */
  forceAdaptiveThinking?: boolean;
  /** 上游会回传空 thinking 签名，回放时需允许 signature:"" */
  allowEmptySignature?: boolean;
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
  thinkingLevelMap?: PiThinkingLevelMap;
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

function isClaudeModel(model: ApiModel): boolean {
  const ownedBy = model.owned_by ?? "";
  const id = model.id.toLowerCase();
  return ownedBy === "AMAZON_AI" || id.startsWith("claude");
}

function normalizeModelIdString(id: string): string {
  return id.toLowerCase().replace(/[\s_.:]+/g, "-");
}

/** Opus adaptive + /v1/messages：网关实测 max_tokens > 128000 会 400 */
const OPUS_ADAPTIVE_MAX_TOKENS = 128_000;

/** Opus 4.7/4.8：Pi 未识别 opus-4-8 时会发 budget thinking 导致 400，需显式 adaptive */
function isOpusAdaptiveModelId(id: string): boolean {
  const normalized = normalizeModelIdString(id);
  return normalized.includes("opus-4-7") || normalized.includes("opus-4-8");
}

function isOpusAdaptiveClaudeModel(model: ApiModel): boolean {
  return isOpusAdaptiveModelId(model.id);
}

/** 网关端点类别，max_tokens 上限按端点区分 */
type GatewayApiKind = "openai-completions" | "anthropic-messages";

/**
 * 网关不在 /v1/models 暴露 max_tokens，且各供应商/类别的输出上限因端点而异，超限会 400
 * （`Range of max_tokens should be [1, N]` 等）。这里按「端点 × 供应商/模型类别」维度制定
 * 上限默认值。多数类别两端点一致，仅 DeepSeek-Pro / GLM 有端点差异：
 *
 * | 类别（owned_by / id）   | openai-completions | anthropic-messages | 备注 |
 * |-------------------------|--------------------|--------------------|------|
 * | Claude Opus 4.7/4.8     | 128000             | 128000             | 两端点实测 OK |
 * | Claude 其余 (AMAZON_AI) | 65536              | 65536              | anthropic 端点 >65536 会丢 usage 致崩溃，故封顶 65536 |
 * | GPT (id 含 gpt)         | 128000             | （已过滤）          | chat/completions 上限 128000；anthropic 端点空响应+缺 usage |
 * | DeepSeek-Pro            | 65536              | 8192               | chat/completions 宽松；anthropic 端点上限约 8192 |
 * | DeepSeek 其余 (Flash)   | 65536              | 65536              | 两端点 OK |
 * | GLM (OTHER)             | 65536              | 8192               | chat/completions OK 65536；anthropic 端点上限约 8192 且抖动 |
 * | Qwen (ALI_QWEN)         | 65536              | 65536              | qwen-max 上限 65536 |
 * | Kimi (MOONSHOT_AI)      | 65536              | 65536              | 两端点 OK |
 * | MiniMax (MINIMAX)       | 65536              | 65536              | 两端点 OK |
 * | 未匹配                  | fallback           | fallback           | 由 *_ENV_MODEL_EXTRA.maxTokens 或默认值决定 |
 */
const GATEWAY_DEFAULT_MAX_TOKENS = 65_536;

function resolveGatewayMaxTokens(
  api: GatewayApiKind,
  model: ApiModel,
  fallback: number,
): number {
  // 网关返回的 max_tokens 若存在则优先（当前实测均为 null）
  if (typeof model.max_tokens === "number" && model.max_tokens > 0) {
    return model.max_tokens;
  }

  const ownedBy = model.owned_by ?? "";
  const id = normalizeModelIdString(model.id);

  // 两端点一致的高上限类别
  if (isOpusAdaptiveModelId(model.id)) {
    return OPUS_ADAPTIVE_MAX_TOKENS; // 128000，两端点实测 OK
  }
  if (id.includes("gpt")) {
    return 128_000; // chat/completions 上限；anthropic 端点已过滤 GPT
  }

  // 端点差异类别：DeepSeek-Pro / GLM 在 anthropic 端点上限仅 ~8192，chat/completions 可至 65536
  const isDeepSeekPro = id.includes("deepseek") && id.includes("pro");
  const isGlm = ownedBy === "OTHER" || id.includes("glm");
  if (isDeepSeekPro || isGlm) {
    return api === "anthropic-messages" ? 8_192 : 65_536;
  }

  // 其余已知类别两端点均封顶 65536（安全且带 usage）
  if (
    ownedBy === "AMAZON_AI" ||
    id.includes("claude") ||
    ownedBy === "ALI_QWEN" ||
    id.includes("qwen") ||
    id.includes("deepseek") ||
    ownedBy === "MOONSHOT_AI" ||
    id.includes("kimi") ||
    ownedBy === "MINIMAX" ||
    id.includes("minimax")
  ) {
    return 65_536;
  }

  return fallback;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** 网关根地址（无 /v1）；Pi anthropic-messages 会拼 /v1/messages */
function toGatewayOrigin(baseUrl: string): string {
  return stripTrailingSlash(baseUrl).replace(/\/v1$/i, "");
}

/** OpenAI 兼容 base（带 /v1）；用户配置可带或不带 /v1，统一归一化 */
function toOpenAiCompatBase(baseUrl: string): string {
  return `${toGatewayOrigin(baseUrl)}/v1`;
}

/** 从 OpenAI 兼容 /v1/models 拉取在线模型列表（两路 provider 共用） */
async function fetchApiModels(openAiCompatBase: string, token: string): Promise<ApiModel[]> {
  try {
    const response = await fetch(`${openAiCompatBase}/models`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    if (response.ok) {
      const data = (await response.json()) as { data: ApiModel[] };
      return data.data.filter((model) => !model.status || model.status === "online");
    }
  } catch (error) {
    console.error("Failed to fetch models:", error);
  }
  return [];
}

function parseModelDefaults(
  extraRaw: string | undefined,
  fallbackMaxTokens = 384_000,
): {
  contextWindow: number;
  maxTokens: number;
} {
  let extraConfig: Record<string, unknown> = {};
  if (extraRaw) {
    try {
      extraConfig = JSON.parse(extraRaw);
    } catch {
      // 忽略解析错误
    }
  }
  return {
    contextWindow: (extraConfig.contextWindow as number) ?? 1_000_000,
    maxTokens: (extraConfig.maxTokens as number) ?? fallbackMaxTokens,
  };
}

// =============================================================================
// openai-completions provider（OPENAI_ENV_*）
//
// 全部走标准 openai-completions（Pi 内置流式实现，无自定义 streamSimple）。
// Opus 4.7/4.8 与 GPT 系列在本路标记为不支持思考（见 isOpenAiThinkingUnsupported）：
// 前者思考需 anthropic adaptive，后者网关 chat/completions 不支持 reasoning_effort+tools。
// 需要它们的思考能力请使用 anthropic-env。
// =============================================================================

/** Sonnet 等：openrouter reasoning.effort 避免 content 内 <think> */
function usesOpenRouterThinking(model: ApiModel): boolean {
  return isClaudeModel(model) && supportsReasoning(model) && !isOpusAdaptiveClaudeModel(model);
}

/** 按网关实测结果设置 Pi compat，避免传错参（openai-completions 用） */
function resolveOpenAiCompat(model: ApiModel): PiModelCompat | undefined {
  const ownedBy = model.owned_by ?? "";
  const id = model.id.toLowerCase();
  const compat: PiModelCompat = {};

  // 网关仅接受 system/user/assistant/tool；reasoning 模型 Pi 默认发 developer role
  compat.supportsDeveloperRole = false;

  if (usesOpenRouterThinking(model)) {
    // 实测：reasoning_effort → content 内 <think>；reasoning.effort 正常
    compat.thinkingFormat = "openrouter";
    compat.supportsReasoningEffort = false;
  }
  if (ownedBy === "OPENAI" || id.startsWith("gpt")) {
    compat.maxTokensField = "max_completion_tokens";
  }
  if (ownedBy === "ALI_QWEN" || id.includes("qwen")) {
    // 实测：reasoning_effort=none/minimal 关思考；enable_thinking 也可用，统一走 reasoning_effort
    compat.requiresReasoningContentOnAssistantMessages = true;
  }
  if (ownedBy === "MINIMAX" || id.includes("minimax")) {
    // 实测：仅 thinking.type adaptive/disabled 有效；Pi 暂无 adaptive 格式
    compat.supportsReasoningEffort = false;
    compat.requiresReasoningContentOnAssistantMessages = true;
  }
  if (id.includes("deepseek")) {
    // 实测：thinking.type enabled/disabled 可开关；reasoning_effort 不接受 minimal
    compat.thinkingFormat = "deepseek";
    compat.requiresReasoningContentOnAssistantMessages = true;
  }

  return Object.keys(compat).length > 0 ? compat : undefined;
}

/** 按网关实测配置 Pi 思考档位映射（openai-completions 用） */
function resolveOpenAiThinkingLevelMap(model: ApiModel): PiThinkingLevelMap | undefined {
  if (!supportsReasoning(model)) {
    return undefined;
  }

  const ownedBy = model.owned_by ?? "";
  const id = model.id.toLowerCase();

  // Claude Opus 4.7/4.8：off 不发 thinking.disabled；Pi 内置 xhigh 映射
  if (isOpusAdaptiveClaudeModel(model)) {
    return { off: null, minimal: null };
  }

  // Claude Sonnet 等：openrouter reasoning.effort；off→none
  if (usesOpenRouterThinking(model)) {
    return { off: "none", minimal: null };
  }

  // Qwen：none/minimal/low~xhigh；不接受 max
  if (ownedBy === "ALI_QWEN" || id.includes("qwen")) {
    return {
      off: "none",
      minimal: null,
      xhigh: "xhigh",
    };
  }

  // DeepSeek：low~max；不接受 minimal；xhigh→max
  if (id.includes("deepseek")) {
    return {
      minimal: null,
      xhigh: "max",
    };
  }

  // Kimi：none/minimal~xhigh；不接受 max
  if (ownedBy === "MOONSHOT_AI" || id.includes("kimi")) {
    return {
      off: "minimal",
      xhigh: "xhigh",
    };
  }

  // GPT：minimal~xhigh；上游不接受 max
  if (ownedBy === "OPENAI" || id.startsWith("gpt")) {
    return {
      xhigh: "xhigh",
    };
  }

  // MiniMax：Pi 暂无法发 thinking.type=adaptive，仅保留 off
  if (ownedBy === "MINIMAX" || id.includes("minimax")) {
    return {
      minimal: null,
      low: null,
      medium: null,
      high: null,
      xhigh: null,
    };
  }

  return { xhigh: "xhigh", minimal: null };
}

/**
 * 在 openai-completions 这条路上不下发思考参数的模型：
 * - Opus 4.7/4.8：思考依赖 anthropic-messages adaptive thinking，openai-completions 无法表达。
 * - GPT 系列：网关 /v1/chat/completions 不支持「reasoning_effort + function tools」组合
 *   （提示用 /v1/responses，但该网关未提供 /v1/responses）。编码场景必带 tools，故关思考。
 * 这些模型在本路标记为 reasoning:false，走普通 openai-completions；需要其思考请用 anthropic-env。
 */
function isOpenAiThinkingUnsupported(model: ApiModel): boolean {
  return isOpusAdaptiveClaudeModel(model) || normalizeModelIdString(model.id).includes("gpt");
}

function mapApiModelToOpenAiModel(
  model: ApiModel,
  defaults: { contextWindow: number; maxTokens: number },
): PiModelDefinition {
  const noThinking = isOpenAiThinkingUnsupported(model);
  const compat = resolveOpenAiCompat(model);
  const thinkingLevelMap = noThinking ? undefined : resolveOpenAiThinkingLevelMap(model);
  return {
    id: model.id,
    name: model.id,
    reasoning: noThinking ? false : supportsReasoning(model),
    input: mapInputModalities(model.architecture?.input_modalities),
    cost: {
      input: parsePricingPerMillion(model.pricing?.prompt),
      output: parsePricingPerMillion(model.pricing?.completion),
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: model.context_window ?? defaults.contextWindow,
    maxTokens: resolveGatewayMaxTokens("openai-completions", model, defaults.maxTokens),
    ...(compat ? { compat } : {}),
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
  };
}

/**
 * 注册 openai-completions provider（OPENAI_ENV_*）
 *
 * 环境变量：
 * - OPENAI_ENV_BASE_URL: API 基础 URL（必填，可带或不带 /v1）
 * - OPENAI_ENV_API_KEY: API 密钥（必填）
 * - OPENAI_ENV_MODEL_ID: 模型 ID（可选，不设置则从 /v1/models 获取所有可用模型）
 * - OPENAI_ENV_MODEL_EXTRA: 额外模型配置（JSON 格式，可选）
 * - OPENAI_ENV_PROVIDER_ID: Provider ID（可选，默认 openai-env）
 * - OPENAI_ENV_PROVIDER_NAME: Provider 显示名称（可选，默认 OpenAI (Environment)）
 */
async function registerOpenAiProvider(pi: ExtensionAPI): Promise<void> {
  const baseUrl = process.env.OPENAI_ENV_BASE_URL;
  const apiKey = process.env.OPENAI_ENV_API_KEY;
  const modelId = process.env.OPENAI_ENV_MODEL_ID;
  const providerId = process.env.OPENAI_ENV_PROVIDER_ID ?? "openai-env";
  const providerName = process.env.OPENAI_ENV_PROVIDER_NAME ?? "OpenAI (Environment)";

  // 缺少密钥或基础 URL，跳过注册
  if (!apiKey || !baseUrl) {
    return;
  }

  const modelDefaults = parseModelDefaults(
    process.env.OPENAI_ENV_MODEL_EXTRA,
    GATEWAY_DEFAULT_MAX_TOKENS,
  );
  const openAiCompatBase = toOpenAiCompatBase(baseUrl);

  const apiModels = await fetchApiModels(openAiCompatBase, apiKey);

  let models: PiModelDefinition[];
  if (modelId) {
    const found = apiModels.find((model) => model.id === modelId);
    models = [mapApiModelToOpenAiModel(found ?? { id: modelId }, modelDefaults)];
  } else {
    models = apiModels.map((model) => mapApiModelToOpenAiModel(model, modelDefaults));
  }

  if (models.length === 0) {
    return;
  }

  pi.registerProvider(providerId, {
    name: providerName,
    baseUrl: openAiCompatBase,
    apiKey,
    api: "openai-completions",
    models,
  });
}

// =============================================================================
// anthropic-messages provider（ANTHROPIC_ENV_*）
//
// 所有模型统一走 anthropic-messages（Pi 内置流式实现，无需自定义 streamSimple）。
// =============================================================================

/** 按网关实测结果设置 anthropic-messages 的 Pi compat */
function resolveAnthropicCompat(model: ApiModel): PiModelCompat | undefined {
  const compat: PiModelCompat = {};

  // Opus 4.7/4.8：Pi 未识别为内置 adaptive 模型，需显式开启 adaptive thinking
  if (isOpusAdaptiveClaudeModel(model)) {
    compat.forceAdaptiveThinking = true;
  }

  return Object.keys(compat).length > 0 ? compat : undefined;
}

/** 按网关实测配置 Pi 思考档位映射（anthropic-messages 用） */
function resolveAnthropicThinkingLevelMap(model: ApiModel): PiThinkingLevelMap | undefined {
  if (!supportsReasoning(model)) {
    return undefined;
  }

  // Opus 4.7/4.8 adaptive：off 不发 thinking.disabled（adaptive 模型不接受 disabled）；
  // minimal 不单独下发（adaptive 由模型自行决定思考量）
  if (isOpusAdaptiveClaudeModel(model)) {
    return { off: null, minimal: null };
  }

  // 其余 reasoning 模型走 Pi 原生 budget-based thinking，无需特殊映射
  return undefined;
}

/**
 * 网关 anthropic 端点对 GPT 系列的适配残缺：返回空 content 且 message_start 不含 usage，
 * 会导致 Pi 内置实现读 usage.input_tokens 崩溃。GPT 应改用 openai-env（openai-completions）。
 */
function isAnthropicUnsupportedModel(model: ApiModel): boolean {
  return normalizeModelIdString(model.id).includes("gpt");
}

function mapApiModelToAnthropicModel(
  model: ApiModel,
  defaults: { contextWindow: number; maxTokens: number },
): PiModelDefinition {
  const compat = resolveAnthropicCompat(model);
  const thinkingLevelMap = resolveAnthropicThinkingLevelMap(model);
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
    maxTokens: resolveGatewayMaxTokens("anthropic-messages", model, defaults.maxTokens),
    ...(compat ? { compat } : {}),
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
  };
}

/**
 * 注册 anthropic-messages provider（ANTHROPIC_ENV_*）
 *
 * 环境变量：
 * - ANTHROPIC_ENV_BASE_URL: 网关基础 URL（必填，可带或不带 /v1，SDK 会拼 /v1/messages）
 * - ANTHROPIC_ENV_AUTH_TOKEN: 网关鉴权 Token（必填，亦可用别名 ANTHROPIC_ENV_API_KEY）
 * - ANTHROPIC_ENV_MODEL_ID: 模型 ID（可选，不设置则从 /v1/models 获取所有可用模型）
 * - ANTHROPIC_ENV_MODEL_EXTRA: 额外模型配置（JSON 格式，可选）
 * - ANTHROPIC_ENV_PROVIDER_ID: Provider ID（可选，默认 anthropic-env）
 * - ANTHROPIC_ENV_PROVIDER_NAME: Provider 显示名称（可选，默认 Anthropic (Environment)）
 */
async function registerAnthropicProvider(pi: ExtensionAPI): Promise<void> {
  const baseUrl = process.env.ANTHROPIC_ENV_BASE_URL;
  // 鉴权 Token：AUTH_TOKEN 为主，API_KEY 作为同名空间内的别名（与 OPENAI 侧命名对齐）
  const authToken = process.env.ANTHROPIC_ENV_AUTH_TOKEN ?? process.env.ANTHROPIC_ENV_API_KEY;
  const modelId = process.env.ANTHROPIC_ENV_MODEL_ID;
  const providerId = process.env.ANTHROPIC_ENV_PROVIDER_ID ?? "anthropic-env";
  const providerName = process.env.ANTHROPIC_ENV_PROVIDER_NAME ?? "Anthropic (Environment)";

  // 缺少鉴权 Token 或基础 URL，跳过注册
  if (!authToken || !baseUrl) {
    return;
  }

  const modelDefaults = parseModelDefaults(
    process.env.ANTHROPIC_ENV_MODEL_EXTRA,
    GATEWAY_DEFAULT_MAX_TOKENS,
  );
  const openAiCompatBase = toOpenAiCompatBase(baseUrl);
  const gatewayOrigin = toGatewayOrigin(baseUrl);

  const apiModels = await fetchApiModels(openAiCompatBase, authToken);

  let models: PiModelDefinition[];
  if (modelId) {
    const found = apiModels.find((model) => model.id === modelId);
    models = [mapApiModelToAnthropicModel(found ?? { id: modelId }, modelDefaults)];
  } else {
    // 过滤网关 anthropic 适配残缺的模型（GPT 系列：空响应 + 缺 usage 会崩溃）
    const unsupported = apiModels.filter(isAnthropicUnsupportedModel);
    if (unsupported.length > 0) {
      console.warn(
        `[pi-provider-env] anthropic-env 跳过 ${unsupported
          .map((m) => m.id)
          .join(", ")}（网关 anthropic 端点返回空响应/缺 usage）；如需使用请改走 openai-env`,
      );
    }
    models = apiModels
      .filter((model) => !isAnthropicUnsupportedModel(model))
      .map((model) => mapApiModelToAnthropicModel(model, modelDefaults));
  }

  if (models.length === 0) {
    return;
  }

  // 鉴权：Pi 内置 anthropic 实现默认用 apiKey 走 x-api-key 头；为兼容以 Bearer
  // 鉴权的网关，这里额外通过 headers 下发 Authorization: Bearer。两个头都带，
  // 网关取其一即可。
  pi.registerProvider(providerId, {
    name: providerName,
    baseUrl: gatewayOrigin,
    apiKey: authToken,
    api: "anthropic-messages",
    headers: {
      Authorization: `Bearer ${authToken}`,
    },
    models,
  });
}

/**
 * Pi 插件入口：两路 provider 共存，各读各自的环境变量、互不回退。
 * - OPENAI_ENV_*    → openai-completions provider（默认 id openai-env）
 * - ANTHROPIC_ENV_* → anthropic-messages provider（默认 id anthropic-env）
 * 仅当某一路的 BASE_URL + 凭证齐全时才注册该路；可同时启用。
 */
export default async function (pi: ExtensionAPI): Promise<void> {
  await Promise.all([registerOpenAiProvider(pi), registerAnthropicProvider(pi)]);
}
