import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isAuthStyle, resolveAuthStyle } from './auth.mjs';
import { HttpError, isPlainObject, nowIso, uniqueStrings } from './util.mjs';
import { isProtocol } from './protocols.mjs';

const PROVIDER_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MODEL_LIMIT = 5000;
const MODEL_ID_LIMIT = 500;

export function defaultConfigPath() {
  if (process.env.PROVIDER_ROUTER_CONFIG) {
    return path.resolve(process.env.PROVIDER_ROUTER_CONFIG);
  }

  const home = os.homedir();
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'provider-router', 'config.json');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'provider-router', 'config.json');
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(configHome, 'provider-router', 'config.json');
}

function createEmptyConfig() {
  return { version: 1, providers: [] };
}

function normalizeBaseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, 'API 接口地址不能为空', { code: 'missing_base_url' });
  }

  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new HttpError(400, 'API 接口地址不是有效 URL', { code: 'invalid_base_url' });
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HttpError(400, 'API 接口地址必须使用 http 或 https', {
      code: 'invalid_base_url_protocol',
    });
  }
  if (parsed.username || parsed.password) {
    throw new HttpError(400, 'API 接口地址不能包含用户名或密码', {
      code: 'invalid_base_url_credentials',
    });
  }
  if (parsed.search || parsed.hash) {
    throw new HttpError(400, 'API 接口地址不能包含查询参数或锚点', {
      code: 'invalid_base_url_parts',
    });
  }

  const pathname = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${pathname}`;
}

function normalizeModels(value) {
  let list = value;
  if (list === undefined || list === null) list = [];
  if (typeof list === 'string') {
    list = list.split(/\r?\n/);
  }
  if (!Array.isArray(list)) {
    throw new HttpError(400, '模型列表必须是数组或逐行文本', { code: 'invalid_models' });
  }
  if (list.length > MODEL_LIMIT) {
    throw new HttpError(400, `模型数量不能超过 ${MODEL_LIMIT}`, { code: 'too_many_models' });
  }

  const cleaned = [];
  for (const item of list) {
    if (typeof item !== 'string') {
      throw new HttpError(400, '模型 id 必须是字符串', { code: 'invalid_model_id' });
    }
    const model = item.trim();
    if (!model) continue;
    if (model.length > MODEL_ID_LIMIT) {
      throw new HttpError(400, `模型 id 不能超过 ${MODEL_ID_LIMIT} 个字符`, {
        code: 'model_id_too_long',
      });
    }
    if (/[\u0000-\u001f\u007f]/.test(model)) {
      throw new HttpError(400, '模型 id 不能包含控制字符', { code: 'invalid_model_id' });
    }
    cleaned.push(model);
  }

  return uniqueStrings(cleaned);
}

function normalizeName(value, previousName) {
  const raw = value === undefined && previousName ? previousName : value;
  const name = String(raw ?? '').trim().toLowerCase();
  if (!PROVIDER_NAME_PATTERN.test(name)) {
    throw new HttpError(
      400,
      '提供商名称需为 1–64 位小写字母、数字、点、下划线或连字符，且不能包含斜杠',
      { code: 'invalid_provider_name' },
    );
  }
  return name;
}

/**
 * Normalizes and validates a provider payload. An existing API key is kept if
 * the update omits `apiKey` or sends an empty string. Use `clearApiKey: true`
 * to explicitly remove a stored key.
 */
export function validateProvider(input, { existingNames = [], previous = null } = {}) {
  if (!isPlainObject(input)) {
    throw new HttpError(400, '提供商配置必须是对象', { code: 'invalid_provider' });
  }

  const name = normalizeName(input.name, previous?.name);
  const conflict = existingNames
    .map((item) => String(item).toLowerCase())
    .some((item) => item === name && item !== previous?.name);
  if (conflict) {
    throw new HttpError(409, `提供商 "${name}" 已存在`, { code: 'provider_exists' });
  }

  const labelText = input.label === undefined ? previous?.label ?? name : input.label;
  if (typeof labelText !== 'string') {
    throw new HttpError(400, '显示名称必须是字符串', { code: 'invalid_label' });
  }
  const label = labelText.trim().slice(0, 80) || name;

  const protocol = input.protocol === undefined ? previous?.protocol ?? 'openai' : input.protocol;
  if (!isProtocol(protocol)) {
    throw new HttpError(400, `不支持的协议：${protocol}`, { code: 'invalid_protocol' });
  }

  const authStyle = input.authStyle === undefined ? previous?.authStyle ?? 'auto' : input.authStyle;
  if (!isAuthStyle(authStyle)) {
    throw new HttpError(400, `不支持的鉴权方式：${authStyle}`, { code: 'invalid_auth_style' });
  }

  const baseUrl = normalizeBaseUrl(input.baseUrl ?? previous?.baseUrl);
  const models = normalizeModels(input.models ?? previous?.models);

  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw new HttpError(400, 'enabled 必须是布尔值', { code: 'invalid_enabled' });
  }
  if (input.apiKey !== undefined && input.apiKey !== null && typeof input.apiKey !== 'string') {
    throw new HttpError(400, 'API Key 必须是字符串', { code: 'invalid_api_key' });
  }

  let apiKey = previous?.apiKey ?? '';
  if (input.clearApiKey === true) {
    apiKey = '';
  } else if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
    apiKey = input.apiKey.trim();
    if (apiKey.length > 10_000) {
      throw new HttpError(400, 'API Key 过长', { code: 'api_key_too_long' });
    }
    if (/[\u0000\r\n]/.test(apiKey)) {
      throw new HttpError(400, 'API Key 不能包含换行或控制字符', {
        code: 'invalid_api_key',
      });
    }
  }

  const enabled =
    input.enabled === undefined ? previous?.enabled ?? true : Boolean(input.enabled);
  const timestamp = nowIso();

  return {
    name,
    label,
    baseUrl,
    apiKey,
    protocol,
    authStyle,
    models,
    enabled,
    createdAt: previous?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
}

function validateProviderList(items) {
  const providers = [];
  const names = [];
  const issues = [];

  items.forEach((item, index) => {
    try {
      const provider = validateProvider(item, { existingNames: names });
      if (isPlainObject(item)) {
        if (typeof item.createdAt === 'string') provider.createdAt = item.createdAt;
        if (typeof item.updatedAt === 'string') provider.updatedAt = item.updatedAt;
      }
      names.push(provider.name);
      providers.push(provider);
    } catch (error) {
      issues.push(`第 ${index + 1} 项：${error.message}`);
    }
  });

  return { providers, issues };
}

export function publicProvider(provider) {
  const copy = { ...provider };
  delete copy.apiKey;
  copy.hasApiKey = Boolean(provider.apiKey);
  copy.apiKeyHint = provider.apiKey ? `••••${provider.apiKey.slice(-4)}` : '';
  copy.effectiveAuthStyle = resolveAuthStyle(provider);
  return copy;
}

async function saveConfig(configPath, config) {
  const directory = path.dirname(configPath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });

  const temporary = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  const body = `${JSON.stringify(config, null, 2)}\n`;
  await fs.writeFile(temporary, body, { mode: 0o600 });
  try {
    await fs.chmod(temporary, 0o600);
  } catch {
    // Windows and some filesystems do not support chmod.
  }
  await fs.rename(temporary, configPath);
  try {
    await fs.chmod(configPath, 0o600);
  } catch {
    // Ignore unsupported filesystems.
  }
}

let saveQueue = Promise.resolve();

export function persistConfig(configPath, config) {
  const snapshot = structuredClone(config);
  const task = saveQueue.then(() => saveConfig(configPath, snapshot));
  saveQueue = task.catch(() => {});
  return task;
}

export async function loadConfig(configPath) {
  let raw;
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const config = createEmptyConfig();
    await saveConfig(configPath, config);
    return { config, warning: null, backupPath: null };
  }

  let parsed;
  try {
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    parsed = JSON.parse(text);
  } catch (error) {
    return resetBrokenConfig(configPath, `JSON 解析失败：${error.message}`);
  }

  if (!isPlainObject(parsed) || !Array.isArray(parsed.providers)) {
    return resetBrokenConfig(configPath, '配置根节点缺少 providers 数组');
  }

  const { providers, issues } = validateProviderList(parsed.providers);
  const config = { version: 1, providers };
  if (!issues.length) {
    return { config, warning: null, backupPath: null };
  }

  const backupPath = `${configPath}.broken-${Date.now()}`;
  try {
    await fs.rename(configPath, backupPath);
    await saveConfig(configPath, config);
  } catch (backupError) {
    throw new Error(`部分提供商配置无效，且无法保存修正后的配置：${backupError.message}`, {
      cause: backupError,
    });
  }

  const detail = issues.slice(0, 5).join('；');
  const more = issues.length > 5 ? `；另有 ${issues.length - 5} 项` : '';
  return {
    config,
    warning: `有 ${issues.length} 个提供商条目无效，已备份原文件并保留 ${providers.length} 个有效条目。${detail}${more}`,
    backupPath,
  };
}

async function resetBrokenConfig(configPath, reason) {
  const backupPath = `${configPath}.broken-${Date.now()}`;
  try {
    await fs.rename(configPath, backupPath);
    const config = createEmptyConfig();
    await saveConfig(configPath, config);
    return {
      config,
      warning: `配置文件无效，已备份为 ${backupPath} 并创建空配置。原因：${reason}`,
      backupPath,
    };
  } catch (error) {
    throw new Error(`配置文件无效，且无法创建备份：${error.message}`);
  }
}
