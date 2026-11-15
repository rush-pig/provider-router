import { isPlainObject } from '../../util.mjs';
import {
  clampReasoningEffort,
  supportsMaxReasoningEffort,
  usesAdaptiveThinking,
} from './model-capabilities.mjs';

export const THINKING_BRIDGE_PREFIX = 'provider-router:thinking:v1:';

const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const BRIDGE_BLOCK_TYPES = new Set(['thinking', 'redacted_thinking']);
const LEGACY_THINKING_BUDGETS = Object.freeze({
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 24576,
  max: 32768,
});
const MIN_THINKING_BUDGET = 1024;
const ADAPTIVE_THINKING_EFFORT = 'xhigh';
const DISABLED_THINKING_EFFORT = 'low';
const LOW_BUDGET_LIMIT = 4000;
const MEDIUM_BUDGET_LIMIT = 16000;
const BASE64_PAYLOAD = /^[A-Za-z0-9+/]+={0,2}$/;

function normalizeEffort(value) {
  if (typeof value !== 'string') return null;
  const effort = value.trim().toLowerCase();
  return EFFORT_LEVELS.has(effort) ? effort : null;
}

function thinkingBlock(anthropicBody) {
  return isPlainObject(anthropicBody?.thinking) ? anthropicBody.thinking : null;
}

/**
 * 从 Anthropic thinking 配置反推 reasoning effort。
 * adaptive → xhigh；enabled 按 budget 分档；其他形态返回 null。
 */
export function effortFromThinking(anthropicBody) {
  const thinking = thinkingBlock(anthropicBody);
  if (!thinking) return null;
  if (thinking.type === 'adaptive') return ADAPTIVE_THINKING_EFFORT;
  if (thinking.type !== 'enabled') return null;

  const budget = thinking.budget_tokens;
  if (!Number.isFinite(budget)) return 'high';
  if (budget < LOW_BUDGET_LIMIT) return 'low';
  if (budget < MEDIUM_BUDGET_LIMIT) return 'medium';
  return 'high';
}

/**
 * 解析请求应使用的 reasoning effort。
 * output_config.effort 优先；thinking 关闭时显式 effort 降为 low。
 */
export function resolveReasoningEffort(anthropicBody) {
  const body = isPlainObject(anthropicBody) ? anthropicBody : {};
  const explicitEffort = normalizeEffort(body.output_config?.effort);
  if (!explicitEffort) return effortFromThinking(body);

  const thinking = thinkingBlock(body);
  if (!thinking || thinking.type === 'disabled') return DISABLED_THINKING_EFFORT;

  if (explicitEffort === 'max' && !supportsMaxReasoningEffort(body.model)) return 'xhigh';
  return explicitEffort;
}

/**
 * 把 reasoning effort 转成 Anthropic 请求字段。
 * 返回 { thinking, outputConfig }，表示不启用 thinking 时返回 null。
 */
export function thinkingForAnthropic({ model, effort, maxTokens } = {}) {
  const normalizedEffort = normalizeEffort(effort);
  if (!normalizedEffort) return null;

  if (usesAdaptiveThinking(model)) {
    return {
      thinking: { type: 'adaptive' },
      outputConfig: { effort: clampAdaptiveEffort(model, normalizedEffort) },
    };
  }

  const budget = legacyThinkingBudget(normalizedEffort, maxTokens);
  if (budget === null) return null;
  return { thinking: { type: 'enabled', budget_tokens: budget }, outputConfig: null };
}

/**
 * 把 Anthropic thinking / redacted_thinking 块编码成 Responses reasoning item，
 * 以 encrypted_content 作为无状态签名桥。
 */
export function encodeThinkingBridge(blocks) {
  if (!Array.isArray(blocks)) return null;

  const bridgeBlocks = blocks.filter(isBridgeBlock);
  if (bridgeBlocks.length === 0) return null;

  const payload = Buffer.from(JSON.stringify(bridgeBlocks), 'utf8').toString('base64');
  return {
    type: 'reasoning',
    encrypted_content: `${THINKING_BRIDGE_PREFIX}${payload}`,
    summary: [],
  };
}

/** 只解码本模块写入的签名桥，任何格式异常一律返回 null。 */
export function decodeThinkingBridge(item) {
  const encrypted = isPlainObject(item) ? item.encrypted_content : null;
  if (typeof encrypted !== 'string' || !encrypted.startsWith(THINKING_BRIDGE_PREFIX)) {
    return null;
  }

  const blocks = decodeBridgePayload(encrypted.slice(THINKING_BRIDGE_PREFIX.length));
  if (!Array.isArray(blocks) || !blocks.every(isBridgeBlock)) return null;
  return blocks;
}

function isBridgeBlock(block) {
  return isPlainObject(block) && BRIDGE_BLOCK_TYPES.has(block.type);
}

function clampAdaptiveEffort(model, effort) {
  const clamped = clampReasoningEffort(model, effort);
  return clamped === 'max' && !supportsMaxReasoningEffort(model) ? 'xhigh' : clamped;
}

function legacyThinkingBudget(effort, maxTokens) {
  let budget = LEGACY_THINKING_BUDGETS[effort];
  if (Number.isFinite(maxTokens) && maxTokens > 0) {
    budget = Math.min(budget, Math.floor(maxTokens / 2));
  }
  return budget >= MIN_THINKING_BUDGET ? budget : null;
}

function decodeBridgePayload(payload) {
  if (!payload || payload.length % 4 !== 0 || !BASE64_PAYLOAD.test(payload)) return null;

  try {
    const bytes = Buffer.from(payload, 'base64');
    if (bytes.toString('base64') !== payload) return null;
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
}
