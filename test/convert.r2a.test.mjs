import assert from 'node:assert/strict';
import test from 'node:test';

import { SseParser } from '../src/convert/common/sse.mjs';
import { ConversionError, ConversionRequestError } from '../src/convert/common/errors.mjs';
import { countCacheBreakpoints } from '../src/convert/common/cache.mjs';
import { encodeThinkingBridge } from '../src/convert/common/thinking.mjs';
import { DEFAULT_ANTHROPIC_MAX_TOKENS } from '../src/convert/common/constants.mjs';
import {
  convertRequest,
  convertResponse,
  createStreamConverter,
} from '../src/convert/directions/r2a.mjs';

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
  const converter = createStreamConverter({ request: { model: 'claude-sonnet-4-6' } });
  const chunks = chunkSize > 0 ? splitBytes(source, chunkSize) : [source];
  let output = '';
  for (const chunk of chunks) output += converter.push(chunk) ?? '';
  output += converter.end() ?? '';
  return { converter, output, events: parseSse(output) };
}

function hasWarning(warnings, code, field) {
  return warnings.some((warning) => warning.code === code && (field === undefined || warning.field === field));
}

function thinkingBridge(blocks) {
  return encodeThinkingBridge(blocks);
}

test('r2a 请求：instructions/system、消息、工具、thinking 冲突与缓存注入', () => {
  const bridge = thinkingBridge([{ type: 'thinking', thinking: 'prior', signature: 'sig' }]);
  const { body, stream, warnings } = convertRequest({
    body: {
      model: 'claude-sonnet-4-6',
      instructions: 'x-anthropic-billing-header: abc\nBe useful',
      input: [
        { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'Extra system' }] },
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'Hello' },
            { type: 'input_image', image_url: 'data:image/png;base64,QUJD' },
          ],
        },
        { type: 'reasoning', ...bridge },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hi' }] },
        { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"a":1}' },
        { type: 'function_call', call_id: 'call_2', name: 'lookup', arguments: '{"b":2}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'one' },
        {
          type: 'function_call_output',
          call_id: 'call_2',
          output: [
            { type: 'output_text', text: 'two' },
            { type: 'input_image', image_url: 'https://example.com/b.png' },
          ],
        },
      ],
      tools: [
        {
          type: 'function',
          name: 'lookup',
          description: 'Look up',
          parameters: { type: 'object', properties: { q: { type: 'string', format: 'uri' } } },
        },
        { type: 'web_search' },
      ],
      tool_choice: { type: 'function', name: 'lookup' },
      parallel_tool_calls: false,
      max_output_tokens: 128,
      reasoning: { effort: 'high' },
      temperature: 0.4,
      top_p: 0.8,
      stream: true,
      previous_response_id: 'resp_prev',
      store: true,
      truncation: 'auto',
      text: { format: { type: 'text' } },
      metadata: { user_id: 'u1' },
    },
    model: 'claude-sonnet-4-6',
  });

  assert.equal(stream, true);
  assert.equal(body.model, 'claude-sonnet-4-6');
  assert.deepEqual(body.system, [{
    type: 'text',
    text: 'Be useful\n\nExtra system',
    cache_control: { type: 'ephemeral' },
  }]);
  assert.deepEqual(body.messages[0], {
    role: 'user',
    content: [
      { type: 'text', text: 'Hello' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'QUJD' },
      },
    ],
  });
  assert.deepEqual(body.messages[1].content, [
    { type: 'thinking', thinking: 'prior', signature: 'sig' },
    { type: 'text', text: 'Hi' },
    { type: 'tool_use', id: 'call_1', name: 'lookup', input: { a: 1 } },
    { type: 'tool_use', id: 'call_2', name: 'lookup', input: { b: 2 } },
  ]);
  assert.deepEqual(body.messages[2].content[0], {
    type: 'tool_result',
    tool_use_id: 'call_1',
    content: 'one',
  });
  assert.deepEqual(body.messages[2].content[1], {
    type: 'tool_result',
    tool_use_id: 'call_2',
    content: [
      { type: 'text', text: 'two' },
      { type: 'image', source: { type: 'url', url: 'https://example.com/b.png' } },
    ],
    cache_control: { type: 'ephemeral' },
  });
  assert.deepEqual(body.tools, [{
    name: 'lookup',
    description: 'Look up',
    input_schema: { type: 'object', properties: { q: { type: 'string' } } },
    cache_control: { type: 'ephemeral' },
  }]);
  assert.deepEqual(body.tool_choice, {
    type: 'tool',
    name: 'lookup',
    disable_parallel_tool_use: true,
  });
  assert.equal(body.max_tokens, 128);
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal('output_config' in body, false);
  assert.equal(body.temperature, 0.4);
  assert.equal(body.top_p, 0.8);
  assert.equal(body.stream, true);
  assert.deepEqual(body.metadata, { user_id: 'u1' });
  assert.equal(countCacheBreakpoints(body), 3);
  assert.equal(hasWarning(warnings, 'unsupported_tool', 'tools'), true);
  assert.equal(hasWarning(warnings, 'unsupported_field', 'previous_response_id'), true);
  assert.equal(hasWarning(warnings, 'unsupported_field', 'store'), true);
  assert.equal(hasWarning(warnings, 'unsupported_field', 'truncation'), true);
  assert.equal(hasWarning(warnings, 'unsupported_field', 'text.format'), true);
  assert.equal(hasWarning(warnings, 'unsupported_field', 'metadata'), false);
});

test('r2a 请求：thinking 开启时移除采样参数', () => {
  const { body } = convertRequest({
    body: {
      model: 'claude-sonnet-4-6',
      input: [{ type: 'message', role: 'user', content: 'hello' }],
      reasoning: { effort: 'medium' },
      temperature: 0.7,
      top_p: 0.5,
    },
    model: 'claude-sonnet-4-6',
  });

  assert.deepEqual(body.thinking, { type: 'adaptive' });
  assert.deepEqual(body.output_config, { effort: 'medium' });
  assert.equal('temperature' in body, false);
  assert.equal('top_p' in body, false);
});

test('r2a 请求：不可关闭 thinking 的模型遇到强制工具调用时报 400', () => {
  assert.throws(
    () => convertRequest({
      body: {
        model: 'fable-5',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
        tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
        tool_choice: 'required',
        reasoning: { effort: 'high' },
      },
      model: 'fable-5',
    }),
    (error) => error instanceof ConversionRequestError
      && error.status === 400
      && error.code === 'thinking_conflict',
  );
});

test('r2a 请求：空 input 抛 ConversionRequestError', () => {
  assert.throws(
    () => convertRequest({ body: { model: 'claude-sonnet-4-6', input: [] }, model: 'claude-sonnet-4-6' }),
    (error) => error instanceof ConversionRequestError && error.status === 400,
  );
});

test('r2a 请求：无工具时删除 tool_choice，max_output_tokens 缺省为 Anthropic 默认值', () => {
  const { body, warnings } = convertRequest({
    body: {
      model: 'claude-sonnet-4-6',
      input: [{ type: 'message', role: 'user', content: 'hello' }],
      tool_choice: 'auto',
    },
    model: 'claude-sonnet-4-6',
  });

  assert.equal('tool_choice' in body, false);
  assert.equal('tools' in body, false);
  assert.equal(body.max_tokens, DEFAULT_ANTHROPIC_MAX_TOKENS);
  assert.equal(hasWarning(warnings, 'tool_choice_without_tools', 'tool_choice'), true);
});

test('r2a 非流式响应：文本、工具调用、thinking 桥与 usage', () => {
  const bridge = thinkingBridge([
    { type: 'thinking', thinking: 'plan', signature: 'sig' },
    { type: 'redacted_thinking', data: 'opaque' },
  ]);
  const { body, warnings } = convertResponse({
    body: {
      id: 'resp_1',
      model: 'claude-sonnet-4-6',
      status: 'completed',
      output: [
        { ...bridge, id: 'rs_1' },
        {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hi there' }],
        },
        { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{"a":1}' },
      ],
      usage: { input_tokens: 15, output_tokens: 5, input_tokens_details: { cached_tokens: 5 } },
    },
    request: { model: 'claude-sonnet-4-6' },
  });

  assert.equal(body.id, 'resp_1');
  assert.equal(body.type, 'message');
  assert.equal(body.role, 'assistant');
  assert.equal(body.model, 'claude-sonnet-4-6');
  assert.equal(body.stop_reason, 'tool_use');
  assert.equal(body.stop_sequence, null);
  assert.deepEqual(body.content, [
    { type: 'thinking', thinking: 'plan', signature: 'sig' },
    { type: 'redacted_thinking', data: 'opaque' },
    { type: 'text', text: 'Hi there' },
    { type: 'tool_use', id: 'call_1', name: 'lookup', input: { a: 1 } },
  ]);
  assert.deepEqual(body.usage, {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 5,
  });
  assert.deepEqual(warnings, []);
});

test('r2a 非流式响应：incomplete 映射 max_tokens，普通 reasoning 丢弃并告警', () => {
  const incomplete = convertResponse({
    body: {
      id: 'resp_2',
      model: 'claude-sonnet-4-6',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [],
      usage: { input_tokens: 2, output_tokens: 3 },
    },
    request: { model: 'claude-sonnet-4-6' },
  });
  assert.equal(incomplete.body.stop_reason, 'max_tokens');
  assert.deepEqual(incomplete.body.content, []);
  assert.deepEqual(incomplete.body.usage, { input_tokens: 2, output_tokens: 3 });

  const dropped = convertResponse({
    body: {
      id: 'resp_3',
      model: 'claude-sonnet-4-6',
      status: 'completed',
      output: [{ type: 'reasoning', id: 'rs_2', summary: [{ type: 'summary_text', text: 'x' }] }],
      usage: {},
    },
    request: { model: 'claude-sonnet-4-6' },
  });
  assert.deepEqual(dropped.body.content, []);
  assert.equal(dropped.body.stop_reason, 'end_turn');
  assert.equal(hasWarning(dropped.warnings, 'reasoning_dropped', 'output'), true);
});

test('r2a 非流式响应：failed/cancelled 抛 422 ConversionError', () => {
  for (const status of ['failed', 'cancelled']) {
    assert.throws(
      () => convertResponse({
        body: {
          id: 'resp_4',
          model: 'claude-sonnet-4-6',
          status,
          error: { message: `${status} boom` },
          output: [],
          usage: {},
        },
        request: { model: 'claude-sonnet-4-6' },
      }),
      (error) => error instanceof ConversionError
        && error.status === 422
        && error.code === 'upstream_failed'
        && error.message.includes(`${status} boom`),
    );
  }
});

test('r2a 流式：消息、工具参数分片、thinking 签名与 completed 收尾', () => {
  const bridge = thinkingBridge([{ type: 'thinking', thinking: 'prior', signature: 'sig-1' }]);
  const source = [
    frame('response.created', {
      type: 'response.created',
      response: { id: 'resp_1', model: 'claude-sonnet-4-6', status: 'in_progress' },
    }),
    frame('response.in_progress', {
      type: 'response.in_progress',
      response: { id: 'resp_1', model: 'claude-sonnet-4-6', status: 'in_progress' },
    }),
    frame('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', id: 'msg_item', role: 'assistant', content: [] },
    }),
    frame('response.output_text.delta', {
      type: 'response.output_text.delta',
      item_id: 'msg_item',
      output_index: 0,
      content_index: 0,
      delta: 'Hi',
    }),
    frame('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'message',
        id: 'msg_item',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hi' }],
      },
    }),
    frame('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 1,
      item: { type: 'function_call', id: 'fc_item', call_id: 'call_1', name: 'lookup', arguments: '' },
    }),
    frame('response.function_call_arguments.delta', {
      type: 'response.function_call_arguments.delta',
      item_id: 'fc_item',
      output_index: 1,
      delta: '{"a":',
    }),
    frame('response.function_call_arguments.delta', {
      type: 'response.function_call_arguments.delta',
      item_id: 'fc_item',
      output_index: 1,
      delta: '1}',
    }),
    frame('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 1,
      item: {
        type: 'function_call',
        id: 'fc_item',
        call_id: 'call_1',
        name: 'lookup',
        arguments: '{"a":1}',
      },
    }),
    frame('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 2,
      item: { type: 'reasoning', id: 'rs_item', ...bridge },
    }),
    frame('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 2,
      item: { type: 'reasoning', id: 'rs_item', ...bridge },
    }),
    frame('response.completed', {
      type: 'response.completed',
      response: {
        id: 'resp_1',
        model: 'claude-sonnet-4-6',
        status: 'completed',
        usage: { input_tokens: 12, output_tokens: 6, input_tokens_details: { cached_tokens: 2 } },
      },
    }),
  ].join('');

  const { converter, events } = runStream(source, 5);
  assert.equal(converter.done, true);
  assert.deepEqual(
    events.map((event) => event.event),
    [
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ],
  );
  assert.equal(events.some((event) => 'sequence_number' in event.data), false);

  const start = events[0].data.message;
  assert.equal(start.id, 'resp_1');
  assert.equal(start.model, 'claude-sonnet-4-6');
  assert.deepEqual(start.content, []);
  assert.deepEqual(start.usage, { input_tokens: 0, output_tokens: 0 });

  assert.deepEqual(events[1].data, {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  });
  assert.deepEqual(events[2].data, {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'Hi' },
  });
  assert.deepEqual(events[4].data.content_block, {
    type: 'tool_use',
    id: 'call_1',
    name: 'lookup',
    input: {},
  });
  assert.deepEqual(events[5].data.delta, { type: 'input_json_delta', partial_json: '{"a":' });
  assert.deepEqual(events[6].data.delta, { type: 'input_json_delta', partial_json: '1}' });
  assert.deepEqual(events[8].data.content_block, { type: 'thinking', thinking: '' });
  assert.deepEqual(events[9].data.delta, { type: 'signature_delta', signature: 'sig-1' });

  assert.deepEqual(events[11].data.delta, { stop_reason: 'tool_use', stop_sequence: null });
  assert.deepEqual(events[11].data.usage, {
    input_tokens: 10,
    output_tokens: 6,
    cache_read_input_tokens: 2,
  });
  assert.deepEqual(events[12].data, { type: 'message_stop' });
});

test('r2a 流式：普通 reasoning 摘要按 thinking_delta 输出', () => {
  const source = [
    frame('response.created', {
      type: 'response.created',
      response: { id: 'resp_2', model: 'claude-sonnet-4-6', status: 'in_progress' },
    }),
    frame('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'reasoning', id: 'rs_2', summary: [] },
    }),
    frame('response.reasoning_summary_text.delta', {
      type: 'response.reasoning_summary_text.delta',
      item_id: 'rs_2',
      output_index: 0,
      summary_index: 0,
      delta: 'think',
    }),
    frame('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'reasoning', id: 'rs_2', summary: [] },
    }),
    frame('response.completed', {
      type: 'response.completed',
      response: { id: 'resp_2', model: 'claude-sonnet-4-6', status: 'completed', usage: {} },
    }),
  ].join('');

  const { events } = runStream(source);
  assert.deepEqual(
    events.map((event) => event.event),
    [
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ],
  );
  assert.deepEqual(events[1].data.content_block, { type: 'thinking', thinking: '' });
  assert.deepEqual(events[2].data.delta, { type: 'thinking_delta', thinking: 'think' });
  assert.deepEqual(events[4].data.delta, { stop_reason: 'end_turn', stop_sequence: null });
});

test('r2a 流式：response.incomplete 与 response.failed', () => {
  const incomplete = runStream([
    frame('response.created', {
      type: 'response.created',
      response: { id: 'resp_3', model: 'claude-sonnet-4-6', status: 'in_progress' },
    }),
    frame('response.incomplete', {
      type: 'response.incomplete',
      response: {
        id: 'resp_3',
        model: 'claude-sonnet-4-6',
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        usage: { input_tokens: 2, output_tokens: 3 },
      },
    }),
  ].join(''));

  assert.deepEqual(incomplete.events.at(-2).data.delta, {
    stop_reason: 'max_tokens',
    stop_sequence: null,
  });
  assert.deepEqual(incomplete.events.at(-1).event, 'message_stop');
  assert.deepEqual(incomplete.events.at(-2).data.usage, { input_tokens: 2, output_tokens: 3 });

  const failed = runStream([
    frame('response.created', {
      type: 'response.created',
      response: { id: 'resp_4', model: 'claude-sonnet-4-6', status: 'in_progress' },
    }),
    frame('response.failed', {
      type: 'response.failed',
      response: {
        id: 'resp_4',
        model: 'claude-sonnet-4-6',
        status: 'failed',
        error: { code: 'server_error', message: 'boom' },
      },
    }),
  ].join(''));

  assert.equal(failed.events.at(-1).event, 'error');
  assert.deepEqual(failed.events.at(-1).data, {
    type: 'error',
    error: { type: 'server_error', message: 'boom' },
  });
});

test('r2a 流式：EOF 有正文以 max_tokens 收尾，仅有未闭合工具时报错', () => {
  const withText = runStream([
    frame('response.created', {
      type: 'response.created',
      response: { id: 'resp_5', model: 'claude-sonnet-4-6', status: 'in_progress' },
    }),
    frame('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', id: 'msg_5', role: 'assistant', content: [] },
    }),
    frame('response.output_text.delta', {
      type: 'response.output_text.delta',
      item_id: 'msg_5',
      output_index: 0,
      delta: 'partial',
    }),
  ].join(''), 7);

  assert.equal(withText.events.at(-1).event, 'message_stop');
  assert.equal(withText.events.at(-2).event, 'message_delta');
  assert.deepEqual(withText.events.at(-2).data.delta, {
    stop_reason: 'max_tokens',
    stop_sequence: null,
  });
  assert.equal(withText.converter.done, true);

  const withTool = runStream([
    frame('response.created', {
      type: 'response.created',
      response: { id: 'resp_6', model: 'claude-sonnet-4-6', status: 'in_progress' },
    }),
    frame('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', id: 'fc_6', call_id: 'call_6', name: 'lookup', arguments: '' },
    }),
    frame('response.function_call_arguments.delta', {
      type: 'response.function_call_arguments.delta',
      item_id: 'fc_6',
      output_index: 0,
      delta: '{"a":',
    }),
  ].join(''));

  assert.equal(withTool.events.at(-1).event, 'error');
  assert.deepEqual(withTool.events.at(-1).data.error, {
    type: 'stream_truncated',
    message: '上游流在完成前结束',
  });
});
