import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpError } from '../src/util.mjs';
import {
  ConversionError,
  ConversionRequestError,
  convertErrorBody,
  errorEnvelopeFor,
} from '../src/convert/common/errors.mjs';
import {
  SSE_DONE,
  SseParser,
  formatSseEvent,
  formatSseJson,
} from '../src/convert/common/sse.mjs';
import {
  mergeNeutral,
  neutralFromAnthropic,
  neutralFromOpenAiChat,
  neutralFromResponses,
  neutralToAnthropic,
  neutralToOpenAiChat,
  neutralToResponses,
} from '../src/convert/common/usage.mjs';

function parseAll(chunks) {
  const parser = new SseParser();
  const events = [];
  for (const chunk of chunks) events.push(...parser.push(chunk));
  events.push(...parser.end());
  return events;
}

test('SSE 帧跨字节 chunk 拆分且 UTF-8 字符不被截断', () => {
  const stream = 'event: message\ndata: 你好🙂\n\ndata: {"ok":true}\n\n';
  const chunks = Array.from(Buffer.from(stream, 'utf8'), (byte) => Buffer.from([byte]));

  assert.deepEqual(parseAll(chunks), [
    { event: 'message', data: '你好🙂', id: null, retry: null },
    { event: null, data: '{"ok":true}', id: null, retry: null },
  ]);
});

test('SSE 解析支持 CRLF、多行 data、注释、id 与 retry', () => {
  const stream = ': heartbeat\r\nevent: delta\r\nid: 7\r\nretry: 1500\r\ndata: first\r\ndata: second\r\n\r\n';
  assert.deepEqual(parseAll([stream]), [
    { event: 'delta', data: 'first\nsecond', id: '7', retry: '1500' },
  ]);
});

test('事件字段不跨帧泄漏', () => {
  const events = parseAll(['event: delta\ndata: x\n\n', 'data: y\n\n']);
  assert.deepEqual(events, [
    { event: 'delta', data: 'x', id: null, retry: null },
    { event: null, data: 'y', id: null, retry: null },
  ]);
});

test('CRLF 恰好被 chunk 边界拆开时仍正确解析', () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push('data: a\r'), []);
  assert.deepEqual(parser.push('\ndata: b\r\n\r\n'), [
    { event: null, data: 'a\nb', id: null, retry: null },
  ]);
});

test('end 冲刷没有空行结尾的残帧，data 为空则忽略', () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push('data: tail'), []);
  assert.deepEqual(parser.end(), [{ event: null, data: 'tail', id: null, retry: null }]);

  assert.deepEqual(parseAll(['data:\n\n', ': only comment\n\n']), []);

  const emptyParser = new SseParser();
  emptyParser.push('data:');
  assert.deepEqual(emptyParser.end(), []);
});

test('push 不修改调用方传入的 Buffer', () => {
  const chunk = Buffer.from('data: hello\n\n', 'utf8');
  const snapshot = Buffer.from(chunk);
  new SseParser().push(chunk);
  assert.deepEqual(chunk, snapshot);
});

test('push 接受字符串 chunk', () => {
  assert.deepEqual(parseAll(['data: a\n\ndata: b\n\n']), [
    { event: null, data: 'a', id: null, retry: null },
    { event: null, data: 'b', id: null, retry: null },
  ]);
});

test('formatSseEvent 编码字段与多行 data，并可被解析器还原', () => {
  const text = formatSseEvent({ event: 'message', data: 'a\nb', id: '1', retry: 100 });
  assert.equal(text, 'event: message\nid: 1\nretry: 100\ndata: a\ndata: b\n\n');
  assert.deepEqual(parseAll([text]), [
    { event: 'message', data: 'a\nb', id: '1', retry: '100' },
  ]);
});

test('formatSseJson 与 SSE_DONE 生成可解析的帧', () => {
  assert.equal(formatSseJson({ a: 1 }), 'data: {"a":1}\n\n');
  assert.equal(SSE_DONE, 'data: [DONE]\n\n');
  assert.deepEqual(parseAll([formatSseJson({ a: 1 }), SSE_DONE]), [
    { event: null, data: '{"a":1}', id: null, retry: null },
    { event: null, data: '[DONE]', id: null, retry: null },
  ]);
});

test('Anthropic usage 映射到中性结构', () => {
  assert.deepEqual(
    neutralFromAnthropic({
      input_tokens: 12,
      output_tokens: 34,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 50,
    }),
    { inputTokens: 12, outputTokens: 34, cacheReadTokens: 100, cacheCreationTokens: 50 },
  );
});

test('OpenAI Chat usage 扣减缓存命中，并兼容多种缓存字段', () => {
  assert.deepEqual(
    neutralFromOpenAiChat({
      prompt_tokens: 150,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 100 },
    }),
    { inputTokens: 50, outputTokens: 20, cacheReadTokens: 100, cacheCreationTokens: 0 },
  );
  assert.equal(
    neutralFromOpenAiChat({ prompt_tokens: 10, prompt_cache_hit_tokens: 4 }).cacheReadTokens,
    4,
  );
  assert.equal(neutralFromOpenAiChat({ prompt_tokens: 10, cached_tokens: 4 }).cacheReadTokens, 4);
});

test('Responses usage 扣减缓存命中', () => {
  assert.deepEqual(
    neutralFromResponses({
      input_tokens: 150,
      output_tokens: 20,
      input_tokens_details: { cached_tokens: 100 },
    }),
    { inputTokens: 50, outputTokens: 20, cacheReadTokens: 100, cacheCreationTokens: 0 },
  );
});

test('cache usage 在三种协议间往返不丢失缓存命中', () => {
  const original = neutralFromAnthropic({
    input_tokens: 12,
    output_tokens: 34,
    cache_read_input_tokens: 100,
    cache_creation_input_tokens: 50,
  });

  const chatUsage = neutralToOpenAiChat(original);
  assert.equal(chatUsage.prompt_tokens, 162);
  assert.equal(chatUsage.total_tokens, 196);
  assert.deepEqual(chatUsage.prompt_tokens_details, { cached_tokens: 100 });

  const fromChat = neutralFromOpenAiChat(chatUsage);
  assert.equal(fromChat.cacheReadTokens, 100);
  assert.equal(fromChat.inputTokens + fromChat.cacheReadTokens, 162);

  const responsesUsage = neutralToResponses(fromChat);
  assert.equal(responsesUsage.input_tokens, 162);
  assert.equal(responsesUsage.total_tokens, 196);
  assert.deepEqual(responsesUsage.input_tokens_details, { cached_tokens: 100 });

  assert.deepEqual(neutralToAnthropic(neutralFromResponses(responsesUsage)), {
    input_tokens: 62,
    output_tokens: 34,
    cache_read_input_tokens: 100,
  });
});

test('缓存命中超过输入时输入 token 不为负', () => {
  const neutral = neutralFromOpenAiChat({
    prompt_tokens: 10,
    prompt_tokens_details: { cached_tokens: 25 },
  });
  assert.equal(neutral.inputTokens, 0);
  assert.equal(neutral.cacheReadTokens, 25);
});

test('为 0 的缓存字段不会出现在输出中', () => {
  assert.deepEqual(neutralToAnthropic({ inputTokens: 5, outputTokens: 6 }), {
    input_tokens: 5,
    output_tokens: 6,
  });
  assert.deepEqual(neutralToOpenAiChat({ inputTokens: 5, outputTokens: 6 }), {
    prompt_tokens: 5,
    completion_tokens: 6,
    total_tokens: 11,
  });
  assert.deepEqual(neutralToResponses({ inputTokens: 5, outputTokens: 6 }), {
    input_tokens: 5,
    output_tokens: 6,
    total_tokens: 11,
  });
});

test('mergeNeutral 逐字段相加且不修改入参', () => {
  const base = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 };
  const extra = { inputTokens: 10, outputTokens: 20 };

  assert.deepEqual(mergeNeutral(base, extra), {
    inputTokens: 11,
    outputTokens: 22,
    cacheReadTokens: 3,
    cacheCreationTokens: 4,
  });
  assert.deepEqual(base, { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 });
});

test('usage 数值统一为非负整数，缺省为 0', () => {
  const neutral = neutralFromAnthropic({ input_tokens: -3, output_tokens: 2.9 });
  assert.equal(neutral.inputTokens, 0);
  assert.equal(neutral.outputTokens, 2);
  assert.deepEqual(neutralFromAnthropic(undefined), {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  });
});

test('错误响应体按客户端协议塑形', () => {
  assert.deepEqual(errorEnvelopeFor('anthropic', { message: 'bad input' }), {
    type: 'error',
    error: { type: 'invalid_request_error', message: 'bad input' },
  });

  const openAiEnvelope = {
    error: { message: 'bad input', type: 'invalid_request_error', code: null, param: null },
  };
  assert.deepEqual(errorEnvelopeFor('openai', { message: 'bad input' }), openAiEnvelope);
  assert.deepEqual(errorEnvelopeFor('openai-responses', { message: 'bad input' }), openAiEnvelope);
  assert.deepEqual(
    errorEnvelopeFor('openai', { message: 'slow down', type: 'rate_limit_error', code: 'slow_down' }),
    { error: { message: 'slow down', type: 'rate_limit_error', code: 'slow_down', param: null } },
  );
});

test('convertErrorBody 从对象、JSON 字符串与纯文本中提取 message', () => {
  const openAiBody = (message) => ({
    body: { error: { message, type: 'invalid_request_error', code: null, param: null } },
    contentType: 'application/json; charset=utf-8',
  });

  assert.deepEqual(
    convertErrorBody({
      clientProtocol: 'openai',
      body: { error: { message: 'nested' }, message: 'top' },
    }),
    openAiBody('nested'),
  );
  assert.deepEqual(
    convertErrorBody({ clientProtocol: 'openai', body: { message: 'top-level' } }),
    openAiBody('top-level'),
  );
  assert.deepEqual(
    convertErrorBody({ clientProtocol: 'openai', body: '{"error":{"message":"json boom"}}' }),
    openAiBody('json boom'),
  );
  assert.deepEqual(
    convertErrorBody({ clientProtocol: 'openai', body: 'plain upstream failure' }),
    openAiBody('plain upstream failure'),
  );

  const anthropicResult = convertErrorBody({
    clientProtocol: 'anthropic',
    body: { message: 'nope' },
  });
  assert.deepEqual(anthropicResult.body, {
    type: 'error',
    error: { type: 'invalid_request_error', message: 'nope' },
  });
  assert.equal(anthropicResult.contentType, 'application/json; charset=utf-8');
});

test('convertErrorBody 无 message 时回退到序列化文本并截断到 400 字符', () => {
  const detail = 'x'.repeat(1000);
  const result = convertErrorBody({ clientProtocol: 'openai', body: { detail } });
  const message = result.body.error.message;

  assert.equal(message.length, 400);
  assert.equal(message.endsWith('…'), true);
  assert.equal(message.includes('x'.repeat(50)), true);
});

test('转换错误类携带状态码、code 与 field', () => {
  const error = new ConversionError('cannot convert', { field: 'messages' });
  assert.equal(error instanceof HttpError, true);
  assert.equal(error.status, 422);
  assert.equal(error.type, 'invalid_request_error');
  assert.equal(error.code, 'conversion_error');
  assert.equal(error.field, 'messages');
  assert.equal(error.message, 'cannot convert');

  const requestError = new ConversionRequestError('bad request');
  assert.equal(requestError instanceof HttpError, true);
  assert.equal(requestError.status, 400);
  assert.equal(requestError.code, 'invalid_request');
  assert.equal(requestError.field, null);
});
