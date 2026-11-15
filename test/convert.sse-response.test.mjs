import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversionError } from '../src/convert/common/errors.mjs';
import {
  SSE_DONE,
  SseParser,
  formatSseEvent,
  formatSseJson,
} from '../src/convert/common/sse.mjs';
import { aggregateSse, synthesizeSse } from '../src/convert/common/sse-response.mjs';

function parseFrames(text) {
  const parser = new SseParser();
  return [...parser.push(text), ...parser.end()];
}

function parseFrame(frame) {
  return JSON.parse(parseFrames(frame)[0].data);
}

function isConversionError(error) {
  return error instanceof ConversionError && error.status === 422;
}

function responsesFrame(event, payload) {
  return formatSseEvent({ event, data: JSON.stringify(payload) });
}

const ANTHROPIC_RESPONSE = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-4-5',
  content: [
    { type: 'text', text: 'Hello' },
    { type: 'thinking', thinking: 'Need a tool', signature: 'sig-1' },
    { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } },
  ],
  stop_reason: 'tool_use',
  stop_sequence: null,
  usage: { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 5 },
};

test('Anthropic 合成 SSE 的事件顺序与 message_start 基线', () => {
  const frames = synthesizeSse({ protocol: 'anthropic', response: ANTHROPIC_RESPONSE });
  const events = parseFrames(frames.join(''));

  assert.deepEqual(events.map((event) => event.event), [
    'message_start',
    'content_block_start', 'content_block_delta', 'content_block_stop',
    'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop',
    'content_block_start', 'content_block_delta', 'content_block_stop',
    'message_delta',
    'message_stop',
  ]);

  const messageStart = JSON.parse(events[0].data);
  assert.equal(messageStart.type, 'message_start');
  assert.equal(messageStart.message.id, 'msg_1');
  assert.deepEqual(messageStart.message.content, []);
  assert.equal(messageStart.message.stop_reason, 'tool_use');
  assert.deepEqual(messageStart.message.usage, ANTHROPIC_RESPONSE.usage);
});

test('Anthropic SSE 可聚合还原文本、tool_use 与 thinking/signature', () => {
  const frames = synthesizeSse({ protocol: 'anthropic', response: ANTHROPIC_RESPONSE });
  assert.equal(frames.every((frame) => frame.startsWith('event: ')), true);

  const restored = aggregateSse({ protocol: 'anthropic', text: frames.join('') });
  assert.deepEqual(restored, ANTHROPIC_RESPONSE);
});

test('Anthropic 残帧（缺少末尾空行）仍可聚合', () => {
  const frames = synthesizeSse({ protocol: 'anthropic', response: ANTHROPIC_RESPONSE });
  const text = frames.join('').replace(/\n\n$/, '');

  assert.deepEqual(aggregateSse({ protocol: 'anthropic', text }), ANTHROPIC_RESPONSE);
});

const OPENAI_TOOL_RESPONSE = {
  id: 'chatcmpl_1',
  object: 'chat.completion',
  created: 1700000000,
  model: 'gpt-5',
  choices: [{
    index: 0,
    message: {
      role: 'assistant',
      content: null,
      reasoning_content: 'Need a tool',
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
      }],
    },
    finish_reason: 'tool_calls',
  }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

test('OpenAI Chat 工具调用响应合成 chunk 后以 [DONE] 结束并可还原', () => {
  const frames = synthesizeSse({ protocol: 'openai', response: OPENAI_TOOL_RESPONSE });

  assert.equal(frames.length, 2);
  assert.equal(frames[1], SSE_DONE);

  const chunk = parseFrame(frames[0]);
  assert.equal(chunk.object, 'chat.completion.chunk');
  assert.equal(chunk.choices[0].delta.content, null);
  assert.equal(chunk.choices[0].delta.reasoning_content, 'Need a tool');
  assert.equal(chunk.choices[0].delta.tool_calls[0].index, 0);
  assert.equal(chunk.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(chunk.usage, OPENAI_TOOL_RESPONSE.usage);

  const restored = aggregateSse({ protocol: 'openai', text: frames.join('') });
  assert.deepEqual(restored, OPENAI_TOOL_RESPONSE);
});

test('OpenAI Chat 文本响应往返保留内容与 usage', () => {
  const original = {
    id: 'chatcmpl_2',
    object: 'chat.completion',
    created: 1700000001,
    model: 'gpt-5',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: 'Hi there' },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  };

  const frames = synthesizeSse({ protocol: 'openai', response: original });
  assert.deepEqual(aggregateSse({ protocol: 'openai', text: frames.join('') }), original);
});

test('OpenAI Chat content 为空且无 tool_calls 时 delta.content 为 null', () => {
  const frames = synthesizeSse({
    protocol: 'openai',
    response: {
      id: 'chatcmpl_3',
      model: 'gpt-5',
      created: 1700000002,
      choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
      usage: null,
    },
  });

  assert.equal(parseFrame(frames[0]).choices[0].delta.content, null);
});

const RESPONSES_RESPONSE = {
  id: 'resp_1',
  object: 'response',
  created_at: 1700000000,
  model: 'gpt-5',
  status: 'completed',
  output: [
    {
      type: 'message',
      id: 'msg_1',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Hello', annotations: [] }],
    },
    {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_1',
      name: 'get_weather',
      arguments: '{"city":"Paris"}',
      status: 'completed',
    },
  ],
  usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
};

test('Responses 合成 SSE 的 sequence_number 连续且 created 使用零值 usage', () => {
  const frames = synthesizeSse({ protocol: 'openai-responses', response: RESPONSES_RESPONSE });
  const events = parseFrames(frames.join(''));

  assert.deepEqual(
    events.map((event) => JSON.parse(event.data).sequence_number),
    events.map((_, index) => index),
  );
  assert.deepEqual(events.map((event) => event.event), [
    'response.created',
    'response.output_item.added',
    'response.content_part.added', 'response.output_text.done', 'response.content_part.done',
    'response.output_item.done',
    'response.output_item.added',
    'response.function_call_arguments.done',
    'response.output_item.done',
    'response.completed',
  ]);

  const created = JSON.parse(events[0].data);
  assert.equal(created.response.status, 'in_progress');
  assert.deepEqual(created.response.output, []);
  assert.equal(created.response.usage.input_tokens, 0);
  assert.equal(created.response.usage.output_tokens, 0);
  assert.equal(created.response.usage.total_tokens, 0);
});

test('Responses SSE 可聚合还原 message + function_call', () => {
  const frames = synthesizeSse({ protocol: 'openai-responses', response: RESPONSES_RESPONSE });
  assert.deepEqual(
    aggregateSse({ protocol: 'openai-responses', text: frames.join('') }),
    RESPONSES_RESPONSE,
  );
});

test('Responses incomplete 状态合成 response.incomplete 并保留 incomplete_details', () => {
  const original = {
    id: 'resp_2',
    object: 'response',
    created_at: 1700000001,
    model: 'gpt-5',
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
    output: [{
      type: 'message',
      id: 'msg_2',
      status: 'incomplete',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'partial', annotations: [] }],
    }],
    usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
  };

  const frames = synthesizeSse({ protocol: 'openai-responses', response: original });
  const events = parseFrames(frames.join(''));
  const lastEvent = events.at(-1);
  assert.equal(lastEvent.event, 'response.incomplete');
  assert.equal(JSON.parse(lastEvent.data).response.status, 'incomplete');

  assert.deepEqual(
    aggregateSse({ protocol: 'openai-responses', text: frames.join('') }),
    original,
  );
});

test('Responses 缺少完成事件时按增量事件还原 output', () => {
  const frames = [
    responsesFrame('response.created', {
      type: 'response.created',
      response: {
        id: 'resp_3',
        object: 'response',
        created_at: 1700000002,
        model: 'gpt-5',
        status: 'in_progress',
        output: [],
        usage: { input_tokens: 5, output_tokens: 0, total_tokens: 5 },
      },
      sequence_number: 0,
    }),
    responsesFrame('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        type: 'message',
        id: 'msg_3',
        role: 'assistant',
        status: 'in_progress',
        content: [],
      },
      sequence_number: 1,
    }),
    responsesFrame('response.output_text.done', {
      type: 'response.output_text.done',
      item_id: 'msg_3',
      output_index: 0,
      content_index: 0,
      text: 'Hello',
      sequence_number: 2,
    }),
    responsesFrame('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 1,
      item: {
        type: 'function_call',
        id: 'fc_3',
        call_id: 'call_3',
        name: 'lookup',
        arguments: '',
        status: 'in_progress',
      },
      sequence_number: 3,
    }),
    responsesFrame('response.function_call_arguments.done', {
      type: 'response.function_call_arguments.done',
      item_id: 'fc_3',
      output_index: 1,
      arguments: '{"q":1}',
      sequence_number: 4,
    }),
    responsesFrame('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 1,
      item: {
        type: 'function_call',
        id: 'fc_3',
        call_id: 'call_3',
        name: 'lookup',
        arguments: '{"q":1}',
        status: 'completed',
      },
      sequence_number: 5,
    }),
  ];

  const restored = aggregateSse({ protocol: 'openai-responses', text: frames.join('') });
  assert.equal(restored.status, 'completed');
  assert.equal(restored.id, 'resp_3');
  assert.deepEqual(restored.output, [
    {
      type: 'message',
      id: 'msg_3',
      role: 'assistant',
      status: 'in_progress',
      content: [{ type: 'output_text', text: 'Hello', annotations: [] }],
    },
    {
      type: 'function_call',
      id: 'fc_3',
      call_id: 'call_3',
      name: 'lookup',
      arguments: '{"q":1}',
      status: 'completed',
    },
  ]);
});

test('OpenAI 聚合忽略 [DONE]，usage-only chunk 只合并 usage', () => {
  const text = [
    SSE_DONE,
    formatSseJson({
      id: 'chatcmpl_9',
      object: 'chat.completion.chunk',
      created: 1700000003,
      model: 'gpt-5',
      choices: [],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    }),
    SSE_DONE,
  ].join('');

  const restored = aggregateSse({ protocol: 'openai', text });
  assert.equal(restored.id, 'chatcmpl_9');
  assert.equal(restored.choices[0].message.content, null);
  assert.equal(restored.choices[0].finish_reason, null);
  assert.deepEqual(restored.usage, { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
});

test('OpenAI 聚合冲刷没有空行收尾的残帧', () => {
  const text = 'data: {"id":"chatcmpl_8","choices":[{"index":0,"delta":{"content":"tail"}}]}';

  assert.equal(
    aggregateSse({ protocol: 'openai', text }).choices[0].message.content,
    'tail',
  );
});

test('空输入、注释流与仅 [DONE] 抛 422 ConversionError', () => {
  for (const protocol of ['anthropic', 'openai', 'openai-responses']) {
    assert.throws(() => aggregateSse({ protocol, text: '' }), isConversionError);
    assert.throws(() => aggregateSse({ protocol, text: ': heartbeat\n\n' }), isConversionError);
  }
  assert.throws(
    () => aggregateSse({ protocol: 'openai', text: SSE_DONE }),
    isConversionError,
  );
});

test('未知协议与非法响应体抛 ConversionError', () => {
  assert.throws(
    () => synthesizeSse({ protocol: 'gemini', response: {} }),
    isConversionError,
  );
  assert.throws(
    () => aggregateSse({ protocol: 'gemini', text: '' }),
    isConversionError,
  );
  assert.throws(
    () => synthesizeSse({ protocol: 'openai', response: null }),
    isConversionError,
  );
});
