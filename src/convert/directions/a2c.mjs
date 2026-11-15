import { randomUUID } from 'node:crypto';

import { isPlainObject } from '../../util.mjs';
import { stripLeadingBillingHeader, textFromContent } from '../common/messages.mjs';
import {
  clampReasoningEffort,
  isOpenAiOSeries,
  supportsReasoningEffort,
} from '../common/model-capabilities.mjs';
import { SSE_DONE, SseParser, formatSseJson } from '../common/sse.mjs';
import { resolveReasoningEffort } from '../common/thinking.mjs';
import { canonicalJson, cleanSchema, mapToolChoiceToChat } from '../common/tools.mjs';
import {
  neutralFromAnthropic,
  neutralToOpenAiChat,
} from '../common/usage.mjs';

const SYSTEM_BLOCK_SEPARATOR = '\n';
const TEXT_SEPARATOR = '\n';
const BATCH_TOOL_NAME = 'BatchTool';
const BATCH_TOOL_TYPE = 'batch_tool';
const DROPPED_REQUEST_FIELDS = Object.freeze([
  'metadata',
  'top_k',
  'service_tier',
  'container',
  'mcp_servers',
  'context_management',
  'betas',
]);
const ANTHROPIC_STOP_REASONS = Object.freeze({
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  refusal: 'content_filter',
});
const COMPLETION_OBJECT = 'chat.completion';
const CHUNK_OBJECT = 'chat.completion.chunk';
const COMPLETION_ID_PREFIX = 'chatcmpl-';
const CALL_ID_PREFIX = 'call_';
const DEFAULT_FINISH_REASON = 'stop';
const DONE_MARKER = '[DONE]';

function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

function addWarning(warnings, code, field) {
  const exists = warnings.some(
    (warning) => warning.code === code && warning.field === field,
  );
  if (exists) return;
  warnings.push(field === undefined ? { code } : { code, field });
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function resolveCallId(value) {
  return typeof value === 'string' && value !== '' ? value : `${CALL_ID_PREFIX}${randomUUID()}`;
}

function resolveCompletionId(value) {
  return typeof value === 'string' && value !== ''
    ? value
    : `${COMPLETION_ID_PREFIX}${randomUUID()}`;
}

function resolveModelName(value, request) {
  if (typeof value === 'string' && value !== '') return value;
  return typeof request?.model === 'string' ? request.model : '';
}

function currentUnixSeconds() {
  return Math.floor(Date.now() / 1000);
}

function mapAnthropicStopReason(reason) {
  return ANTHROPIC_STOP_REASONS[reason] ?? DEFAULT_FINISH_REASON;
}

function joinFrames(frames) {
  return frames.length === 0 ? null : frames.join('');
}

/**
 * 相邻字段合并时取最新非零值：Anthropic 的 message_start 已给出 input_tokens，
 * message_delta 再次给出累计 output_tokens，直接相加会重复计数。
 */
function mergeUsagePreferLatest(base, extra) {
  return {
    inputTokens: extra.inputTokens > 0 ? extra.inputTokens : base.inputTokens,
    outputTokens: extra.outputTokens > 0 ? extra.outputTokens : base.outputTokens,
    cacheReadTokens: extra.cacheReadTokens > 0 ? extra.cacheReadTokens : base.cacheReadTokens,
    cacheCreationTokens: extra.cacheCreationTokens > 0
      ? extra.cacheCreationTokens
      : base.cacheCreationTokens,
  };
}

function convertSystem(system) {
  if (typeof system === 'string') {
    const text = stripLeadingBillingHeader(system);
    return text.trim() === '' ? null : text;
  }
  if (!Array.isArray(system)) return null;

  const text = system
    .filter((block) => (
      isPlainObject(block)
      && block.type === 'text'
      && typeof block.text === 'string'
    ))
    .map((block) => stripLeadingBillingHeader(block.text))
    .join(SYSTEM_BLOCK_SEPARATOR);
  return text.trim() === '' ? null : text;
}

function convertImageBlock(block) {
  const source = isPlainObject(block.source) ? block.source : null;
  if (source === null) return null;

  if (
    source.type === 'base64'
    && typeof source.media_type === 'string'
    && typeof source.data === 'string'
  ) {
    return {
      type: 'image_url',
      image_url: { url: `data:${source.media_type};base64,${source.data}` },
    };
  }
  if (source.type === 'url' && typeof source.url === 'string' && source.url !== '') {
    return { type: 'image_url', image_url: { url: source.url } };
  }
  return null;
}

function convertToolUseBlock(block, warnings) {
  if (typeof block.name !== 'string' || block.name === '') {
    addWarning(warnings, 'invalid_tool_use', 'messages');
    return null;
  }
  return {
    id: resolveCallId(block.id),
    type: 'function',
    function: {
      name: block.name,
      arguments: canonicalJson(block.input ?? {}),
    },
  };
}

function appendAssistantMessage(message, output, warnings) {
  const textParts = [];
  const toolCalls = [];

  if (typeof message.content === 'string') {
    if (message.content !== '') textParts.push({ type: 'text', text: message.content });
  } else if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (!isPlainObject(block)) continue;
      if (block.type === 'text') {
        if (typeof block.text === 'string' && block.text !== '') {
          textParts.push({ type: 'text', text: block.text });
        }
      } else if (block.type === 'tool_use') {
        const toolCall = convertToolUseBlock(block, warnings);
        if (toolCall !== null) toolCalls.push(toolCall);
      } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        addWarning(warnings, 'thinking_dropped', 'messages');
      } else {
        addWarning(warnings, 'unsupported_content_block', 'messages');
      }
    }
  }

  if (textParts.length === 0 && toolCalls.length === 0) return;
  const converted = {
    role: 'assistant',
    content: textParts.length === 0 ? null : textParts,
  };
  if (toolCalls.length > 0) converted.tool_calls = toolCalls;
  output.push(converted);
}

function splitToolResultContent(content, warnings) {
  if (typeof content === 'string') return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: '', images: [] };

  const textParts = [];
  const images = [];
  for (const block of content) {
    if (!isPlainObject(block)) continue;
    if (block.type === 'text') {
      if (typeof block.text === 'string' && block.text !== '') textParts.push(block.text);
    } else if (block.type === 'image') {
      const imagePart = convertImageBlock(block);
      if (imagePart === null) {
        addWarning(warnings, 'invalid_image_block', 'messages');
      } else {
        images.push(imagePart);
      }
    } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      addWarning(warnings, 'thinking_dropped', 'messages');
    } else {
      addWarning(warnings, 'unsupported_content_block', 'messages');
    }
  }
  return { text: textParts.join(TEXT_SEPARATOR), images };
}

function convertToolResultBlock(block, warnings) {
  if (typeof block.tool_use_id !== 'string' || block.tool_use_id === '') {
    addWarning(warnings, 'missing_tool_use_id', 'messages');
  }
  const { text, images } = splitToolResultContent(block.content, warnings);
  return {
    toolMessage: {
      role: 'tool',
      tool_call_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
      content: text,
    },
    images,
  };
}

function appendUserMessage(message, output, warnings) {
  if (typeof message.content === 'string') {
    if (message.content !== '') output.push({ role: 'user', content: message.content });
    return;
  }
  if (!Array.isArray(message.content)) return;

  const toolMessages = [];
  const userParts = [];
  for (const block of message.content) {
    if (!isPlainObject(block)) continue;
    if (block.type === 'text') {
      if (typeof block.text === 'string' && block.text !== '') {
        userParts.push({ type: 'text', text: block.text });
      }
    } else if (block.type === 'image') {
      const imagePart = convertImageBlock(block);
      if (imagePart === null) {
        addWarning(warnings, 'invalid_image_block', 'messages');
      } else {
        userParts.push(imagePart);
      }
    } else if (block.type === 'tool_result') {
      const { toolMessage, images } = convertToolResultBlock(block, warnings);
      toolMessages.push(toolMessage);
      userParts.push(...images);
    } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      addWarning(warnings, 'thinking_dropped', 'messages');
    } else {
      addWarning(warnings, 'unsupported_content_block', 'messages');
    }
  }

  // Chat 协议要求 tool 消息紧跟在带 tool_calls 的 assistant 消息之后。
  output.push(...toolMessages);
  if (userParts.length > 0) output.push({ role: 'user', content: userParts });
}

function convertAnthropicMessages(messages, warnings) {
  if (!Array.isArray(messages)) return [];

  const converted = [];
  for (const message of messages) {
    if (!isPlainObject(message)) continue;
    if (message.role === 'assistant') {
      appendAssistantMessage(message, converted, warnings);
    } else if (message.role === 'user') {
      appendUserMessage(message, converted, warnings);
    } else {
      addWarning(warnings, 'unsupported_message_role', 'messages');
    }
  }
  return converted;
}

function convertAnthropicTools(tools, warnings) {
  if (!Array.isArray(tools)) return [];

  const converted = [];
  for (const tool of tools) {
    if (!isPlainObject(tool)) {
      addWarning(warnings, 'invalid_tool', 'tools');
      continue;
    }
    if (tool.name === BATCH_TOOL_NAME || tool.type === BATCH_TOOL_TYPE) {
      addWarning(warnings, 'unsupported_tool', 'tools');
      continue;
    }
    if (typeof tool.name !== 'string' || tool.name === '') {
      addWarning(warnings, 'invalid_tool', 'tools');
      continue;
    }

    const fn = { name: tool.name, parameters: cleanSchema(tool.input_schema) };
    if (typeof tool.description === 'string' && tool.description !== '') {
      fn.description = tool.description;
    }
    converted.push({ type: 'function', function: fn });
  }
  return converted;
}

function assignMaxTokens(target, maxTokens, model) {
  if (!isFiniteNumber(maxTokens) || maxTokens <= 0) return;
  const field = isOpenAiOSeries(model) ? 'max_completion_tokens' : 'max_tokens';
  target[field] = Math.floor(maxTokens);
}

function assignSamplingParameters(target, source) {
  if (isFiniteNumber(source.temperature)) target.temperature = source.temperature;
  if (isFiniteNumber(source.top_p)) target.top_p = source.top_p;
}

function assignStopSequences(target, stopSequences) {
  if (Array.isArray(stopSequences) && stopSequences.length > 0) {
    target.stop = stopSequences;
  } else if (typeof stopSequences === 'string' && stopSequences !== '') {
    target.stop = stopSequences;
  }
}

function assignReasoningEffort(target, source, model) {
  // resolveReasoningEffort 会读取 body.model 判断 'max' 是否可用。
  const effort = resolveReasoningEffort({ ...source, model });
  if (effort === null || !supportsReasoningEffort(model)) return;
  target.reasoning_effort = clampReasoningEffort(model, effort);
}

function hasCacheControl(value, visited = new WeakSet()) {
  if (value === null || typeof value !== 'object') return false;
  if (visited.has(value)) return false;
  visited.add(value);
  if (Array.isArray(value)) return value.some((item) => hasCacheControl(item, visited));
  if (value.cache_control !== undefined) return true;
  return Object.values(value).some((child) => hasCacheControl(child, visited));
}

function warnDroppedFields(source, warnings) {
  for (const field of DROPPED_REQUEST_FIELDS) {
    if (source[field] !== undefined) addWarning(warnings, 'dropped_field', field);
  }
  if (hasCacheControl(source)) addWarning(warnings, 'dropped_field', 'cache_control');
}

/**
 * 把 Anthropic Messages 请求转换为 OpenAI Chat Completions 请求。
 * @param {{ body: object, model: string }} input 已替换为上游模型 id 的请求体。
 * @returns {{ body: object, stream: boolean, warnings: Array<{ code: string, field?: string }> }}
 */
export function convertRequest({ body, model } = {}) {
  const source = isPlainObject(body) ? body : {};
  const warnings = [];
  const upstreamModel = model ?? source.model;
  const messages = convertAnthropicMessages(source.messages, warnings);
  const systemText = convertSystem(source.system);
  if (systemText !== null) messages.unshift({ role: 'system', content: systemText });

  const stream = source.stream === true;
  const converted = { model: upstreamModel, messages, stream };
  assignMaxTokens(converted, source.max_tokens, upstreamModel);
  assignSamplingParameters(converted, source);
  assignStopSequences(converted, source.stop_sequences);

  const tools = convertAnthropicTools(source.tools, warnings);
  if (tools.length > 0) {
    converted.tools = tools;
    const toolChoice = mapToolChoiceToChat(source.tool_choice);
    if (toolChoice !== undefined) converted.tool_choice = toolChoice;
  }

  assignReasoningEffort(converted, source, upstreamModel);
  if (stream) {
    converted.stream_options = {
      ...(isPlainObject(source.stream_options) ? source.stream_options : {}),
      include_usage: true,
    };
  }

  warnDroppedFields(source, warnings);
  return { body: converted, stream, warnings };
}

function collectThinkingText(blocks, warnings) {
  const parts = [];
  for (const block of blocks) {
    if (!isPlainObject(block)) continue;
    if (block.type === 'thinking') {
      if (typeof block.thinking === 'string' && block.thinking !== '') {
        parts.push(block.thinking);
      }
    } else if (block.type === 'redacted_thinking') {
      addWarning(warnings, 'redacted_thinking_dropped', 'content');
    }
  }
  return parts.join(TEXT_SEPARATOR);
}

function collectToolCalls(blocks) {
  const toolCalls = [];
  for (const block of blocks) {
    if (!isPlainObject(block) || block.type !== 'tool_use') continue;
    toolCalls.push({
      id: resolveCallId(block.id),
      type: 'function',
      function: {
        name: typeof block.name === 'string' ? block.name : '',
        arguments: canonicalJson(block.input ?? {}),
      },
    });
  }
  return toolCalls;
}

/**
 * 把 Anthropic Messages 非流式响应转换为 OpenAI Chat Completions 响应。
 * @param {{ body: object, request: object }} input
 * @returns {{ body: object, warnings: Array<{ code: string, field?: string }> }}
 */
export function convertResponse({ body, request } = {}) {
  const response = isPlainObject(body) ? body : {};
  const warnings = [];
  const blocks = Array.isArray(response.content) ? response.content : [];
  const text = textFromContent(blocks);
  const reasoning = collectThinkingText(blocks, warnings);
  const toolCalls = collectToolCalls(blocks);

  const message = {
    role: 'assistant',
    content: text === '' ? null : text,
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  if (reasoning !== '') message.reasoning_content = reasoning;

  return {
    body: {
      id: resolveCompletionId(response.id),
      object: COMPLETION_OBJECT,
      created: currentUnixSeconds(),
      model: resolveModelName(response.model, request),
      choices: [{
        index: 0,
        message,
        finish_reason: mapAnthropicStopReason(response.stop_reason),
      }],
      usage: neutralToOpenAiChat(neutralFromAnthropic(response.usage)),
    },
    warnings,
  };
}

class AnthropicToChatStream {
  #parser = new SseParser();
  #warnings = [];
  #created = currentUnixSeconds();
  #chatId = null;
  #model;
  #started = false;
  #done = false;
  #terminalSent = false;
  #stopReason = DEFAULT_FINISH_REASON;
  #usage = emptyUsage();
  #toolIndexByBlock = new Map();
  #nextToolIndex = 0;

  constructor(request) {
    this.#model = typeof request?.model === 'string' ? request.model : '';
  }

  get done() {
    return this.#done;
  }

  get warnings() {
    return this.#warnings;
  }

  push(chunk) {
    if (this.#done) return null;
    return joinFrames(this.#processEvents(this.#parser.push(chunk)));
  }

  end() {
    if (this.#done) return null;
    const frames = this.#processEvents(this.#parser.end());
    if (!this.#terminalSent) {
      // 上游没有 message_stop 时必须补结束标记，否则 Chat 客户端会一直等待。
      frames.push(SSE_DONE);
      this.#terminalSent = true;
    }
    this.#done = true;
    return joinFrames(frames);
  }

  #processEvents(events) {
    const frames = [];
    for (const event of events) {
      if (this.#done) break;
      this.#handleSseEvent(event, frames);
    }
    return frames;
  }

  #handleSseEvent(event, frames) {
    if (event.data.trim() === DONE_MARKER) {
      if (!this.#terminalSent) {
        frames.push(SSE_DONE);
        this.#terminalSent = true;
      }
      this.#done = true;
      return;
    }

    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      this.#addWarning('invalid_upstream_event');
      return;
    }
    if (!isPlainObject(payload)) return;

    const type = typeof payload.type === 'string' ? payload.type : event.event;
    switch (type) {
      case 'message_start':
        this.#handleMessageStart(payload, frames);
        break;
      case 'content_block_start':
        this.#handleContentBlockStart(payload, frames);
        break;
      case 'content_block_delta':
        this.#handleContentBlockDelta(payload, frames);
        break;
      case 'message_delta':
        this.#handleMessageDelta(payload);
        break;
      case 'message_stop':
        this.#handleMessageStop(frames);
        break;
      case 'error':
        this.#handleError(payload, frames);
        break;
      default:
        break;
    }
  }

  #ensureChatStart(frames) {
    if (this.#started) return;
    this.#started = true;
    if (this.#chatId === null) this.#chatId = resolveCompletionId(null);
    frames.push(formatSseJson({
      id: this.#chatId,
      object: CHUNK_OBJECT,
      created: this.#created,
      model: this.#model,
      choices: [{
        index: 0,
        delta: { role: 'assistant', content: '' },
        finish_reason: null,
      }],
    }));
  }

  #emitChunk(frames, { delta, finishReason = null, usage }) {
    const chunk = {
      id: this.#chatId,
      object: CHUNK_OBJECT,
      created: this.#created,
      model: this.#model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    if (usage !== undefined) chunk.usage = usage;
    frames.push(formatSseJson(chunk));
  }

  #handleMessageStart(payload, frames) {
    const message = isPlainObject(payload.message) ? payload.message : {};
    if (this.#chatId === null && typeof message.id === 'string' && message.id !== '') {
      this.#chatId = message.id;
    }
    if (typeof message.model === 'string' && message.model !== '') {
      this.#model = message.model;
    }
    this.#usage = mergeUsagePreferLatest(this.#usage, neutralFromAnthropic(message.usage));
    this.#ensureChatStart(frames);
  }

  #handleContentBlockStart(payload, frames) {
    const block = isPlainObject(payload.content_block) ? payload.content_block : {};
    if (block.type !== 'tool_use') return;

    this.#ensureChatStart(frames);
    const toolIndex = this.#nextToolIndex;
    this.#nextToolIndex += 1;
    this.#toolIndexByBlock.set(payload.index, toolIndex);
    this.#emitChunk(frames, {
      delta: {
        tool_calls: [{
          index: toolIndex,
          id: resolveCallId(block.id),
          type: 'function',
          function: {
            name: typeof block.name === 'string' ? block.name : '',
            arguments: '',
          },
        }],
      },
    });
  }

  #handleContentBlockDelta(payload, frames) {
    const delta = isPlainObject(payload.delta) ? payload.delta : {};
    switch (delta.type) {
      case 'text_delta':
        if (typeof delta.text === 'string' && delta.text !== '') {
          this.#ensureChatStart(frames);
          this.#emitChunk(frames, { delta: { content: delta.text } });
        }
        break;
      case 'thinking_delta':
        if (typeof delta.thinking === 'string' && delta.thinking !== '') {
          this.#ensureChatStart(frames);
          this.#emitChunk(frames, { delta: { reasoning_content: delta.thinking } });
        }
        break;
      case 'input_json_delta': {
        const toolIndex = this.#toolIndexByBlock.get(payload.index);
        if (toolIndex === undefined) {
          this.#addWarning('tool_delta_without_start', 'content');
          break;
        }
        const partialJson = typeof delta.partial_json === 'string' ? delta.partial_json : '';
        if (partialJson !== '') {
          this.#emitChunk(frames, {
            delta: {
              tool_calls: [{ index: toolIndex, function: { arguments: partialJson } }],
            },
          });
        }
        break;
      }
      case 'signature_delta':
        break;
      default:
        break;
    }
  }

  #handleMessageDelta(payload) {
    const delta = isPlainObject(payload.delta) ? payload.delta : {};
    if (typeof delta.stop_reason === 'string') {
      this.#stopReason = mapAnthropicStopReason(delta.stop_reason);
    }
    this.#usage = mergeUsagePreferLatest(this.#usage, neutralFromAnthropic(payload.usage));
  }

  #handleMessageStop(frames) {
    if (this.#terminalSent) return;
    this.#ensureChatStart(frames);
    this.#emitChunk(frames, {
      delta: {},
      finishReason: this.#stopReason,
      usage: neutralToOpenAiChat(this.#usage),
    });
    frames.push(SSE_DONE);
    this.#terminalSent = true;
    this.#done = true;
  }

  #handleError(payload, frames) {
    if (this.#terminalSent) return;
    frames.push(formatSseJson({ error: payload.error ?? payload }));
    frames.push(SSE_DONE);
    this.#terminalSent = true;
    this.#done = true;
  }

  #addWarning(code, field) {
    addWarning(this.#warnings, code, field);
  }
}

/**
 * 创建 Anthropic SSE → OpenAI Chat SSE 的增量转换器。
 * @param {{ request: object }} input request 为转换后的 Chat 上游请求体。
 */
export function createStreamConverter({ request } = {}) {
  return new AnthropicToChatStream(request);
}
