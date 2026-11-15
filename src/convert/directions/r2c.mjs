import { isPlainObject } from '../../util.mjs';
import { ConversionError, ConversionRequestError } from '../common/errors.mjs';
import { clampReasoningEffort, isOpenAiOSeries, supportsReasoningEffort } from '../common/model-capabilities.mjs';
import { SseParser, formatSseEvent } from '../common/sse.mjs';
import { cleanSchema, mapToolChoiceToChat } from '../common/tools.mjs';
import { mergeNeutral, neutralFromOpenAiChat, neutralToResponses } from '../common/usage.mjs';

const TEXT_SEPARATOR = '\n';
const RESPONSES_TEXT_PART_TYPES = new Set(['input_text', 'output_text', 'text']);
const PASSTHROUGH_FIELDS = Object.freeze([
  'frequency_penalty', 'logit_bias', 'logprobs', 'metadata',
  'n', 'parallel_tool_calls', 'presence_penalty', 'response_format',
  'seed', 'service_tier', 'stop', 'top_logprobs', 'user',
]);
const DROPPED_REQUEST_FIELDS = Object.freeze(['previous_response_id', 'store']);
const FALLBACK_RESPONSE_ID = 'resp_converted';
const STREAM_TRUNCATED_MESSAGE = '上游流在完成前意外结束';
const DONE_MARKER = '[DONE]';

function addWarning(warnings, code, field) {
  const exists = warnings.some((warning) => warning.code === code && warning.field === field);
  if (exists) return;
  warnings.push(field === undefined ? { code } : { code, field });
}

function emptyNeutral() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
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

function responsesTextFromParts(parts, warnings, field) {
  const texts = [];
  for (const part of parts) {
    if (typeof part === 'string') {
      texts.push(part);
      continue;
    }
    if (isPlainObject(part) && RESPONSES_TEXT_PART_TYPES.has(part.type) && typeof part.text === 'string') {
      texts.push(part.text);
      continue;
    }
    addWarning(warnings, 'unsupported_content_part', field);
  }
  return texts.join(TEXT_SEPARATOR);
}

function chatImagePart(part) {
  const url = typeof part.image_url === 'string' ? part.image_url : null;
  if (url === null || url === '') return null;
  const imageUrl = { url, ...(typeof part.detail === 'string' ? { detail: part.detail } : {}) };
  return { type: 'image_url', image_url: imageUrl };
}

function mapMessageContent(content, role, warnings) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    if (content !== undefined && content !== null) {
      addWarning(warnings, 'unsupported_content_part', 'input');
    }
    return '';
  }

  const texts = [];
  const images = [];
  for (const part of content) {
    if (typeof part === 'string') {
      texts.push(part);
      continue;
    }
    if (!isPlainObject(part)) {
      addWarning(warnings, 'unsupported_content_part', 'input');
      continue;
    }
    if (RESPONSES_TEXT_PART_TYPES.has(part.type)) {
      if (typeof part.text === 'string') texts.push(part.text);
      else addWarning(warnings, 'unsupported_content_part', 'input');
      continue;
    }
    if (part.type === 'input_image' && role === 'user') {
      const image = chatImagePart(part);
      if (image === null) addWarning(warnings, 'invalid_image_part', 'input');
      else images.push(image);
      continue;
    }
    addWarning(warnings, 'unsupported_content_part', 'input');
  }

  if (images.length === 0) return texts.join(TEXT_SEPARATOR);
  return [
    ...texts.filter((text) => text !== '').map((text) => ({ type: 'text', text })),
    ...images,
  ];
}

function isEmptyContent(content) {
  if (typeof content === 'string') return content === '';
  if (Array.isArray(content)) return content.length === 0;
  return true;
}

function mapResponsesMessage(item, warnings) {
  const role = item.role;
  if (role !== 'user' && role !== 'assistant' && role !== 'system' && role !== 'developer') {
    throw new ConversionRequestError(`不支持的 input 角色：${String(role)}`, { field: 'input' });
  }
  const content = mapMessageContent(item.content, role, warnings);
  if (isEmptyContent(content)) return null;
  return { role: role === 'developer' ? 'system' : role, content };
}

function mapFunctionCall(item, warnings) {
  if (typeof item.name !== 'string' || item.name === '') {
    addWarning(warnings, 'invalid_tool_call', 'input');
    return null;
  }
  const callId = pickString(item.call_id, item.id);
  if (callId === '') {
    throw new ConversionRequestError('function_call 缺少 call_id', { field: 'input' });
  }
  return {
    id: callId,
    type: 'function',
    function: { name: item.name, arguments: stringifyArguments(item.arguments) },
  };
}

function appendFunctionCall(item, messages, warnings) {
  const toolCall = mapFunctionCall(item, warnings);
  if (toolCall === null) return;

  const last = messages[messages.length - 1];
  if (last !== undefined && last.role === 'assistant') {
    if (!Array.isArray(last.tool_calls)) last.tool_calls = [];
    last.tool_calls.push(toolCall);
    return;
  }
  messages.push({ role: 'assistant', content: null, tool_calls: [toolCall] });
}

function extractOutputText(output, warnings) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return responsesTextFromParts(output, warnings, 'input');
  }
  if (output === undefined || output === null) return '';
  return JSON.stringify(output);
}

function mapFunctionCallOutput(item, warnings) {
  const callId = pickString(item.call_id);
  if (callId === '') {
    throw new ConversionRequestError('function_call_output 缺少 call_id', { field: 'input' });
  }
  return {
    role: 'tool',
    tool_call_id: callId,
    content: extractOutputText(item.output, warnings),
  };
}
function appendInputItem(item, messages, warnings) {
  if (!isPlainObject(item)) {
    addWarning(warnings, 'unsupported_input_item', 'input');
    return;
  }
  const type = typeof item.type === 'string'
    ? item.type
    : (item.role !== undefined ? 'message' : '');

  switch (type) {
    case 'message': {
      const message = mapResponsesMessage(item, warnings);
      if (message !== null) messages.push(message);
      break;
    }
    case 'function_call':
      appendFunctionCall(item, messages, warnings);
      break;
    case 'function_call_output':
      messages.push(mapFunctionCallOutput(item, warnings));
      break;
    case 'reasoning':
      addWarning(warnings, 'reasoning_dropped', 'input');
      break;
    default:
      addWarning(warnings, 'unsupported_input_item', 'input');
      break;
  }
}

function addInstructions(instructions, messages, warnings) {
  if (instructions === undefined || instructions === null) return;

  let text;
  if (typeof instructions === 'string') {
    text = instructions;
  } else if (Array.isArray(instructions)) {
    text = responsesTextFromParts(instructions, warnings, 'instructions');
  } else {
    addWarning(warnings, 'unsupported_field', 'instructions');
    return;
  }
  if (text !== '') messages.push({ role: 'system', content: text });
}

function appendInput(input, messages, warnings) {
  if (typeof input === 'string') {
    if (input !== '') messages.push({ role: 'user', content: input });
    return;
  }
  if (!Array.isArray(input)) {
    throw new ConversionRequestError('input 必须是字符串或数组', { field: 'input' });
  }
  for (const item of input) appendInputItem(item, messages, warnings);
}

function buildMessages(body, warnings) {
  const messages = [];
  addInstructions(body.instructions, messages, warnings);
  appendInput(body.input, messages, warnings);
  return messages;
}

function mapTools(tools, warnings) {
  if (tools === undefined || tools === null) return [];
  if (!Array.isArray(tools)) {
    throw new ConversionRequestError('tools 必须是数组', { field: 'tools' });
  }

  const mapped = [];
  for (const tool of tools) {
    const valid = isPlainObject(tool)
      && tool.type === 'function'
      && typeof tool.name === 'string'
      && tool.name !== '';
    if (!valid) {
      addWarning(warnings, 'unsupported_tool', 'tools');
      continue;
    }
    mapped.push({
      type: 'function',
      function: {
        name: tool.name,
        ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
        parameters: cleanSchema(tool.parameters),
      },
    });
  }
  return mapped;
}

/** 公共 mapper 接受 Anthropic 形状；先把 Responses 的 function 选择归一化。 */
function normalizeResponsesToolChoice(toolChoice) {
  if (!isPlainObject(toolChoice) || toolChoice.type !== 'function') return toolChoice;
  if (typeof toolChoice.name !== 'string' || toolChoice.name === '') return toolChoice;
  return { type: 'tool', name: toolChoice.name };
}

function applyMaxTokens(source, model, converted) {
  const requested = source.max_output_tokens;
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) return;

  const tokens = Math.floor(requested);
  if (isOpenAiOSeries(model)) converted.max_completion_tokens = tokens;
  else converted.max_tokens = tokens;
}

function applyStreamOptions(source, converted) {
  if (source.stream === true) {
    const options = isPlainObject(source.stream_options) ? source.stream_options : {};
    converted.stream_options = { ...options, include_usage: true };
  } else if (source.stream_options !== undefined) {
    converted.stream_options = source.stream_options;
  }
  if (source.stream !== undefined) converted.stream = source.stream === true;
}

function applyReasoningEffort(source, model, converted, warnings) {
  if (!isPlainObject(source.reasoning)) return;
  const effort = source.reasoning.effort;
  if (typeof effort !== 'string' || effort.trim() === '') return;

  if (!supportsReasoningEffort(model)) {
    addWarning(warnings, 'unsupported_reasoning_effort', 'reasoning.effort');
    return;
  }
  converted.reasoning_effort = clampReasoningEffort(model, effort.trim().toLowerCase());
}

/**
 * 把 OpenAI Responses 请求转换为 OpenAI Chat Completions 请求。
 * @param {{ body: object, model: string }} input body.model 已是上游模型 id。
 * @returns {{ body: object, stream: boolean, warnings: Array<{ code: string, field?: string }> }}
 */
export function convertRequest({ body, model } = {}) {
  if (!isPlainObject(body)) {
    throw new ConversionRequestError('请求体必须是 JSON 对象');
  }
  const upstreamModel = pickString(model, body.model);
  if (upstreamModel === '') {
    throw new ConversionRequestError('缺少上游模型 id', { field: 'model' });
  }

  const warnings = [];
  const messages = buildMessages(body, warnings);
  if (messages.length === 0) {
    throw new ConversionRequestError('转换后没有可发送的消息', {
      code: 'empty_messages',
      field: 'input',
    });
  }

  const converted = { model: upstreamModel, messages };
  const tools = mapTools(body.tools, warnings);
  if (tools.length > 0) {
    converted.tools = tools;
    const toolChoice = mapToolChoiceToChat(normalizeResponsesToolChoice(body.tool_choice));
    if (toolChoice !== undefined) converted.tool_choice = toolChoice;
  }

  applyMaxTokens(body, upstreamModel, converted);
  if (body.temperature !== undefined) converted.temperature = body.temperature;
  if (body.top_p !== undefined) converted.top_p = body.top_p;
  applyStreamOptions(body, converted);
  applyReasoningEffort(body, upstreamModel, converted, warnings);

  for (const field of PASSTHROUGH_FIELDS) {
    if (body[field] !== undefined) converted[field] = body[field];
  }
  for (const field of DROPPED_REQUEST_FIELDS) {
    if (body[field] !== undefined) addWarning(warnings, 'dropped_field', field);
  }

  return { body: converted, stream: body.stream === true, warnings };
}

function chatMessageText(content, warnings) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const texts = [];
  for (const part of content) {
    if (
      isPlainObject(part)
      && (part.type === 'text' || part.type === 'output_text')
      && typeof part.text === 'string'
    ) {
      texts.push(part.text);
      continue;
    }
    addWarning(warnings, 'unsupported_content_part', 'choices');
  }
  return texts.join('');
}

function mapChatToolCalls(toolCalls, warnings) {
  if (toolCalls === undefined || toolCalls === null) return [];
  if (!Array.isArray(toolCalls)) {
    addWarning(warnings, 'invalid_tool_call', 'choices');
    return [];
  }

  const items = [];
  for (const toolCall of toolCalls) {
    const fn = isPlainObject(toolCall) ? toolCall.function : null;
    if (!isPlainObject(fn) || typeof fn.name !== 'string' || fn.name === '') {
      addWarning(warnings, 'invalid_tool_call', 'choices');
      continue;
    }
    items.push({
      type: 'function_call',
      id: `fc_${items.length}`,
      call_id: pickString(toolCall.id),
      name: fn.name,
      arguments: stringifyArguments(fn.arguments),
      status: 'completed',
    });
  }
  return items;
}

function statusFromFinishReason(finishReason) {
  if (finishReason === 'length') {
    return { status: 'incomplete', incompleteDetails: { reason: 'max_output_tokens' } };
  }
  if (finishReason === 'content_filter') {
    return { status: 'incomplete', incompleteDetails: { reason: 'content_filter' } };
  }
  return { status: 'completed' };
}
function toEpochSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  return Math.floor(Date.now() / 1000);
}

/**
 * 把 OpenAI Chat Completions 非流式响应转换为 OpenAI Responses 响应。
 * @param {{ body: object, request: object }} input request 为转换后的 Chat 请求体。
 * @returns {{ body: object, warnings: Array<{ code: string, field?: string }> }}
 */
export function convertResponse({ body, request } = {}) {
  if (!isPlainObject(body)) {
    throw new ConversionError('上游响应必须是 JSON 对象', { code: 'invalid_upstream_response' });
  }
  const choice = Array.isArray(body.choices) && body.choices.length > 0 ? body.choices[0] : null;
  if (!isPlainObject(choice)) {
    throw new ConversionError('上游响应缺少 choices[0]', {
      code: 'invalid_chat_response',
      field: 'choices',
    });
  }
  if (!isPlainObject(choice.message)) {
    throw new ConversionError('上游响应缺少 message', {
      code: 'invalid_chat_response',
      field: 'choices',
    });
  }

  const warnings = [];
  const message = choice.message;
  if (hasReasoningContent(message.reasoning_content)) {
    addWarning(warnings, 'reasoning_content_dropped', 'choices');
  }
  const text = chatMessageText(message.content, warnings);
  const toolCallItems = mapChatToolCalls(message.tool_calls, warnings);
  const statusInfo = statusFromFinishReason(choice.finish_reason);

  const output = [];
  if (text !== '') {
    output.push({
      type: 'message',
      id: 'msg_0',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    });
  }
  output.push(...toolCallItems);

  return {
    body: {
      id: pickString(body.id, FALLBACK_RESPONSE_ID),
      object: 'response',
      created_at: toEpochSeconds(body.created),
      model: pickString(body.model, request?.model),
      status: statusInfo.status,
      output,
      usage: neutralToResponses(neutralFromOpenAiChat(body.usage)),
      ...(statusInfo.incompleteDetails
        ? { incomplete_details: statusInfo.incompleteDetails }
        : {}),
    },
    warnings,
  };
}

function joinFrames(frames) {
  return frames.length === 0 ? null : frames.join('');
}

function firstChoice(chunk) {
  if (!Array.isArray(chunk.choices) || chunk.choices.length === 0) return null;
  const choice = chunk.choices[0];
  return isPlainObject(choice) ? choice : null;
}

function incompleteTerminal(reason) {
  return { status: 'incomplete', eventType: 'response.incomplete', incompleteDetails: { reason } };
}

function chatDeltaText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .filter((part) => (
      isPlainObject(part)
      && (part.type === 'text' || part.type === 'output_text')
      && typeof part.text === 'string'
    ))
    .map((part) => part.text)
    .join('');
}

class ChatToResponsesStream {
  #parser = new SseParser();
  #warnings = [];
  #model;
  #id = null;
  #createdAt = null;
  #sequence = 0;
  #started = false;
  #finishReason = null;
  #done = false;
  #message = null;
  #tools = new Map();
  #nextOutputIndex = 0;
  #outputItems = [];
  #usage = emptyNeutral();

  constructor(request) { this.#model = typeof request?.model === 'string' ? request.model : ''; }

  get done() { return this.#done; }

  get warnings() { return this.#warnings; }

  push(chunk) {
    if (this.#done) return null;
    return joinFrames(this.#processEvents(this.#parser.push(chunk)));
  }

  end() {
    if (this.#done) return null;
    const frames = this.#processEvents(this.#parser.end());
    // finish_reason 只关闭输出项；终止事件延迟到 [DONE]/EOF，让 usage-only chunk 能并入。
    if (!this.#done) this.#finalize(frames);
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
      this.#finalize(frames);
      return;
    }

    let chunk;
    try {
      chunk = JSON.parse(event.data);
    } catch {
      this.#warn('invalid_upstream_event');
      return;
    }
    if (!isPlainObject(chunk)) return;
    this.#ensureStarted(chunk, frames);
    this.#mergeUsage(chunk);
    if (this.#finishReason !== null) return;

    const choice = firstChoice(chunk);
    if (choice === null) return;
    const delta = isPlainObject(choice.delta) ? choice.delta : {};
    this.#handleDelta(delta, frames);

    if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
      this.#finishReason = choice.finish_reason;
      this.#closeOpenItems(frames);
    }
  }

  #ensureStarted(chunk, frames) {
    if (this.#started) return;
    this.#started = true;
    if (typeof chunk.id === 'string' && chunk.id !== '') this.#id = chunk.id;
    if (typeof chunk.model === 'string' && chunk.model !== '') this.#model = chunk.model;
    if (typeof chunk.created === 'number' && Number.isFinite(chunk.created)) {
      this.#createdAt = Math.floor(chunk.created);
    }

    const response = this.#responseEnvelope('in_progress');
    frames.push(this.#emit('response.created', { response }));
    frames.push(this.#emit('response.in_progress', { response }));
  }

  #mergeUsage(chunk) {
    if (isPlainObject(chunk.usage)) this.#usage = mergeNeutral(this.#usage, neutralFromOpenAiChat(chunk.usage));
  }

  #handleDelta(delta, frames) {
    if (hasReasoningContent(delta.reasoning_content) || hasReasoningContent(delta.reasoning)) {
      this.#warn('reasoning_dropped', 'choices');
    }

    const text = chatDeltaText(delta.content);
    if (text !== '') this.#appendText(text, frames);
    if (Array.isArray(delta.tool_calls)) this.#handleToolCalls(delta.tool_calls, frames);
  }

  #appendText(text, frames) {
    const message = this.#ensureMessageItem(frames);
    message.text += text;
    frames.push(this.#emit('response.output_text.delta', {
      item_id: message.itemId,
      output_index: message.outputIndex,
      content_index: 0,
      delta: text,
    }));
  }

  #ensureMessageItem(frames) {
    if (this.#message !== null) return this.#message;

    const outputIndex = this.#nextOutputIndex;
    this.#nextOutputIndex += 1;
    const itemId = `msg_${outputIndex}`;
    this.#message = { itemId, outputIndex, text: '', done: false };

    frames.push(this.#emit('response.output_item.added', {
      output_index: outputIndex,
      item: { type: 'message', id: itemId, status: 'in_progress', role: 'assistant', content: [] },
    }));
    frames.push(this.#emit('response.content_part.added', {
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    }));
    return this.#message;
  }

  #handleToolCalls(toolCalls, frames) {
    for (const toolDelta of toolCalls) {
      if (!isPlainObject(toolDelta)) continue;
      const tool = this.#ensureToolItem(toolDelta, frames);
      const fragment = typeof toolDelta.function?.arguments === 'string'
        ? toolDelta.function.arguments
        : '';      if (fragment === '') continue;

      tool.arguments += fragment;
      frames.push(this.#emit('response.function_call_arguments.delta', {
        item_id: tool.itemId,
        output_index: tool.outputIndex,
        delta: fragment,
      }));
    }
  }

  #ensureToolItem(toolDelta, frames) {
    const key = Number.isInteger(toolDelta.index) ? toolDelta.index : this.#tools.size;
    const existing = this.#tools.get(key);
    const callId = typeof toolDelta.id === 'string' ? toolDelta.id : '';
    const name = typeof toolDelta.function?.name === 'string' ? toolDelta.function.name : '';

    if (existing !== undefined) {
      if (existing.callId === '' && callId !== '') existing.callId = callId;
      if (existing.name === '' && name !== '') existing.name = name;
      return existing;
    }

    const outputIndex = this.#nextOutputIndex;
    this.#nextOutputIndex += 1;
    const itemId = `fc_${outputIndex}`;
    const tool = { key, itemId, outputIndex, callId, name, arguments: '', done: false };
    this.#tools.set(key, tool);

    frames.push(this.#emit('response.output_item.added', {
      output_index: outputIndex,
      item: {
        type: 'function_call',
        id: itemId,
        call_id: callId,
        name,
        arguments: '',
        status: 'in_progress',
      },
    }));
    return tool;
  }

  #closeOpenItems(frames) {
    if (this.#message !== null && !this.#message.done) this.#closeMessageItem(frames);
    for (const tool of this.#orderedTools()) if (!tool.done) this.#closeToolItem(tool, frames);
  }

  #closeMessageItem(frames) {
    const message = this.#message;
    message.done = true;
    const part = { type: 'output_text', text: message.text, annotations: [] };

    frames.push(this.#emit('response.output_text.done', {
      item_id: message.itemId,
      output_index: message.outputIndex,
      content_index: 0,
      text: message.text,
    }));
    frames.push(this.#emit('response.content_part.done', {
      item_id: message.itemId,
      output_index: message.outputIndex,
      content_index: 0,
      part,
    }));
    const item = { type: 'message', id: message.itemId, status: 'completed', role: 'assistant', content: [part] };
    this.#outputItems.push(item);
    frames.push(this.#emit('response.output_item.done', {
      output_index: message.outputIndex,
      item,
    }));
  }

  #closeToolItem(tool, frames) {
    tool.done = true;
    frames.push(this.#emit('response.function_call_arguments.done', {
      item_id: tool.itemId,
      output_index: tool.outputIndex,
      arguments: tool.arguments,
    }));
    const item = {
      type: 'function_call',
      id: tool.itemId,
      call_id: tool.callId,
      name: tool.name,
      arguments: tool.arguments,
      status: 'completed',
    };
    this.#outputItems.push(item);
    frames.push(this.#emit('response.output_item.done', {
      output_index: tool.outputIndex,
      item,
    }));
  }

  #orderedTools() { return [...this.#tools.values()].sort((left, right) => left.key - right.key); }

  #finalize(frames) {
    if (this.#done) return;
    this.#done = true;
    this.#closeOpenItems(frames);
    const terminal = this.#terminalStatus();
    frames.push(this.#emit(terminal.eventType, { response: this.#terminalResponse(terminal) }));
  }

  #terminalStatus() {
    if (this.#finishReason === null) {
      if (this.#hasContent()) return incompleteTerminal('max_output_tokens');
      return {
        status: 'failed',
        eventType: 'response.failed',
        error: { code: 'stream_truncated', message: STREAM_TRUNCATED_MESSAGE },
      };
    }
    if (this.#finishReason === 'length') return incompleteTerminal('max_output_tokens');
    if (this.#finishReason === 'content_filter') return incompleteTerminal('content_filter');
    return { status: 'completed', eventType: 'response.completed' };
  }

  #hasContent() { return this.#message !== null || this.#tools.size > 0; }

  #terminalResponse(terminal) {
    return {
      ...this.#responseEnvelope(terminal.status),
      output: this.#outputItems,
      usage: neutralToResponses(this.#usage),
      ...(terminal.incompleteDetails ? { incomplete_details: terminal.incompleteDetails } : {}),
      ...(terminal.error ? { error: terminal.error } : {}),
    };
  }

  #responseEnvelope(status) {
    return {
      id: this.#id ?? FALLBACK_RESPONSE_ID,
      object: 'response',
      created_at: this.#createdAt ?? Math.floor(Date.now() / 1000),
      model: this.#model,
      status,
      output: [],
      usage: neutralToResponses(emptyNeutral()),
    };
  }

  #emit(type, payload) {
    const data = { type, sequence_number: this.#sequence, ...payload };
    this.#sequence += 1;
    return formatSseEvent({ event: type, data: JSON.stringify(data) });
  }

  #warn(code, field) { addWarning(this.#warnings, code, field); }
}

/**
 * 创建 OpenAI Chat SSE → OpenAI Responses SSE 的增量转换器。
 * @param {{ request: object }} input request 为转换后的 Chat 上游请求体。
 */
export function createStreamConverter({ request } = {}) {
  return new ChatToResponsesStream(request);
}
