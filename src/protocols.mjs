export const PROTOCOLS = Object.freeze([
  {
    id: 'openai',
    label: 'OpenAI Chat Completions',
    shortLabel: 'OpenAI',
    description: '转发到 OpenAI 兼容的 /chat/completions 接口。',
  },
  {
    id: 'openai-responses',
    label: 'OpenAI Responses',
    shortLabel: 'Responses',
    description: '转发到 OpenAI Responses API。',
  },
  {
    id: 'anthropic',
    label: 'Anthropic Messages',
    shortLabel: 'Anthropic',
    description: '转发到 Anthropic Messages API。',
  },
  {
    id: 'google',
    label: 'Google Gemini',
    shortLabel: 'Gemini',
    description: '转发到 Gemini generateContent 接口。',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    shortLabel: 'Ollama',
    description: 'Ollama 的 OpenAI 兼容接口；模型目录读取 /api/tags。',
  },
  {
    id: 'custom',
    label: '自定义 / 兼容接口',
    shortLabel: 'Custom',
    description: '按原路径透传，适用于自建网关或兼容服务。',
  },
]);

const PROTOCOL_IDS = new Set(PROTOCOLS.map((protocol) => protocol.id));

export function isProtocol(value) {
  return PROTOCOL_IDS.has(value);
}

/**
 * Downstream model ids use the first "/" as the provider separator. Everything
 * after it belongs to the upstream model id, including any additional slashes.
 */
export function parseModelReference(model) {
  if (typeof model !== 'string') return null;
  const value = model.trim();
  if (!value || value.startsWith('/')) return null;
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;

  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) return null;

  const provider = value.slice(0, slash).trim().toLowerCase();
  const upstreamModel = value.slice(slash + 1).trim();
  if (!provider || !upstreamModel) return null;

  return {
    provider,
    model: upstreamModel,
    raw: value,
  };
}

/** 只有登记在提供商 models 里的上游模型才允许路由。 */
export function isModelRegistered(provider, modelId) {
  return Array.isArray(provider?.models) && provider.models.includes(modelId);
}

function stripTrailingSlashes(pathname) {
  return pathname.replace(/\/+$/, '');
}

const VERSION_SEGMENT = /^v\d+(?:alpha|beta)?\d*$/i;

/**
 * Joins a configured base URL with an incoming API path without duplicating a
 * version segment. This handles both /v1 + /v1/... and API roots such as
 * /api/paas/v4 which already carry a non-v1 version.
 */
export function joinUpstreamUrl(baseUrl, requestPath, search = '') {
  const target = new URL(baseUrl);
  const basePath = stripTrailingSlashes(target.pathname);
  const reqPath = requestPath.startsWith('/') ? requestPath : `/${requestPath}`;

  if (basePath && basePath.endsWith(reqPath)) {
    target.pathname = basePath;
    target.search = search || '';
    return target;
  }

  const baseSegments = basePath.split('/').filter(Boolean);
  const requestSegments = reqPath.split('/').filter(Boolean);
  const baseHasVersion = baseSegments.some((segment) => VERSION_SEGMENT.test(segment));

  if (requestSegments[0]?.toLowerCase() === 'v1' && baseHasVersion) {
    requestSegments.shift();
  } else if (
    baseSegments.length > 0 &&
    requestSegments.length > 0 &&
    baseSegments.at(-1) === requestSegments[0]
  ) {
    requestSegments.shift();
  }

  target.pathname = `/${[...baseSegments, ...requestSegments].join('/')}`;
  target.search = search || '';
  return target;
}

export function getModelsEndpoint(provider) {
  const base = new URL(provider.baseUrl);

  if (provider.protocol === 'ollama') {
    const basePath = stripTrailingSlashes(base.pathname).replace(/\/v1$/, '');
    base.pathname = `${basePath}/api/tags` || '/api/tags';
    base.search = '';
    return base;
  }

  return joinUpstreamUrl(provider.baseUrl, '/models');
}

export function mapPiApiToProtocol(api) {
  const value = String(api ?? '').toLowerCase();
  if (value.includes('anthropic')) return 'anthropic';
  if (value.includes('openai-responses') || value === 'openai-responses') {
    return 'openai-responses';
  }
  if (value.includes('openai')) return 'openai';
  if (value.includes('google') || value.includes('gemini')) return 'google';
  if (value.includes('ollama')) return 'ollama';
  return 'custom';
}
