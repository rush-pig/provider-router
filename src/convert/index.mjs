import * as a2c from './directions/a2c.mjs';
import * as a2r from './directions/a2r.mjs';
import * as c2a from './directions/c2a.mjs';
import * as c2r from './directions/c2r.mjs';
import * as r2a from './directions/r2a.mjs';
import * as r2c from './directions/r2c.mjs';

const REQUEST_DIRECTIONS = Object.freeze({
  'openai->anthropic': c2a,
  'openai->openai-responses': c2r,
  'anthropic->openai': a2c,
  'anthropic->openai-responses': a2r,
  'openai-responses->anthropic': r2a,
  'openai-responses->openai': r2c,
});

/**
 * Response and stream adapters are keyed by the wire direction they emit,
 * which is the reverse of the request direction. For example, a Chat client
 * routed to an Anthropic provider uses c2a for the request and a2c to turn the
 * Anthropic response back into Chat.
 */
const RESPONSE_DIRECTIONS = Object.freeze({
  'openai->anthropic': a2c,
  'openai->openai-responses': c2r,
  'anthropic->openai': c2a,
  'anthropic->openai-responses': r2a,
  'openai-responses->anthropic': a2r,
  'openai-responses->openai': r2c,
});

export function conversionLabel(from, to) {
  return `${from}->${to}`;
}

function directionFor(directions, from, to) {
  const direction = directions[conversionLabel(from, to)];
  if (!direction) {
    throw new Error(`不支持的转换方向：${from} -> ${to}`);
  }
  return direction;
}

export function convertRequest({ from, to, body, model }) {
  return directionFor(REQUEST_DIRECTIONS, from, to).convertRequest({ body, model });
}

export function convertResponse({ from, to, body, request }) {
  return directionFor(RESPONSE_DIRECTIONS, from, to).convertResponse({ body, request });
}

export function createStreamConverter({ from, to, request }) {
  return directionFor(RESPONSE_DIRECTIONS, from, to).createStreamConverter({ request });
}

export { detectClientProtocol, planConversion, resolveTargetProtocol } from './detect.mjs';
