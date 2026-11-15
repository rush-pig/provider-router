import { isPlainObject } from '../../util.mjs';

const ROOT_SCHEMA_TYPE = 'object';
const REMOVED_SCHEMA_FORMATS = new Set(['uri']);

/**
 * 清洗工具入参 schema：补齐根节点、去掉上游不接受的 format。
 * 返回深拷贝，不修改调用方对象。
 */
export function cleanSchema(schema) {
  const cleaned = cloneSchemaNode(isPlainObject(schema) ? schema : {});
  if (cleaned.type === undefined) cleaned.type = ROOT_SCHEMA_TYPE;
  if (cleaned.properties === undefined) cleaned.properties = {};
  return cleaned;
}

/** Anthropic tool_choice → OpenAI Chat Completions tool_choice。 */
export function mapToolChoiceToChat(toolChoice) {
  if (typeof toolChoice === 'string') {
    return toolChoice.trim().toLowerCase() === 'any' ? 'required' : toolChoice;
  }
  if (!isPlainObject(toolChoice)) return undefined;

  switch (toolChoice.type) {
    case 'any':
      return 'required';
    case 'auto':
    case 'none':
      return toolChoice.type;
    case 'tool': {
      const name = toolChoiceName(toolChoice);
      return name === null ? undefined : { type: 'function', function: { name } };
    }
    default:
      return undefined;
  }
}

/** Anthropic tool_choice → OpenAI Responses tool_choice。 */
export function mapToolChoiceToResponses(toolChoice) {
  if (typeof toolChoice === 'string') {
    return toolChoice.trim().toLowerCase() === 'any' ? 'required' : toolChoice;
  }
  if (!isPlainObject(toolChoice)) return undefined;

  switch (toolChoice.type) {
    case 'any':
      return 'required';
    case 'auto':
    case 'none':
      return toolChoice.type;
    case 'tool': {
      const name = toolChoiceName(toolChoice);
      return name === null ? undefined : { type: 'function', name };
    }
    default:
      return undefined;
  }
}

/** Chat Completions / Responses tool_choice → Anthropic tool_choice。 */
export function mapToolChoiceToAnthropic(toolChoice) {
  if (typeof toolChoice === 'string') {
    const value = toolChoice.trim().toLowerCase();
    if (value === 'required') return 'any';
    return value === 'auto' || value === 'none' || value === 'any' ? value : undefined;
  }
  if (!isPlainObject(toolChoice)) return undefined;

  switch (toolChoice.type) {
    case 'required':
      return 'any';
    case 'auto':
    case 'none':
    case 'any':
      return toolChoice.type;
    case 'function':
    case 'tool': {
      const name = toolChoiceName(toolChoice);
      return name === null ? undefined : { type: 'tool', name };
    }
    default:
      return undefined;
  }
}

/** 递归按 key 排序后序列化，保证相同工具参数得到稳定字节。 */
export function canonicalJson(value) {
  return JSON.stringify(sortJsonValue(value));
}

/** 解析 JSON 对象文本；非对象、非字符串或非法 JSON 一律返回 null。 */
export function parseJsonObject(text) {
  if (typeof text !== 'string') return null;

  try {
    const parsed = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function cloneSchemaNode(value) {
  if (Array.isArray(value)) return value.map(cloneSchemaNode);
  if (!isPlainObject(value)) return value;

  const cloned = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'format' && REMOVED_SCHEMA_FORMATS.has(child)) continue;
    cloned[key] = cloneSchemaNode(child);
  }
  return cloned;
}

function toolChoiceName(toolChoice) {
  const nested = toolChoice.function;
  if (isPlainObject(nested) && typeof nested.name === 'string') return nested.name;
  return typeof toolChoice.name === 'string' ? toolChoice.name : null;
}

function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!isPlainObject(value)) return value;

  const sorted = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortJsonValue(value[key]);
  return sorted;
}
