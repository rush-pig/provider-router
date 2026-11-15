import { Readable } from 'node:stream';
import { applyProviderAuth } from './auth.mjs';
import { joinUpstreamUrl } from './protocols.mjs';
import { truncate } from './util.mjs';

const CONNECT_TIMEOUT_MS =
  Number(process.env.PROVIDER_ROUTER_CONNECT_TIMEOUT_MS) || 300_000;

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

function buildRequestHeaders(req, provider) {
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
 * Forwards a parsed JSON request to the selected provider. Only the API key
 * header and the `model` field change; every other request header, body field,
 * method, path and query string is preserved.
 */
export async function proxyRequest({
  req,
  res,
  provider,
  payload,
  modelReference,
  pathname,
  search,
  onComplete,
}) {
  const startedAt = Date.now();
  let finished = false;

  const finish = (status, error = null) => {
    if (finished) return;
    finished = true;
    try {
      onComplete?.({
        status,
        error,
        durationMs: Date.now() - startedAt,
      });
    } catch {
      // Logging must never affect the proxied response.
    }
  };

  res.once('finish', () => finish(res.statusCode));
  res.once('close', () => {
    if (!res.writableEnded) finish(499, '客户端提前断开');
  });

  const target = joinUpstreamUrl(provider.baseUrl, pathname, search);
  const body = JSON.stringify({ ...payload, model: modelReference.model });

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
      headers: buildRequestHeaders(req, provider),
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
      sendProxyError(res, 504, message, 'upstream_timeout');
      finish(504, message);
      return;
    }

    const message = `上游请求失败：${truncate(error.message, 400)}`;
    sendProxyError(res, 502, message, 'upstream_request_failed');
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
      sendProxyError(res, 502, message, 'upstream_response_invalid');
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
      controller.abort();
    }
  });

  nodeStream.pipe(res);
}

function sendProxyError(res, status, message, code) {
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
