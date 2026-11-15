const AUTH_HEADER_NAMES = Object.freeze([
  'authorization',
  'api-key',
  'x-api-key',
  'x-goog-api-key',
]);

export const AUTH_STYLES = Object.freeze([
  { id: 'auto', label: '自动（按协议）', hint: '按所选协议使用对应的鉴权请求头。' },
  { id: 'bearer', label: 'Authorization: Bearer', hint: 'Authorization: Bearer <key>' },
  { id: 'api-key', label: 'api-key 请求头', hint: 'api-key: <key>' },
  { id: 'x-api-key', label: 'x-api-key 请求头', hint: 'x-api-key: <key>' },
  { id: 'x-goog-api-key', label: 'x-goog-api-key 请求头', hint: 'x-goog-api-key: <key>' },
  { id: 'none', label: '不发送密钥', hint: '不向上游发送任何鉴权请求头。' },
]);

const AUTH_STYLE_IDS = new Set(AUTH_STYLES.map((style) => style.id));

const PROTOCOL_DEFAULT_STYLE = Object.freeze({
  openai: 'bearer',
  'openai-responses': 'bearer',
  ollama: 'bearer',
  anthropic: 'x-api-key',
  google: 'x-goog-api-key',
  custom: 'bearer',
});

export const ANTHROPIC_VERSION = '2023-06-01';

export function isAuthStyle(value) {
  return AUTH_STYLE_IDS.has(value);
}

export function resolveAuthStyle(provider) {
  if (provider.authStyle && provider.authStyle !== 'auto') return provider.authStyle;
  return PROTOCOL_DEFAULT_STYLE[provider.protocol] ?? 'bearer';
}

/**
 * The gateway owns upstream credentials: any auth header sent by the calling
 * client is dropped and replaced with the provider's own key. This keeps client
 * keys from leaking upstream and keeps one provider's key from being reused
 * against another.
 */
export function applyProviderAuth(headers, provider) {
  for (const name of AUTH_HEADER_NAMES) headers.delete(name);

  if (provider.protocol === 'anthropic' && !headers.has('anthropic-version')) {
    headers.set('anthropic-version', ANTHROPIC_VERSION);
  }

  const style = resolveAuthStyle(provider);
  if (style === 'none' || !provider.apiKey) return headers;

  if (style === 'bearer') headers.set('authorization', `Bearer ${provider.apiKey}`);
  else headers.set(style, provider.apiKey);

  return headers;
}
