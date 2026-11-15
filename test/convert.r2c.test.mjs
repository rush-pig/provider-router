import assert from 'node:assert/strict';
import test from 'node:test';

import { ConversionError, ConversionRequestError } from '../src/convert/common/errors.mjs';
import { SSE_DONE, SseParser, formatSseJson } from '../src/convert/common/sse.mjs';
import {
  convertRequest,
  convertResponse,
  createStreamConverter,
} from '../src/convert/directions/r2c.mjs';

function chatChunk(payload) {
  return formatSseJson(payload);
}

function chatDelta({ id = 'chatcmpl-1', created = 1700000000, model = 'gpt-5.1' }, delta, finishReason = null) {
  return chatChunk({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
}

function parseResponsesEvents(text) {
  const parser = new SseParser();
  const events = [...parser.push(text), ...parser.end()];
  return events.map((event) => ({ event: event.event, data: JSON.parse(event.data) }));
}

function collectResponsesEvents(converter, chunks) {
  let output = '';
  for (const chunk of chunks) {
    const frame = converter.push(chunk);
    if (frame !== null) output += frame;
  }
  const tail = converter.end();
  if (tail !== null) output += tail;
  return output === '' ? [] : parseResponsesEvents(output);
}

test('r2c 请求把 instructions 与 Responses input 映射为 Chat messages', () => {
  const { body, stream, warnings } = convertRequest({
    body: {
      model: 'gpt-5.1',
      instructions: 'You are helpful',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'Look' },
            { type: 'input_image', image_url: 'https://example.com/cat.png' },
          ],
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Checking' }],
        },
        { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":1}' },
        { type: 'function_call', call_id: 'call_2', name: 'lookup', arguments: '{"q":2}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'one' },
        {
          type: 'function_call_output',
          call_id: 'call_2',
          output: [{ type: 'input_text', text: 'two' }],
        },
      ],
    },
    model: 'gpt-5.1',
  });

  assert.deepEqual(body.messages, [
    { role: 'system', content: 'You are helpful' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Look' },
        { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
      ],
    },
    {
      role: 'assistant',
      content: 'Checking',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":1}' } },
        { id: 'call_2', type: 'function', function: { name: 'lookup', arguments: '{"q":2}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'one' },
    { role: 'tool', tool_call_id: 'call_2', content: 'two' },
  ]);
  assert.equal(stream, false);
  assert.deepEqual(warnings, []);
});

test('r2c 请求支持字符串 input 与 developer 角色', () => {
  const text = convertRequest({
    body: { model: 'gpt-4.1', input: 'Hello' },
    model: 'gpt-4.1',
  });
  assert.deepEqual(text.body.messages, [{ role: 'user', content: 'Hello' }]);

  const developer = convertRequest({
    body: {
      model: 'gpt-4.1',
      input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'sys' }] },
        { type: 'message', role: 'user', content: 'hi' },
      ],
    },
    model: 'gpt-4.1',
  });
  assert.deepEqual(developer.body.messages, [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
  ]);
});

test('r2c 请求丢弃 reasoning item 与不支持的 input item', () => {
  const { body, warnings } = convertRequest({
    body: {
      model: 'gpt-5.1',
      input: [
        { type: 'reasoning', id: 'rs_1', summary: [] },
        { type: 'item_reference', id: 'ref_1' },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      ],
    },
    model: 'gpt-5.1',
  });

  assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
  assert.deepEqual(warnings, [
    { code: 'reasoning_dropped', field: 'input' },
    { code: 'unsupported_input_item', field: 'input' },
  ]);
});

test('r2c 请求把 Responses tools 嵌套为 Chat function 工具', () => {
  const { body } = convertRequest({
    body: {
      model: 'gpt-4.1',
      input: 'hi',
      tools: [{
        type: 'function',
        name: 'lookup',
        description: 'Find a record',
        parameters: {
          properties: { q: { type: 'string', format: 'uri' } },
          required: ['q'],
        },
        strict: true,
      }],
      tool_choice: { type: 'function', name: 'lookup' },
    },
    model: 'gpt-4.1',
  });

  assert.deepEqual(body.tools, [{
    type: 'function',
    function: {
      name: 'lookup',
      description: 'Find a record',
      parameters: {
        type: 'object',
        properties: { q: { type: 'string' } },
        required: ['q'],
      },
    },
  }]);
  assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'lookup' } });
});

test('r2c 请求没有 tools 时删除 tool_choice', () => {
  const { body } = convertRequest({
    body: { model: 'gpt-4.1', input: 'hi', tool_choice: 'required' },
    model: 'gpt-4.1',
  });

  assert.equal('tools' in body, false);
  assert.equal('tool_choice' in body, false);
});

test('r2c 请求按模型家族映射 max_output_tokens', () => {
  const standard = convertRequest({
    body: { model: 'gpt-4.1', input: 'hi', max_output_tokens: 128 },
    model: 'gpt-4.1',
  });
  assert.equal(standard.body.max_tokens, 128);
  assert.equal('max_completion_tokens' in standard.body, false);

  const oSeries = convertRequest({
    body: { model: 'o3-mini', input: 'hi', max_output_tokens: 256 },
    model: 'o3-mini',
  });
  assert.equal(oSeries.body.max_completion_tokens, 256);
  assert.equal('max_tokens' in oSeries.body, false);
});

test('r2c 请求按模型能力把 reasoning.effort 映射为 reasoning_effort', () => {
  const supported = convertRequest({
    body: { model: 'gpt-5.1', input: 'hi', reasoning: { effort: 'medium' } },
    model: 'gpt-5.1',
  });
  assert.equal(supported.body.reasoning_effort, 'medium');

  const clamped = convertRequest({
    body: { model: 'gpt-5-pro', input: 'hi', reasoning: { effort: 'low' } },
    model: 'gpt-5-pro',
  });
  assert.equal(clamped.body.reasoning_effort, 'high');

  const unsupported = convertRequest({
    body: { model: 'gpt-4o', input: 'hi', reasoning: { effort: 'high' } },
    model: 'gpt-4o',
  });
  assert.equal('reasoning_effort' in unsupported.body, false);
  assert.deepEqual(unsupported.warnings, [
    { code: 'unsupported_reasoning_effort', field: 'reasoning.effort' },
  ]);
});

test('r2c 请求透传 cc-switch 字段并在流式时注入 include_usage', () => {
  const { body, stream, warnings } = convertRequest({
    body: {
      model: 'gpt-4.1',
      input: 'hi',
      stream: true,
      stream_options: { foo: 'bar' },
      temperature: 0.2,
      top_p: 0.8,
      frequency_penalty: 0.1,
      logit_bias: { '1': 1 },
      logprobs: true,
      metadata: { a: 'b' },
      n: 2,
      parallel_tool_calls: false,
      presence_penalty: 0.3,
      response_format: { type: 'json_object' },
      seed: 7,
      service_tier: 'auto',
      stop: ['END'],
      top_logprobs: 2,
      user: 'u1',
    },
    model: 'gpt-4.1',
  });

  assert.equal(stream, true);
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { foo: 'bar', include_usage: true });
  assert.equal(body.temperature, 0.2);
  assert.equal(body.top_p, 0.8);
  for (const field of ['frequency_penalty', 'logit_bias', 'logprobs', 'metadata', 'n',
    'parallel_tool_calls', 'presence_penalty', 'response_format', 'seed', 'service_tier',
    'stop', 'top_logprobs', 'user']) {
    assert.deepEqual(body[field], {
      frequency_penalty: 0.1,
      logit_bias: { '1': 1 },
      logprobs: true,
      metadata: { a: 'b' },
      n: 2,
      parallel_tool_calls: false,
      presence_penalty: 0.3,
      response_format: { type: 'json_object' },
      seed: 7,
      service_tier: 'auto',
      stop: ['END'],
      top_logprobs: 2,
      user: 'u1',
    }[field]);
  }
  assert.deepEqual(warnings, []);
});

test('r2c 请求非流式时原样透传 stream_options', () => {
  const { body } = convertRequest({
    body: { model: 'gpt-4.1', input: 'hi', stream_options: { include_usage: false } },
    model: 'gpt-4.1',
  });
  assert.deepEqual(body.stream_options, { include_usage: false });
});

test('r2c 请求丢弃 previous_response_id 与 store 并给出 warning', () => {
  const { body, warnings } = convertRequest({
    body: {
      model: 'gpt-5.1',
      input: 'hi',
      previous_response_id: 'resp_0',
      store: false,
    },
    model: 'gpt-5.1',
  });

  assert.equal('previous_response_id' in body, false);
  assert.equal('store' in body, false);
  assert.deepEqual(warnings, [
    { code: 'dropped_field', field: 'previous_response_id' },
    { code: 'dropped_field', field: 'store' },
  ]);
});

test('r2c 请求 input 非法时抛 400', () => {
  assert.throws(
    () => convertRequest({ body: { model: 'gpt-4.1' }, model: 'gpt-4.1' }),
    (error) => error instanceof ConversionRequestError && error.status === 400,
  );
  assert.throws(
    () => convertRequest({ body: { model: 'gpt-4.1', input: {} }, model: 'gpt-4.1' }),
    (error) => error instanceof ConversionRequestError && error.status === 400,
  );
  assert.throws(
    () => convertRequest({ body: { model: 'gpt-4.1', input: [] }, model: 'gpt-4.1' }),
    (error) => error instanceof ConversionRequestError && error.status === 400,
  );
});

test('r2c 非流式响应把 Chat completion 转换为 Responses 对象', () => {
  const { body, warnings } = convertResponse({
    body: {
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 1700000000,
      model: 'gpt-5.1',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'Hello world' },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 150,
        completion_tokens: 20,
        total_tokens: 170,
        prompt_tokens_details: { cached_tokens: 100 },
      },
    },
    request: { model: 'gpt-5.1' },
  });

  assert.deepEqual(body, {
    id: 'chatcmpl-1',
    object: 'response',
    created_at: 1700000000,
    model: 'gpt-5.1',
    status: 'completed',
    output: [{
      type: 'message',
      id: 'msg_0',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Hello world', annotations: [] }],
    }],
    usage: {
      input_tokens: 150,
      output_tokens: 20,
      total_tokens: 170,
      input_tokens_details: { cached_tokens: 100 },
    },
  });
  assert.deepEqual(warnings, []);
});

test('r2c 非流式响应把 tool_calls 转换为 function_call items', () => {
  const { body } = convertResponse({
    body: {
      id: 'chatcmpl-2',
      created: 1700000001,
      model: 'gpt-5.1',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'lookup', arguments: '{"q":1}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    },
    request: { model: 'gpt-5.1' },
  });

  assert.equal(body.status, 'completed');
  assert.deepEqual(body.output, [{
    type: 'function_call',
    id: 'fc_0',
    call_id: 'call_1',
    name: 'lookup',
    arguments: '{"q":1}',
    status: 'completed',
  }]);
});

test('r2c 非流式响应把 length 映射为 incomplete', () => {
  const { body } = convertResponse({
    body: {
      id: 'chatcmpl-3',
      created: 1700000002,
      model: 'gpt-5.1',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'cut' },
        finish_reason: 'length',
      }],
    },
    request: { model: 'gpt-5.1' },
  });

  assert.equal(body.status, 'incomplete');
  assert.deepEqual(body.incomplete_details, { reason: 'max_output_tokens' });
});

test('r2c 非流式响应丢弃 reasoning_content 并给出 warning', () => {
  const { body, warnings } = convertResponse({
    body: {
      id: 'chatcmpl-4',
      created: 1700000003,
      model: 'deepseek-r1',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'answer',
          reasoning_content: 'thinking',
        },
        finish_reason: 'stop',
      }],
    },
    request: { model: 'deepseek-r1' },
  });

  assert.deepEqual(warnings, [{ code: 'reasoning_content_dropped', field: 'choices' }]);
  assert.equal(body.output[0].content[0].text, 'answer');
});

test('r2c 非流式响应空 choices 抛 422', () => {
  assert.throws(
    () => convertResponse({ body: { choices: [] }, request: {} }),
    (error) => error instanceof ConversionError && error.status === 422,
  );
  assert.throws(
    () => convertResponse({ body: null, request: {} }),
    (error) => error instanceof ConversionError && error.status === 422,
  );
});

test('r2c 流式响应输出 created、文本增量与 completed 事件', () => {
  const converter = createStreamConverter({ request: { model: 'gpt-5.1' } });
  const events = collectResponsesEvents(converter, [
    chatChunk({
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      created: 1700000000,
      model: 'gpt-5.1',
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    }),
    chatDelta({}, { content: 'Hel' }),
    chatDelta({}, { content: 'lo' }),
    chatDelta({}, {}, 'stop'),
    chatChunk({
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      created: 1700000000,
      model: 'gpt-5.1',
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    }),
    SSE_DONE,
  ]);

  assert.deepEqual(events.map((event) => event.event), [
    'response.created',
    'response.in_progress',
    'response.output_item.added',
    'response.content_part.added',
    'response.output_text.delta',
    'response.output_text.delta',
    'response.output_text.done',
    'response.content_part.done',
    'response.output_item.done',
    'response.completed',
  ]);
  assert.deepEqual(
    events.map((event) => event.data.sequence_number),
    events.map((_, index) => index),
  );
  for (const event of events) assert.equal(event.data.type, event.event);

  const created = events[0].data.response;
  assert.equal(created.id, 'chatcmpl-1');
  assert.equal(created.object, 'response');
  assert.equal(created.created_at, 1700000000);
  assert.equal(created.model, 'gpt-5.1');
  assert.equal(created.status, 'in_progress');
  assert.deepEqual(created.output, []);
  assert.deepEqual(created.usage, { input_tokens: 0, output_tokens: 0, total_tokens: 0 });

  assert.deepEqual(events[2].data.item, {
    type: 'message',
    id: 'msg_0',
    status: 'in_progress',
    role: 'assistant',
    content: [],
  });
  assert.equal(events[2].data.output_index, 0);
  assert.equal(events[4].data.delta, 'Hel');
  assert.equal(events[5].data.delta, 'lo');
  assert.equal(events[6].data.text, 'Hello');
  assert.equal(events[8].data.item.status, 'completed');

  const completed = events[9].data.response;
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.output, [{
    type: 'message',
    id: 'msg_0',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'Hello', annotations: [] }],
  }]);
  assert.deepEqual(completed.usage, {
    input_tokens: 10,
    output_tokens: 2,
    total_tokens: 12,
  });
  assert.equal(converter.done, true);
  assert.equal(converter.end(), null);
});

test('r2c 流式响应按 index 输出工具调用并分片 arguments', () => {
  const converter = createStreamConverter({ request: { model: 'gpt-5.1' } });
  const events = collectResponsesEvents(converter, [
    chatDelta({}, { role: 'assistant', content: '' }),
    chatDelta({}, { content: 'Using tool' }),
    chatDelta({}, {
      tool_calls: [{
        index: 0,
        id: 'call_1',
        type: 'function',
        function: { name: 'lookup', arguments: '' },
      }],
    }),
    chatDelta({}, { tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] }),
    chatDelta({}, { tool_calls: [{ index: 0, function: { arguments: '1}' } }] }),
    chatDelta({}, {}, 'tool_calls'),
    chatChunk({
      id: 'chatcmpl-1',
      created: 1700000000,
      model: 'gpt-5.1',
      choices: [],
      usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
    }),
    SSE_DONE,
  ]);

  const types = events.map((event) => event.event);
  assert.deepEqual(types, [
    'response.created',
    'response.in_progress',
    'response.output_item.added',
    'response.content_part.added',
    'response.output_text.delta',
    'response.output_item.added',
    'response.function_call_arguments.delta',
    'response.function_call_arguments.delta',
    'response.output_text.done',
    'response.content_part.done',
    'response.output_item.done',
    'response.function_call_arguments.done',
    'response.output_item.done',
    'response.completed',
  ]);

  const toolAdded = events[5].data;
  assert.equal(toolAdded.output_index, 1);
  assert.deepEqual(toolAdded.item, {
    type: 'function_call',
    id: 'fc_1',
    call_id: 'call_1',
    name: 'lookup',
    arguments: '',
    status: 'in_progress',
  });
  assert.deepEqual(
    events.slice(6, 8).map((event) => event.data.delta),
    ['{"q":', '1}'],
  );
  assert.equal(events[11].data.arguments, '{"q":1}');
  assert.deepEqual(events[12].data.item, {
    type: 'function_call',
    id: 'fc_1',
    call_id: 'call_1',
    name: 'lookup',
    arguments: '{"q":1}',
    status: 'completed',
  });

  const completed = events[13].data.response;
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.output.map((item) => item.type), ['message', 'function_call']);
  assert.deepEqual(completed.usage, {
    input_tokens: 20,
    output_tokens: 8,
    total_tokens: 28,
  });
});

test('r2c 流式 finish_reason length 输出 incomplete', () => {
  const events = collectResponsesEvents(createStreamConverter({ request: {} }), [
    chatDelta({}, { content: 'cut' }),
    chatDelta({}, {}, 'length'),
    SSE_DONE,
  ]);

  const terminal = events.at(-1);
  assert.equal(terminal.event, 'response.incomplete');
  assert.equal(terminal.data.response.status, 'incomplete');
  assert.deepEqual(terminal.data.response.incomplete_details, {
    reason: 'max_output_tokens',
  });
  assert.equal(terminal.data.response.output[0].content[0].text, 'cut');
});

test('r2c 流式重复 finish 只关闭一次并只输出一个终止事件', () => {
  const events = collectResponsesEvents(createStreamConverter({ request: {} }), [
    chatDelta({}, { content: 'a' }),
    chatDelta({}, {}, 'stop'),
    chatDelta({}, {}, 'stop'),
    chatDelta({}, { content: 'late' }),
    SSE_DONE,
  ]);

  assert.equal(events.filter((event) => event.event === 'response.output_text.done').length, 1);
  assert.equal(events.filter((event) => event.event === 'response.completed').length, 1);
  assert.equal(events.at(-1).data.response.output[0].content[0].text, 'a');
});

test('r2c 流式消费 finish chunk 自带的 usage', () => {
  const chunk = chatChunk({
    id: 'chatcmpl-1',
    created: 1700000000,
    model: 'gpt-5.1',
    choices: [{ index: 0, delta: { content: 'x' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
  });
  const events = collectResponsesEvents(createStreamConverter({ request: {} }), [
    chunk,
    SSE_DONE,
  ]);

  assert.deepEqual(events.at(-1).data.response.usage, {
    input_tokens: 5,
    output_tokens: 1,
    total_tokens: 6,
  });
});

test('r2c 流式 EOF 无 finish 时有正文输出 incomplete', () => {
  const converter = createStreamConverter({ request: {} });
  const events = collectResponsesEvents(converter, [chatDelta({}, { content: 'partial' })]);

  const terminal = events.at(-1);
  assert.equal(terminal.event, 'response.incomplete');
  assert.equal(terminal.data.response.output[0].content[0].text, 'partial');
  assert.equal(converter.done, true);
});

test('r2c 流式 EOF 无正文输出 stream_truncated 失败', () => {
  const events = collectResponsesEvents(createStreamConverter({ request: {} }), [
    chatDelta({}, { role: 'assistant', content: '' }),
  ]);

  const terminal = events.at(-1);
  assert.equal(terminal.event, 'response.failed');
  assert.equal(terminal.data.response.status, 'failed');
  assert.deepEqual(terminal.data.response.error, {
    code: 'stream_truncated',
    message: '上游流在完成前意外结束',
  });
});

test('r2c 流式 DONE 之后停止处理', () => {
  const converter = createStreamConverter({ request: {} });
  collectResponsesEvents(converter, [chatDelta({}, { content: 'x' }), SSE_DONE]);

  assert.equal(converter.done, true);
  assert.equal(converter.push(chatDelta({}, { content: 'late' })), null);
  assert.equal(converter.end(), null);
});

test('r2c 流式解析跨任意字节边界稳定', () => {
  const upstream = [
    chatDelta({}, { role: 'assistant', content: '' }),
    chatDelta({}, { content: '你好🙂' }),
    chatDelta({}, {}, 'stop'),
    chatChunk({
      id: 'chatcmpl-1',
      created: 1700000000,
      model: 'gpt-5.1',
      choices: [],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }),
    SSE_DONE,
  ].join('');
  const byteChunks = Array.from(Buffer.from(upstream, 'utf8'), (byte) => Buffer.from([byte]));
  const events = collectResponsesEvents(createStreamConverter({ request: {} }), byteChunks);

  assert.equal(
    events.find((event) => event.event === 'response.output_text.delta').data.delta,
    '你好🙂',
  );
  assert.deepEqual(events.at(-1).data.response.usage, {
    input_tokens: 3,
    output_tokens: 2,
    total_tokens: 5,
  });
});

test('r2c 流式丢弃 reasoning_content 增量并给出 warning', () => {
  const converter = createStreamConverter({ request: {} });
  const events = collectResponsesEvents(converter, [
    chatDelta({}, { role: 'assistant', content: '', reasoning_content: 'secret' }),
    chatDelta({}, {}, 'stop'),
    SSE_DONE,
  ]);

  assert.deepEqual(converter.warnings, [{ code: 'reasoning_dropped', field: 'choices' }]);
  assert.equal(events.some((event) => event.event === 'response.output_text.delta'), false);
  assert.equal(events.at(-1).event, 'response.completed');
});
