/**
 * 控制台共享状态、视图常量与派生选择器。
 * 所有模块通过 ES 模块单例共享同一个可变 state 对象。
 */

/** 视图标识 → 标题与面包屑。 */
export const VIEW_META = {
  overview: { title: '概览', kicker: '控制台 / 概览' },
  providers: { title: '提供商', kicker: '配置 / 提供商' },
  models: { title: '模型目录', kicker: '目录 / 模型' },
  logs: { title: '请求日志', kicker: '运行 / 请求日志' },
  settings: { title: '设置', kicker: '系统 / 设置' },
};

/** 服务端未返回协议目录时的兜底协议列表。 */
export const FALLBACK_PROTOCOLS = [
  { id: 'openai', label: 'OpenAI Chat Completions', shortLabel: 'OpenAI', description: 'OpenAI 兼容接口。' },
  { id: 'openai-responses', label: 'OpenAI Responses', shortLabel: 'Responses', description: 'OpenAI Responses API。' },
  { id: 'anthropic', label: 'Anthropic Messages', shortLabel: 'Anthropic', description: 'Anthropic Messages API。' },
  { id: 'google', label: 'Google Gemini', shortLabel: 'Gemini', description: 'Google Gemini 接口。' },
  { id: 'ollama', label: 'Ollama', shortLabel: 'Ollama', description: 'Ollama 本地服务。' },
  { id: 'custom', label: '自定义 / 兼容接口', shortLabel: 'Custom', description: '按原路径透传。' },
];

/** 服务端未返回鉴权方式目录时的兜底列表。 */
export const FALLBACK_AUTH_STYLES = [
  { id: 'auto', label: '自动（按协议）', hint: '按所选协议使用对应的鉴权请求头。' },
  { id: 'bearer', label: 'Authorization: Bearer', hint: 'Authorization: Bearer <key>' },
  { id: 'api-key', label: 'api-key 请求头', hint: 'api-key: <key>' },
  { id: 'x-api-key', label: 'x-api-key 请求头', hint: 'x-api-key: <key>' },
  { id: 'x-goog-api-key', label: 'x-goog-api-key 请求头', hint: 'x-goog-api-key: <key>' },
  { id: 'none', label: '不发送密钥', hint: '不向上游发送任何鉴权请求头。' },
];

/** 各协议在 authStyle 为 auto 时使用的默认鉴权方式。 */
export const PROTOCOL_DEFAULT_AUTH_STYLE = {
  openai: 'bearer',
  'openai-responses': 'bearer',
  ollama: 'bearer',
  anthropic: 'x-api-key',
  google: 'x-goog-api-key',
  custom: 'bearer',
};

/** 鉴权方式 → 实际发送的上游请求头说明。 */
export const AUTH_STYLE_HEADERS = {
  bearer: 'Authorization: Bearer <key>',
  'api-key': 'api-key: <key>',
  'x-api-key': 'x-api-key: <key>',
  'x-goog-api-key': 'x-goog-api-key: <key>',
  none: '不发送鉴权头',
};

/** 控制台的全部运行时状态。 */
export const state = {
  app: null,
  providers: [],
  protocols: [],
  authStyles: [],
  stats: null,
  recentLogs: [],
  autostart: null,
  piAi: null,
  catalog: null,
  models: null,
  modelsLoading: false,
  logs: [],
  logsLoaded: false,
  logsLoading: false,
  view: 'overview',
  editingProvider: null,
  pollTimer: null,
  pollBusy: false,
  autostartBusy: false,
};

/**
 * 按协议 id 查找协议元数据，找不到时返回占位信息。
 *
 * @param {string} id 协议标识
 * @returns {{id: string, label: string, shortLabel: string, description: string}}
 */
export function protocolInfo(id) {
  return (
    state.protocols.find((item) => item.id === id) ||
    FALLBACK_PROTOCOLS.find((item) => item.id === id) || {
      id,
      label: id || '未知',
      shortLabel: id || '未知',
      description: '',
    }
  );
}

/** @returns {Array<object>} 已启用的提供商列表。 */
export function enabledProviders() {
  return state.providers.filter((provider) => provider.enabled);
}

/** @returns {number} 本地登记的模型总数。 */
export function totalConfiguredModels() {
  return state.providers.reduce((sum, provider) => sum + (provider.models?.length || 0), 0);
}

/** @returns {string} 快速调用示例使用的首个可用模型引用。 */
export function firstModelReference() {
  const provider =
    state.providers.find((item) => item.enabled && item.models?.length) ||
    state.providers.find((item) => item.models?.length);
  if (!provider) return 'openai/gpt-4.1';
  return `${provider.name}/${provider.models[0]}`;
}

/** @returns {string} 概览页的 curl 快速调用示例。 */
export function buildQuickstart() {
  if (!state.app) return '—';
  const model = firstModelReference();
  const payload = JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'Hello' }],
  });
  const escapedPayload = payload.replaceAll("'", "'\\''");
  return `curl ${state.app.gatewayBaseUrl}/chat/completions \\
  -H 'Content-Type: application/json' \\
  -H 'Authorization: Bearer any-client-key' \\
  -d '${escapedPayload}'`;
}

/**
 * 把日志状态映射为展示文案与样式类。
 *
 * @param {{status?: number|null}|null} log 请求日志
 * @returns {{label: string, className: string}}
 */
export function logStatus(log) {
  if (!log || log.status === null || log.status === undefined) {
    return { label: '···', className: 'is-pending' };
  }
  if (log.status >= 200 && log.status < 400) {
    return { label: String(log.status), className: 'is-ok' };
  }
  return { label: String(log.status), className: 'is-error' };
}
