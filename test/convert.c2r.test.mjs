import assert from 'node:assert/strict';
import test from 'node:test';

import { ConversionError, ConversionRequestError } from '../src/convert/common/errors.mjs';
import { SSE_DONE, SseParser, formatSseEvent } from '../src/convert/common/sse.mjs';
import {
  convertRequest,
  convertResponse,
  createStreamConverter,
} from '../src/convert/directions/c2r.mjs';

function responsesEvent(type, payload) {
  return formatSseEvent({ event: type, data: JSON.stringify({ type, ...payload }) });
}

function parseChatFrames(text) {
  const parser = new SseParser();
  const events = [...parser.push(text), ...parser.end()];
  return events.map((event) => (event.data === '[DONE]' ? '[DONE]' : JSON.parse(event.data)));
}

function collectChatChunks(converter, chunks) {
  let output = '';
  for (const chunk of chunks) {
    const frame = converter.push(chunk);
    if (frame !== null) output += frame;
  }
  const tail = converter.end();
  if (tail !== null) output += tail;
  return { output, chunks: output === '' ? [] : parseChatFrames(output) };
}

test('c2r 请求合并 system/developer 为 instructions', () => {
  const { body, stream, warnings } = convertRequest({
    body: {
      model: 'gpt-5.1',
      messages: [
        { role: 'system', content: 'You are helpful' },
        { role: 'developer', content: [{ type: 'text', text: 'Be terse' }] },
        { role: 'user', content: 'Hi' },
      ],
    },
    model: 'gpt-5.1',
  });

  assert.equal(body.instructions, 'You are helpful\n\nBe terse');
  assert.deepEqual(body.input, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hi' }] },
  ]);
  assert.equal(body.store, undefined);
  assert.equal(body.prompt_cache_key, undefined);
  assert.equal(stream, false);
  assert.deepEqual(warnings, []);
});

test('c2r 请求映射图片、assistant 工具调用与 tool 输出', () => {
  const { body } = convertRequest({
    body: {
      model: 'gpt-4.1',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe' },
            { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
          ],
        },
        {
          role: 'assistant',
          content: 'Calling',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'lookup', arguments: '{"q":"cat"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'found' },
      ],
    },
    model: 'gpt-4.1',
  });

  assert.deepEqual(body.input, [
    {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'Describe' },
        { type: 'input_image', image_url: 'https://example.com/cat.png' },
      ],
    },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Calling' }] },
    { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":"cat"}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'found' },
  ]);
});

test('c2r 请求丢弃 reasoning_content 并给出 warning', () => {
  const { body, warnings } = convertRequest({
    body: {
      model: 'deepseek-r1',
      messages: [{ role: 'assistant', content: 'answer', reasoning_content: 'thinking' }],
    },
    model: 'deepseek-r1',
  });

  assert.deepEqual(warnings, [{ code: 'reasoning_content_dropped', field: 'messages' }]);
  assert.deepEqual(body.input, [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
  ]);
});

test('c2r 请求扁平化 tools 并映射 tool_choice', () => {
  const { body } = convertRequest({
    body: {
      model: 'gpt-4.1',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'lookup',
            description: 'Find a record',
            parameters: {
              type: 'object',
              properties: { q: { type: 'string', format: 'uri' } },
              required: ['q'],
            },
            strict: true,
          },
        },
        { type: 'function', function: { name: 'noargs' } },
      ],
      tool_choice: { type: 'function', function: { name: 'lookup' } },
    },
    model: 'gpt-4.1',
  });

  assert.deepEqual(body.tools, [
    {
      type: 'function',
      name: 'lookup',
      description: 'Find a record',
      parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      strict: false,
    },
    {
      type: 'function',
      name: 'noargs',
      parameters: { type: 'object', properties: {} },
      strict: false,
    },
  ]);
  assert.deepEqual(body.tool_choice, { type: 'function', name: 'lookup' });
});

test('c2r 请求没有 tools 时删除 tool_choice', () => {
  const { body } = convertRequest({
    body: {
      model: 'gpt-4.1',
      messages: [{ role: 'user', content: 'hi' }],
      tool_choice: 'required',
    },
    model: 'gpt-4.1',
  });

  assert.equal('tools' in body, false);
  assert.equal('tool_choice' in body, false);
});

test('c2r 请求映射 max_tokens 并抬升到最小值', () => {
  const small = convertRequest({
    body: { model: 'gpt-4.1', messages: [{ role: 'user', content: 'hi' }], max_tokens: 4 },
    model: 'gpt-4.1',
  });
  assert.equal(small.body.max_output_tokens, 16);

  const preferred = convertRequest({
    body: {
      model: 'gpt-4.1',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 50,
      max_completion_tokens: 100,
    },
    model: 'gpt-4.1',
  });
  assert.equal(preferred.body.max_output_tokens, 100);
});

test('c2r 请求按模型能力写 reasoning.effort', () => {
  const supported = convertRequest({
    body: { model: 'gpt-5.2', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'low' },
    model: 'gpt-5.2',
  });
  assert.deepEqual(supported.body.reasoning, { effort: 'low' });

  const clamped = convertRequest({
    body: { model: 'gpt-5-pro', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'low' },
    model: 'gpt-5-pro',
  });
  assert.deepEqual(clamped.body.reasoning, { effort: 'high' });

  const unsupported = convertRequest({
    body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'high' },
    model: 'gpt-4o',
  });
  assert.equal('reasoning' in unsupported.body, false);
  assert.deepEqual(unsupported.warnings, [
    { code: 'unsupported_reasoning_effort', field: 'reasoning_effort' },
  ]);
});

test('c2r 请求透传采样字段并对丢弃字段给出 warning', () => {
  const { body, stream, warnings } = convertRequest({
    body: {
      model: 'gpt-4.1',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0,
      top_p: 0.9,
      stream: true,
      metadata: { user_id: 'u1' },
      n: 2,
      seed: 7,
      response_format: { type: 'json_object' },
      logprobs: true,
      service_tier: 'auto',
      presence_penalty: 0,
      frequency_penalty: 0,
      user: 'u1',
    },
    model: 'gpt-4.1',
  });

  assert.equal(body.temperature, 0);
  assert.equal(body.top_p, 0.9);
  assert.equal(body.stream, true);
  assert.deepEqual(body.metadata, { user_id: 'u1' });
  assert.equal(stream, true);
  for (const field of ['n', 'seed', 'response_format', 'logprobs', 'service_tier',
    'presence_penalty', 'frequency_penalty', 'user']) {
    assert.equal(field in body, false);
  }
  assert.deepEqual(warnings, [
    { code: 'dropped_field', field: 'n' },
    { code: 'dropped_field', field: 'seed' },
    { code: 'dropped_field', field: 'response_format' },
    { code: 'dropped_field', field: 'logprobs' },
    { code: 'dropped_field', field: 'service_tier' },
    { code: 'dropped_field', field: 'presence_penalty' },
    { code: 'dropped_field', field: 'frequency_penalty' },
    { code: 'dropped_field', field: 'user' },
  ]);
});

test('c2r 请求形状非法时抛 400', () => {
  assert.throws(
    () => convertRequest({ body: { model: 'gpt-4.1', messages: 'hi' }, model: 'gpt-4.1' }),
    (error) => error instanceof ConversionRequestError && error.status === 400,
  );
  assert.throws(
    () => convertRequest({ body: null, model: 'gpt-4.1' }),
    (error) => error instanceof ConversionRequestError && error.status === 400,
  );
});

test('c2r 非流式响应合并文本并映射 usage', () => {
  const { body, warnings } = convertResponse({
    body: {
      id: 'resp_1',
      created_at: 1700000000,
      model: 'gpt-5.1',
      status: 'completed',
      output: [
        {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          content: [
            { type: 'output_text', text: 'Hello' },
            { type: 'text', text: ' world' },
          ],
        },
      ],
      usage: {
        input_tokens: 150,
        output_tokens: 20,
        total_tokens: 170,
        input_tokens_details: { cached_tokens: 100 },
      },
    },
    request: { model: 'gpt-5.1' },
  });

  assert.deepEqual(body, {
    id: 'resp_1',
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
  });
  assert.deepEqual(warnings, []);
});

test('c2r 非流式响应把 function_call 映射为 tool_calls', () => {
  const { body } = convertResponse({
    body: {
      id: 'resp_2',
      created_at: 1700000001,
      model: 'gpt-5.1',
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Checking' }],
        },
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_9',
          name: 'lookup',
          arguments: '{"q":1}',
          status: 'completed',
        },
      ],
    },
    request: { model: 'gpt-5.1' },
  });

  assert.deepEqual(body.choices[0].message, {
    role: 'assistant',
    content: 'Checking',
    tool_calls: [{
      id: 'call_9',
      type: 'function',
      function: { name: 'lookup', arguments: '{"q":1}' },
    }],
  });
  assert.equal(body.choices[0].finish_reason, 'tool_calls');
});

test('c2r 非流式响应把 incomplete 映射为 length', () => {
  const { body } = convertResponse({
    body: {
      id: 'resp_3',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'cut' }] }],
    },
    request: { model: 'gpt-5.1' },
  });

  assert.equal(body.choices[0].finish_reason, 'length');
  assert.equal(body.choices[0].message.content, 'cut');
});

test('c2r 非流式响应丢弃 reasoning 并给出 warning', () => {
  const { body, warnings } = convertResponse({
    body: {
      id: 'resp_4',
      status: 'completed',
      output: [
        { type: 'reasoning', id: 'rs_1', summary: [] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
      ],
    },
    request: { model: 'gpt-5.1' },
  });

  assert.equal(body.choices[0].message.content, 'ok');
  assert.deepEqual(warnings, [{ code: 'reasoning_dropped', field: 'output' }]);
});

test('c2r 非流式响应为空时 content 为 null 并回退 model', () => {
  const { body } = convertResponse({
    body: { id: 'resp_5', status: 'completed', output: [] },
    request: { model: 'gpt-5.1' },
  });

  assert.equal(body.model, 'gpt-5.1');
  assert.equal(body.choices[0].message.content, null);
  assert.equal(body.choices[0].finish_reason, 'stop');
  assert.deepEqual(body.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
});

test('c2r 非流式响应 failed/cancelled 抛 422', () => {
  for (const status of ['failed', 'cancelled']) {
    assert.throws(
      () => convertResponse({ body: { id: 'resp_6', status, output: [] }, request: {} }),
      (error) => error instanceof ConversionError && error.status === 422,
    );
  }
  assert.throws(
    () => convertResponse({ body: { id: 'resp_7', status: 'completed' }, request: {} }),
    (error) => error instanceof ConversionError && error.status === 422,
  );
});

test('c2r 流式响应按顺序产生 role、文本、完成事件和 DONE', () => {
  const converter = createStreamConverter({ request: { model: 'gpt-5.1' } });
  const createdResponse = {
    id: 'resp_1',
    object: 'response',
    created_at: 1700000000,
    model: 'gpt-5.1',
    status: 'in_progress',
    output: [],
    usage: null,
  };
  const { output, chunks } = collectChatChunks(converter, [
    responsesEvent('response.created', { response: createdResponse }),
    responsesEvent('response.in_progress', { response: createdResponse }),
    responsesEvent('response.output_text.delta', { delta: 'Hel' }),
    responsesEvent('response.output_text.delta', { delta: 'lo' }),
    responsesEvent('response.completed', {
      response: {
        ...createdResponse,
        status: 'completed',
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      },
    }),
    'data: [DONE]\n\n',
  ]);

  assert.equal(output.endsWith(SSE_DONE), true);
  assert.equal(chunks.at(-1), '[DONE]');
  assert.deepEqual(chunks.slice(0, -1).map((chunk) => chunk.choices[0].delta), [
    { role: 'assistant', content: '' },
    { content: 'Hel' },
    { content: 'lo' },
    {},
  ]);
  assert.deepEqual(chunks.slice(0, -1).map((chunk) => chunk.choices[0].finish_reason), [
    null,
    null,
    null,
    'stop',
  ]);
  for (const chunk of chunks.slice(0, -1)) {
    assert.equal(chunk.id, 'resp_1');
    assert.equal(chunk.object, 'chat.completion.chunk');
    assert.equal(chunk.created, 1700000000);
    assert.equal(chunk.model, 'gpt-5.1');
    assert.equal(chunk.choices[0].index, 0);
  }
  assert.deepEqual(chunks[3].usage, {
    prompt_tokens: 10,
    completion_tokens: 2,
    total_tokens: 12,
  });
  assert.equal(converter.done, true);
  assert.equal(converter.end(), null);
});

test('c2r 流式工具调用按 item 建立状态并分片输出参数', () => {
  const converter = createStreamConverter({ request: { model: 'gpt-5.1' } });
  const { chunks } = collectChatChunks(converter, [
    responsesEvent('response.created', {
      response: { id: 'resp_2', model: 'gpt-5.1', created_at: 1700000002 },
    }),
    responsesEvent('response.output_item.added', {
      output_index: 0,
      item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '' },
    }),
    responsesEvent('response.function_call_arguments.delta', {
      item_id: 'fc_1',
      output_index: 0,
      delta: '{"q":',
    }),
    responsesEvent('response.function_call_arguments.delta', {
      item_id: 'fc_1',
      output_index: 0,
      delta: '1}',
    }),
    responsesEvent('response.completed', {
      response: { id: 'resp_2', model: 'gpt-5.1', created_at: 1700000002, status: 'completed' },
    }),
  ]);

  assert.deepEqual(chunks[0].choices[0].delta, { role: 'assistant', content: '' });
  assert.deepEqual(chunks[1].choices[0].delta, {
    tool_calls: [{
      index: 0,
      id: 'call_1',
      type: 'function',
      function: { name: 'lookup', arguments: '' },
    }],
  });
  assert.deepEqual(chunks[2].choices[0].delta, {
    tool_calls: [{ index: 0, function: { arguments: '{"q":' } }],
  });
  assert.deepEqual(chunks[3].choices[0].delta, {
    tool_calls: [{ index: 0, function: { arguments: '1}' } }],
  });
  assert.deepEqual(chunks[4].choices[0].delta, {});
  assert.equal(chunks[4].choices[0].finish_reason, 'tool_calls');
  assert.equal(chunks[5], '[DONE]');
});

test('c2r 流式 incomplete 与 failed 分别映射 length 和错误帧', () => {
  const incomplete = collectChatChunks(
    createStreamConverter({ request: {} }),
    [
      responsesEvent('response.created', { response: { id: 'resp_3' } }),
      responsesEvent('response.output_text.delta', { delta: 'cut' }),
      responsesEvent('response.incomplete', {
        response: { id: 'resp_3', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
      }),
    ],
  );
  assert.equal(incomplete.chunks.at(-2).choices[0].finish_reason, 'length');
  assert.equal(incomplete.chunks.at(-1), '[DONE]');

  const failed = collectChatChunks(
    createStreamConverter({ request: {} }),
    [
      responsesEvent('response.created', { response: { id: 'resp_4' } }),
      responsesEvent('response.failed', {
        response: {
          id: 'resp_4',
          status: 'failed',
          error: { message: 'boom', type: 'upstream_error', code: 'bad_response' },
        },
      }),
    ],
  );
  assert.deepEqual(failed.chunks.at(-2), {
    error: { message: 'boom', type: 'upstream_error', code: 'bad_response' },
  });
  assert.equal(failed.chunks.at(-1), '[DONE]');
});

test('c2r 流式重复完成事件只处理一次', () => {
  const completed = responsesEvent('response.completed', {
    response: { id: 'resp_5', status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } },
  });
  const { chunks } = collectChatChunks(createStreamConverter({ request: {} }), [
    responsesEvent('response.created', { response: { id: 'resp_5' } }),
    completed,
    completed,
    responsesEvent('response.output_text.delta', { delta: 'late' }),
  ]);

  assert.deepEqual(chunks.map((chunk) => chunk === '[DONE]' ? '[DONE]' : chunk.choices[0].delta), [
    { role: 'assistant', content: '' },
    {},
    '[DONE]',
  ]);
});

test('c2r 流式 EOF 无终止时有正文补 length，无正文报 stream_truncated', () => {
  const withText = collectChatChunks(createStreamConverter({ request: {} }), [
    responsesEvent('response.output_text.delta', { delta: 'partial' }),
  ]);
  assert.equal(withText.chunks[0].choices[0].delta.content, '');
  assert.equal(withText.chunks[1].choices[0].delta.content, 'partial');
  assert.equal(withText.chunks[2].choices[0].finish_reason, 'length');
  assert.equal(withText.chunks[3], '[DONE]');

  const empty = collectChatChunks(createStreamConverter({ request: {} }), []);
  assert.deepEqual(empty.chunks[0], {
    error: {
      message: '上游流在完成前意外结束',
      type: 'server_error',
      code: 'stream_truncated',
    },
  });
  assert.equal(empty.chunks[1], '[DONE]');
});

test('c2r 流式解析跨任意字节边界稳定', () => {
  const upstream = [
    responsesEvent('response.created', {
      response: { id: 'resp_7', model: 'gpt-5.1', created_at: 1700000007 },
    }),
    responsesEvent('response.output_text.delta', { delta: '你好🙂' }),
    responsesEvent('response.completed', {
      response: { id: 'resp_7', model: 'gpt-5.1', created_at: 1700000007, status: 'completed' },
    }),
  ].join('');
  const byteChunks = Array.from(Buffer.from(upstream, 'utf8'), (byte) => Buffer.from([byte]));
  const { chunks } = collectChatChunks(createStreamConverter({ request: {} }), byteChunks);

  assert.equal(chunks[1].choices[0].delta.content, '你好🙂');
  assert.equal(chunks[2].choices[0].finish_reason, 'stop');
  assert.equal(chunks[3], '[DONE]');
});

test('c2r 流式丢弃 reasoning 事件并给出 warning', () => {
  const converter = createStreamConverter({ request: {} });
  collectChatChunks(converter, [
    responsesEvent('response.created', { response: { id: 'resp_8' } }),
    responsesEvent('response.output_item.added', {
      output_index: 0,
      item: { type: 'reasoning', id: 'rs_1', summary: [] },
    }),
    responsesEvent('response.reasoning_summary_text.delta', { delta: 'secret' }),
    responsesEvent('response.completed', {
      response: { id: 'resp_8', status: 'completed' },
    }),
  ]);

  assert.deepEqual(converter.warnings, [{ code: 'reasoning_dropped', field: 'output' }]);
});
