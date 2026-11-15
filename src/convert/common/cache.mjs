import { isPlainObject } from '../../util.mjs';

const MAX_CACHE_BREAKPOINTS = 4;
const HISTORY_BREAKPOINT_MIN_MESSAGES = 4;
const EPHEMERAL_CACHE_TYPE = 'ephemeral';
const DEFAULT_SYSTEM_BLOCK_TYPE = 'text';
const TOO_MANY_BREAKPOINTS = 'too_many_cache_breakpoints';
const NON_CACHEABLE_BLOCK_TYPES = new Set(['thinking', 'redacted_thinking']);

/** 统计 tools、system、messages content 上已有的 cache_control 断点数量。 */
export function countCacheBreakpoints(body) {
  if (!isPlainObject(body)) return 0;

  const tools = Array.isArray(body.tools) ? body.tools : [];
  const system = Array.isArray(body.system) ? body.system : [];
  const messages = Array.isArray(body.messages) ? body.messages : [];

  const messageBreakpoints = messages.reduce(
    (total, message) => total + countBreakpoints(messageContent(message)),
    0,
  );
  return countBreakpoints(tools) + countBreakpoints(system) + messageBreakpoints;
}

/**
 * 按固定优先级注入 Anthropic prompt cache 断点，最多 4 个。
 * 返回深拷贝后的 body；已有断点不覆盖、不删除，warnings 不含 prompt 内容。
 */
export function injectAnthropicCacheControl(body) {
  const cloned = structuredClone(body);
  if (!isPlainObject(cloned)) return { body: cloned, warnings: [] };

  const existing = countCacheBreakpoints(cloned);
  if (existing > MAX_CACHE_BREAKPOINTS) {
    return { body: cloned, warnings: [{ code: TOO_MANY_BREAKPOINTS, count: existing }] };
  }

  let budget = MAX_CACHE_BREAKPOINTS - existing;
  const injectors = [
    injectToolBreakpoint,
    injectSystemBreakpoint,
    injectLastMessageBreakpoint,
    injectSecondLastUserBreakpoint,
  ];
  for (const inject of injectors) {
    if (budget === 0) break;
    if (inject(cloned)) budget -= 1;
  }
  return { body: cloned, warnings: [] };
}

function countBreakpoints(entries) {
  return entries.filter(hasCacheControl).length;
}

function hasCacheControl(entry) {
  return isPlainObject(entry) && entry.cache_control != null;
}

function messageContent(message) {
  return isPlainObject(message) && Array.isArray(message.content) ? message.content : [];
}

function injectToolBreakpoint(body) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return addCacheControl(tools.at(-1));
}

function injectSystemBreakpoint(body) {
  if (typeof body.system === 'string') {
    body.system = [{ type: DEFAULT_SYSTEM_BLOCK_TYPE, text: body.system }];
  }
  const system = Array.isArray(body.system) ? body.system : [];
  return addCacheControl(system.at(-1));
}

function injectLastMessageBreakpoint(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const block = lastCacheableBlock(messageContent(messages[index]));
    if (block && addCacheControl(block)) return true;
  }
  return false;
}

function injectSecondLastUserBreakpoint(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length < HISTORY_BREAKPOINT_MIN_MESSAGES) return false;

  const userMessages = messages.filter(
    (message) => isPlainObject(message) && message.role === 'user',
  );
  if (userMessages.length < 2) return false;

  return addCacheControl(lastCacheableBlock(messageContent(userMessages.at(-2))));
}

function lastCacheableBlock(blocks) {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (isPlainObject(block) && NON_CACHEABLE_BLOCK_TYPES.has(block.type)) continue;
    return block;
  }
  return null;
}

function addCacheControl(target) {
  if (!isPlainObject(target) || target.cache_control != null) return false;
  target.cache_control = { type: EPHEMERAL_CACHE_TYPE };
  return true;
}
