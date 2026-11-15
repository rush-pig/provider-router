import { applyProviderAuth } from './auth.mjs';
import { getModelsEndpoint } from './protocols.mjs';
import { truncate } from './util.mjs';

const MODEL_FETCH_TIMEOUT_MS = Number(process.env.PROVIDER_ROUTER_MODEL_TIMEOUT_MS) || 12_000;
const MODEL_CACHE_TTL_MS = 60_000;
const MODEL_ERROR_CACHE_TTL_MS = 15_000;
const MAX_MODEL_RESPONSE_BYTES = 5 * 1024 * 1024;
const modelCache = new Map();

function modelHeaders(provider) {
  const headers = new Headers({
    accept: 'application/json',
    'user-agent': 'provider-router/1.0',
  });
  return applyProviderAuth(headers, provider);
}

function upstreamErrorMessage(payload) {
  if (!payload) return '';
  if (typeof payload.error === 'string') return payload.error;
  if (typeof payload.error?.message === 'string') return payload.error.message;
  if (typeof payload.message === 'string') return payload.message;
  if (typeof payload.detail === 'string') return payload.detail;
  return '';
}

function idsFromPayload(payload, protocol) {
  let list = null;
  if (Array.isArray(payload)) list = payload;
  else if (Array.isArray(payload?.data)) list = payload.data;
  else if (Array.isArray(payload?.models)) list = payload.models;
  else if (Array.isArray(payload?.result)) list = payload.result;
  else if (Array.isArray(payload?.data?.models)) list = payload.data.models;

  if (!list) return [];

  const seen = new Set();
  const models = [];

  for (const item of list) {
    let id;
    let name;

    if (typeof item === 'string') {
      id = item.trim();
      name = id;
    } else if (item && typeof item === 'object') {
      const rawId = item.id ?? item.model ?? item.name ?? item.slug ?? item.model_name;
      if (typeof rawId !== 'string') continue;
      id = rawId.trim();
      const rawName =
        item.display_name ?? item.displayName ?? item.name ?? item.label ?? item.id ?? id;
      name = typeof rawName === 'string' ? rawName.trim() : id;
    } else {
      continue;
    }

    if (!id) continue;
    if (protocol === 'google') {
      if (id.startsWith('models/')) id = id.slice('models/'.length);
      if (name.startsWith('models/')) name = name.slice('models/'.length);
    }
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name: name || id });
  }

  return models;
}

/**
 * Fetches a provider's native model list. Authentication uses the same single
 * `api-key` header as the routing path.
 */
export async function fetchProviderModels(provider, { timeoutMs = MODEL_FETCH_TIMEOUT_MS } = {}) {
  const endpoint = getModelsEndpoint(provider);
  const startedAt = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref?.();

  try {
    let response;
    try {
      response = await fetch(endpoint, {
        method: 'GET',
        headers: modelHeaders(provider),
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut) {
        throw new Error(`模型目录请求超时（${timeoutMs} ms）`);
      }
      throw new Error(`无法连接上游：${error.message}`);
    }

    if (response.status >= 300 && response.status < 400) {
      throw new Error(
        `上游返回重定向 HTTP ${response.status}；请直接填写最终 API 地址，网关不会跟随跨域重定向`,
      );
    }

    let text;
    try {
      text = await response.text();
    } catch (error) {
      if (timedOut) {
        throw new Error(`读取模型目录超时（${timeoutMs} ms）`);
      }
      throw new Error(`读取上游模型目录失败：${error.message}`);
    }
    if (text.length > MAX_MODEL_RESPONSE_BYTES) {
      throw new Error('上游模型列表响应过大');
    }

    let payload = null;
    if (text.trim()) {
      try {
        payload = JSON.parse(text);
      } catch {
        if (!response.ok) {
          throw new Error(`上游返回 HTTP ${response.status} ${response.statusText}`.trim());
        }
        throw new Error('上游模型列表不是有效 JSON');
      }
    }

    if (!response.ok) {
      const detail = upstreamErrorMessage(payload);
      const suffix = detail ? `：${truncate(detail, 240)}` : '';
      throw new Error(`上游返回 HTTP ${response.status}${suffix}`);
    }

    const models = idsFromPayload(payload, provider.protocol);
    return {
      models,
      endpoint: endpoint.toString(),
      status: response.status,
      latencyMs: Date.now() - startedAt,
      fetchedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timer);
  }
}

function providerSignature(provider) {
  return [
    provider.baseUrl,
    provider.protocol,
    provider.apiKey ? 'key' : 'no-key',
    provider.updatedAt || '',
  ].join('|');
}

async function getLiveModels(provider, { force = false } = {}) {
  const signature = providerSignature(provider);
  const cached = modelCache.get(provider.name);
  if (
    !force &&
    cached &&
    cached.signature === signature &&
    Date.now() < cached.expiresAt
  ) {
    return cached.value;
  }

  let live = null;
  let error = null;
  try {
    live = await fetchProviderModels(provider);
  } catch (fetchError) {
    error = truncate(fetchError.message, 500);
  }

  const value = {
    live,
    error,
    fetchedAt: new Date().toISOString(),
  };
  modelCache.set(provider.name, {
    signature,
    expiresAt: Date.now() + (error ? MODEL_ERROR_CACHE_TTL_MS : MODEL_CACHE_TTL_MS),
    value,
  });
  return value;
}

export function invalidateModelCache(providerName = null) {
  if (providerName) modelCache.delete(providerName);
  else modelCache.clear();
}

/**
 * Aggregates configured and live model lists from every enabled provider.
 * A failed live request keeps the configured list usable and reports the
 * upstream error alongside it.
 */
export async function aggregateModels(providers, { refresh = false } = {}) {
  const enabled = providers.filter((provider) => provider.enabled !== false);
  const fetchedAt = new Date().toISOString();

  const results = await Promise.all(
    enabled.map(async (provider) => {
      const result = await getLiveModels(provider, { force: refresh });
      return { provider, ...result };
    }),
  );

  const data = [];
  const summaries = [];
  const errors = [];

  for (const { provider, live, error } of results) {
    const byUpstreamId = new Map();

    for (const id of provider.models) {
      const clean = id.trim();
      if (!clean) continue;
      byUpstreamId.set(clean, {
        id: `${provider.name}/${clean}`,
        object: 'model',
        created: 0,
        owned_by: provider.name,
        provider: provider.name,
        provider_label: provider.label,
        upstream_id: clean,
        display_name: clean,
        source: 'configured',
      });
    }

    if (live) {
      for (const model of live.models) {
        byUpstreamId.set(model.id, {
          id: `${provider.name}/${model.id}`,
          object: 'model',
          created: 0,
          owned_by: provider.name,
          provider: provider.name,
          provider_label: provider.label,
          upstream_id: model.id,
          display_name: model.name || model.id,
          source: 'live',
        });
      }
    }

    data.push(...byUpstreamId.values());

    const liveCount = live?.models.length ?? 0;
    const configuredCount = provider.models.length;
    let source = 'configured';
    if (live && liveCount > 0) source = 'live';
    else if (!live && configuredCount === 0) source = 'error';
    else if (live && liveCount === 0 && configuredCount > 0) source = 'configured';

    summaries.push({
      name: provider.name,
      label: provider.label,
      protocol: provider.protocol,
      count: byUpstreamId.size,
      live_count: liveCount,
      configured_count: configuredCount,
      source,
      latency_ms: live?.latencyMs ?? null,
      fetched_at: live?.fetchedAt ?? null,
      error,
    });

    if (error) {
      errors.push({
        provider: provider.name,
        message: error,
      });
    }
  }

  return {
    object: 'list',
    data,
    count: data.length,
    providers: summaries,
    errors,
    fetched_at: fetchedAt,
    cache_ttl_seconds: Math.floor(MODEL_CACHE_TTL_MS / 1000),
  };
}

export { idsFromPayload };
