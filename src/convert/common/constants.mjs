export const PROTOCOLS = Object.freeze({
  ANTHROPIC: 'anthropic',
  OPENAI: 'openai',
  RESPONSES: 'openai-responses',
});

export const CLIENT_PATHS = Object.freeze({
  '/v1/messages': PROTOCOLS.ANTHROPIC,
  '/v1/chat/completions': PROTOCOLS.OPENAI,
  '/v1/responses': PROTOCOLS.RESPONSES,
});

export const UPSTREAM_PATHS = Object.freeze({
  [PROTOCOLS.ANTHROPIC]: '/v1/messages',
  [PROTOCOLS.OPENAI]: '/v1/chat/completions',
  [PROTOCOLS.RESPONSES]: '/v1/responses',
});

export const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096;
export const RESPONSES_MIN_MAX_OUTPUT_TOKENS = 16;
