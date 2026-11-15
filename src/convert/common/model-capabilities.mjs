const ADAPTIVE_THINKING_MODELS = Object.freeze([
  'fable-5',
  'mythos-5',
  'mythos-preview',
  'sonnet-5',
  'opus-5',
  'opus-4-8',
  'opus-4-7',
  'opus-4-6',
  'sonnet-4-6',
]);

const DEFAULT_ADAPTIVE_THINKING_MODELS = Object.freeze([
  'fable-5',
  'mythos-5',
  'mythos-preview',
  'opus-5',
  'sonnet-5',
]);

const UNDISABLEABLE_THINKING_MODELS = Object.freeze(['fable-5', 'mythos-5']);

const MAX_EFFORT_GPT_MAJOR = 5;
const MAX_EFFORT_GPT_MINOR = 6;
const MAX_EFFORT_VARIANTS = new Set(['', 'sol', 'terra', 'luna', 'astra']);
const REASONING_GROK_MAJOR = 4;
const REASONING_GROK_MINOR = 5;
const GPT_5_PRO_PREFIX = 'gpt-5-pro';
const GPT_PRO_SUFFIX = /^gpt-.*-pro(?:$|-)/;
const GPT_VERSION = /^gpt-(\d+)(?:-(\d+))?(?:-(.+))?$/;
const GROK_VERSION = /^grok-(\d+)(?:-(\d+))?/;
const O_SERIES = /^o\d/;

function normalizeModelName(model) {
  return String(model ?? '').trim().toLowerCase().replace(/[._]/g, '-');
}

function matchesModelFamily(model, familyNames) {
  const normalized = normalizeModelName(model);
  return familyNames.some((name) => normalized.includes(name));
}

function parseGptVersion(normalizedModel) {
  const match = GPT_VERSION.exec(normalizedModel);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: match[2] === undefined ? null : Number(match[2]),
    variant: match[3] ?? '',
  };
}

/** 模型是否使用 Anthropic 的 adaptive thinking，而不是 token budget。 */
export function usesAdaptiveThinking(model) {
  return matchesModelFamily(model, ADAPTIVE_THINKING_MODELS);
}

/** adaptive thinking 是否是该模型的默认行为（客户端未显式配置时）。 */
export function adaptiveThinkingIsDefault(model) {
  return matchesModelFamily(model, DEFAULT_ADAPTIVE_THINKING_MODELS);
}

/** 这些模型不允许关闭 thinking。 */
export function thinkingCannotBeDisabled(model) {
  return matchesModelFamily(model, UNDISABLEABLE_THINKING_MODELS);
}

/** OpenAI o 系列模型，例如 o1、o3、o4-mini。 */
export function isOpenAiOSeries(model) {
  return O_SERIES.test(normalizeModelName(model));
}

/** 模型是否接受 reasoning.effort 参数。 */
export function supportsReasoningEffort(model) {
  if (isOpenAiOSeries(model)) return true;

  const normalized = normalizeModelName(model);
  if (normalized.startsWith('grok-build-')) return true;

  const gpt = parseGptVersion(normalized);
  if (gpt && gpt.major >= 5) return true;

  const grok = GROK_VERSION.exec(normalized);
  return Boolean(grok)
    && Number(grok[1]) === REASONING_GROK_MAJOR
    && grok[2] !== undefined
    && Number(grok[2]) >= REASONING_GROK_MINOR;
}

/** 模型是否支持 reasoning.effort = 'max'（gpt-5.6+ 的限定变体）。 */
export function supportsMaxReasoningEffort(model) {
  const version = parseGptVersion(normalizeModelName(model));
  if (!version || version.minor === null) return false;

  const versionEligible = version.major > MAX_EFFORT_GPT_MAJOR
    || (version.major === MAX_EFFORT_GPT_MAJOR && version.minor >= MAX_EFFORT_GPT_MINOR);
  return versionEligible && MAX_EFFORT_VARIANTS.has(version.variant);
}

/** 按模型约束校正 effort：gpt-5-pro 恒定 high，其他 gpt-*-pro 不支持 low。 */
export function clampReasoningEffort(model, effort) {
  const normalized = normalizeModelName(model);
  if (normalized.startsWith(GPT_5_PRO_PREFIX)) return 'high';
  if (effort === 'low' && GPT_PRO_SUFFIX.test(normalized)) return 'medium';
  return effort;
}
