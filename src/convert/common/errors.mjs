import { HttpError, isPlainObject, truncate } from '../../util.mjs';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const DEFAULT_ERROR_TYPE = 'invalid_request_error';
const UNKNOWN_ERROR_MESSAGE = '未知错误';
const FALLBACK_MESSAGE_LIMIT = 400;

export class ConversionError extends HttpError {
  constructor(message, { code = 'conversion_error', field = null } = {}) {
    super(422, message, { type: DEFAULT_ERROR_TYPE, code });
    this.name = 'ConversionError';
    this.field = field;
  }
}

export class ConversionRequestError extends HttpError {
  constructor(message, { code = 'invalid_request', field = null } = {}) {
    super(400, message, { type: DEFAULT_ERROR_TYPE, code });
    this.name = 'ConversionRequestError';
    this.field = field;
  }
}

/**
 * 按客户端协议生成错误响应体。OpenAI Chat 与 Responses 共用同一种错误体，
 * 其余未知协议也按 OpenAI 兼容形态处理。
 */
export function errorEnvelopeFor(
  clientProtocol,
  { message, type = DEFAULT_ERROR_TYPE, code = null } = {},
) {
  const text = typeof message === 'string' && message.trim() !== '' ? message : UNKNOWN_ERROR_MESSAGE;

  if (clientProtocol === 'anthropic') {
    return { type: 'error', error: { type, message: text } };
  }
  return { error: { message: text, type, code, param: null } };
}

/**
 * 把任意上游错误体（对象、JSON 字符串或纯文本）塑形成客户端协议的错误响应体。
 * 不改变 HTTP 状态码，状态码由调用方决定。
 */
export function convertErrorBody({ clientProtocol, body }) {
  return {
    body: errorEnvelopeFor(clientProtocol, { message: extractErrorMessage(body) }),
    contentType: JSON_CONTENT_TYPE,
  };
}

function extractErrorMessage(body) {
  if (Buffer.isBuffer(body)) {
    return extractErrorMessage(body.toString('utf8'));
  }
  if (typeof body === 'string') {
    const parsed = tryParseJson(body);
    if (isPlainObject(parsed)) {
      return extractNestedMessage(parsed) ?? truncate(body, FALLBACK_MESSAGE_LIMIT);
    }
    return truncate(body, FALLBACK_MESSAGE_LIMIT);
  }
  if (isPlainObject(body)) {
    return extractNestedMessage(body) ?? truncate(JSON.stringify(body), FALLBACK_MESSAGE_LIMIT);
  }
  return truncate(JSON.stringify(body), FALLBACK_MESSAGE_LIMIT);
}

function extractNestedMessage(payload) {
  for (const candidate of [payload.error, payload]) {
    if (
      isPlainObject(candidate)
      && typeof candidate.message === 'string'
      && candidate.message.trim() !== ''
    ) {
      return candidate.message;
    }
  }
  return null;
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
