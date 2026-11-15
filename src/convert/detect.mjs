import { CLIENT_PATHS, PROTOCOLS, UPSTREAM_PATHS } from './common/constants.mjs';

const COUNT_TOKENS_PATH = '/v1/messages/count_tokens';
const OLLAMA_PROTOCOL = 'ollama';
const UNSUPPORTED_ENDPOINT = 'unsupported_endpoint';

const TARGET_PROTOCOLS = Object.freeze({
  [PROTOCOLS.ANTHROPIC]: PROTOCOLS.ANTHROPIC,
  [PROTOCOLS.OPENAI]: PROTOCOLS.OPENAI,
  [PROTOCOLS.RESPONSES]: PROTOCOLS.RESPONSES,
  [OLLAMA_PROTOCOL]: PROTOCOLS.OPENAI,
});

function normalizePathname(pathname) {
  if (typeof pathname !== 'string') return '';
  const trimmed = pathname.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

function detectNormalizedProtocol(normalizedPathname) {
  if (normalizedPathname === COUNT_TOKENS_PATH) return PROTOCOLS.ANTHROPIC;
  const protocol = CLIENT_PATHS[normalizedPathname];
  return typeof protocol === 'string' ? protocol : null;
}

/**
 * Maps a client request path to the protocol family it speaks, accepting only
 * the exact conversion endpoints (trailing slashes ignored). Everything else,
 * including embeddings/images/audio routes, keeps its pass-through behavior.
 */
export function detectClientProtocol(pathname) {
  return detectNormalizedProtocol(normalizePathname(pathname));
}

/**
 * Resolves the protocol an upstream provider actually speaks. Providers that
 * cannot be expressed as one of the three convertible protocols return null.
 */
export function resolveTargetProtocol(providerProtocol) {
  if (typeof providerProtocol !== 'string') return null;
  const target = TARGET_PROTOCOLS[providerProtocol];
  return typeof target === 'string' ? target : null;
}

/**
 * Decides whether a request needs body conversion. Returns null for requests
 * that must pass through untouched (unknown endpoints, non-convertible
 * providers, or matching protocols), and an error marker when a cross-protocol
 * request targets an endpoint that cannot be translated (token counting has no
 * protocol-neutral equivalent).
 */
export function planConversion({ pathname, providerProtocol } = {}) {
  const normalizedPathname = normalizePathname(pathname);
  const from = detectNormalizedProtocol(normalizedPathname);
  if (from === null) return null;

  const to = resolveTargetProtocol(providerProtocol);
  if (to === null) return null;

  if (from === to) return null;

  if (normalizedPathname === COUNT_TOKENS_PATH) {
    return { error: UNSUPPORTED_ENDPOINT };
  }

  return { from, to, upstreamPath: UPSTREAM_PATHS[to] };
}
