import { Readable } from 'node:stream';
import { applyProviderAuth } from './auth.mjs';
import { createStreamConverter, convertRequest, convertResponse } from './convert/index.mjs';
import { convertErrorBody, errorEnvelopeFor } from './convert/common/errors.mjs';
import { formatSseEvent } from './convert/common/sse.mjs';
import { aggregateSse, synthesizeSse } from './convert/common/sse-response.mjs';
import { joinUpstreamUrl } from './protocols.mjs';
import { HttpError, truncate } from './util.mjs';

const CONNECT_TIMEOUT_MS =
  Number(process.env.PROVIDER_ROUTER_CONNECT_TIMEOUT_MS) || 300_000;
const MAX_CONVERTED_BYTES = 64 * 1024 * 1024;

const REQUEST_HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'expect',
  'host',
  'content-length',
  'content-md5',
  'digest',
  'accept-encoding',
]);

const RESPONSE_STRIP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'content-encoding',
  'strict-transport-security',
  'alt-svc',
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-expose-headers',
  'access-control-max-age',
  'timing-allow-origin',
  'clear-site-data',
]);

const ANTHROPIC_ONLY_HEADERS = [
  'anthropic-version',
  'anthropic-beta',
  'anthropic-dangerous-direct-browser-access',
];

function buildRequestHeaders(req, provider, conversion) {
  const headers = new Headers();

  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (REQUEST_HOP_BY_HOP.has(lower)) continue;
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }

  applyProviderAuth(headers, provider);

  if (conversion && conversion.to !== 'anthropic') {
    for (const name of ANTHROPIC_ONLY_HEADERS) headers.delete(name);
  }

  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  return headers;
}

function responseHeaders(headers) {
  const result = {};
  for (const [name, value] of headers) {
    if (RESPONSE_STRIP.has(name.toLowerCase())) continue;
    if (name.toLowerCase() === 'set-cookie') continue;
    result[name] = value;
  }

  const cookies =
    typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : null;
  if (cookies && cookies.length > 0) {
    result['set-cookie'] = cookies;
  } else {
    const cookie = headers.get('set-cookie');
    if (cookie) result['set-cookie'] = cookie;
  }

  return result;
}

/**
 * Forwards a request to the selected provider. Without a conversion plan the
 * request is passed through unchanged except for the upstream model and auth
 * header; with one, the request and response bodies are translated.
 */
export async function proxyRequest({
  req,
  res,
  provider,
  payload,
  modelReference,
  pathname,
  search,
  conversion = null,
  onComplete,
}) {
  const startedAt = Date.now();
  const warnings = [];
  let finished = false;

  const finish = (status, error = null) => {
    if (finished) return;
    finished = true;
    try {
      onComplete?.({
        status,
        error,
        durationMs: Date.now() - startedAt,
        warnings,
      });
    } catch {
      // Logging must never affect the proxied response.
    }
  };

  res.once('finish', () => finish(res.statusCode));
  res.once('close', () => {
    if (!res.writableEnded) finish(499, '客户端提前断开');
  });

  let upstreamRequestBody = { ...payload, model: modelReference.model };
  if (conversion) {
    const converted = convertRequest({
      from: conversion.from,
      to: conversion.to,
      body: upstreamRequestBody,
      model: modelReference.model,
    });
    upstreamRequestBody = converted.body;
    if (converted.stream !== undefined && upstreamRequestBody.stream === undefined) {
      upstreamRequestBody.stream = converted.stream;
    }
    warnings.push(...(converted.warnings ?? []));
  }

  const targetPath = conversion ? conversion.upstreamPath : pathname;
  const target = joinUpstreamUrl(provider.baseUrl, targetPath, conversion ? '' : search);
  const body = JSON.stringify(upstreamRequestBody);

  const controller = new AbortController();
  let timedOut = false;
  let clientClosed = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, CONNECT_TIMEOUT_MS);
  timer.unref?.();

  const abortOnClose = () => {
    if (res.writableEnded) return;
    clientClosed = true;
    controller.abort();
  };
  res.once('close', abortOnClose);
  req.once('aborted', abortOnClose);

  let upstream;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers: buildRequestHeaders(req, provider, conversion),
      body,
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    if (clientClosed || res.destroyed || res.writableEnded) {
      if (!finished) finish(499, '客户端提前断开');
      return;
    }

    if (timedOut) {
      const message = `上游连接超时（${Math.round(CONNECT_TIMEOUT_MS / 1000)} 秒）`;
      sendProxyError({ res, status: 504, message, code: 'upstream_timeout' });
      finish(504, message);
      return;
    }

    const message = `上游请求失败：${truncate(error.message, 400)}`;
    sendProxyError({ res, status: 502, message, code: 'upstream_request_failed' });
    finish(502, message);
    return;
  } finally {
    clearTimeout(timer);
  }

  if (res.destroyed || res.writableEnded) {
    try {
      await upstream.body?.cancel();
    } catch {
      // Already gone.
    }
    if (!finished) finish(499, '客户端提前断开');
    return;
  }

  if (conversion) {
    try {
      await writeConvertedResponse({
        upstream,
        res,
        conversion,
        request: upstreamRequestBody,
        warnings,
      });
    } catch (error) {
      if (clientClosed || res.destroyed) {
        if (!finished) finish(499, '客户端提前断开');
        return;
      }
      const status = error instanceof HttpError ? error.status : 502;
      const message = truncate(error.message, 400);
      sendConversionError({
        res,
        clientProtocol: conversion.from,
        status,
        message,
        code: error.code,
      });
      finish(status, message);
    }
    return;
  }

  await pipeUpstreamResponse({ upstream, res, finish });
}

async function pipeUpstreamResponse({ upstream, res, finish }) {
  try {
    res.writeHead(upstream.status, responseHeaders(upstream.headers));
    res.flushHeaders?.();
  } catch (error) {
    try {
      await upstream.body?.cancel();
    } catch {
      // Ignore cancellation errors.
    }
    const message = `写入响应失败：${truncate(error.message, 300)}`;
    if (!res.headersSent) {
      sendProxyError({ res, status: 502, message, code: 'upstream_response_invalid' });
    } else {
      res.destroy(error);
    }
    finish(502, message);
    return;
  }

  if (!upstream.body) {
    res.end();
    return;
  }

  let nodeStream;
  try {
    nodeStream = Readable.fromWeb(upstream.body);
  } catch (error) {
    try {
      await upstream.body.cancel();
    } catch {
      // Ignore cancellation errors.
    }
    const message = `无法读取上游响应：${truncate(error.message, 300)}`;
    finish(502, message);
    res.destroy(error);
    return;
  }

  nodeStream.on('error', (error) => {
    if (!res.writableEnded) {
      finish(502, `响应流中断：${truncate(error.message, 300)}`);
      res.destroy(error);
    }
  });

  res.once('close', () => {
    if (!res.writableEnded) {
      nodeStream.destroy();
    }
  });

  nodeStream.pipe(res);
}

async function writeConvertedResponse({ upstream, res, conversion, request, warnings }) {
  const contentType = String(upstream.headers.get('content-type') || '').toLowerCase();
  const isSse = contentType.includes('text/event-stream');
  const wantsStream = Boolean(request.stream);

  if (upstream.status >= 400) {
    const text = await readUpstreamText(upstream);
    const parsed = parseJson(text);
    const { body: errorBody, contentType: errorContentType } = convertErrorBody({
      clientProtocol: conversion.from,
      body: parsed ?? text,
    });
    writeJson({
      res,
      status: upstream.status,
      payload: errorBody,
      contentType: errorContentType,
      upstreamHeaders: upstream.headers,
    });
    return;
  }

  if (wantsStream && isSse) {
    await writeConvertedStream({ upstream, res, conversion, request, warnings });
    return;
  }

  if (wantsStream && !isSse) {
    const upstreamBody = await readUpstreamJson(upstream);
    const converted = convertResponse({
      from: conversion.from,
      to: conversion.to,
      body: upstreamBody,
      request,
    });
    warnings.push(...(converted.warnings ?? []));
    const frames = synthesizeSse({ protocol: conversion.from, response: converted.body });
    writeSse({
      res,
      status: upstream.status,
      frames,
      upstreamHeaders: upstream.headers,
    });
    return;
  }

  if (!wantsStream && isSse) {
    const text = await readUpstreamText(upstream);
    const upstreamBody = aggregateSse({ protocol: conversion.to, text });
    const converted = convertResponse({
      from: conversion.from,
      to: conversion.to,
      body: upstreamBody,
      request,
    });
    warnings.push(...(converted.warnings ?? []));
    writeJson({
      res,
      status: upstream.status,
      payload: converted.body,
      contentType: 'application/json; charset=utf-8',
      upstreamHeaders: upstream.headers,
    });
    return;
  }

  const upstreamBody = await readUpstreamJson(upstream);
  const converted = convertResponse({
    from: conversion.from,
    to: conversion.to,
    body: upstreamBody,
    request,
  });
  warnings.push(...(converted.warnings ?? []));
  writeJson({
    res,
    status: upstream.status,
    payload: converted.body,
    contentType: 'application/json; charset=utf-8',
    upstreamHeaders: upstream.headers,
  });
}

async function writeConvertedStream({ upstream, res, conversion, request, warnings }) {
  if (!upstream.body) {
    res.writeHead(upstream.status, streamHeaders(upstream.headers));
    res.end();
    return;
  }

  const converter = createStreamConverter({
    from: conversion.from,
    to: conversion.to,
    request,
  });
  const source = Readable.fromWeb(upstream.body);

  res.writeHead(upstream.status, streamHeaders(upstream.headers));
  res.flushHeaders?.();

  try {
    for await (const chunk of source) {
      if (res.destroyed || res.writableEnded) break;
      const output = converter.push(chunk);
      if (output) await writeChunk(res, output);
    }

    const tail = converter.end();
    if (tail) await writeChunk(res, tail);
    if (Array.isArray(converter.warnings)) warnings.push(...converter.warnings);
    if (!res.writableEnded) res.end();
  } finally {
    source.destroy();
  }
}

function streamHeaders(headers) {
  const result = responseHeaders(headers);
  result['content-type'] = 'text/event-stream; charset=utf-8';
  result['cache-control'] = 'no-cache';
  delete result['content-length'];
  return result;
}

function writeJson({ res, status, payload, contentType, upstreamHeaders }) {
  if (res.writableEnded || res.destroyed) return;
  const body = Buffer.from(JSON.stringify(payload));
  const headers = responseHeaders(upstreamHeaders);
  headers['content-type'] = contentType;
  headers['content-length'] = body.length;
  headers['cache-control'] = 'no-store';
  res.writeHead(status, headers);
  res.end(body);
}

function writeSse({ res, status, frames, upstreamHeaders }) {
  if (res.writableEnded || res.destroyed) return;
  const body = frames.join('');
  const headers = responseHeaders(upstreamHeaders);
  headers['content-type'] = 'text/event-stream; charset=utf-8';
  headers['content-length'] = Buffer.byteLength(body);
  headers['cache-control'] = 'no-cache';
  res.writeHead(status, headers);
  res.end(body);
}

async function writeChunk(res, text) {
  if (res.destroyed || res.writableEnded) return;
  if (res.write(text)) return;

  await new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
  });
}

async function readUpstreamText(upstream, limit = MAX_CONVERTED_BYTES) {
  if (!upstream.body) return '';
  const stream = Readable.fromWeb(upstream.body);
  const chunks = [];
  let size = 0;

  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) {
      stream.destroy();
      throw new HttpError(502, '上游响应过大，无法转换', {
        type: 'server_error',
        code: 'upstream_response_too_large',
      });
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString('utf8');
}

async function readUpstreamJson(upstream) {
  const text = await readUpstreamText(upstream);
  const parsed = parseJson(text);
  if (parsed === null) {
    throw new HttpError(502, '上游返回了无效 JSON', {
      type: 'server_error',
      code: 'upstream_response_invalid',
    });
  }
  return parsed;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sendConversionError({ res, clientProtocol, status, message, code }) {
  if (res.writableEnded || res.destroyed) return;

  if (!res.headersSent) {
    const payload = errorEnvelopeFor(clientProtocol, {
      message,
      type: 'invalid_request_error',
      code: code ?? 'conversion_error',
    });
    writeJson({
      res,
      status,
      payload,
      contentType: 'application/json; charset=utf-8',
      upstreamHeaders: new Headers(),
    });
    return;
  }

  const payload =
    clientProtocol === 'anthropic'
      ? { type: 'error', error: { type: 'server_error', message } }
      : { error: { message, type: 'server_error', code: code ?? 'conversion_error' } };
  const frame =
    clientProtocol === 'anthropic'
      ? formatSseEvent({ event: 'error', data: JSON.stringify(payload) })
      : `data: ${JSON.stringify(payload)}\n\n`;

  try {
    res.write(frame);
    res.end();
  } catch {
    res.destroy();
  }
}

function sendProxyError({ res, status, message, code }) {
  if (res.writableEnded || res.destroyed) return;
  const body = Buffer.from(
    JSON.stringify({
      error: {
        message,
        type: 'upstream_error',
        code,
      },
    }),
  );
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}
