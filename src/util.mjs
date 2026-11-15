export class HttpError extends Error {
  constructor(status, message, { type = 'invalid_request_error', code = null, expose = true } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.type = type;
    this.code = code;
    this.expose = expose;
  }
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function truncate(value, max = 400) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function nowIso() {
  return new Date().toISOString();
}

function parsePort(value, fallback = 4141) {
  if (value === undefined || value === null || value === '') return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new HttpError(400, `端口无效：${value}`, { code: 'invalid_port' });
  }
  return port;
}

export function parseArgs(argv) {
  const result = {
    port: parsePort(process.env.PROVIDER_ROUTER_PORT, 4141),
    host: process.env.PROVIDER_ROUTER_HOST || '127.0.0.1',
    configPath: process.env.PROVIDER_ROUTER_CONFIG || null,
    open: true,
    silent: false,
    help: false,
    version: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const equals = arg.indexOf('=');
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    const inlineValue = equals === -1 ? undefined : arg.slice(equals + 1);

    const takeValue = () => {
      if (inlineValue !== undefined) return inlineValue;
      index += 1;
      if (index >= argv.length) {
        throw new HttpError(400, `参数 ${flag} 缺少值`, { code: 'invalid_argument' });
      }
      return argv[index];
    };

    switch (flag) {
      case '--host':
        result.host = takeValue();
        break;
      case '--port':
        result.port = parsePort(takeValue());
        break;
      case '--config':
        result.configPath = takeValue();
        break;
      case '--no-open':
        result.open = false;
        break;
      case '--open':
        result.open = true;
        break;
      case '--silent':
        result.silent = true;
        result.open = false;
        break;
      case '--help':
      case '-h':
        result.help = true;
        break;
      case '--version':
      case '-v':
        result.version = true;
        break;
      default:
        if (arg.startsWith('-')) {
          throw new HttpError(400, `未知参数：${arg}`, { code: 'unknown_argument' });
        }
    }
  }

  if (result.silent) result.open = false;
  result.host = String(result.host ?? '').trim();
  if (!result.host) {
    throw new HttpError(400, '监听地址不能为空', { code: 'invalid_host' });
  }
  if (result.configPath !== null) {
    result.configPath = String(result.configPath).trim();
    if (!result.configPath) {
      throw new HttpError(400, '配置文件路径不能为空', { code: 'invalid_config_path' });
    }
  }
  return result;
}

async function readBody(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      throw new HttpError(413, '请求体过大', { code: 'body_too_large' });
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

export async function readJsonBody(req, limit = 2 * 1024 * 1024) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    throw new HttpError(415, '请求必须使用 application/json', {
      code: 'unsupported_media_type',
    });
  }

  const raw = await readBody(req, limit);
  if (raw.length === 0) {
    throw new HttpError(400, '请求体不能为空', { code: 'empty_body' });
  }

  let parsed;
  try {
    const text = raw.toString('utf8');
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw new HttpError(400, '请求体不是有效的 JSON', { code: 'invalid_json' });
  }

  if (!isPlainObject(parsed)) {
    throw new HttpError(400, '请求体必须是 JSON 对象', { code: 'invalid_json_shape' });
  }

  return parsed;
}

export function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.writableEnded || res.destroyed) return;
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

export function sendError(res, error) {
  if (res.writableEnded || res.destroyed) return;
  const known = error instanceof HttpError;
  const status = known ? error.status : 500;
  const message = known || error?.expose ? error.message : '服务器内部错误';
  sendJson(res, status, {
    error: {
      message,
      type: known ? error.type : 'server_error',
      code: known ? error.code : 'internal_error',
    },
  });
}
