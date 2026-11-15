import { isPlainObject } from '../../util.mjs';
import { RESPONSES_MIN_MAX_OUTPUT_TOKENS } from '../common/constants.mjs';
import { ConversionError, ConversionRequestError } from '../common/errors.mjs';
import { clampReasoningEffort, supportsReasoningEffort } from '../common/model-capabilities.mjs';
import { SSE_DONE, SseParser, formatSseJson } from '../common/sse.mjs';
import { cleanSchema, mapToolChoiceToResponses } from '../common/tools.mjs';
import { neutralFromResponses, neutralToOpenAiChat } from '../common/usage.mjs';

const SYSTEM_ROLES = new Set(['system', 'developer']);
const INSTRUCTIONS_SEPARATOR = '\n\n';
const TEXT_SEPARATOR = '\n';
const DROPPED_REQUEST_FIELDS = Object.freeze([
  'n',
  'seed',
  'response_format',
  'logprobs',
  'service_tier',
  'presence_penalty',
  'frequency_penalty',
  'user',
]);
const RESPONSES_TEXT_PART_TYPES = new Set(['output_text', 'text']);
const STREAM_TERMINAL_TYPES = new Set(['response.completed', 'response.incomplete', 'response.failed', 'error']);
const FALLBACK_CHAT_ID = 'chatcmpl-converted';
const STREAM_TRUNCATED_MESSAGE = '上游流在完成前意外结束';
const DONE_MARKER = '[DONE]';

function addWarning(warnings, code, field) {
  const exists = warnings.some(
    (warning) => warning.code === code && warning.field === field,
  );
  if (exists) return;
  warnings.push(field === undefined ? { code } : { code, field });
}

function pickString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value;
  }
  return '';
}

function stringifyArguments(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return JSON.stringify(value);
}

function hasReasoningContent(value) {
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null;
}

function extractChatText(content, warnings, field) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const texts = [];
  for (const part of content) {
    if (isPlainObject(part) && part.type === 'text' && typeof part.text === 'string') {
      texts.push(part.text);
      continue;
    }
    addWarning(warnings, 'unsupported_content_part', field);
  }
  return texts.join(TEXT_SEPARATOR);
}

function imageUrlOf(part) {
  const source = part.image_url;
  if (typeof source === 'string' && source !== '') return source;
  if (isPlainObject(source) && typeof source.url === 'string' && source.url !== '') {
    return source.url;
  }
  return null;
}

function mapUserContent(content, warnings) {
  if (typeof content === 'string') {
    return content === '' ? [] : [{ type: 'input_text', text: content }];
  }
  if (!Array.isArray(content)) return [];

  const parts = [];
  for (const part of content) {
    if (!isPlainObject(part)) {
      addWarning(warnings, 'unsupported_content_part', 'messages');
      continue;
    }
    if (part.type === 'text' && typeof part.text === 'string') {
      parts.push({ type: 'input_text', text: part.text });
      continue;
    }
    if (part.type === 'image_url') {
      const url = imageUrlOf(part);
      if (url === null) {
        addWarning(warnings, 'invalid_image_part', 'messages');
        continue;
      }
      parts.push({ type: 'input_image', image_url: url });
      continue;
    }
    addWarning(warnings, 'unsupported_content_part', 'messages');
  }
  return parts;
}

function mapToolCallItem(toolCall, warnings) {
  const fn = isPlainObject(toolCall) ? toolCall.function : null;
  if (!isPlainObject(fn) || typeof fn.name !== 'string' || fn.name === '') {
    addWarning(warnings, 'invalid_tool_call', 'messages');
    return null;
  }
  return {
    type: 'function_call',
    call_id: typeof toolCall.id === 'string' ? toolCall.id : '',
    name: fn.name,
    arguments: stringifyArguments(fn.arguments),
  };
}

function mapAssistantItems(message, input, warnings) {
  if (hasReasoningContent(message.reasoning_content)) {
    addWarning(warnings, 'reasoning_content_dropped', 'messages');
  }

  const text = extractChatText(message.content, warnings, 'messages');
  if (text !== '') {
    input.push({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    });
  }

  if (message.tool_calls === undefined || message.tool_calls === null) return;
  if (!Array.isArray(message.tool_calls)) {
    throw new ConversionRequestError('tool_calls 必须是数组', { field: 'messages' });
  }
  for (const toolCall of message.tool_calls) {
    const item = mapToolCallItem(toolCall, warnings);
    if (item !== null) input.push(item);
  }
}

function mapToolOutput(message, warnings) {
  const callId = typeof message.tool_call_id === 'string' ? message.tool_call_id : '';
  if (callId === '') {
    throw new ConversionRequestError('tool 消息缺少 tool_call_id', { field: 'messages' });
  }
  return {
    type: 'function_call_output',
    call_id: callId,
    output: extractChatText(message.content, warnings, 'messages'),
  };
}

function mapChatMessages(messages, warnings) {
  const instructions = [];
  const input = [];

  for (const message of messages) {
    if (!isPlainObject(message)) {
      throw new ConversionRequestError('messages 中存在非对象消息', { field: 'messages' });
    }
    if (SYSTEM_ROLES.has(message.role)) {
      const text = extractChatText(message.content, warnings, 'messages');
      if (text.trim() !== '') instructions.push(text);
      continue;
    }
    if (message.role === 'user') {
      const content = mapUserContent(message.content, warnings);
      if (content.length > 0) input.push({ type: 'message', role: 'user', content });
      continue;
    }
    if (message.role === 'assistant') {
      mapAssistantItems(message, input, warnings);
      continue;
    }
    if (message.role === 'tool') {
      input.push(mapToolOutput(message, warnings));
      continue;
    }
    throw new ConversionRequestError(`不支持的消息角色：${String(message.role)}`, {
      field: 'messages',
    });
  }
  return { instructions, input };
}

function mapTools(tools, warnings) {
  if (tools === undefined || tools === null) return [];
  if (!Array.isArray(tools)) {
    throw new ConversionRequestError('tools 必须是数组', { field: 'tools' });
  }

  const mapped = [];
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
    mapped.push({
      type: 'function',
      name: fn.name,
      ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
      parameters: cleanSchema(fn.parameters),
      strict: false,
    });
  }
  return mapped;
}

/** 公共 mapper 接受 Anthropic 形状；先把 Chat 的 function 选择归一化。 */
function normalizeChatToolChoice(toolChoice) {
  if (!isPlainObject(toolChoice) || toolChoice.type !== 'function') return toolChoice;

  const fn = isPlainObject(toolChoice.function) ? toolChoice.function : toolChoice;
  if (typeof fn.name !== 'string' || fn.name === '') return toolChoice;
  return { type: 'tool', name: fn.name };
}

function applyMaxOutputTokens(source, converted) {
  const requested = source.max_completion_tokens ?? source.max_tokens;
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return;
  converted.max_output_tokens = Math.max(
    RESPONSES_MIN_MAX_OUTPUT_TOKENS,
    Math.floor(requested),
  );
}

function applyReasoningEffort(source, model, converted, warnings) {
  const effort = source.reasoning_effort;
  if (typeof effort !== 'string' || effort.trim() === '') return;

  if (!supportsReasoningEffort(model)) {
    addWarning(warnings, 'unsupported_reasoning_effort', 'reasoning_effort');
    return;
  }
  converted.reasoning = {
    effort: clampReasoningEffort(model, effort.trim().toLowerCase()),
  };
}

/**
 * 把 OpenAI Chat Completions 请求转换为 OpenAI Responses 请求。
 * @param {{ body: object, model: string }} input body.model 已是上游模型 id。
 * @returns {{ body: object, stream: boolean, warnings: Array<{ code: string, field?: string }> }}
 */
export function convertRequest({ body, model } = {}) {
  if (!isPlainObject(body)) {
    throw new ConversionRequestError('请求体必须是 JSON 对象');
  }
  if (!Array.isArray(body.messages)) {
    throw new ConversionRequestError('messages 必须是数组', { field: 'messages' });
  }

  const warnings = [];
  const upstreamModel = pickString(model, body.model);
  if (upstreamModel === '') {
    throw new ConversionRequestError('缺少上游模型 id', { field: 'model' });
  }

  const { instructions, input } = mapChatMessages(body.messages, warnings);
  const converted = { model: upstreamModel, input };
  if (instructions.length > 0) {
    converted.instructions = instructions.join(INSTRUCTIONS_SEPARATOR);
  }

  const tools = mapTools(body.tools, warnings);
  if (tools.length > 0) {
    converted.tools = tools;
    const toolChoice = mapToolChoiceToResponses(normalizeChatToolChoice(body.tool_choice));
    if (toolChoice !== undefined) converted.tool_choice = toolChoice;
  }

  applyMaxOutputTokens(body, converted);
  applyReasoningEffort(body, upstreamModel, converted, warnings);
  if (body.temperature !== undefined) converted.temperature = body.temperature;
  if (body.top_p !== undefined) converted.top_p = body.top_p;
  if (body.stream !== undefined) converted.stream = body.stream === true;
  if (body.metadata !== undefined) converted.metadata = body.metadata;

  for (const field of DROPPED_REQUEST_FIELDS) {
    if (body[field] !== undefined) addWarning(warnings, 'dropped_field', field);
  }

  return { body: converted, stream: body.stream === true, warnings };
}

function responsesMessageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .filter((part) => (
      isPlainObject(part)
      && RESPONSES_TEXT_PART_TYPES.has(part.type)
      && typeof part.text === 'string'
    ))
    .map((part) => part.text)
    .join('');
}

function collectResponsesOutput(output, warnings) {
  const texts = [];
  const toolCalls = [];
  let hasReasoning = false;

  for (const item of output) {
    if (!isPlainObject(item)) continue;
    if (item.type === 'message') {
      texts.push(responsesMessageText(item.content));
      continue;
    }
    if (item.type === 'function_call') {
      const callId = pickString(item.call_id, item.id);
      toolCalls.push({
        id: callId,
        type: 'function',
        function: {
          name: typeof item.name === 'string' ? item.name : '',
          arguments: stringifyArguments(item.arguments),
        },
      });
      continue;
    }
    if (item.type === 'reasoning') hasReasoning = true;
  }

  if (hasReasoning) addWarning(warnings, 'reasoning_dropped', 'output');
  return { text: texts.join(''), toolCalls };
}

function finishReasonFromResponse(body, hasToolCalls) {
  const status = body.status;
  if (status === 'incomplete') {
    const reason = body.incomplete_details?.reason;
    return reason === 'content_filter' ? 'content_filter' : 'length';
  }
  if (status === 'failed' || status === 'cancelled') {
    const detail = isPlainObject(body.error) && typeof body.error.message === 'string'
      ? `：${body.error.message}`
      : '';
    throw new ConversionError(`上游响应状态为 ${status}${detail}`, {
      code: 'upstream_failed',
      field: 'status',
    });
  }
  if (status === undefined || status === null || status === 'completed') {
    return hasToolCalls ? 'tool_calls' : 'stop';
  }
  throw new ConversionError(`未知的上游响应状态：${status}`, {
    code: 'invalid_upstream_status',
    field: 'status',
  });
}

function toEpochSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  return Math.floor(Date.now() / 1000);
}

/**
 * 把 OpenAI Responses 非流式响应转换为 OpenAI Chat Completions 响应。
 * @param {{ body: object, request: object }} input request 为转换后的 Responses 请求体。
 * @returns {{ body: object, warnings: Array<{ code: string, field?: string }> }}
 */
export function convertResponse({ body, request } = {}) {
  if (!isPlainObject(body)) {
    throw new ConversionError('上游响应必须是 JSON 对象', { code: 'invalid_upstream_response' });
  }
  if (!Array.isArray(body.output)) {
    throw new ConversionError('上游响应缺少 output', {
      code: 'invalid_upstream_response',
      field: 'output',
    });
  }

  const warnings = [];
  const { text, toolCalls } = collectResponsesOutput(body.output, warnings);
  const finishReason = finishReasonFromResponse(body, toolCalls.length > 0);
  const message = { role: 'assistant', content: text === '' ? null : text };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    body: {
      id: pickString(body.id, FALLBACK_CHAT_ID),
      object: 'chat.completion',
      created: toEpochSeconds(body.created_at),
      model: pickString(body.model, request?.model),
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: neutralToOpenAiChat(neutralFromResponses(body.usage)),
    },
    warnings,
  };
}

function joinFrames(frames) {
  return frames.length === 0 ? null : frames.join('');
}

class ResponsesToChatStream {
  #parser = new SseParser();
  #warnings = [];
  #model;
  #id = null;
  #created = null;
  #started = false;
  #finished = false;
  #done = false;
  #messageText = '';
  #sawContent = false;
  #toolStates = new Map();
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
    if (!this.#done) this.#finalizeEof(frames);
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
    if (event.data === DONE_MARKER) {
      this.#finalizeEof(frames);
      return;
    }

    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      this.#warn('invalid_upstream_event');
      return;
    }
    if (!isPlainObject(payload)) return;

    const type = typeof payload.type === 'string' ? payload.type : event.event;
    if (STREAM_TERMINAL_TYPES.has(type)) {
      if (type === 'response.failed' || type === 'error') {
        this.#fail(payload, frames);
        return;
      }
      if (this.#finished) return;
      this.#finish(payload.response, type === 'response.incomplete' ? 'length' : null, frames);
      return;
    }

    if (this.#finished) return;
    switch (type) {
      case 'response.created':
      case 'response.in_progress':
        this.#adoptResponse(payload.response);
        this.#ensureStarted(frames);
        break;
      case 'response.output_text.delta':
        this.#handleTextDelta(payload.delta, frames);
        break;
      case 'response.output_text.done':
        if (this.#messageText === '') this.#handleTextDelta(payload.text, frames);
        break;
      case 'response.output_item.added':
        this.#handleOutputItemAdded(payload, frames);
        break;
      case 'response.function_call_arguments.delta':
        this.#handleArgumentsDelta(payload, frames);
        break;
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        this.#warn('reasoning_dropped', 'output');
        break;
      default:
        break;
    }
  }

  #adoptResponse(response) {
    if (!isPlainObject(response)) return;
    if (typeof response.id === 'string' && response.id !== '') this.#id = response.id;
    if (typeof response.model === 'string' && response.model !== '') this.#model = response.model;
    if (typeof response.created_at === 'number' && Number.isFinite(response.created_at)) {
      this.#created = Math.floor(response.created_at);
    }
  }

  #ensureStarted(frames) {
    if (this.#started) return;
    this.#started = true;
    frames.push(formatSseJson(this.#chatChunk({ role: 'assistant', content: '' }, null)));
  }

  #chatChunk(delta, finishReason, usage) {
    return {
      id: this.#id ?? FALLBACK_CHAT_ID,
      object: 'chat.completion.chunk',
      created: this.#created ?? Math.floor(Date.now() / 1000),
      model: this.#model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...(usage !== undefined ? { usage } : {}),
    };
  }

  #handleTextDelta(delta, frames) {
    if (typeof delta !== 'string' || delta === '') return;
    this.#ensureStarted(frames);
    this.#sawContent = true;
    this.#messageText += delta;
    frames.push(formatSseJson(this.#chatChunk({ content: delta }, null)));
  }

  #handleOutputItemAdded(event, frames) {
    const item = event.item;
    if (!isPlainObject(item)) return;
    if (item.type === 'reasoning') {
      this.#warn('reasoning_dropped', 'output');
      return;
    }
    if (item.type !== 'function_call') return;
    if (this.#findToolState(item) !== null) return;

    this.#ensureStarted(frames);
    this.#sawContent = true;
    const index = this.#nextToolIndex;
    this.#nextToolIndex += 1;
    const state = {
      index,
      itemId: pickString(item.id),
      callId: pickString(item.call_id, item.id),
      name: typeof item.name === 'string' ? item.name : '',
      outputIndex: Number.isInteger(event.output_index) ? event.output_index : null,
    };
    this.#toolStates.set(state.itemId === '' ? `call_${index}` : state.itemId, state);

    frames.push(formatSseJson(this.#chatChunk({
      tool_calls: [{
        index,
        id: state.callId,
        type: 'function',
        function: { name: state.name, arguments: '' },
      }],
    }, null)));
  }

  #handleArgumentsDelta(event, frames) {
    const delta = typeof event.delta === 'string' ? event.delta : '';
    if (delta === '') return;

    this.#ensureStarted(frames);
    this.#sawContent = true;
    let state = this.#findToolState(event);
    if (state === null) {
      // 上游没有先发 output_item.added，按需补建一个名字未知的工具调用。
      const index = this.#nextToolIndex;
      this.#nextToolIndex += 1;
      state = {
        index,
        itemId: pickString(event.item_id),
        callId: '',
        name: '',
        outputIndex: Number.isInteger(event.output_index) ? event.output_index : null,
      };
      this.#toolStates.set(state.itemId === '' ? `call_${index}` : state.itemId, state);
      frames.push(formatSseJson(this.#chatChunk({
        tool_calls: [{
          index,
          id: state.itemId,
          type: 'function',
          function: { name: '', arguments: '' },
        }],
      }, null)));
    }

    frames.push(formatSseJson(this.#chatChunk({
      tool_calls: [{ index: state.index, function: { arguments: delta } }],
    }, null)));
  }

  #findToolState(event) {
    const itemId = pickString(event.item_id, event.item?.id);
    if (itemId !== '') {
      const direct = this.#toolStates.get(itemId);
      if (direct !== undefined) return direct;
      for (const state of this.#toolStates.values()) {
        if (state.itemId === itemId) return state;
      }
    }
    const outputIndex = Number.isInteger(event.output_index) ? event.output_index : null;
    if (outputIndex !== null) {
      for (const state of this.#toolStates.values()) {
        if (state.outputIndex === outputIndex) return state;
      }
    }
    return null;
  }

  #finish(response, forcedReason, frames) {
    this.#adoptResponse(response);
    this.#ensureStarted(frames);
    this.#finished = true;
    this.#done = true;

    const finishReason = forcedReason
      ?? (this.#toolStates.size > 0 ? 'tool_calls' : 'stop');
    const usage = isPlainObject(response?.usage)
      ? neutralToOpenAiChat(neutralFromResponses(response.usage))
      : undefined;
    frames.push(formatSseJson(this.#chatChunk({}, finishReason, usage)));
    frames.push(SSE_DONE);
  }

  #fail(payload, frames) {
    if (this.#done) return;
    this.#finished = true;
    this.#done = true;

    const error = isPlainObject(payload.error)
      ? payload.error
      : (isPlainObject(payload.response?.error) ? payload.response.error : payload);
    frames.push(formatSseJson({
      error: {
        message: typeof error.message === 'string' && error.message !== ''
          ? error.message
          : '上游响应失败',
        type: typeof error.type === 'string' && error.type !== '' ? error.type : 'server_error',
        code: typeof error.code === 'string' && error.code !== '' ? error.code : 'upstream_failed',
      },
    }));
    frames.push(SSE_DONE);
  }

  #finalizeEof(frames) {
    if (this.#done) return;
    this.#finished = true;
    this.#done = true;

    if (this.#sawContent) {
      frames.push(formatSseJson(this.#chatChunk({}, 'length')));
    } else {
      frames.push(formatSseJson({
        error: {
          message: STREAM_TRUNCATED_MESSAGE,
          type: 'server_error',
          code: 'stream_truncated',
        },
      }));
    }
    frames.push(SSE_DONE);
  }

  #warn(code, field) {
    addWarning(this.#warnings, code, field);
  }
}

/**
 * 创建 OpenAI Responses SSE → OpenAI Chat SSE 的增量转换器。
 * @param {{ request: object }} input request 为转换后的 Responses 上游请求体。
 */
export function createStreamConverter({ request } = {}) {
  return new ResponsesToChatStream(request);
}
