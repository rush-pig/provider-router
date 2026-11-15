/**
 * 中性 usage 以 Anthropic 语义为基准：inputTokens 只计未命中缓存的输入，
 * cacheReadTokens / cacheCreationTokens 单独记录。
 * OpenAI 的 prompt_tokens 与 Responses 的 input_tokens 都包含缓存命中，
 * 因此从 OpenAI 侧回读时需要做减法。
 */

function nonNegativeInt(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.floor(number);
}

function createNeutral(source = {}) {
  const usage = source ?? {};
  return {
    inputTokens: nonNegativeInt(usage.inputTokens),
    outputTokens: nonNegativeInt(usage.outputTokens),
    cacheReadTokens: nonNegativeInt(usage.cacheReadTokens),
    cacheCreationTokens: nonNegativeInt(usage.cacheCreationTokens),
  };
}

export function neutralFromAnthropic(usage) {
  const source = usage ?? {};
  return createNeutral({
    inputTokens: source.input_tokens,
    outputTokens: source.output_tokens,
    cacheReadTokens: source.cache_read_input_tokens,
    cacheCreationTokens: source.cache_creation_input_tokens,
  });
}

export function neutralFromOpenAiChat(usage) {
  const source = usage ?? {};
  const cached = nonNegativeInt(
    source.prompt_tokens_details?.cached_tokens
      ?? source.prompt_cache_hit_tokens
      ?? source.cached_tokens,
  );
  const promptTokens = nonNegativeInt(source.prompt_tokens);
  return createNeutral({
    inputTokens: Math.max(0, promptTokens - cached),
    outputTokens: source.completion_tokens,
    cacheReadTokens: cached,
  });
}

export function neutralFromResponses(usage) {
  const source = usage ?? {};
  const cached = nonNegativeInt(source.input_tokens_details?.cached_tokens);
  const inputTokens = nonNegativeInt(source.input_tokens);
  return createNeutral({
    inputTokens: Math.max(0, inputTokens - cached),
    outputTokens: source.output_tokens,
    cacheReadTokens: cached,
  });
}

export function neutralToAnthropic(neutral) {
  const usage = createNeutral(neutral);
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    ...(usage.cacheCreationTokens > 0
      ? { cache_creation_input_tokens: usage.cacheCreationTokens }
      : {}),
    ...(usage.cacheReadTokens > 0 ? { cache_read_input_tokens: usage.cacheReadTokens } : {}),
  };
}

export function neutralToOpenAiChat(neutral) {
  const usage = createNeutral(neutral);
  // OpenAI 没有缓存写入的概念，把 cacheCreation 计入 prompt_tokens，
  // 否则跨协议统计的总输入 token 会凭空减少。
  const promptTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: promptTokens + usage.outputTokens,
    ...(usage.cacheReadTokens > 0
      ? { prompt_tokens_details: { cached_tokens: usage.cacheReadTokens } }
      : {}),
  };
}

export function neutralToResponses(neutral) {
  const usage = createNeutral(neutral);
  const inputTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
  return {
    input_tokens: inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: inputTokens + usage.outputTokens,
    ...(usage.cacheReadTokens > 0
      ? { input_tokens_details: { cached_tokens: usage.cacheReadTokens } }
      : {}),
  };
}

export function mergeNeutral(base, extra) {
  const left = createNeutral(base);
  const right = createNeutral(extra);
  return createNeutral({
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheCreationTokens: left.cacheCreationTokens + right.cacheCreationTokens,
  });
}
