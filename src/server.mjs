import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTH_STYLES } from './auth.mjs';
import { getAutostartStatus, setAutostart } from './autostart.mjs';
import { getProviderCatalog, piAiAvailability } from './catalog.mjs';
import {
  defaultConfigPath,
  loadConfig,
  persistConfig,
  publicProvider,
  validateProvider,
} from './config.mjs';
import { addLog, clearLogs, completeLog, getRecentLogs, getStats, listLogs } from './logs.mjs';
import { PROTOCOLS, parseModelReference } from './protocols.mjs';
import { proxyRequest } from './proxy.mjs';
import { aggregateModels, fetchProviderModels, invalidateModelCache } from './upstream.mjs';
import {
  HttpError,
  isPlainObject,
  parseArgs,
  readJsonBody,
  sendError,
  sendJson,
  truncate,
} from './util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_PROXY_BODY = 64 * 1024 * 1024;
const SERVER_VERSION = JSON.parse(
  await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'),
).version;

const STATIC_CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.woff2', 'font/woff2'],
]);

const DEFAULT_STATIC_CONTENT_TYPE = 'application/octet-stream';

const CLI_HELP = `Provider Router ${SERVER_VERSION}

用法：
  node src/server.mjs [选项]

选项：
  --host <地址>       监听地址，默认 127.0.0.1
  --port <端口>       监听端口，默认 4141
  --config <路径>     配置文件路径
  --no-open           启动时不打开浏览器
  --silent            静默模式：不输出日志、不打开浏览器
  -h, --help          显示帮助
  -v, --version       显示版本

图形控制台： http://127.0.0.1:4141/
网关地址：   http://127.0.0.1:4141/v1
`;

function isLoopbackHost(host) {
  return ['127.0.0.1', 'localhost', '::1'].includes(host);
}

function formatHost(host) {
  if (host.includes(':') && !host.startsWith('[')) return `[${host}]`;
  return host;
}

function displayHost(host) {
  if (host === '0.0.0.0') return '127.0.0.1';
  if (host === '::') return '::1';
  return host;
}

function hostHeaderAllowed(hostHeader, boundHost) {
  if (!hostHeader) return false;
  let hostname;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  const allowed = new Set([
    '127.0.0.1',
    'localhost',
    '::1',
    '[::1]',
    boundHost.toLowerCase(),
  ]);
  return allowed.has(hostname);
}

function setSecurityHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('cross-origin-resource-policy', 'same-origin');
  res.setHeader(
    'permissions-policy',
    'camera=(), microphone=(), geolocation=(), payment=()',
  );
  res.setHeader(
    'content-security-policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
}

function decodePathSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, '路径参数编码无效', { code: 'invalid_path_encoding' });
  }
}

function methodNotAllowed(method) {
  return new HttpError(405, `不支持 ${method} 方法`, {
    type: 'invalid_request_error',
    code: 'method_not_allowed',
  });
}

function resolveStaticFile(pathname) {
  let decodedPath;
  try {
    // The URL parser leaves percent-encoded segments untouched, so traversal
    // attempts such as %2e%2e%2f only become visible after decoding.
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decodedPath.includes('\0')) return null;

  const relativePath = decodedPath.replace(/^\/+/, '') || 'index.html';
  const filePath = path.resolve(PUBLIC_DIR, relativePath);
  const publicPrefix = `${PUBLIC_DIR}${path.sep}`;
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(publicPrefix)) return null;
  return filePath;
}

function contentTypeFor(filePath) {
  return (
    STATIC_CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) ??
    DEFAULT_STATIC_CONTENT_TYPE
  );
}

function assetNotFound() {
  return new HttpError(404, '静态资源不存在', { code: 'asset_not_found' });
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    console.log(CLI_HELP);
    return;
  }
  if (options.version) {
    console.log(SERVER_VERSION);
    return;
  }

  const log = (...values) => {
    if (!options.silent) console.log(...values);
  };
  const logError = (...values) => {
    if (!options.silent) console.error(...values);
  };

  const configPath = options.configPath
    ? path.resolve(process.cwd(), options.configPath)
    : defaultConfigPath();

  let loaded;
  try {
    loaded = await loadConfig(configPath);
  } catch (error) {
    console.error(`无法加载配置：${error.message}`);
    process.exitCode = 1;
    return;
  }

  let config = loaded.config;
  if (loaded.warning) logError(`配置警告：${loaded.warning}`);

  const advertiseHost = displayHost(options.host);
  const dashboardUrl = `http://${formatHost(advertiseHost)}:${options.port}/`;
  const gatewayBaseUrl = `${dashboardUrl}v1`;

  const commitConfig = async (nextConfig) => {
    await persistConfig(configPath, nextConfig);
    config = nextConfig;
    loaded.warning = null;
    loaded.backupPath = null;
    invalidateModelCache();
  };

  let configMutation = Promise.resolve();
  const withConfigMutation = (task) => {
    const run = configMutation.then(task);
    configMutation = run.catch(() => {});
    return run;
  };

  const getProvider = (name) => config.providers.find((provider) => provider.name === name);

  const buildState = async () => ({
    app: {
      name: 'Provider Router',
      version: SERVER_VERSION,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
      host: options.host,
      port: options.port,
      dashboardUrl,
      gatewayBaseUrl,
      configPath,
      configWarning: loaded.warning,
      configBackupPath: loaded.backupPath,
      startedAt: getStats().startedAt,
    },
    providers: config.providers.map(publicProvider),
    protocols: PROTOCOLS,
    authStyles: AUTH_STYLES,
    stats: getStats(),
    recentLogs: getRecentLogs(6),
    autostart: await getAutostartStatus(),
    piAi: piAiAvailability(),
  });

  async function handleProviderCollection(req, res, method) {
    if (method === 'GET') {
      sendJson(res, 200, {
        providers: config.providers.map(publicProvider),
        protocols: PROTOCOLS,
        authStyles: AUTH_STYLES,
      });
      return;
    }

    if (method !== 'POST') throw methodNotAllowed(method);

    const body = await readJsonBody(req);
    await withConfigMutation(async () => {
      const provider = validateProvider(body, {
        existingNames: config.providers.map((item) => item.name),
      });
      const nextConfig = {
        ...config,
        providers: [...config.providers, provider],
      };
      await commitConfig(nextConfig);
      sendJson(res, 201, { provider: publicProvider(provider) });
    });
  }

  async function handleProviderItem(req, res, method, name, isTest) {
    const provider = getProvider(name);
    if (!provider) {
      throw new HttpError(404, `提供商 "${name}" 不存在`, {
        type: 'invalid_request_error',
        code: 'provider_not_found',
      });
    }

    if (isTest) {
      if (method !== 'POST') throw methodNotAllowed(method);
      try {
        const result = await fetchProviderModels(provider);
        sendJson(res, 200, {
          ok: true,
          models: result.models,
          count: result.models.length,
          latencyMs: result.latencyMs,
          fetchedAt: result.fetchedAt,
        });
      } catch (error) {
        sendJson(res, 200, { ok: false, error: error.message });
      }
      return;
    }

    if (method === 'PUT') {
      const body = await readJsonBody(req);
      await withConfigMutation(async () => {
        const current = getProvider(name);
        if (!current) {
          throw new HttpError(404, `提供商 "${name}" 不存在`, {
            type: 'invalid_request_error',
            code: 'provider_not_found',
          });
        }
        const updated = validateProvider(body, {
          existingNames: config.providers.map((item) => item.name),
          previous: current,
        });
        const nextConfig = {
          ...config,
          providers: config.providers.map((item) =>
            item.name === current.name ? updated : item,
          ),
        };
        await commitConfig(nextConfig);
        sendJson(res, 200, { provider: publicProvider(updated) });
      });
      return;
    }

    if (method === 'DELETE') {
      await withConfigMutation(async () => {
        const current = getProvider(name);
        if (!current) {
          throw new HttpError(404, `提供商 "${name}" 不存在`, {
            type: 'invalid_request_error',
            code: 'provider_not_found',
          });
        }
        const nextConfig = {
          ...config,
          providers: config.providers.filter((item) => item.name !== current.name),
        };
        await commitConfig(nextConfig);
        sendJson(res, 200, { ok: true });
      });
      return;
    }

    throw methodNotAllowed(method);
  }

  async function handleDiscoverModels(req, res) {
    const body = await readJsonBody(req);
    let apiKey = typeof body.apiKey === 'string' ? body.apiKey : '';
    if (!apiKey && typeof body.reuseKeyFrom === 'string') {
      const saved = getProvider(body.reuseKeyFrom);
      apiKey = saved?.apiKey ?? '';
    }

    const draft = validateProvider({
      name: 'draft',
      label: 'draft',
      baseUrl: body.baseUrl,
      protocol: body.protocol,
      authStyle: body.authStyle,
      apiKey,
      models: [],
      enabled: true,
    });

    try {
      const result = await fetchProviderModels(draft);
      sendJson(res, 200, {
        ok: true,
        models: result.models,
        count: result.models.length,
        latencyMs: result.latencyMs,
        fetchedAt: result.fetchedAt,
      });
    } catch (error) {
      sendJson(res, 200, { ok: false, error: truncate(error.message, 800) });
    }
  }

  async function handleModels(req, res, url) {
    if (req.method !== 'GET') throw methodNotAllowed(req.method);
    const refresh = ['1', 'true', 'yes'].includes(
      String(url.searchParams.get('refresh') || '').toLowerCase(),
    );
    const result = await aggregateModels(config.providers, { refresh });
    sendJson(res, 200, result);
  }

  async function handleProxy(req, res, url) {
    if (req.method !== 'POST') throw methodNotAllowed(req.method);

    const payload = await readJsonBody(req, MAX_PROXY_BODY);
    if (typeof payload.model !== 'string' || !payload.model.trim()) {
      throw new HttpError(400, '请求体必须包含 model，格式为 provider/model', {
        code: 'missing_model',
      });
    }

    const ref = parseModelReference(payload.model);
    if (!ref) {
      throw new HttpError(
        400,
        'model 必须使用 provider/model 格式；模型 id 可以包含额外的斜杠',
        { code: 'invalid_model_reference' },
      );
    }

    const provider = getProvider(ref.provider);
    if (!provider) {
      throw new HttpError(404, `未注册提供商 "${ref.provider}"`, {
        type: 'invalid_request_error',
        code: 'provider_not_found',
      });
    }
    if (!provider.enabled) {
      throw new HttpError(503, `提供商 "${ref.provider}" 已停用`, {
        type: 'server_error',
        code: 'provider_disabled',
      });
    }

    const logId = addLog({
      method: req.method,
      path: url.pathname,
      provider: provider.name,
      model: ref.model,
    });
    const startedAt = Date.now();

    try {
      await proxyRequest({
        req,
        res,
        provider,
        payload,
        modelReference: ref,
        pathname: url.pathname,
        search: url.search,
        onComplete: ({ status, error, durationMs }) => {
          completeLog(logId, {
            status,
            error,
            durationMs: durationMs ?? Date.now() - startedAt,
          });
        },
      });
    } catch (error) {
      completeLog(logId, {
        status: 500,
        error: error.message,
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  async function handleApi(req, res, url, pathname) {
    if (pathname === '/api/state' && req.method === 'GET') {
      sendJson(res, 200, await buildState());
      return true;
    }

    if (pathname === '/api/providers') {
      await handleProviderCollection(req, res, req.method);
      return true;
    }

    const providerTestMatch = pathname.match(/^\/api\/providers\/([^/]+)\/test$/);
    if (providerTestMatch) {
      await handleProviderItem(
        req,
        res,
        req.method,
        decodePathSegment(providerTestMatch[1]),
        true,
      );
      return true;
    }

    const providerMatch = pathname.match(/^\/api\/providers\/([^/]+)$/);
    if (providerMatch) {
      await handleProviderItem(
        req,
        res,
        req.method,
        decodePathSegment(providerMatch[1]),
        false,
      );
      return true;
    }

    if (pathname === '/api/discover-models') {
      if (req.method !== 'POST') throw methodNotAllowed(req.method);
      await handleDiscoverModels(req, res);
      return true;
    }

    if (pathname === '/api/catalog') {
      if (req.method !== 'GET') throw methodNotAllowed(req.method);
      const refresh = url.searchParams.get('refresh') === '1';
      const catalog = await getProviderCatalog({ refresh });
      sendJson(res, 200, { ...catalog, protocols: PROTOCOLS });
      return true;
    }

    if (pathname === '/api/stats') {
      if (req.method !== 'GET') throw methodNotAllowed(req.method);
      sendJson(res, 200, {
        stats: getStats(),
        recentLogs: getRecentLogs(8),
      });
      return true;
    }

    if (pathname === '/api/logs') {
      if (req.method === 'GET') {
        const limit = Number(url.searchParams.get('limit')) || 100;
        sendJson(res, 200, { logs: listLogs(limit) });
        return true;
      }
      if (req.method === 'DELETE') {
        clearLogs();
        sendJson(res, 200, { ok: true });
        return true;
      }
      throw methodNotAllowed(req.method);
    }

    if (pathname === '/api/autostart') {
      if (req.method === 'GET') {
        sendJson(res, 200, { autostart: await getAutostartStatus() });
        return true;
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        if (typeof body.enabled !== 'boolean') {
          throw new HttpError(400, 'enabled 必须是布尔值', {
            code: 'invalid_autostart_value',
          });
        }
        const scriptPath = path.resolve(
          process.argv[1] || fileURLToPath(import.meta.url),
        );
        let autostart;
        try {
          autostart = await setAutostart(body.enabled, {
            scriptPath,
            configPath,
            host: options.host,
            port: options.port,
          });
        } catch (error) {
          throw new HttpError(500, `设置自启动失败：${error.message}`, {
            type: 'server_error',
            code: 'autostart_failed',
          });
        }
        sendJson(res, 200, { autostart });
        return true;
      }
      throw methodNotAllowed(req.method);
    }

    if (pathname === '/api/models') {
      await handleModels(req, res, url);
      return true;
    }

    return false;
  }

  async function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw methodNotAllowed(req.method);

    let filePath = resolveStaticFile(pathname);
    if (!filePath) return false;

    let stats;
    try {
      stats = await fs.stat(filePath);
    } catch (error) {
      if (error.code === 'ENOENT') throw assetNotFound();
      throw error;
    }
    if (stats.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }

    let body;
    try {
      body = await fs.readFile(filePath);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EISDIR') throw assetNotFound();
      throw error;
    }

    res.writeHead(200, {
      'content-type': contentTypeFor(filePath),
      'content-length': body.length,
      'cache-control': 'no-cache',
    });
    if (req.method === 'HEAD') res.end();
    else res.end(body);
    return true;
  }

  async function handleRequest(req, res) {
    setSecurityHeaders(res);

    if (isLoopbackHost(options.host) && !hostHeaderAllowed(req.headers.host, options.host)) {
      throw new HttpError(403, 'Host 头不被允许', {
        type: 'invalid_request_error',
        code: 'invalid_host',
      });
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const { pathname } = url;

    if (pathname === '/health' && req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        name: 'Provider Router',
        version: SERVER_VERSION,
        uptimeSeconds: getStats().uptimeSeconds,
      });
      return;
    }

    if (pathname.startsWith('/api/')) {
      const handled = await handleApi(req, res, url, pathname);
      if (!handled) {
        throw new HttpError(404, '接口不存在', {
          type: 'invalid_request_error',
          code: 'not_found',
        });
      }
      return;
    }

    if (pathname === '/models' || pathname === '/v1/models') {
      await handleModels(req, res, url);
      return;
    }

    if (pathname.startsWith('/v1/')) {
      await handleProxy(req, res, url);
      return;
    }

    if (await serveStatic(req, res, pathname)) return;

    throw new HttpError(404, '页面不存在；图形控制台位于 /', {
      type: 'invalid_request_error',
      code: 'not_found',
    });
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      if (!(error instanceof HttpError)) {
        logError(`请求处理失败：${error.stack || error.message}`);
      }
      if (res.headersSent) {
        res.destroy();
        return;
      }
      try {
        sendError(res, error);
      } catch {
        res.destroy();
      }
    });
  });

  server.headersTimeout = 60_000;
  server.requestTimeout = 0;
  server.keepAliveTimeout = 65_000;

  server.on('clientError', (error, socket) => {
    if (!socket.writable) return;
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(options.port, options.host);
    });
  } catch (error) {
    if (error.code === 'EADDRINUSE') {
      console.error(`端口 ${options.port} 已被占用。使用 --port 指定其他端口。`);
    } else if (error.code === 'EACCES') {
      console.error(`没有权限监听 ${options.host}:${options.port}。`);
    } else {
      console.error(`HTTP 服务启动失败：${error.message}`);
    }
    process.exitCode = 1;
    return;
  }

  log(`Provider Router ${SERVER_VERSION}`);
  log(`控制台  ${dashboardUrl}`);
  log(`网关    ${gatewayBaseUrl}`);
  log(`配置    ${configPath}`);
  if (options.host === '0.0.0.0' || options.host === '::') {
    logError('警告：服务正在监听所有网络接口，请确认防火墙与 api-key 配置。');
  }

  if (options.open) {
    openBrowser(dashboardUrl, logError);
  }

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`收到 ${signal}，正在关闭…`);
    server.close(() => process.exit(0));
    const timer = setTimeout(() => process.exit(1), 4000);
    timer.unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function openBrowser(url, onError) {
  const platform = process.platform;
  const command = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open';
  const args =
    platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', (error) => onError(`无法自动打开浏览器：${error.message}`));
    child.unref();
  } catch (error) {
    onError(`无法自动打开浏览器：${error.message}`);
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
