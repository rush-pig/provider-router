import { randomUUID } from 'node:crypto';

import { isPlainObject } from '../../util.mjs';
import { injectAnthropicCacheControl } from '../common/cache.mjs';
import { DEFAULT_ANTHROPIC_MAX_TOKENS } from '../common/constants.mjs';
import { ConversionError, ConversionRequestError } from '../common/errors.mjs';
import { normalizeAnthropicMessages } from '../common/messages.mjs';
import { thinkingCannotBeDisabled } from '../common/model-capabilities.mjs';
import { SseParser, formatSseEvent } from '../common/sse.mjs';
import { thinkingForAnthropic } from '../common/thinking.mjs';
import { cleanSchema, mapToolChoiceToAnthropic, parseJsonObject } from '../common/tools.mjs';
import { mergeNeutral, neutralFromOpenAiChat, neutralToAnthropic } from '../common/usage.mjs';

const SYSTEM_ROLES = new Set(['system', 'developer']);
const SYSTEM_SEPARATOR = '\n\n';
const TEXT_SEPARATOR = '\n';
const CHAT_RESPONSE_TEXT_PART_TYPES = new Set(['text', 'output_text']);
const FORCED_TOOL_CHOICE_TYPES = new Set(['any', 'tool']);
const DROPPED_REQUEST_FIELDS = Object.freeze([
  'n',
  'response_format',
  'logprobs',
  'seed',
  'presence_penalty',
  'frequency_penalty',
  'service_tier',
  'user',
  'stream_options',
]);
const CHAT_FINISH_REASONS = Object.freeze({
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'end_turn',
});
const IMAGE_DATA_URI = /^data:([^;,]+);base64,([\s\S]+)$/;
const MESSAGE_ID_PREFIX = 'msg_';
const TOOL_USE_ID_PREFIX = 'toolu_';
const DEFAULT_STOP_REASON = 'end_turn';
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

function resolveToolUseId(value) {
  return typeof value === 'string' && value !== '' ? value : `${TOOL_USE_ID_PREFIX}${randomUUID()}`;
}

function toolInputFromArguments(argumentsText) {
  return parseJsonObject(argumentsText) ?? {};
}

function chatContentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => (
      isPlainObject(part)
      && typeof part.text === 'string'
      && (part.type === 'text' || part.type === undefined)
    ))
    .map((part) => part.text)
    .join(TEXT_SEPARATOR);
}

function splitSystemMessages(messages) {
  const segments = [];
  const chatMessages = [];
  if (!Array.isArray(messages)) return { systemText: '', chatMessages };

  for (const message of messages) {
    if (!isPlainObject(message)) continue;
    if (SYSTEM_ROLES.has(message.role)) {
      const text = chatContentText(message.content);
      if (text !== '') segments.push(text);
      continue;
    }
    chatMessages.push(message);
  }
  return { systemText: segments.join(SYSTEM_SEPARATOR), chatMessages };
}

function convertImagePart(part, warnings) {
  const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
  if (typeof url !== 'string' || url === '') {
    addWarning(warnings, 'invalid_image_part', 'messages');
    return null;
  }

  const dataUri = IMAGE_DATA_URI.exec(url);
  if (dataUri !== null) {
    return {
      type: 'image',
      source: { type: 'base64', media_type: dataUri[1], data: dataUri[2] },
    };
  }
  if (url.startsWith('data:')) {
    // Anthropic 只接受 base64 data URI 或 http(s) 图片地址。
    addWarning(warnings, 'invalid_image_part', 'messages');
    return null;
  }
  return { type: 'image', source: { type: 'url', url } };
}

function convertUserContent(content, warnings) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];

  const blocks = [];
  for (const part of content) {
    if (!isPlainObject(part)) {
      addWarning(warnings, 'unsupported_content_part', 'messages');
      continue;
    }
    if (part.type === 'text' && typeof part.text === 'string') {
      blocks.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.type === 'image_url') {
      const imageBlock = convertImagePart(part, warnings);
      if (imageBlock !== null) blocks.push(imageBlock);
      continue;
    }
    addWarning(warnings, 'unsupported_content_part', 'messages');
  }
  return blocks;
}

function convertToolCalls(toolCalls, warnings) {
  const blocks = [];
  for (const call of toolCalls) {
    const fn = isPlainObject(call) ? call.function : null;
    if (!isPlainObject(fn) || typeof fn.name !== 'string' || fn.name === '') {
      addWarning(warnings, 'invalid_tool_call', 'messages');
      continue;
    }
    blocks.push({
      type: 'tool_use',
      id: resolveToolUseId(call.id),
      name: fn.name,
      input: toolInputFromArguments(fn.arguments),
    });
  }
  return blocks;
}

function convertAssistantContent(message, warnings) {
  const blocks = [];
  if (typeof message.content === 'string') {
    if (message.content !== '') blocks.push({ type: 'text', text: message.content });
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (!isPlainObject(part)) continue;
      if (part.type === 'text' && typeof part.text === 'string') {
        blocks.push({ type: 'text', text: part.text });
      } else {
        addWarning(warnings, 'unsupported_content_part', 'messages');
      }
    }
  }

  if (typeof message.reasoning_content === 'string' && message.reasoning_content.trim() !== '') {
    addWarning(warnings, 'reasoning_content_dropped', 'messages');
  }
  if (Array.isArray(message.tool_calls)) {
    blocks.push(...convertToolCalls(message.tool_calls, warnings));
  }
  return blocks;
}

function convertToolMessage(message, warnings) {
  if (typeof message.tool_call_id !== 'string' || message.tool_call_id === '') {
    addWarning(warnings, 'missing_tool_call_id', 'messages');
  }
  return {
    type: 'tool_result',
    tool_use_id: typeof message.tool_call_id === 'string' ? message.tool_call_id : '',
    content: chatContentText(message.content),
  };
}

function convertChatMessages(messages, warnings) {
  const converted = [];
  let pendingToolResults = null;

  for (const message of messages) {
    if (message.role === 'tool') {
      if (pendingToolResults === null) {
        pendingToolResults = [];
        converted.push({ role: 'user', content: pendingToolResults });
      }
      pendingToolResults.push(convertToolMessage(message, warnings));
      continue;
    }

    pendingToolResults = null;
    if (message.role === 'user') {
      converted.push({ role: 'user', content: convertUserContent(message.content, warnings) });
    } else if (message.role === 'assistant') {
      converted.push({ role: 'assistant', content: convertAssistantContent(message, warnings) });
    } else {
      addWarning(warnings, 'unsupported_message_role', 'messages');
    }
  }
  return converted;
}

function convertTools(tools, warnings) {
  if (!Array.isArray(tools)) return [];

  const converted = [];
  for (const tool of tools) {
    const fn = isPlainObject(tool) ? tool.function : null;
    const valid = isPlainObject(tool)
      && tool.type === 'function'
      && isPlainObject(fn)
      && typeof fn.name === 'string'
      && fn.name !== '';
    if (!valid) {
      addWarning(warnings, 'unsupported_tool', 'tools');
      continue;
    }

    const mapped = { name: fn.name, input_schema: cleanSchema(fn.parameters) };
    if (typeof fn.description === 'string' && fn.description !== '') {
      mapped.description = fn.description;
    }
    converted.push(mapped);
  }
  return converted;
}

function withDisableParallelToolUse(choice) {
  const normalized = choice === null
    ? { type: 'auto' }
    : typeof choice === 'string'
      ? { type: choice }
      : { ...choice };
  if (normalized.type === 'none') return normalized;
  normalized.disable_parallel_tool_use = true;
  return normalized;
}

function convertToolChoice(source, hasTools) {
  if (!hasTools) return null;

  const mapped = mapToolChoiceToAnthropic(source.tool_choice);
  const choice = mapped === undefined ? null : mapped;
  return source.parallel_tool_calls === false ? withDisableParallelToolUse(choice) : choice;
}

function resolveMaxTokens(source) {
  for (const candidate of [source.max_completion_tokens, source.max_tokens]) {
    if (Number.isInteger(candidate) && candidate > 0) return candidate;
  }
  return DEFAULT_ANTHROPIC_MAX_TOKENS;
}

function convertStopSequences(stop) {
  if (typeof stop === 'string') return stop === '' ? [] : [stop];
  if (!Array.isArray(stop)) return [];
  return stop.filter((value) => typeof value === 'string' && value !== '');
}

function normalizeChatReasoningEffort(value) {
  if (typeof value !== 'string') return null;
  const effort = value.trim().toLowerCase();
  if (effort === '' || effort === 'none') return null;
  return effort === 'minimal' ? 'low' : effort;
}

function isForcedToolChoice(toolChoice) {
  if (typeof toolChoice === 'string') return toolChoice === 'any';
  return isPlainObject(toolChoice) && FORCED_TOOL_CHOICE_TYPES.has(toolChoice.type);
}

function resolveThinkingState({ source, model, maxTokens, toolChoice }) {
  const effort = normalizeChatReasoningEffort(source.reasoning_effort);
  if (effort === null) return { thinking: null, outputConfig: null, enabled: false };

  const resolved = thinkingForAnthropic({ model, effort, maxTokens });
  if (resolved === null) return { thinking: null, outputConfig: null, enabled: false };

  if (isForcedToolChoice(toolChoice)) {
    if (thinkingCannotBeDisabled(model)) {
      throw new ConversionRequestError(
        '模型在强制工具调用时不允许关闭思考模式',
        { code: 'thinking_required_by_tool_choice', field: 'reasoning_effort' },
      );
    }
    return { thinking: { type: 'disabled' }, outputConfig: null, enabled: false };
  }
  return { thinking: resolved.thinking, outputConfig: resolved.outputConfig, enabled: true };
}

function assignSamplingParameters(target, source) {
  if (isFiniteNumber(source.temperature)) target.temperature = source.temperature;
  if (isFiniteNumber(source.top_p)) target.top_p = source.top_p;
}

function buildAnthropicRequest(options) {
  const { source, model, messages, systemText, tools, toolChoice, maxTokens, thinkingState } = options;
  const stream = source.stream === true;
  const converted = {
    model,
    max_tokens: maxTokens,
    messages,
    stream,
  };

  if (systemText !== '') converted.system = systemText;
  if (tools.length > 0) {
    converted.tools = tools;
    if (toolChoice !== null) converted.tool_choice = toolChoice;
  }
  const stopSequences = convertStopSequences(source.stop);
  if (stopSequences.length > 0) converted.stop_sequences = stopSequences;
  if (thinkingState.thinking !== null) converted.thinking = thinkingState.thinking;
  if (thinkingState.outputConfig !== null) converted.output_config = thinkingState.outputConfig;
  // temperature/top_p 与 Anthropic 思考模式互斥，只有未启用思考时才透传。
  if (!thinkingState.enabled) assignSamplingParameters(converted, source);
  return converted;
}

function warnDroppedFields(source, warnings) {
  for (const field of DROPPED_REQUEST_FIELDS) {
    if (source[field] !== undefined) addWarning(warnings, 'dropped_field', field);
  }
}

/**
 * 把 OpenAI Chat Completions 请求转换为 Anthropic Messages 请求。
 * @param {{ body: object, model: string }} input 已替换为上游模型 id 的请求体。
 * @returns {{ body: object, stream: boolean, warnings: Array<{ code: string, field?: string }> }}
 */
export function convertRequest({ body, model } = {}) {
  const source = isPlainObject(body) ? body : {};
  const warnings = [];
  const upstreamModel = model ?? source.model;
  const { systemText, chatMessages } = splitSystemMessages(source.messages);

  const messages = normalizeAnthropicMessages(convertChatMessages(chatMessages, warnings));
  if (messages.length === 0) {
    throw new ConversionRequestError('转换后没有可发送的消息', {
      code: 'empty_messages',
      field: 'messages',
    });
  }

  const tools = convertTools(source.tools, warnings);
  const toolChoice = convertToolChoice(source, tools.length > 0);
  const maxTokens = resolveMaxTokens(source);
  const thinkingState = resolveThinkingState({
    source,
    model: upstreamModel,
    maxTokens,
    toolChoice,
  });
  const converted = buildAnthropicRequest({
    source,
    model: upstreamModel,
    messages,
    systemText,
    tools,
    toolChoice,
    maxTokens,
    thinkingState,
  });

  warnDroppedFields(source, warnings);
  const cached = injectAnthropicCacheControl(converted);
  warnings.push(...cached.warnings);
  return { body: cached.body, stream: converted.stream, warnings };
}

function mapChatFinishReason(reason, hasToolUse) {
  if (hasToolUse) return 'tool_use';
  return CHAT_FINISH_REASONS[reason] ?? DEFAULT_STOP_REASON;
}

function chatResponseTextBlocks(message) {
  const blocks = [];
  if (typeof message.content === 'string') {
    if (message.content !== '') blocks.push({ type: 'text', text: message.content });
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (!isPlainObject(part)) continue;
      if (
        CHAT_RESPONSE_TEXT_PART_TYPES.has(part.type)
        && typeof part.text === 'string'
        && part.text !== ''
      ) {
        blocks.push({ type: 'text', text: part.text });
      }
    }
  }
  if (typeof message.refusal === 'string' && message.refusal !== '') {
    blocks.push({ type: 'text', text: message.refusal });
  }
  return blocks;
}

function chatResponseToolUseBlocks(message, warnings) {
  const blocks = [];
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      const fn = isPlainObject(call) ? call.function : null;
      if (!isPlainObject(fn) || typeof fn.name !== 'string' || fn.name === '') {
        addWarning(warnings, 'invalid_tool_call', 'choices');
        continue;
      }
      blocks.push({
        type: 'tool_use',
        id: resolveToolUseId(call.id),
        name: fn.name,
        input: toolInputFromArguments(fn.arguments),
      });
    }
  }

  const legacy = message.function_call;
  if (blocks.length === 0 && isPlainObject(legacy) && typeof legacy.name === 'string') {
    blocks.push({
      type: 'tool_use',
      id: resolveToolUseId(undefined),
      name: legacy.name,
      input: toolInputFromArguments(legacy.arguments),
    });
  }
  return blocks;
}

function resolveMessageId(value) {
  return typeof value === 'string' && value !== '' ? value : `${MESSAGE_ID_PREFIX}${randomUUID()}`;
}

function resolveResponseModel(value, request) {
  if (typeof value === 'string' && value !== '') return value;
  return typeof request?.model === 'string' ? request.model : '';
}

/**
 * 把 OpenAI Chat Completions 非流式响应转换为 Anthropic Messages 响应。
 * @param {{ body: object, request: object }} input
 * @returns {{ body: object, warnings: Array<{ code: string, field?: string }> }}
 */
export function convertResponse({ body, request } = {}) {
  const response = isPlainObject(body) ? body : {};
  const choice = Array.isArray(response.choices) ? response.choices[0] : undefined;
  if (!isPlainObject(choice)) {
    throw new ConversionError('上游响应缺少 choices[0]', {
      code: 'invalid_chat_response',
      field: 'choices',
    });
  }
  const message = isPlainObject(choice.message) ? choice.message : null;
  if (message === null) {
    throw new ConversionError('上游响应缺少 message', {
      code: 'invalid_chat_response',
      field: 'choices',
    });
  }

  const warnings = [];
  const content = [];
  const reasoning = message.reasoning_content;
  if (typeof reasoning === 'string' && reasoning !== '') {
    // cc-switch 同样不补 signature，客户端按明文思考内容消费。
    content.push({ type: 'thinking', thinking: reasoning });
  }
  content.push(...chatResponseTextBlocks(message));
  const toolUseBlocks = chatResponseToolUseBlocks(message, warnings);
  content.push(...toolUseBlocks);

  return {
    body: {
      id: resolveMessageId(response.id),
      type: 'message',
      role: 'assistant',
      model: resolveResponseModel(response.model, request),
      content,
      stop_reason: mapChatFinishReason(choice.finish_reason, toolUseBlocks.length > 0),
      stop_sequence: null,
      usage: neutralToAnthropic(neutralFromOpenAiChat(response.usage)),
    },
    warnings,
  };
}

function joinFrames(frames) {
  return frames.length === 0 ? null : frames.join('');
}

class ChatToAnthropicStream {
  #parser = new SseParser();
  #warnings = [];
  #model;
  #messageId = null;
  #started = false;
  #finished = false;
  #done = false;
  #currentBlock = null;
  #openBlockIndices = new Set();
  #nextBlockIndex = 0;
  #toolStates = new Map();
  #usage = emptyUsage();
  #sawToolBlock = false;

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
    // 没有 finish_reason 时不伪造 message_stop，与 cc-switch 行为一致。
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
    if (isPlainObject(payload)) this.#handleChunk(payload, frames);
  }

  #handleChunk(chunk, frames) {
    if (isPlainObject(chunk.usage)) {
      this.#usage = mergeNeutral(this.#usage, neutralFromOpenAiChat(chunk.usage));
    }
    if (this.#finished) return;

    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    if (choices.length === 0) return;
    const choice = choices[0];
    if (!isPlainObject(choice)) return;

    this.#ensureMessageStart(chunk, frames);
    const delta = isPlainObject(choice.delta) ? choice.delta : {};
    this.#handleReasoningDelta(delta.reasoning_content, frames);
    this.#handleTextDelta(delta.content, frames);
    this.#handleToolDeltas(delta.tool_calls, frames);
    if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
      this.#finish(choice.finish_reason, frames);
    }
  }

  #ensureMessageStart(chunk, frames) {
    if (this.#started) return;
    this.#started = true;
    if (typeof chunk.id === 'string' && chunk.id !== '') this.#messageId = chunk.id;
    if (typeof chunk.model === 'string' && chunk.model !== '') this.#model = chunk.model;

    const message = {
      id: this.#messageId ?? `${MESSAGE_ID_PREFIX}${randomUUID()}`,
      type: 'message',
      role: 'assistant',
      model: this.#model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: neutralToAnthropic(this.#usage),
    };
    this.#messageId = message.id;
    this.#emit(frames, 'message_start', { type: 'message_start', message });
  }

  #handleReasoningDelta(text, frames) {
    if (typeof text !== 'string' || text === '') return;
    const index = this.#openBlock('thinking', frames);
    this.#emit(frames, 'content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'thinking_delta', thinking: text },
    });
  }

  #handleTextDelta(text, frames) {
    if (typeof text !== 'string' || text === '') return;
    const index = this.#openBlock('text', frames);
    this.#emit(frames, 'content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'text_delta', text },
    });
  }

  #openBlock(type, frames) {
    if (this.#currentBlock !== null && this.#currentBlock.type === type) {
      return this.#currentBlock.index;
    }
    this.#closeCurrentBlock(frames);

    const index = this.#nextBlockIndex;
    this.#nextBlockIndex += 1;
    this.#currentBlock = { type, index };
    this.#openBlockIndices.add(index);
    const contentBlock = type === 'thinking'
      ? { type: 'thinking', thinking: '' }
      : { type: 'text', text: '' };
    this.#emit(frames, 'content_block_start', {
      type: 'content_block_start',
      index,
      content_block: contentBlock,
    });
    return index;
  }

  #closeCurrentBlock(frames) {
    if (this.#currentBlock === null) return;
    this.#openBlockIndices.delete(this.#currentBlock.index);
    this.#emit(frames, 'content_block_stop', {
      type: 'content_block_stop',
      index: this.#currentBlock.index,
    });
    this.#currentBlock = null;
  }

  #handleToolDeltas(toolCalls, frames) {
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return;
    this.#closeCurrentBlock(frames);
    for (const call of toolCalls) {
      if (!isPlainObject(call)) continue;
      this.#absorbToolCallDelta(this.#toolState(call.index), call, frames);
    }
  }

  #toolState(index) {
    const key = Number.isInteger(index) ? index : this.#toolStates.size;
    let state = this.#toolStates.get(key);
    if (state === undefined) {
      state = {
        blockIndex: this.#nextBlockIndex,
        id: null,
        name: null,
        started: false,
        pendingArguments: '',
      };
      this.#nextBlockIndex += 1;
      this.#toolStates.set(key, state);
    }
    return state;
  }

  #absorbToolCallDelta(state, call, frames) {
    if (typeof call.id === 'string' && call.id !== '') state.id = call.id;
    const fn = isPlainObject(call.function) ? call.function : {};
    if (typeof fn.name === 'string' && fn.name !== '') state.name = fn.name;

    const argumentsDelta = typeof fn.arguments === 'string' ? fn.arguments : '';
    if (!state.started) {
      state.pendingArguments += argumentsDelta;
      this.#startToolBlock(state, frames);
      return;
    }
    if (argumentsDelta !== '') this.#emitToolArgumentsDelta(state, argumentsDelta, frames);
  }

  #startToolBlock(state, frames) {
    if (state.started || state.id === null || state.name === null) return;
    state.started = true;
    this.#sawToolBlock = true;
    this.#openBlockIndices.add(state.blockIndex);
    this.#emit(frames, 'content_block_start', {
      type: 'content_block_start',
      index: state.blockIndex,
      content_block: {
        type: 'tool_use',
        id: state.id,
        name: state.name,
        input: {},
      },
    });
    if (state.pendingArguments !== '') {
      this.#emitToolArgumentsDelta(state, state.pendingArguments, frames);
      state.pendingArguments = '';
    }
  }

  #emitToolArgumentsDelta(state, partialJson, frames) {
    this.#emit(frames, 'content_block_delta', {
      type: 'content_block_delta',
      index: state.blockIndex,
      delta: { type: 'input_json_delta', partial_json: partialJson },
    });
  }

  #finish(reason, frames) {
    if (this.#finished) return;
    this.#finished = true;

    this.#closeCurrentBlock(frames);
    for (const index of [...this.#openBlockIndices].sort((left, right) => left - right)) {
      this.#emit(frames, 'content_block_stop', { type: 'content_block_stop', index });
    }
    this.#openBlockIndices.clear();

    this.#emit(frames, 'message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: mapChatFinishReason(reason, this.#sawToolBlock),
        stop_sequence: null,
      },
      usage: neutralToAnthropic(this.#usage),
    });
    this.#emit(frames, 'message_stop', { type: 'message_stop' });
  }

  #emit(frames, eventName, payload) {
    frames.push(formatSseEvent({ event: eventName, data: JSON.stringify(payload) }));
  }

  #addWarning(code, field) {
    addWarning(this.#warnings, code, field);
  }
}

/**
 * 创建 OpenAI Chat SSE → Anthropic SSE 的增量转换器。
 * @param {{ request: object }} input request 为转换后的 Anthropic 上游请求体。
 */
export function createStreamConverter({ request } = {}) {
  return new ChatToAnthropicStream(request);
}
