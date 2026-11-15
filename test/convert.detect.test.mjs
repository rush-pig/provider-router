import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLIENT_PATHS,
  DEFAULT_ANTHROPIC_MAX_TOKENS,
  PROTOCOLS,
  RESPONSES_MIN_MAX_OUTPUT_TOKENS,
  UPSTREAM_PATHS,
} from '../src/convert/common/constants.mjs';
import {
  detectClientProtocol,
  planConversion,
  resolveTargetProtocol,
} from '../src/convert/detect.mjs';
import {
  normalizeAnthropicMessages,
  stripLeadingBillingHeader,
  textFromContent,
} from '../src/convert/common/messages.mjs';

function userMessage(text) {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function assistantMessage(text) {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

function toolResultMessage(...toolUseIds) {
  return {
    role: 'user',
    content: toolUseIds.map((toolUseId) => ({ type: 'tool_result', tool_use_id: toolUseId })),
  };
}

test('conversion tables stay aligned', () => {
  assert.deepEqual(CLIENT_PATHS, {
    '/v1/messages': PROTOCOLS.ANTHROPIC,
    '/v1/chat/completions': PROTOCOLS.OPENAI,
    '/v1/responses': PROTOCOLS.RESPONSES,
  });
  assert.deepEqual(UPSTREAM_PATHS, {
    [PROTOCOLS.ANTHROPIC]: '/v1/messages',
    [PROTOCOLS.OPENAI]: '/v1/chat/completions',
    [PROTOCOLS.RESPONSES]: '/v1/responses',
  });
  assert.equal(Object.isFrozen(CLIENT_PATHS), true);
  assert.equal(Object.isFrozen(UPSTREAM_PATHS), true);
  assert.equal(DEFAULT_ANTHROPIC_MAX_TOKENS, 4096);
  assert.equal(RESPONSES_MIN_MAX_OUTPUT_TOKENS, 16);
});

test('client protocol detection recognizes the supported endpoints', () => {
  assert.equal(detectClientProtocol('/v1/messages'), PROTOCOLS.ANTHROPIC);
  assert.equal(detectClientProtocol('/v1/chat/completions'), PROTOCOLS.OPENAI);
  assert.equal(detectClientProtocol('/v1/responses'), PROTOCOLS.RESPONSES);
});

test('client protocol detection ignores trailing slashes', () => {
  assert.equal(detectClientProtocol('/v1/messages/'), PROTOCOLS.ANTHROPIC);
  assert.equal(detectClientProtocol('/v1/chat/completions///'), PROTOCOLS.OPENAI);
  assert.equal(detectClientProtocol('/v1/responses/'), PROTOCOLS.RESPONSES);
});

test('count_tokens is an anthropic endpoint', () => {
  assert.equal(detectClientProtocol('/v1/messages/count_tokens'), PROTOCOLS.ANTHROPIC);
  assert.equal(detectClientProtocol('/v1/messages/count_tokens/'), PROTOCOLS.ANTHROPIC);
});

test('unknown paths do not map to a client protocol', () => {
  const unknownPaths = [
    '/',
    '/v1/models',
    '/v1/embeddings',
    '/v1/images/generations',
    '/v1/audio/transcriptions',
    '/v1/messages/count_tokens/extra',
    '/v2/messages',
    '',
  ];
  for (const pathname of unknownPaths) {
    assert.equal(detectClientProtocol(pathname), null, pathname);
  }
  assert.equal(detectClientProtocol(undefined), null);
});

test('provider protocols resolve to convertible targets', () => {
  const expectedTargets = {
    openai: PROTOCOLS.OPENAI,
    ollama: PROTOCOLS.OPENAI,
    anthropic: PROTOCOLS.ANTHROPIC,
    'openai-responses': PROTOCOLS.RESPONSES,
  };
  for (const [providerProtocol, target] of Object.entries(expectedTargets)) {
    assert.equal(resolveTargetProtocol(providerProtocol), target, providerProtocol);
  }
});

test('non-convertible provider protocols resolve to null', () => {
  for (const providerProtocol of ['google', 'custom', 'unknown', '', null, undefined, {}]) {
    assert.equal(resolveTargetProtocol(providerProtocol), null);
  }
});

test('same protocol requests bypass conversion', () => {
  assert.equal(
    planConversion({ pathname: '/v1/messages', providerProtocol: 'anthropic' }),
    null,
  );
  assert.equal(
    planConversion({ pathname: '/v1/chat/completions', providerProtocol: 'openai' }),
    null,
  );
  assert.equal(
    planConversion({ pathname: '/v1/chat/completions', providerProtocol: 'ollama' }),
    null,
  );
  assert.equal(
    planConversion({ pathname: '/v1/responses', providerProtocol: 'openai-responses' }),
    null,
  );
});

test('cross protocol requests plan the target upstream path', () => {
  assert.deepEqual(
    planConversion({ pathname: '/v1/messages', providerProtocol: 'openai' }),
    { from: PROTOCOLS.ANTHROPIC, to: PROTOCOLS.OPENAI, upstreamPath: '/v1/chat/completions' },
  );
  assert.deepEqual(
    planConversion({ pathname: '/v1/messages/', providerProtocol: 'ollama' }),
    { from: PROTOCOLS.ANTHROPIC, to: PROTOCOLS.OPENAI, upstreamPath: '/v1/chat/completions' },
  );
  assert.deepEqual(
    planConversion({ pathname: '/v1/chat/completions', providerProtocol: 'anthropic' }),
    { from: PROTOCOLS.OPENAI, to: PROTOCOLS.ANTHROPIC, upstreamPath: '/v1/messages' },
  );
  assert.deepEqual(
    planConversion({ pathname: '/v1/chat/completions', providerProtocol: 'openai-responses' }),
    { from: PROTOCOLS.OPENAI, to: PROTOCOLS.RESPONSES, upstreamPath: '/v1/responses' },
  );
  assert.deepEqual(
    planConversion({ pathname: '/v1/responses', providerProtocol: 'anthropic' }),
    { from: PROTOCOLS.RESPONSES, to: PROTOCOLS.ANTHROPIC, upstreamPath: '/v1/messages' },
  );
  assert.deepEqual(
    planConversion({ pathname: '/v1/responses', providerProtocol: 'openai' }),
    { from: PROTOCOLS.RESPONSES, to: PROTOCOLS.OPENAI, upstreamPath: '/v1/chat/completions' },
  );
});

test('non-convertible providers or unknown paths keep pass-through', () => {
  assert.equal(planConversion({ pathname: '/v1/messages', providerProtocol: 'google' }), null);
  assert.equal(planConversion({ pathname: '/v1/messages', providerProtocol: 'custom' }), null);
  assert.equal(planConversion({ pathname: '/v1/embeddings', providerProtocol: 'anthropic' }), null);
  assert.equal(planConversion({ pathname: '/v1/models', providerProtocol: 'openai' }), null);
  assert.equal(planConversion({}), null);
});

test('count_tokens rejects cross protocol conversion', () => {
  assert.deepEqual(
    planConversion({ pathname: '/v1/messages/count_tokens', providerProtocol: 'openai' }),
    { error: 'unsupported_endpoint' },
  );
  assert.deepEqual(
    planConversion({ pathname: '/v1/messages/count_tokens/', providerProtocol: 'openai-responses' }),
    { error: 'unsupported_endpoint' },
  );
  assert.equal(
    planConversion({ pathname: '/v1/messages/count_tokens', providerProtocol: 'anthropic' }),
    null,
  );
  assert.equal(
    planConversion({ pathname: '/v1/messages/count_tokens', providerProtocol: 'google' }),
    null,
  );
});

test('billing header is stripped from the first line only', () => {
  assert.equal(
    stripLeadingBillingHeader('x-anthropic-billing-header: cc_version=2.0.0\nHello'),
    'Hello',
  );
  assert.equal(
    stripLeadingBillingHeader('x-anthropic-billing-header: cc_version=2.0.0\r\nHello\r\nWorld'),
    'Hello\r\nWorld',
  );
  assert.equal(stripLeadingBillingHeader('x-anthropic-billing-header: only-line'), '');
  assert.equal(
    stripLeadingBillingHeader('x-anthropic-billing-header: one\nx-anthropic-billing-header: two\nBody'),
    'x-anthropic-billing-header: two\nBody',
  );
});

test('billing header stripping leaves ordinary text untouched', () => {
  const text = 'Hello\nx-anthropic-billing-header: not-a-prefix';
  assert.equal(stripLeadingBillingHeader(text), text);
  assert.equal(stripLeadingBillingHeader(''), '');
  assert.equal(stripLeadingBillingHeader(undefined), '');
});

test('textFromContent flattens text blocks', () => {
  assert.equal(textFromContent('plain text'), 'plain text');
  assert.equal(
    textFromContent([
      { type: 'text', text: 'one' },
      { type: 'image', source: { type: 'base64', data: '' } },
      { type: 'text', text: 'two' },
    ]),
    'one\ntwo',
  );
  assert.equal(textFromContent([{ type: 'tool_use', id: 'tool-1' }]), '');
  assert.equal(textFromContent([]), '');
  assert.equal(textFromContent(null), '');
  assert.equal(textFromContent(undefined), '');
});

test('incomplete tool rounds lose only unanswered tool_use blocks', () => {
  const messages = [
    userMessage('start'),
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'checking' },
        { type: 'tool_use', id: 'tool-1', name: 'search', input: {} },
        { type: 'tool_use', id: 'tool-2', name: 'fetch', input: {} },
      ],
      stop_reason: 'tool_use',
    },
    toolResultMessage('tool-1'),
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'done' }] },
  ];
  const snapshot = structuredClone(messages);

  const normalized = normalizeAnthropicMessages(messages);

  assert.deepEqual(normalized[1].content, [
    { type: 'text', text: 'checking' },
    { type: 'tool_use', id: 'tool-1', name: 'search', input: {} },
  ]);
  assert.equal(normalized[1].stop_reason, 'tool_use');
  assert.deepEqual(messages, snapshot);
});

test('assistant messages emptied by tool_use removal are dropped', () => {
  const messages = [
    userMessage('start'),
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-9', name: 'search', input: {} }] },
    userMessage('next'),
  ];

  assert.deepEqual(normalizeAnthropicMessages(messages), [userMessage('start'), userMessage('next')]);
});

test('empty messages are dropped', () => {
  const messages = [
    { role: 'user', content: [] },
    { role: 'user', content: [{ type: 'text', text: '' }] },
    { role: 'user', content: [{ type: 'text', text: '   ' }] },
    { role: 'user', content: '' },
    { role: 'user' },
    userMessage('real'),
    assistantMessage('answer'),
    userMessage('follow-up'),
  ];

  assert.deepEqual(
    normalizeAnthropicMessages(messages),
    [userMessage('real'), assistantMessage('answer'), userMessage('follow-up')],
  );
});

test('leading assistant messages are dropped', () => {
  const messages = [assistantMessage('prefill'), assistantMessage('more'), userMessage('hello')];
  assert.deepEqual(normalizeAnthropicMessages(messages), [userMessage('hello')]);
});

test('conversations without a user turn normalize to an empty array', () => {
  assert.deepEqual(normalizeAnthropicMessages([assistantMessage('a')]), []);
  assert.deepEqual(
    normalizeAnthropicMessages([assistantMessage('a'), assistantMessage('b')]),
    [],
  );
});

test('trailing assistant text turns are trimmed repeatedly', () => {
  const messages = [
    userMessage('question'),
    assistantMessage('partial'),
    assistantMessage('more'),
  ];
  assert.deepEqual(normalizeAnthropicMessages(messages), [userMessage('question')]);
});

test('trailing assistant string content counts as text', () => {
  const messages = [userMessage('question'), { role: 'assistant', content: 'prefill' }];
  assert.deepEqual(normalizeAnthropicMessages(messages), [userMessage('question')]);
});

test('trailing assistant turns with non-text blocks are kept', () => {
  const messages = [
    userMessage('question'),
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'answer' },
        { type: 'thinking', thinking: 'reasoning' },
      ],
    },
  ];
  assert.deepEqual(normalizeAnthropicMessages(messages), messages);
});

test('a complete conversation passes through as a new array', () => {
  const messages = [userMessage('hi'), assistantMessage('hello'), userMessage('bye')];
  const normalized = normalizeAnthropicMessages(messages);
  assert.deepEqual(normalized, messages);
  assert.notStrictEqual(normalized, messages);
});

test('unknown fields survive normalization', () => {
  const messages = [
    {
      role: 'user',
      content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }],
      name: 'custom-field',
    },
  ];
  assert.deepEqual(normalizeAnthropicMessages(messages), messages);
});

test('empty or malformed input yields an empty array', () => {
  assert.deepEqual(normalizeAnthropicMessages([]), []);
  assert.deepEqual(normalizeAnthropicMessages(undefined), []);
  assert.deepEqual(normalizeAnthropicMessages(null), []);
  assert.deepEqual(
    normalizeAnthropicMessages([{ role: 'user', content: [] }, assistantMessage('')]),
    [],
  );
});
