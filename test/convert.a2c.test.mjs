import assert from 'node:assert/strict';
import test from 'node:test';

import { SSE_DONE, SseParser } from '../src/convert/common/sse.mjs';
import {
  convertRequest,
  convertResponse,
  createStreamConverter,
} from '../src/convert/directions/a2c.mjs';

function sseFrame(type, payload) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

function parsePayloads(text) {
  const parser = new SseParser();
  const frames = [...parser.push(text), ...parser.end()];
  return frames.map((frame) => (frame.data === '[DONE]' ? '[DONE]' : JSON.parse(frame.data)));
}

function byteChunks(text) {
  return Array.from(Buffer.from(text, 'utf8'), (byte) => Buffer.from([byte]));
}

function collectStream(converter, chunks) {
  const parts = [];
  for (const chunk of chunks) {
    const output = converter.push(chunk);
    if (output !== null) parts.push(output);
  }
  const tail = converter.end();
  if (tail !== null) parts.push(tail);
  return parts.join('');
}

function baseBody(overrides = {}) {
  return {
    model: 'claude-opus-5',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  };
}

test('a2c 请求清洗 system 计费头并合并多段文本', () => {
  const { body } = convertRequest({
    model: 'gpt-5',
    body: baseBody({
      system: [
        {
          type: 'text',
          text: 'x-anthropic-billing-header: abc\nYou are helpful.',
          cache_control: { type: 'ephemeral' },
        },
        { type: 'text', text: 'Second paragraph' },
      ],
    }),
  });

  assert.deepEqual(body.messages[0], {
    role: 'system',
    content: 'You are helpful.\nSecond paragraph',
  });
});

test('a2c 请求转换文本、图片、tool_use 与 tool_result', () => {
  const { body, warnings } = convertRequest({
    model: 'gpt-5',
    body: baseBody({
      messages: [
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'internal plan' },
            { type: 'text', text: 'calling' },
            { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { b: 2, a: 1 } },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: [
                { type: 'text', text: 'result' },
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: 'QUJD' },
                },
              ],
            },
            { type: 'text', text: 'continue' },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
          ],
        },
      ],
    }),
  });

  assert.deepEqual(body.messages[0], { role: 'user', content: 'hello' });
  assert.deepEqual(body.messages[1], {
    role: 'assistant',
    content: [{ type: 'text', text: 'calling' }],
    tool_calls: [{
      id: 'toolu_1',
      type: 'function',
      function: { name: 'lookup', arguments: '{"a":1,"b":2}' },
    }],
  });
  assert.deepEqual(body.messages[2], {
    role: 'tool',
    tool_call_id: 'toolu_1',
    content: 'result',
  });
  assert.deepEqual(body.messages[3], {
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
      { type: 'text', text: 'continue' },
    ],
  });
  assert.deepEqual(body.messages[4], {
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
    ],
  });
  assert.equal(warnings.some((warning) => warning.code === 'thinking_dropped'), true);
});

test('a2c 请求在没有文本时把 assistant content 设为 null', () => {
  const { body } = convertRequest({
    model: 'gpt-5',
    body: baseBody({
      messages: [{
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_2', name: 'ping', input: {} }],
      }],
    }),
  });

  assert.equal(body.messages[0].content, null);
  assert.equal(body.messages[0].tool_calls.length, 1);
});

test('a2c 请求过滤 BatchTool 并清洗 input_schema', () => {
  const { body, warnings } = convertRequest({
    model: 'gpt-5',
    body: baseBody({
      tools: [
        { name: 'BatchTool', input_schema: { type: 'object' } },
        { type: 'batch_tool', name: 'batch_lower' },
        {
          name: 'lookup',
          description: 'Find a record',
          input_schema: {
            type: 'object',
            properties: { url: { type: 'string', format: 'uri' } },
          },
        },
      ],
      tool_choice: { type: 'any' },
    }),
  });

  assert.deepEqual(body.tools, [{
    type: 'function',
    function: {
      name: 'lookup',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
      },
      description: 'Find a record',
    },
  }]);
  assert.equal(body.tool_choice, 'required');
  assert.equal(warnings.some((warning) => warning.code === 'unsupported_tool'), true);
});

test('a2c 请求在 tools 为空时删除 tool_choice', () => {
  const { body } = convertRequest({
    model: 'gpt-5',
    body: baseBody({ tools: [], tool_choice: { type: 'any' } }),
  });

  assert.equal(body.tools, undefined);
  assert.equal(body.tool_choice, undefined);
});

test('a2c 请求按 o 系列选择 max_completion_tokens，并透传采样与 stop', () => {
  const oSeries = convertRequest({
    model: 'o3',
    body: baseBody({
      model: 'o3',
      max_tokens: 500,
      temperature: 0.3,
      top_p: 0.9,
      stop_sequences: ['STOP'],
    }),
  });

  assert.equal(oSeries.body.max_completion_tokens, 500);
  assert.equal(oSeries.body.max_tokens, undefined);
  assert.equal(oSeries.body.temperature, 0.3);
  assert.equal(oSeries.body.top_p, 0.9);
  assert.deepEqual(oSeries.body.stop, ['STOP']);

  const standard = convertRequest({
    model: 'gpt-4.1',
    body: baseBody({ model: 'gpt-4.1', max_tokens: 300 }),
  });
  assert.equal(standard.body.max_tokens, 300);
  assert.equal(standard.body.max_completion_tokens, undefined);
});

test('a2c 请求把 thinking/output_config 解析为支持的 reasoning_effort', () => {
  const adaptive = convertRequest({
    model: 'gpt-5',
    body: baseBody({ model: 'gpt-5', thinking: { type: 'adaptive' } }),
  });
  assert.equal(adaptive.body.reasoning_effort, 'xhigh');
  assert.equal(adaptive.body.thinking, undefined);

  const budget = convertRequest({
    model: 'gpt-5.1-pro',
    body: baseBody({
      model: 'gpt-5.1-pro',
      thinking: { type: 'enabled', budget_tokens: 2000 },
    }),
  });
  assert.equal(budget.body.reasoning_effort, 'medium');

  const unsupported = convertRequest({
    model: 'claude-opus-5',
    body: baseBody({ model: 'claude-opus-5', thinking: { type: 'adaptive' } }),
  });
  assert.equal(unsupported.body.reasoning_effort, undefined);

  const disabled = convertRequest({
    model: 'gpt-5',
    body: baseBody({ model: 'gpt-5', thinking: { type: 'disabled' } }),
  });
  assert.equal(disabled.body.reasoning_effort, undefined);

  const explicitWhileDisabled = convertRequest({
    model: 'gpt-5',
    body: baseBody({
      model: 'gpt-5',
      thinking: { type: 'disabled' },
      output_config: { effort: 'high' },
    }),
  });
  assert.equal(explicitWhileDisabled.body.reasoning_effort, 'low');
});

test('a2c 请求在流式时合并 stream_options.include_usage', () => {
  const streaming = convertRequest({
    model: 'gpt-5',
    body: baseBody({ stream: true, stream_options: { foo: 'bar' } }),
  });
  assert.equal(streaming.stream, true);
  assert.deepEqual(streaming.body.stream_options, { foo: 'bar', include_usage: true });

  const nonStreaming = convertRequest({
    model: 'gpt-5',
    body: baseBody({ stream: false }),
  });
  assert.equal(nonStreaming.stream, false);
  assert.equal(nonStreaming.body.stream_options, undefined);
});

test('a2c 请求丢弃不支持的字段并对嵌套 cache_control 告警', () => {
  const { body, warnings } = convertRequest({
    model: 'gpt-5',
    body: baseBody({
      metadata: { trace: 'x' },
      top_k: 10,
      service_tier: 'auto',
      container: { id: 'c' },
      mcp_servers: [{ name: 'm' }],
      context_management: { keep: 1 },
      betas: ['beta-1'],
      system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
    }),
  });

  const droppedFields = warnings
    .filter((warning) => warning.code === 'dropped_field')
    .map((warning) => warning.field)
    .sort();
  assert.deepEqual(droppedFields, [
    'betas',
    'cache_control',
    'container',
    'context_management',
    'mcp_servers',
    'metadata',
    'service_tier',
    'top_k',
  ]);
  for (const field of droppedFields) assert.equal(body[field], undefined);
});

test('a2c 非流式响应拼接文本/思考并用 canonicalJson 生成工具参数', () => {
  const { body, warnings } = convertResponse({
    request: { model: 'gpt-5' },
    body: {
      id: 'msg_1',
      type: 'message',
      model: 'claude-upstream',
      content: [
        { type: 'thinking', thinking: 'step' },
        { type: 'redacted_thinking', data: 'opaque' },
        { type: 'text', text: 'Hello' },
        { type: 'text', text: 'world' },
        { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { b: 2, a: 1 } },
      ],
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 2,
      },
    },
  });

  assert.equal(body.id, 'msg_1');
  assert.equal(body.object, 'chat.completion');
  assert.equal(typeof body.created, 'number');
  assert.equal(body.model, 'claude-upstream');
  assert.deepEqual(body.choices, [{
    index: 0,
    message: {
      role: 'assistant',
      content: 'Hello\nworld',
      tool_calls: [{
        id: 'toolu_1',
        type: 'function',
        function: { name: 'lookup', arguments: '{"a":1,"b":2}' },
      }],
      reasoning_content: 'step',
    },
    finish_reason: 'tool_calls',
  }]);
  assert.deepEqual(body.usage, {
    prompt_tokens: 15,
    completion_tokens: 5,
    total_tokens: 20,
    prompt_tokens_details: { cached_tokens: 3 },
  });
  assert.equal(warnings.some((warning) => warning.code === 'redacted_thinking_dropped'), true);
});

test('a2c 非流式响应 finish_reason 映射与空内容', () => {
  const cases = [
    ['end_turn', 'stop'],
    ['stop_sequence', 'stop'],
    ['max_tokens', 'length'],
    ['tool_use', 'tool_calls'],
    ['refusal', 'content_filter'],
    ['unknown_reason', 'stop'],
    [null, 'stop'],
  ];

  for (const [stopReason, expected] of cases) {
    const { body } = convertResponse({
      request: { model: 'gpt-5' },
      body: { content: [], stop_reason: stopReason },
    });
    assert.equal(body.choices[0].finish_reason, expected);
    assert.equal(body.choices[0].message.content, null);
    assert.equal(body.id.startsWith('chatcmpl-'), true);
    assert.equal(body.model, 'gpt-5');
  }
});

test('a2c 流式转换 Anthropic 事件为 Chat chunk 并以 usage 和 DONE 收尾', () => {
  const upstream = [
    sseFrame('message_start', {
      message: {
        id: 'msg_1',
        model: 'claude-opus-5',
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    }),
    sseFrame('content_block_start', {
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    }),
    sseFrame('content_block_delta', {
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'plan' },
    }),
    sseFrame('content_block_delta', {
      index: 0,
      delta: { type: 'signature_delta', signature: 'sig' },
    }),
    sseFrame('content_block_stop', { index: 0 }),
    sseFrame('content_block_start', {
      index: 1,
      content_block: { type: 'text', text: '' },
    }),
    sseFrame('content_block_delta', {
      index: 1,
      delta: { type: 'text_delta', text: 'Hi' },
    }),
    sseFrame('content_block_stop', { index: 1 }),
    sseFrame('content_block_start', {
      index: 2,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} },
    }),
    sseFrame('content_block_delta', {
      index: 2,
      delta: { type: 'input_json_delta', partial_json: '{"q"' },
    }),
    sseFrame('content_block_delta', {
      index: 2,
      delta: { type: 'input_json_delta', partial_json: ':"x"}' },
    }),
    sseFrame('content_block_stop', { index: 2 }),
    sseFrame('message_delta', {
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 5 },
    }),
    sseFrame('message_stop', {}),
  ].join('');

  const converter = createStreamConverter({ request: { model: 'gpt-5' } });
  const payloads = parsePayloads(collectStream(converter, byteChunks(upstream)));

  assert.equal(payloads.length, 8);
  assert.equal(payloads[0].object, 'chat.completion.chunk');
  assert.equal(payloads[0].id, 'msg_1');
  assert.equal(payloads[0].model, 'claude-opus-5');
  assert.deepEqual(payloads[0].choices, [{
    index: 0,
    delta: { role: 'assistant', content: '' },
    finish_reason: null,
  }]);
  assert.deepEqual(payloads[1].choices[0].delta, { reasoning_content: 'plan' });
  assert.deepEqual(payloads[2].choices[0].delta, { content: 'Hi' });
  assert.deepEqual(payloads[3].choices[0].delta, {
    tool_calls: [{
      index: 0,
      id: 'toolu_1',
      type: 'function',
      function: { name: 'lookup', arguments: '' },
    }],
  });
  assert.deepEqual(payloads[4].choices[0].delta, {
    tool_calls: [{ index: 0, function: { arguments: '{"q"' } }],
  });
  assert.deepEqual(payloads[5].choices[0].delta, {
    tool_calls: [{ index: 0, function: { arguments: ':"x"}' } }],
  });
  assert.deepEqual(payloads[6].choices[0], { index: 0, delta: {}, finish_reason: 'tool_calls' });
  assert.deepEqual(payloads[6].usage, {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
  });
  assert.equal(payloads[7], '[DONE]');
  assert.equal(payloads[0].created, payloads[6].created);
  assert.equal(converter.done, true);
  assert.deepEqual(converter.warnings, []);
});

test('a2c 流式 EOF 缺少 message_stop 时冲刷并补 DONE', () => {
  const converter = createStreamConverter({ request: { model: 'gpt-5' } });
  const output = converter.push(sseFrame('message_start', {
    message: { id: 'msg_2', model: 'claude-opus-5', usage: { input_tokens: 3 } },
  }));
  const tail = converter.end();
  const payloads = parsePayloads(output + tail);

  assert.equal(payloads[0].choices[0].delta.role, 'assistant');
  assert.equal(payloads.at(-1), '[DONE]');
  assert.equal(payloads.some((payload) => payload.choices?.[0]?.finish_reason), false);
  assert.equal(converter.done, true);
});

test('a2c 流式 error 事件输出 error data 与 DONE', () => {
  const converter = createStreamConverter({ request: { model: 'gpt-5' } });
  const output = converter.push(sseFrame('error', {
    error: { type: 'overloaded_error', message: 'busy' },
  }));
  const payloads = parsePayloads(output);

  assert.deepEqual(payloads, [
    { error: { type: 'overloaded_error', message: 'busy' } },
    '[DONE]',
  ]);
  assert.equal(converter.done, true);
  assert.equal(converter.end(), null);
});

test('a2c 流式 message_stop 只收尾一次', () => {
  const converter = createStreamConverter({ request: { model: 'gpt-5' } });
  const output = converter.push(
    sseFrame('message_start', { message: { id: 'msg_3', usage: {} } })
      + sseFrame('message_stop', {})
      + sseFrame('message_stop', {}),
  );
  const payloads = parsePayloads(output);

  assert.equal(payloads.filter((payload) => payload !== '[DONE]').length, 2);
  assert.equal(payloads.at(-1), '[DONE]');
  assert.equal(payloads.filter((payload) => payload === '[DONE]').length, 1);
});

test('a2c 流式 input_json_delta 缺少工具块时告警且不输出', () => {
  const converter = createStreamConverter({ request: { model: 'gpt-5' } });
  const output = converter.push(sseFrame('content_block_delta', {
    index: 9,
    delta: { type: 'input_json_delta', partial_json: '{}' },
  }));
  const tail = converter.end();

  assert.equal(output, null);
  assert.equal(tail, SSE_DONE);
  assert.equal(converter.warnings.some((warning) => warning.code === 'tool_delta_without_start'), true);
});
