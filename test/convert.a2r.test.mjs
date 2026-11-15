import assert from 'node:assert/strict';
import test from 'node:test';

import { SseParser } from '../src/convert/common/sse.mjs';
import { THINKING_BRIDGE_PREFIX, decodeThinkingBridge } from '../src/convert/common/thinking.mjs';
import {
  convertRequest,
  convertResponse,
  createStreamConverter,
} from '../src/convert/directions/a2r.mjs';

function parseSse(text) {
  const parser = new SseParser();
  const events = [...parser.push(text), ...parser.end()];
  return events.map((event) => ({ event: event.event, data: JSON.parse(event.data) }));
}

function frame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function splitBytes(text, size) {
  const bytes = Buffer.from(text, 'utf8');
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    chunks.push(bytes.subarray(offset, offset + size));
  }
  return chunks;
}

function runStream(source, chunkSize = 0) {
  const converter = createStreamConverter({ request: { model: 'gpt-5.6' } });
  const chunks = chunkSize > 0 ? splitBytes(source, chunkSize) : [source];
  let output = '';
  for (const chunk of chunks) output += converter.push(chunk) ?? '';
  output += converter.end() ?? '';
  return { converter, output, events: parseSse(output) };
}

function hasWarning(warnings, code, field) {
  return warnings.some((warning) => warning.code === code && (field === undefined || warning.field === field));
}

test('a2r 请求：system、文本、tool_use、tool_result 与工具定义', () => {
  const { body, stream, warnings } = convertRequest({
    body: {
      model: 'gpt-5.6',
      max_tokens: 8,
      stream: true,
      temperature: 0.5,
      top_p: 0.9,
      system: [
        { type: 'text', text: 'x-anthropic-billing-header: abc\nYou are helpful' },
        { type: 'text', text: 'Second rule' },
      ],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { b: 2, a: 1 } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '42' }] },
            { type: 'text', text: 'thanks' },
          ],
        },
      ],
      tools: [
        {
          name: 'lookup',
          description: 'Look up',
          input_schema: { properties: { q: { type: 'string', format: 'uri' } } },
        },
        { name: 'BatchTool', input_schema: {} },
      ],
      tool_choice: { type: 'tool', name: 'lookup' },
      thinking: { type: 'enabled', budget_tokens: 16000 },
      top_k: 5,
      stop_sequences: ['STOP'],
      cache_control: { type: 'ephemeral' },
      prompt_cache_key: 'cache-key',
    },
    model: 'gpt-5.6',
  });

  assert.equal(stream, true);
  assert.equal(body.model, 'gpt-5.6');
  assert.equal(body.instructions, 'You are helpful\n\nSecond rule');
  assert.deepEqual(body.input, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hi' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello' }] },
    { type: 'function_call', call_id: 'toolu_1', name: 'lookup', arguments: '{"a":1,"b":2}' },
    { type: 'function_call_output', call_id: 'toolu_1', output: '42' },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'thanks' }] },
  ]);
  assert.deepEqual(body.tools, [{
    type: 'function',
    name: 'lookup',
    description: 'Look up',
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
    strict: false,
  }]);
  assert.deepEqual(body.tool_choice, { type: 'function', name: 'lookup' });
  assert.equal(body.max_output_tokens, 16);
  assert.equal(body.temperature, 0.5);
  assert.equal(body.top_p, 0.9);
  assert.equal(body.stream, true);
  assert.equal(body.prompt_cache_key, 'cache-key');
  assert.deepEqual(body.reasoning, { effort: 'high' });
  assert.equal('store' in body, false);
  assert.equal(hasWarning(warnings, 'unsupported_field', 'top_k'), true);
  assert.equal(hasWarning(warnings, 'unsupported_field', 'stop_sequences'), true);
  assert.equal(hasWarning(warnings, 'unsupported_field', 'cache_control'), true);
});

test('a2r 请求：assistant thinking 块编码为 reasoning item', () => {
  const { body } = convertRequest({
    body: {
      model: 'gpt-5.6',
      messages: [
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'step', signature: 'sig' },
            { type: 'redacted_thinking', data: 'opaque' },
            { type: 'text', text: 'answer' },
          ],
        },
      ],
      thinking: { type: 'adaptive' },
    },
    model: 'gpt-5.6',
  });

  const reasoning = body.input[1];
  assert.equal(reasoning.type, 'reasoning');
  assert.equal(reasoning.encrypted_content.startsWith(THINKING_BRIDGE_PREFIX), true);
  assert.deepEqual(reasoning.summary, []);
  assert.deepEqual(decodeThinkingBridge(reasoning), [
    { type: 'thinking', thinking: 'step', signature: 'sig' },
    { type: 'redacted_thinking', data: 'opaque' },
  ]);
  assert.deepEqual(body.input[2], {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'answer' }],
  });
});

test('a2r 请求：tool_result 图片提取为紧随其后的 user 图片消息', () => {
  const { body } = convertRequest({
    body: {
      model: 'gpt-5.6',
      messages: [{
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: [
              { type: 'text', text: 'see image' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
            ],
          },
          { type: 'text', text: 'and this' },
          { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
          { type: 'image', source: { type: 'base64' } },
        ],
      }],
    },
    model: 'gpt-5.6',
  });

  assert.deepEqual(body.input, [
    { type: 'function_call_output', call_id: 'toolu_1', output: 'see image' },
    {
      type: 'message',
      role: 'user',
      content: [{
        type: 'input_image',
        image_url: 'data:image/png;base64,QUJD',
      }],
    },
    {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'and this' },
        { type: 'input_image', image_url: 'https://example.com/a.png' },
      ],
    },
  ]);
});

test('a2r 请求：无 tools 删除 tool_choice，缺失 max_tokens 不生成输出上限', () => {
  const { body, warnings } = convertRequest({
    body: {
      model: 'gpt-5.6',
      messages: [{ role: 'user', content: 'hello' }],
      tool_choice: { type: 'auto' },
    },
    model: 'gpt-5.6',
  });

  assert.equal('tool_choice' in body, false);
  assert.equal('max_output_tokens' in body, false);
  assert.equal(hasWarning(warnings, 'tool_choice_without_tools', 'tool_choice'), true);
});

test('a2r 请求：reasoning effort 按模型能力裁剪或丢弃', () => {
  const clamped = convertRequest({
    body: {
      model: 'gpt-5-pro',
      thinking: { type: 'enabled', budget_tokens: 2000 },
      messages: [{ role: 'user', content: 'hello' }],
    },
    model: 'gpt-5-pro',
  });
  assert.deepEqual(clamped.body.reasoning, { effort: 'high' });

  const unsupported = convertRequest({
    body: {
      model: 'gpt-4.1',
      output_config: { effort: 'high' },
      thinking: { type: 'enabled', budget_tokens: 16000 },
      messages: [{ role: 'user', content: 'hello' }],
    },
    model: 'gpt-4.1',
  });
  assert.equal('reasoning' in unsupported.body, false);
});

test('a2r 请求：system 字符串剥离计费头', () => {
  const { body } = convertRequest({
    body: {
      model: 'gpt-5.6',
      system: 'x-anthropic-billing-header: abc\nSystem prompt',
      messages: [{ role: 'user', content: 'hello' }],
    },
    model: 'gpt-5.6',
  });
  assert.equal(body.instructions, 'System prompt');
});

test('a2r 非流式响应：文本合并、工具调用、thinking 桥与 usage', () => {
  const { body, warnings } = convertResponse({
    body: {
      id: 'msg_up_1',
      model: 'claude-sonnet-4-6',
      stop_reason: 'tool_use',
      content: [
        { type: 'thinking', thinking: 'plan', signature: 'sig' },
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'world' },
        { type: 'tool_use', id: 'toolu_9', name: 'lookup', input: { b: 2, a: 1 } },
      ],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 },
    },
    request: { model: 'gpt-5.6' },
  });

  assert.equal(body.id, 'msg_up_1');
  assert.equal(body.object, 'response');
  assert.equal(body.model, 'claude-sonnet-4-6');
  assert.equal(body.status, 'completed');
  assert.equal(body.output.length, 3);
  assert.deepEqual(decodeThinkingBridge(body.output[0]), [
    { type: 'thinking', thinking: 'plan', signature: 'sig' },
  ]);
  assert.deepEqual(body.output[1], {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'Hello \nworld' }],
  });
  assert.deepEqual(body.output[2], {
    type: 'function_call',
    call_id: 'toolu_9',
    name: 'lookup',
    arguments: '{"a":1,"b":2}',
  });
  assert.deepEqual(body.usage, {
    input_tokens: 13,
    output_tokens: 5,
    total_tokens: 18,
    input_tokens_details: { cached_tokens: 3 },
  });
  assert.equal('incomplete_details' in body, false);
  assert.deepEqual(warnings, []);
});

test('a2r 非流式响应：max_tokens 映射 incomplete，空内容输出空数组', () => {
  const incomplete = convertResponse({
    body: {
      id: 'msg_up_2',
      model: 'claude-sonnet-4-6',
      stop_reason: 'max_tokens',
      content: [],
      usage: { input_tokens: 1, output_tokens: 2 },
    },
    request: { model: 'gpt-5.6' },
  });
  assert.equal(incomplete.body.status, 'incomplete');
  assert.deepEqual(incomplete.body.incomplete_details, { reason: 'max_output_tokens' });
  assert.deepEqual(incomplete.body.output, []);
  assert.deepEqual(incomplete.body.usage, { input_tokens: 1, output_tokens: 2, total_tokens: 3 });

  const unsupported = convertResponse({
    body: {
      id: 'msg_up_3',
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
      content: [{ type: 'server_tool_use', id: 'srv_1' }],
      usage: {},
    },
    request: { model: 'gpt-5.6' },
  });
  assert.equal(hasWarning(unsupported.warnings, 'unsupported_output_block', 'content'), true);
});

test('a2r 流式：文本、工具参数分片、thinking 签名桥与序列号', () => {
  const source = [
    frame('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_stream_1',
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    }),
    frame('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    frame('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hel' },
    }),
    frame('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'lo' },
    }),
    frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
    frame('content_block_start', {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} },
    }),
    frame('content_block_delta', {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"a":' },
    }),
    frame('content_block_delta', {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '1}' },
    }),
    frame('content_block_stop', { type: 'content_block_stop', index: 1 }),
    frame('content_block_start', {
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'thinking' },
    }),
    frame('content_block_delta', {
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'thinking_delta', thinking: 'plan' },
    }),
    frame('content_block_delta', {
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'signature_delta', signature: 'sig-1' },
    }),
    frame('content_block_stop', { type: 'content_block_stop', index: 2 }),
    frame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 7 },
    }),
    frame('message_stop', { type: 'message_stop' }),
  ].join('');

  const { converter, events } = runStream(source, 5);
  assert.equal(converter.done, true);
  assert.deepEqual(
    events.map((event) => event.event),
    [
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.output_item.added',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.done',
      'response.output_item.done',
      'response.reasoning_summary_text.delta',
      'response.output_item.added',
      'response.output_item.done',
      'response.completed',
    ],
  );
  events.forEach((event, index) => assert.equal(event.data.sequence_number, index));

  const created = events[0].data.response;
  assert.equal(created.id, 'msg_stream_1');
  assert.equal(created.model, 'claude-sonnet-4-6');
  assert.equal(created.status, 'in_progress');
  assert.deepEqual(created.output, []);
  assert.deepEqual(created.usage, { input_tokens: 0, output_tokens: 0, total_tokens: 0 });

  assert.equal(events[2].data.output_index, 0);
  assert.equal(events[4].data.delta, 'Hel');
  assert.equal(events[5].data.delta, 'lo');
  assert.equal(events[6].data.text, 'Hello');
  assert.equal(events[9].data.output_index, 1);
  assert.equal(events[10].data.delta, '{"a":');
  assert.equal(events[11].data.delta, '1}');
  assert.equal(events[12].data.arguments, '{"a":1}');
  assert.equal(events[14].data.output_index, 2);
  assert.equal(events[14].data.delta, 'plan');

  const reasoningItem = events[15].data.item;
  assert.equal(reasoningItem.type, 'reasoning');
  assert.equal(reasoningItem.encrypted_content.startsWith(THINKING_BRIDGE_PREFIX), true);
  assert.deepEqual(decodeThinkingBridge(reasoningItem), [
    { type: 'thinking', thinking: 'plan', signature: 'sig-1' },
  ]);

  const completed = events[17].data.response;
  assert.equal(completed.status, 'completed');
  assert.equal(completed.output.length, 3);
  assert.equal(completed.output[0].type, 'message');
  assert.equal(completed.output[1].type, 'function_call');
  assert.equal(completed.output[2].type, 'reasoning');
  assert.deepEqual(completed.usage, {
    input_tokens: 10,
    output_tokens: 8,
    total_tokens: 18,
  });
});

test('a2r 流式：stop_reason=max_tokens 时以 response.incomplete 收尾', () => {
  const source = [
    frame('message_start', {
      type: 'message_start',
      message: { id: 'msg_stream_2', model: 'claude-sonnet-4-6', usage: { input_tokens: 3 } },
    }),
    frame('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    frame('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'partial' },
    }),
    frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
    frame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'max_tokens' },
      usage: { output_tokens: 4 },
    }),
    frame('message_stop', { type: 'message_stop' }),
  ].join('');

  const { events } = runStream(source);
  const last = events.at(-1);
  assert.equal(last.event, 'response.incomplete');
  assert.equal(last.data.response.status, 'incomplete');
  assert.deepEqual(last.data.response.incomplete_details, { reason: 'max_output_tokens' });
});

test('a2r 流式：EOF 有正文补 incomplete，无正文报 failed', () => {
  const withText = [
    frame('message_start', {
      type: 'message_start',
      message: { id: 'msg_stream_3', model: 'claude-sonnet-4-6', usage: {} },
    }),
    frame('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    frame('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: '你好🙂' },
    }),
  ].join('');

  const truncated = runStream(withText, 7);
  const incomplete = truncated.events.at(-1);
  assert.equal(incomplete.event, 'response.incomplete');
  assert.deepEqual(incomplete.data.response.incomplete_details, { reason: 'max_output_tokens' });
  assert.equal(
    truncated.events.filter((event) => event.event === 'response.output_text.delta')[0].data.delta,
    '你好🙂',
  );

  const empty = runStream(frame('message_start', {
    type: 'message_start',
    message: { id: 'msg_stream_4', model: 'claude-sonnet-4-6', usage: {} },
  }));
  const failed = empty.events.at(-1);
  assert.equal(failed.event, 'response.failed');
  assert.equal(failed.data.response.status, 'failed');
  assert.deepEqual(failed.data.response.error, {
    code: 'stream_truncated',
    message: '上游流在完成前结束',
  });
});

test('a2r 流式：上游 error 事件转换为 response.failed', () => {
  const source = [
    frame('message_start', {
      type: 'message_start',
      message: { id: 'msg_stream_5', model: 'claude-sonnet-4-6', usage: {} },
    }),
    frame('error', {
      type: 'error',
      error: { type: 'overloaded_error', message: 'busy' },
    }),
  ].join('');

  const { converter, events } = runStream(source);
  const failed = events.at(-1);
  assert.equal(failed.event, 'response.failed');
  assert.equal(failed.data.response.status, 'failed');
  assert.deepEqual(failed.data.response.error, { code: 'overloaded_error', message: 'busy' });
  assert.equal(converter.done, true);
  assert.equal(converter.push(frame('message_stop', { type: 'message_stop' })), null);
});
