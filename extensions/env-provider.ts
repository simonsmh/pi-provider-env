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

/**
 * Pi 插件：从环境变量读取 OpenAI 兼容 API 配置
 *
 * 环境变量：
 * - OPENAI_ENV_BASE_URL: API 基础 URL（必填）
 * - OPENAI_ENV_API_KEY: API 密钥（必填）
 * - OPENAI_ENV_MODEL_ID: 模型 ID（可选，不设置则从 /v1/models 获取所有可用模型）
 * - OPENAI_ENV_MODEL_EXTRA: 额外模型配置（JSON 格式，可选）
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

  // 获取模型列表
  let models: Array<{
    id: string;
    name: string;
    reasoning: boolean;
    input: string[];
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    contextWindow: number;
    maxTokens: number;
  }> = [];

  if (modelId) {
    // 指定了模型 ID，只注册该模型
    models = [
      {
        id: modelId,
        name: modelId,
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: (extraConfig.contextWindow as number) ?? 1000000,
        maxTokens: (extraConfig.maxTokens as number) ?? 384000,
      },
    ];
  } else {
    // 未指定模型 ID，从 /v1/models 获取所有可用模型
    try {
      const response = await fetch(`${baseUrl}/models`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });

      if (response.ok) {
        const data = (await response.json()) as {
          data: Array<{
            id: string;
            name?: string;
            context_window?: number;
            max_tokens?: number;
          }>;
        };

        models = data.data.map((model) => ({
          id: model.id,
          name: model.name ?? model.id,
          reasoning: false,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: model.context_window ?? (extraConfig.contextWindow as number) ?? 1000000,
          maxTokens: model.max_tokens ?? (extraConfig.maxTokens as number) ?? 384000,
        }));
      }
    } catch (error) {
      // 获取模型列表失败，忽略
      console.error("Failed to fetch models:", error);
    }
  }

  // 如果没有模型，跳过注册
  if (models.length === 0) {
    return;
  }

  // 注册 provider
  pi.registerProvider("openai-env", {
    name: "OpenAI (Environment)",
    baseUrl,
    apiKey,
    api: "openai-completions",
    models,
  });
}
