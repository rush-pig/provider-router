import test from 'node:test';
import assert from 'node:assert/strict';

import {
  adaptiveThinkingIsDefault,
  clampReasoningEffort,
  isOpenAiOSeries,
  supportsMaxReasoningEffort,
  supportsReasoningEffort,
  thinkingCannotBeDisabled,
  usesAdaptiveThinking,
} from '../src/convert/common/model-capabilities.mjs';
import {
  THINKING_BRIDGE_PREFIX,
  decodeThinkingBridge,
  effortFromThinking,
  encodeThinkingBridge,
  resolveReasoningEffort,
  thinkingForAnthropic,
} from '../src/convert/common/thinking.mjs';
import {
  canonicalJson,
  cleanSchema,
  mapToolChoiceToAnthropic,
  mapToolChoiceToChat,
  mapToolChoiceToResponses,
  parseJsonObject,
} from '../src/convert/common/tools.mjs';
import {
  countCacheBreakpoints,
  injectAnthropicCacheControl,
} from '../src/convert/common/cache.mjs';

test('usesAdaptiveThinking normalizes case, dots and underscores', () => {
  assert.equal(usesAdaptiveThinking('opus-5-5'), true);
  assert.equal(usesAdaptiveThinking('claude-opus-5-5'), true);
  assert.equal(usesAdaptiveThinking('OPUS_4.6'), true);
  assert.equal(usesAdaptiveThinking('claude-sonnet-4.6'), true);
  assert.equal(usesAdaptiveThinking('fable-5'), true);
  assert.equal(usesAdaptiveThinking('claude-3-5-sonnet'), false);
  assert.equal(usesAdaptiveThinking('gpt-5.6'), false);
});

test('adaptive defaults and undisableable thinking families match', () => {
  assert.equal(adaptiveThinkingIsDefault('fable-5'), true);
  assert.equal(adaptiveThinkingIsDefault('mythos-preview'), true);
  assert.equal(adaptiveThinkingIsDefault('opus-5-5'), true);
  assert.equal(adaptiveThinkingIsDefault('opus-4-8'), false);
  assert.equal(thinkingCannotBeDisabled('mythos-5'), true);
  assert.equal(thinkingCannotBeDisabled('opus-5'), false);
});

test('o-series detection requires o followed by a digit', () => {
  assert.equal(isOpenAiOSeries('o1'), true);
  assert.equal(isOpenAiOSeries('O3'), true);
  assert.equal(isOpenAiOSeries('o4-mini'), true);
  assert.equal(isOpenAiOSeries('gpt-4o'), false);
  assert.equal(isOpenAiOSeries('opus-5'), false);
});

test('supportsReasoningEffort covers o-series, gpt-5+, grok and grok-build', () => {
  assert.equal(supportsReasoningEffort('o3-mini'), true);
  assert.equal(supportsReasoningEffort('gpt-5'), true);
  assert.equal(supportsReasoningEffort('gpt-5.2-codex'), true);
  assert.equal(supportsReasoningEffort('gpt-6-preview'), true);
  assert.equal(supportsReasoningEffort('grok-4.5'), true);
  assert.equal(supportsReasoningEffort('grok-build-0.1'), true);
  assert.equal(supportsReasoningEffort('gpt-4.1'), false);
  assert.equal(supportsReasoningEffort('grok-4.1'), false);
  assert.equal(supportsReasoningEffort('claude-opus-5'), false);
});

test('supportsMaxReasoningEffort requires gpt-5.6+ with an allowed variant', () => {
  assert.equal(supportsMaxReasoningEffort('gpt-5.6'), true);
  assert.equal(supportsMaxReasoningEffort('gpt-5.6-sol'), true);
  assert.equal(supportsMaxReasoningEffort('gpt-5.6-terra'), true);
  assert.equal(supportsMaxReasoningEffort('gpt-6.0-luna'), true);
  assert.equal(supportsMaxReasoningEffort('gpt-5.5'), false);
  assert.equal(supportsMaxReasoningEffort('gpt-5.6-preview'), false);
  assert.equal(supportsMaxReasoningEffort('gpt-5'), false);
});

test('clampReasoningEffort enforces gpt pro constraints', () => {
  assert.equal(clampReasoningEffort('gpt-5-pro', 'low'), 'high');
  assert.equal(clampReasoningEffort('gpt-5-pro-2025-01-01', 'max'), 'high');
  assert.equal(clampReasoningEffort('gpt-5.1-pro', 'low'), 'medium');
  assert.equal(clampReasoningEffort('gpt-5.1-pro', 'high'), 'high');
  assert.equal(clampReasoningEffort('o3', 'low'), 'low');
});

test('resolveReasoningEffort prioritizes explicit output_config.effort', () => {
  assert.equal(
    resolveReasoningEffort({
      model: 'gpt-5.6',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'max' },
    }),
    'max',
  );
  assert.equal(
    resolveReasoningEffort({
      model: 'claude-opus-5',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'max' },
    }),
    'xhigh',
  );
  assert.equal(
    resolveReasoningEffort({
      model: 'claude-opus-5',
      thinking: { type: 'enabled', budget_tokens: 2000 },
      output_config: { effort: 'high' },
    }),
    'high',
  );
  assert.equal(
    resolveReasoningEffort({
      model: 'claude-opus-5',
      thinking: { type: 'disabled' },
      output_config: { effort: 'high' },
    }),
    'low',
  );
  assert.equal(
    resolveReasoningEffort({ model: 'claude-opus-5', output_config: { effort: 'medium' } }),
    'low',
  );
  assert.equal(
    resolveReasoningEffort({
      model: 'claude-opus-5',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'turbo' },
    }),
    'xhigh',
  );
});

test('effortFromThinking maps adaptive and budget tiers', () => {
  assert.equal(effortFromThinking({ thinking: { type: 'adaptive' } }), 'xhigh');
  assert.equal(effortFromThinking({ thinking: { type: 'enabled', budget_tokens: 3999 } }), 'low');
  assert.equal(effortFromThinking({ thinking: { type: 'enabled', budget_tokens: 4000 } }), 'medium');
  assert.equal(
    effortFromThinking({ thinking: { type: 'enabled', budget_tokens: 15999 } }),
    'medium',
  );
  assert.equal(effortFromThinking({ thinking: { type: 'enabled', budget_tokens: 16000 } }), 'high');
  assert.equal(effortFromThinking({ thinking: { type: 'enabled' } }), 'high');
  assert.equal(effortFromThinking({ thinking: { type: 'disabled' } }), null);
  assert.equal(effortFromThinking({}), null);
});

test('thinkingForAnthropic emits adaptive thinking for adaptive models', () => {
  assert.equal(thinkingForAnthropic({ model: 'claude-opus-5', effort: null, maxTokens: 32000 }), null);
  assert.deepEqual(
    thinkingForAnthropic({ model: 'claude-opus-5', effort: 'high', maxTokens: 64000 }),
    { thinking: { type: 'adaptive' }, outputConfig: { effort: 'high' } },
  );
  assert.deepEqual(
    thinkingForAnthropic({ model: 'claude-opus-5', effort: 'max', maxTokens: 64000 }),
    { thinking: { type: 'adaptive' }, outputConfig: { effort: 'xhigh' } },
  );
});

test('thinkingForAnthropic maps legacy effort to capped budgets', () => {
  assert.deepEqual(
    thinkingForAnthropic({ model: 'claude-3-5-sonnet', effort: 'medium', maxTokens: 100000 }),
    { thinking: { type: 'enabled', budget_tokens: 8192 }, outputConfig: null },
  );
  assert.deepEqual(
    thinkingForAnthropic({ model: 'claude-3-5-sonnet', effort: 'max', maxTokens: 20000 }),
    { thinking: { type: 'enabled', budget_tokens: 10000 }, outputConfig: null },
  );
  assert.equal(
    thinkingForAnthropic({ model: 'claude-3-5-sonnet', effort: 'low', maxTokens: 2000 }),
    null,
  );
});

test('thinking bridge round-trips thinking blocks only', () => {
  const blocks = [
    { type: 'thinking', thinking: 'step', signature: 'sig' },
    { type: 'redacted_thinking', data: 'opaque' },
    { type: 'text', text: 'ignored' },
  ];
  const encoded = encodeThinkingBridge(blocks);

  assert.equal(encoded.type, 'reasoning');
  assert.equal(encoded.encrypted_content.startsWith(THINKING_BRIDGE_PREFIX), true);
  assert.deepEqual(encoded.summary, []);
  assert.deepEqual(decodeThinkingBridge(encoded), blocks.slice(0, 2));
  assert.equal(encodeThinkingBridge([]), null);
  assert.equal(encodeThinkingBridge([{ type: 'text', text: 'x' }]), null);
});

test('thinking bridge rejects foreign prefixes and malformed payloads', () => {
  assert.equal(decodeThinkingBridge({ encrypted_content: 'not-a-bridge' }), null);
  assert.equal(decodeThinkingBridge({ encrypted_content: `${THINKING_BRIDGE_PREFIX}!!!` }), null);

  const nonArray = Buffer.from('{"type":"thinking"}', 'utf8').toString('base64');
  assert.equal(decodeThinkingBridge({ encrypted_content: `${THINKING_BRIDGE_PREFIX}${nonArray}` }), null);

  const wrongBlock = Buffer.from('[{"type":"text","text":"x"}]', 'utf8').toString('base64');
  assert.equal(decodeThinkingBridge({ encrypted_content: `${THINKING_BRIDGE_PREFIX}${wrongBlock}` }), null);

  const invalidJson = Buffer.from('{oops', 'utf8').toString('base64');
  assert.equal(
    decodeThinkingBridge({ encrypted_content: `${THINKING_BRIDGE_PREFIX}${invalidJson}` }),
    null,
  );
});

test('tool_choice maps between anthropic, chat and responses', () => {
  assert.equal(mapToolChoiceToChat({ type: 'any' }), 'required');
  assert.deepEqual(
    mapToolChoiceToChat({ type: 'tool', name: 'search' }),
    { type: 'function', function: { name: 'search' } },
  );
  assert.equal(mapToolChoiceToChat('auto'), 'auto');

  assert.equal(mapToolChoiceToResponses({ type: 'any' }), 'required');
  assert.deepEqual(
    mapToolChoiceToResponses({ type: 'tool', name: 'search' }),
    { type: 'function', name: 'search' },
  );
  assert.equal(mapToolChoiceToResponses({ type: 'auto' }), 'auto');

  assert.equal(mapToolChoiceToAnthropic('required'), 'any');
  assert.equal(mapToolChoiceToAnthropic('auto'), 'auto');
  assert.deepEqual(
    mapToolChoiceToAnthropic({ type: 'function', function: { name: 'search' } }),
    { type: 'tool', name: 'search' },
  );
  assert.deepEqual(
    mapToolChoiceToAnthropic({ type: 'function', name: 'lookup' }),
    { type: 'tool', name: 'lookup' },
  );
});

test('canonicalJson sorts keys recursively while preserving arrays', () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: 2, c: [{ f: 1, e: 2 }] } }),
    '{"a":{"c":[{"e":2,"f":1}],"d":2},"b":1}',
  );
  assert.equal(canonicalJson([{ z: 1, y: 2 }]), '[{"y":2,"z":1}]');
});

test('cleanSchema fills the root and removes uri formats without mutating input', () => {
  const schema = {
    type: 'object',
    properties: {
      url: { type: 'string', format: 'uri' },
      nested: { type: 'array', items: { type: 'string', format: 'uri' } },
    },
  };

  const cleaned = cleanSchema(schema);
  assert.deepEqual(cleaned, {
    type: 'object',
    properties: {
      url: { type: 'string' },
      nested: { type: 'array', items: { type: 'string' } },
    },
  });
  assert.equal(schema.properties.url.format, 'uri');
  assert.equal(schema.properties.nested.items.format, 'uri');
  assert.deepEqual(cleanSchema({}), { type: 'object', properties: {} });
});

test('parseJsonObject accepts only parsed plain objects', () => {
  assert.deepEqual(parseJsonObject('{"a":1}'), { a: 1 });
  assert.equal(parseJsonObject('[1]'), null);
  assert.equal(parseJsonObject('"text"'), null);
  assert.equal(parseJsonObject('{bad'), null);
  assert.equal(parseJsonObject(42), null);
});

test('countCacheBreakpoints counts tools, system and message blocks', () => {
  assert.equal(
    countCacheBreakpoints({
      tools: [{ cache_control: { type: 'ephemeral' } }],
      system: [{ cache_control: { type: 'ephemeral' } }],
      messages: [{ content: [{ cache_control: { type: 'ephemeral' } }] }],
    }),
    3,
  );
  assert.equal(countCacheBreakpoints({}), 0);
});

test('injectAnthropicCacheControl adds four breakpoints in priority order', () => {
  const body = {
    model: 'claude-opus-5',
    tools: [{ name: 'a' }, { name: 'b' }],
    system: 'system prompt',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'u1' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
      { role: 'user', content: [{ type: 'text', text: 'u2' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'a2' },
          { type: 'thinking', thinking: 't' },
          { type: 'redacted_thinking', data: 'r' },
        ],
      },
    ],
  };

  const { body: injected, warnings } = injectAnthropicCacheControl(body);
  assert.deepEqual(warnings, []);
  assert.deepEqual(injected.tools[1].cache_control, { type: 'ephemeral' });
  assert.equal(injected.tools[0].cache_control, undefined);
  assert.deepEqual(injected.system, [
    { type: 'text', text: 'system prompt', cache_control: { type: 'ephemeral' } },
  ]);
  assert.deepEqual(injected.messages[3].content[0].cache_control, { type: 'ephemeral' });
  assert.equal(injected.messages[3].content[1].cache_control, undefined);
  assert.deepEqual(injected.messages[0].content[0].cache_control, { type: 'ephemeral' });
  assert.equal(injected.messages[2].content[0].cache_control, undefined);
  assert.equal(countCacheBreakpoints(injected), 4);

  assert.equal(body.system, 'system prompt');
  assert.equal(body.tools[1].cache_control, undefined);
  assert.equal(body.messages[0].content[0].cache_control, undefined);
});

test('injectAnthropicCacheControl preserves existing breakpoints and ttl', () => {
  const body = {
    tools: [
      { name: 'a', cache_control: { type: 'ephemeral', ttl: '1h' } },
      { name: 'b' },
    ],
    system: [{ type: 'text', text: 'sys' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'u1', cache_control: { type: 'ephemeral' } }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
    ],
  };

  const { body: injected, warnings } = injectAnthropicCacheControl(body);
  assert.deepEqual(warnings, []);
  assert.deepEqual(injected.tools[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.deepEqual(injected.tools[1].cache_control, { type: 'ephemeral' });
  assert.deepEqual(injected.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(injected.messages[1].content[0].cache_control, undefined);
  assert.deepEqual(injected.messages[0].content[0].cache_control, { type: 'ephemeral' });
  assert.equal(countCacheBreakpoints(injected), 4);
});

test('injectAnthropicCacheControl warns and leaves body untouched above four', () => {
  const body = {
    tools: [0, 1, 2, 3, 4].map((index) => ({
      name: `t${index}`,
      cache_control: { type: 'ephemeral' },
    })),
    messages: [],
  };

  const { body: injected, warnings } = injectAnthropicCacheControl(body);
  assert.deepEqual(warnings, [{ code: 'too_many_cache_breakpoints', count: 5 }]);
  assert.deepEqual(injected, body);
});

test('injectAnthropicCacheControl skips history breakpoint for short conversations', () => {
  const body = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'u1' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
      { role: 'user', content: [{ type: 'text', text: 'u2' }] },
    ],
  };

  const { body: injected, warnings } = injectAnthropicCacheControl(body);
  assert.deepEqual(warnings, []);
  assert.deepEqual(injected.messages[2].content[0].cache_control, { type: 'ephemeral' });
  assert.equal(injected.messages[0].content[0].cache_control, undefined);
  assert.equal(countCacheBreakpoints(injected), 1);
});

test('injectAnthropicCacheControl falls back to an older message when the latest has no cacheable block', () => {
  const body = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'u1' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 't' }] },
    ],
  };

  const { body: injected } = injectAnthropicCacheControl(body);
  assert.deepEqual(injected.messages[1].content[0].cache_control, { type: 'ephemeral' });
  assert.equal(injected.messages[2].content[0].cache_control, undefined);
  assert.equal(countCacheBreakpoints(injected), 1);
});

