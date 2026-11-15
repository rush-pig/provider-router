import assert from 'node:assert/strict';
import test from 'node:test';

import { ConversionError, ConversionRequestError } from '../src/convert/common/errors.mjs';
import { SseParser, formatSseJson } from '../src/convert/common/sse.mjs';
import {
  convertRequest,
  convertResponse,
  createStreamConverter,
} from '../src/convert/directions/c2a.mjs';

function parseFrames(text) {
  const parser = new SseParser();
  return [...parser.push(text), ...parser.end()];
}

function streamEvents(text) {
  return parseFrames(text).map((frame) => ({
    event: frame.event,
    data: frame.data === '[DONE]' ? frame.data : JSON.parse(frame.data),
  }));
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
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  };
}

test('c2a 请求合并 system/developer 并转换文本与 user part', () => {
  const { body, stream, warnings } = convertRequest({
    model: 'claude-opus-5',
    body: baseBody({
      messages: [
        { role: 'system', content: 'sys one' },
        { role: 'developer', content: [{ type: 'text', text: 'sys two' }] },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'input_audio', input_audio: { data: 'x' } },
          ],
        },
      ],
    }),
  });

  assert.equal(stream, false);
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, 4096);
  assert.deepEqual(body.system, [
    {
      type: 'text',
      text: 'sys one\n\nsys two',
      cache_control: { type: 'ephemeral' },
    },
  ]);
  assert.deepEqual(body.messages[0], {
    role: 'user',
    content: [{ type: 'text', text: 'hello' }],
  });
  assert.deepEqual(body.messages[1], {
    role: 'assistant',
    content: [{ type: 'text', text: 'hi there' }],
  });
  assert.equal(body.messages[2].content[0].text, 'look');
  assert.deepEqual(body.messages[2].content[0].cache_control, { type: 'ephemeral' });
  assert.equal(warnings.some((warning) => warning.code === 'unsupported_content_part'), true);
});

test('c2a 请求把 image_url 的 data URI 与普通 URL 转成 Anthropic image source', () => {
  const { body, warnings } = convertRequest({
    model: 'claude-opus-5',
    body: baseBody({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'images' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
          { type: 'image_url', image_url: { url: 'https://example.com/a.jpg' } },
          { type: 'video_url', video_url: { url: 'https://example.com/a.mp4' } },
        ],
      }],
    }),
  });

  const content = body.messages[0].content;
  assert.deepEqual(content[1], {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'QUJD' },
  });
  assert.deepEqual(content[2], {
    type: 'image',
    source: { type: 'url', url: 'https://example.com/a.jpg' },
    cache_control: { type: 'ephemeral' },
  });
  assert.equal(content.length, 3);
  assert.equal(warnings.some((warning) => warning.code === 'unsupported_content_part'), true);
});

test('c2a 请求转换 tool_calls 与连续 tool 消息，并丢弃 reasoning_content', () => {
  const { body, warnings } = convertRequest({
    model: 'claude-opus-5',
    body: baseBody({
      messages: [
        { role: 'user', content: 'run tools' },
        {
          role: 'assistant',
          content: 'calling',
          reasoning_content: 'internal plan',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'lookup', arguments: '{"q":"x"}' },
            },
            {
              id: 'call_2',
              type: 'function',
              function: { name: 'lookup', arguments: 'not json' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'first result' },
        { role: 'tool', tool_call_id: 'call_2', content: [{ type: 'text', text: 'second' }] },
        { role: 'user', content: 'continue' },
      ],
    }),
  });

  assert.deepEqual(body.messages[1], {
    role: 'assistant',
    content: [
      { type: 'text', text: 'calling' },
      { type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'x' } },
      { type: 'tool_use', id: 'call_2', name: 'lookup', input: {} },
    ],
  });
  assert.deepEqual(body.messages[2], {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'call_1', content: 'first result' },
      {
        type: 'tool_result',
        tool_use_id: 'call_2',
        content: 'second',
        cache_control: { type: 'ephemeral' },
      },
    ],
  });
  assert.equal(body.messages[3].content[0].text, 'continue');
  assert.equal(warnings.some((warning) => warning.code === 'reasoning_content_dropped'), true);
});

test('c2a 请求映射 tools/tool_choice/parallel_tool_calls 与 schema 清洗', () => {
  const { body, stream, warnings } = convertRequest({
    model: 'claude-opus-5',
    body: baseBody({
      stream: true,
      temperature: 0.2,
      tools: [
        {
          type: 'function',
          function: {
            name: 'lookup',
            description: 'Find a record',
            parameters: {
              type: 'object',
              properties: { url: { type: 'string', format: 'uri' } },
            },
          },
        },
        { type: 'web_search' },
      ],
      tool_choice: { type: 'function', function: { name: 'lookup' } },
      parallel_tool_calls: false,
    }),
  });

  assert.equal(stream, true);
  assert.equal(body.tools.length, 1);
  assert.deepEqual(body.tools[0], {
    name: 'lookup',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string' } },
    },
    description: 'Find a record',
    cache_control: { type: 'ephemeral' },
  });
  assert.deepEqual(body.tool_choice, {
    type: 'tool',
    name: 'lookup',
    disable_parallel_tool_use: true,
  });
  assert.equal(body.temperature, 0.2);
  assert.equal(warnings.some((warning) => warning.code === 'unsupported_tool'), true);
});

test('c2a 请求在无 tools 时省略 tool_choice，required 映射为 any 并附加禁用并行', () => {
  const withoutTools = convertRequest({
    model: 'claude-opus-5',
    body: baseBody({ tool_choice: 'required' }),
  });
  assert.equal(withoutTools.body.tool_choice, undefined);

  const withTools = convertRequest({
    model: 'claude-opus-5',
    body: baseBody({
      tools: [{ type: 'function', function: { name: 'ping' } }],
      tool_choice: 'required',
      parallel_tool_calls: false,
    }),
  });
  assert.deepEqual(withTools.body.tool_choice, {
    type: 'any',
    disable_parallel_tool_use: true,
  });
});

test('c2a 请求优先 max_completion_tokens，并把 stop 字符串转成 stop_sequences', () => {
  const { body } = convertRequest({
    model: 'claude-opus-5',
    body: baseBody({
      max_completion_tokens: 1234,
      max_tokens: 999,
      stop: 'END',
    }),
  });

  assert.equal(body.max_tokens, 1234);
  assert.deepEqual(body.stop_sequences, ['END']);
});

test('c2a 请求把 reasoning_effort 映射为 Anthropic thinking 并丢弃采样参数', () => {
  const adaptive = convertRequest({
    model: 'claude-opus-5',
    body: baseBody({
      reasoning_effort: 'HIGH',
      max_tokens: 64000,
      temperature: 0.5,
      top_p: 0.9,
    }),
  });

  assert.deepEqual(adaptive.body.thinking, { type: 'adaptive' });
  assert.deepEqual(adaptive.body.output_config, { effort: 'high' });
  assert.equal(adaptive.body.temperature, undefined);
  assert.equal(adaptive.body.top_p, undefined);

  const minimal = convertRequest({
    model: 'claude-3-5-sonnet',
    body: baseBody({ reasoning_effort: 'minimal', max_tokens: 32000 }),
  });
  assert.deepEqual(minimal.body.thinking, { type: 'enabled', budget_tokens: 2048 });
  assert.equal(minimal.body.output_config, undefined);

  const none = convertRequest({
    model: 'claude-3-5-sonnet',
    body: baseBody({ reasoning_effort: 'none', temperature: 0.3 }),
  });
  assert.equal(none.body.thinking, undefined);
  assert.equal(none.body.temperature, 0.3);
});

test('c2a 强制工具调用与 thinking 冲突时按模型能力报错或关闭 thinking', () => {
  const tools = [{ type: 'function', function: { name: 'ping' } }];

  assert.throws(
    () => convertRequest({
      model: 'fable-5',
      body: baseBody({ tools, tool_choice: 'required', reasoning_effort: 'high' }),
    }),
    (error) => {
      assert.equal(error instanceof ConversionRequestError, true);
      assert.equal(error.status, 400);
      assert.equal(error.code, 'thinking_required_by_tool_choice');
      return true;
    },
  );

  const disabled = convertRequest({
    model: 'claude-opus-5',
    body: baseBody({
      tools,
      tool_choice: { type: 'function', function: { name: 'ping' } },
      reasoning_effort: 'high',
      temperature: 0.4,
      top_p: 0.8,
    }),
  });
  assert.deepEqual(disabled.body.thinking, { type: 'disabled' });
  assert.equal(disabled.body.output_config, undefined);
  assert.equal(disabled.body.temperature, 0.4);
  assert.equal(disabled.body.top_p, 0.8);
});

test('c2a 请求丢弃不支持的 Chat 字段并为每个字段产生 warning', () => {
  const { body, warnings } = convertRequest({
    model: 'claude-opus-5',
    body: baseBody({
      n: 2,
      response_format: { type: 'json_object' },
      logprobs: true,
      seed: 7,
      presence_penalty: 0.1,
      frequency_penalty: 0.2,
      service_tier: 'auto',
      user: 'someone',
      stream_options: { include_usage: true },
    }),
  });

  const droppedFields = warnings
    .filter((warning) => warning.code === 'dropped_field')
    .map((warning) => warning.field);
  assert.deepEqual(droppedFields.sort(), [
    'frequency_penalty',
    'logprobs',
    'n',
    'presence_penalty',
    'response_format',
    'seed',
    'service_tier',
    'stream_options',
    'user',
  ]);
  for (const field of droppedFields) assert.equal(body[field], undefined);
});

test('c2a 规范化后没有消息时抛出 ConversionRequestError', () => {
  assert.throws(
    () => convertRequest({
      model: 'claude-opus-5',
      body: { model: 'gpt-test', messages: [{ role: 'system', content: 'only system' }] },
    }),
    (error) => {
      assert.equal(error instanceof ConversionRequestError, true);
      assert.equal(error.status, 400);
      assert.equal(error.code, 'empty_messages');
      return true;
    },
  );
});

test('c2a 非流式响应转换文本、usage 与默认 id', () => {
  const { body, warnings } = convertResponse({
    request: { model: 'claude-opus-5' },
    body: {
      model: 'upstream-model',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'Hello' },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 30 },
      },
    },
  });

  assert.equal(body.id.startsWith('msg_'), true);
  assert.deepEqual(body, {
    id: body.id,
    type: 'message',
    role: 'assistant',
    model: 'upstream-model',
    content: [{ type: 'text', text: 'Hello' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 70,
      output_tokens: 20,
      cache_read_input_tokens: 30,
    },
  });
  assert.deepEqual(warnings, []);
});

test('c2a 非流式响应把 reasoning_content 放首位，并兼容 refusal 与 output_text', () => {
  const { body } = convertResponse({
    request: { model: 'claude-opus-5' },
    body: {
      id: 'chatcmpl-1',
      model: 'm',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          reasoning_content: 'plan',
          content: [
            { type: 'text', text: 'A' },
            { type: 'output_text', text: 'B' },
          ],
          refusal: 'cannot comply',
        },
        finish_reason: 'content_filter',
      }],
    },
  });

  assert.equal(body.id, 'chatcmpl-1');
  assert.deepEqual(body.content, [
    { type: 'thinking', thinking: 'plan' },
    { type: 'text', text: 'A' },
    { type: 'text', text: 'B' },
    { type: 'text', text: 'cannot comply' },
  ]);
  assert.equal(body.stop_reason, 'end_turn');
  assert.deepEqual(body.usage, { input_tokens: 0, output_tokens: 0 });
});

test('c2a 非流式响应转换 tool_calls/function_call 并强制 tool_use 停止原因', () => {
  const toolResponse = convertResponse({
    body: {
      id: 'chatcmpl-2',
      model: 'm',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } },
            { id: 'call_2', type: 'function', function: { name: 'lookup', arguments: 'oops' } },
          ],
        },
        finish_reason: 'stop',
      }],
    },
  });

  assert.deepEqual(toolResponse.body.content, [
    { type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'x' } },
    { type: 'tool_use', id: 'call_2', name: 'lookup', input: {} },
  ]);
  assert.equal(toolResponse.body.stop_reason, 'tool_use');

  const legacy = convertResponse({
    body: {
      model: 'm',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'legacy',
          function_call: { name: 'old_tool', arguments: '{"a":1}' },
        },
        finish_reason: 'function_call',
      }],
    },
  });
  assert.equal(legacy.body.content[0].text, 'legacy');
  assert.equal(legacy.body.content[1].type, 'tool_use');
  assert.equal(legacy.body.content[1].name, 'old_tool');
  assert.deepEqual(legacy.body.content[1].input, { a: 1 });
  assert.equal(legacy.body.content[1].id.startsWith('toolu_'), true);
  assert.equal(legacy.body.stop_reason, 'tool_use');
});

test('c2a 非流式响应 finish_reason 映射表', () => {
  const cases = [
    ['stop', 'end_turn'],
    ['length', 'max_tokens'],
    ['tool_calls', 'tool_use'],
    ['content_filter', 'end_turn'],
    ['unknown_reason', 'end_turn'],
    [null, 'end_turn'],
  ];

  for (const [finishReason, expected] of cases) {
    const { body } = convertResponse({
      body: {
        model: 'm',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: '' },
          finish_reason: finishReason,
        }],
      },
    });
    assert.equal(body.stop_reason, expected);
    assert.deepEqual(body.content, []);
  }
});

test('c2a 非流式响应缺少 choices 时抛出 ConversionError', () => {
  assert.throws(
    () => convertResponse({ body: { choices: [] } }),
    (error) => {
      assert.equal(error instanceof ConversionError, true);
      assert.equal(error.status, 422);
      assert.equal(error.code, 'invalid_chat_response');
      return true;
    },
  );
});

test('c2a 流式转换 thinking/text/tool 分片并生成完整 Anthropic 事件序列', () => {
  const upstream = [
    formatSseJson({
      id: 'chatcmpl-9',
      model: 'claude-opus-5',
      choices: [{
        index: 0,
        delta: { role: 'assistant', reasoning_content: 'plan', content: '' },
        finish_reason: null,
      }],
    }),
    formatSseJson({
      choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
    }),
    formatSseJson({
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name: 'lookup', arguments: '{"q":' },
          }],
        },
        finish_reason: null,
      }],
    }),
    formatSseJson({
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] },
        finish_reason: null,
      }],
    }),
    formatSseJson({
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
    'data: [DONE]\n\n',
  ].join('');

  const converter = createStreamConverter({ request: { model: 'claude-opus-5' } });
  const events = streamEvents(collectStream(converter, byteChunks(upstream)));

  assert.deepEqual(events.map((item) => item.event), [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
    'content_block_start',
    'content_block_delta',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ]);
  assert.equal(events[0].data.message.id, 'chatcmpl-9');
  assert.equal(events[0].data.message.model, 'claude-opus-5');
  assert.deepEqual(events[0].data.message.usage, { input_tokens: 0, output_tokens: 0 });
  assert.deepEqual(events[1].data.content_block, { type: 'thinking', thinking: '' });
  assert.deepEqual(events[2].data.delta, { type: 'thinking_delta', thinking: 'plan' });
  assert.equal(events[4].data.content_block.type, 'text');
  assert.deepEqual(events[5].data.delta, { type: 'text_delta', text: 'Hello' });
  assert.deepEqual(events[7].data.content_block, {
    type: 'tool_use',
    id: 'call_1',
    name: 'lookup',
    input: {},
  });
  assert.deepEqual(events[8].data.delta, { type: 'input_json_delta', partial_json: '{"q":' });
  assert.deepEqual(events[9].data.delta, { type: 'input_json_delta', partial_json: '"x"}' });
  assert.equal(events[10].data.index, 2);
  assert.deepEqual(events[11].data, {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use', stop_sequence: null },
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  assert.deepEqual(events[12].data, { type: 'message_stop' });
  assert.equal(converter.done, true);
  assert.deepEqual(converter.warnings, []);
});

test('c2a 流式工具块等待 id 与 name 齐备后补发缓存参数', () => {
  const upstream = [
    formatSseJson({
      id: 'chatcmpl-3',
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{ index: 0, id: 'call_7', function: { arguments: '{"a":' } }],
        },
        finish_reason: null,
      }],
    }),
    formatSseJson({
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { name: 'search', arguments: '1}' } }] },
        finish_reason: null,
      }],
    }),
    formatSseJson({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    }),
  ].join('');

  const converter = createStreamConverter({ request: { model: 'm' } });
  const events = streamEvents(collectStream(converter, byteChunks(upstream)));
  const starts = events.filter((item) => item.event === 'content_block_start');
  const argumentDeltas = events
    .filter((item) => item.event === 'content_block_delta')
    .map((item) => item.data.delta);

  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0].data.content_block, {
    type: 'tool_use',
    id: 'call_7',
    name: 'search',
    input: {},
  });
  assert.deepEqual(argumentDeltas, [
    { type: 'input_json_delta', partial_json: '{"a":1}' },
  ]);
  assert.equal(events.at(-2).data.delta.stop_reason, 'tool_use');
  assert.deepEqual(events.at(-1).data, { type: 'message_stop' });
});

test('c2a 流式 usage-only chunk 只合并 usage，message_start 使用已合并的 usage', () => {
  const converter = createStreamConverter({ request: { model: 'm' } });
  const usageOnly = converter.push(formatSseJson({
    choices: [],
    usage: { prompt_tokens: 4, completion_tokens: 2 },
  }));
  assert.equal(usageOnly, null);

  const output = converter.push(formatSseJson({
    id: 'chatcmpl-4',
    choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
  }));
  const events = streamEvents(output);

  assert.equal(events[0].event, 'message_start');
  assert.deepEqual(events[0].data.message.usage, { input_tokens: 4, output_tokens: 2 });
  assert.deepEqual(events[2].data.delta, { type: 'text_delta', text: 'hi' });
});

test('c2a 流式没有 finish_reason 时 EOF 不伪造 message_stop', () => {
  const converter = createStreamConverter({ request: { model: 'm' } });
  const events = streamEvents(collectStream(converter, [
    formatSseJson({
      id: 'chatcmpl-5',
      choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }],
    }),
  ]));

  assert.equal(events.some((item) => item.event === 'message_stop'), false);
  assert.equal(events.some((item) => item.event === 'message_delta'), false);
  assert.deepEqual(events.at(-1).data.delta, { type: 'text_delta', text: 'partial' });
  assert.equal(converter.done, true);
});

test('c2a 流式忽略空 reasoning_content，并对非法 JSON 记录 warning', () => {
  const converter = createStreamConverter({ request: { model: 'm' } });
  const invalid = converter.push('data: {not json}\n\n');
  assert.equal(invalid, null);
  assert.equal(converter.warnings.some((warning) => warning.code === 'invalid_upstream_event'), true);

  const output = converter.push(formatSseJson({
    id: 'chatcmpl-6',
    choices: [{
      index: 0,
      delta: { reasoning_content: '', content: 'text only' },
      finish_reason: null,
    }],
  }));
  const events = streamEvents(output);
  const starts = events.filter((item) => item.event === 'content_block_start');

  assert.equal(starts.length, 1);
  assert.equal(starts[0].data.content_block.type, 'text');
});
