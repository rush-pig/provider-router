import { isPlainObject } from '../../util.mjs';
import { SseParser, formatSseEvent } from '../common/sse.mjs';
import { mergeNeutral, neutralFromAnthropic, neutralFromResponses, neutralToAnthropic } from '../common/usage.mjs';
import { ConversionError, ConversionRequestError } from '../common/errors.mjs';
import { canonicalJson, cleanSchema, mapToolChoiceToAnthropic, parseJsonObject } from '../common/tools.mjs';
import { decodeThinkingBridge, thinkingForAnthropic } from '../common/thinking.mjs';
import { thinkingCannotBeDisabled } from '../common/model-capabilities.mjs';
import { injectAnthropicCacheControl } from '../common/cache.mjs';
import { normalizeAnthropicMessages, stripLeadingBillingHeader } from '../common/messages.mjs';
import { DEFAULT_ANTHROPIC_MAX_TOKENS } from '../common/constants.mjs';

const SYSTEM_SEPARATOR = '\n\n';
const FORCED_TOOL_CHOICE_TYPES = new Set(['any', 'required', 'tool']);
const TEXT_PART_TYPES = new Set(['input_text', 'output_text', 'text']);
const DATA_URI_PATTERN = /^data:([^;,]+);base64,(.+)$/s;
const SYSTEM_ROLES = new Set(['system', 'developer']);

const WARN_UNSUPPORTED_FIELD = 'unsupported_field';
const WARN_UNSUPPORTED_TOOL = 'unsupported_tool';
const WARN_TOOL_CHOICE_WITHOUT_TOOLS = 'tool_choice_without_tools';
const WARN_UNSUPPORTED_CONTENT_PART = 'unsupported_content_part';
const WARN_UNSUPPORTED_INPUT_ITEM = 'unsupported_input_item';
const WARN_UNSUPPORTED_OUTPUT_ITEM = 'unsupported_output_item';
const WARN_UNSUPPORTED_OUTPUT_PART = 'unsupported_output_part';
const WARN_REASONING_DROPPED = 'reasoning_dropped';
const WARN_INVALID_STREAM_EVENT = 'invalid_stream_event';
const WARN_UNKNOWN_STREAM_ITEM = 'unknown_stream_item';
const ERROR_STREAM_TRUNCATED = 'stream_truncated';
const THINKING_CONFLICT_CODE = 'thinking_conflict';

/** OpenAI Responses 请求 → Anthropic Messages 请求。 */
export function convertRequest({ body, model }) {
  if (!isPlainObject(body)) {
    throw new ConversionRequestError('请求体必须是 JSON 对象', { field: 'body' });
  }

  const warnings = [];
  const input = normalizeResponsesInput(body.input);
  const target = { model: body.model ?? model };

  const system = collectSystemPrompt(body.instructions, input);
  if (system !== '') target.system = system;

  target.messages = buildMessages(input, warnings);
  if (target.messages.length === 0) {
    throw new ConversionRequestError('input 中没有可转换的消息', { field: 'input' });
  }

  const tools = convertTools(body.tools, warnings);
  if (tools) {
    target.tools = tools;
    const toolChoice = mapToolChoiceToAnthropic(body.tool_choice);
    if (toolChoice !== undefined) applyToolChoice(target, toolChoice, body);
  } else if (body.tool_choice !== undefined) {
    warnings.push({ code: WARN_TOOL_CHOICE_WITHOUT_TOOLS, field: 'tool_choice' });
  }

  target.max_tokens = resolveMaxTokens(body.max_output_tokens);
  applySampling(target, body);
  applyThinking(target, body, model, target.max_tokens);
  if (typeof body.stream === 'boolean') target.stream = body.stream;
  if (isPlainObject(body.metadata)) target.metadata = body.metadata;
  collectDroppedRequestFields(body, warnings);

  const injected = injectAnthropicCacheControl(target);
  return {
    body: injected.body,
    stream: body.stream === true,
    warnings: [...warnings, ...injected.warnings],
  };
}

function normalizeResponsesInput(input) {
  if (Array.isArray(input)) return input;
  if (typeof input === 'string' && input.trim() !== '') {
    return [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: input }] }];
  }
  return [];
}

/** OpenAI Responses 响应 → Anthropic Messages 响应。 */
export function convertResponse({ body, request }) {
  if (!isPlainObject(body)) {
    throw new ConversionError('上游响应必须是 JSON 对象', { field: 'body' });
  }

  const warnings = [];
  const output = Array.isArray(body.output) ? body.output : [];
  const { content, hasToolUse } = buildAnthropicContent(output, warnings);
  const stopReason = resolveStopReason(body, hasToolUse);

  return {
    body: {
      id: body.id,
      type: 'message',
      role: 'assistant',
      model: body.model ?? request?.model ?? null,
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: neutralToAnthropic(neutralFromResponses(body.usage)),
    },
    warnings,
  };
}

/** Responses SSE → Anthropic SSE。 */
export function createStreamConverter({ request }) {
  return new AnthropicStreamConverter(request?.model ?? null);
}

function collectSystemPrompt(instructions, input) {
  const segments = [];
  if (typeof instructions === 'string') segments.push(instructions);
  else if (Array.isArray(instructions)) segments.push(...textSegmentsFromParts(instructions));

  for (const item of input) {
    if (!isPlainObject(item) || item.type !== 'message' || !SYSTEM_ROLES.has(item.role)) continue;
    segments.push(...textSegmentsFromParts(item.content));
  }

  return segments
    .map((segment) => stripLeadingBillingHeader(segment))
    .filter((segment) => segment.trim() !== '')
    .join(SYSTEM_SEPARATOR);
}

function textSegmentsFromParts(content) {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content
    .filter((part) => isPlainObject(part) && TEXT_PART_TYPES.has(part.type) && typeof part.text === 'string')
    .map((part) => part.text);
}

function buildMessages(input, warnings) {
  const state = { messages: [], pendingReasoning: [] };
  for (const item of input) {
    if (!isPlainObject(item)) continue;
    if (item.type === 'message') appendMessageItem(state, item, warnings);
    else if (item.type === 'function_call') appendFunctionCall(state, item);
    else if (item.type === 'function_call_output') appendFunctionCallOutput(state, item, warnings);
    else if (item.type === 'reasoning') appendReasoningItem(state, item, warnings);
    else warnings.push({ code: WARN_UNSUPPORTED_INPUT_ITEM, field: 'input' });
  }

  if (state.pendingReasoning.length > 0) {
    warnings.push({ code: WARN_REASONING_DROPPED, field: 'input' });
  }
  return normalizeAnthropicMessages(state.messages);
}

function appendMessageItem(state, item, warnings) {
  if (SYSTEM_ROLES.has(item.role)) return;

  const blocks = messageContentBlocks(item.content, warnings);
  if (blocks.length === 0) return;
  if (item.role === 'assistant') appendAssistantBlocks(state, blocks);
  else if (item.role === 'user') appendUserBlocks(state, blocks);
  else warnings.push({ code: WARN_UNSUPPORTED_INPUT_ITEM, field: 'input' });
}

function messageContentBlocks(content, warnings) {
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];

  const blocks = [];
  for (const part of content) {
    if (!isPlainObject(part)) continue;
    if (TEXT_PART_TYPES.has(part.type)) {
      if (typeof part.text === 'string' && part.text !== '') blocks.push({ type: 'text', text: part.text });
      continue;
    }
    const image = part.type === 'input_image' ? imageBlockFromPart(part) : null;
    if (image) blocks.push(image);
    else warnings.push({ code: WARN_UNSUPPORTED_CONTENT_PART, field: 'input' });
  }
  return blocks;
}

function appendAssistantBlocks(state, blocks) {
  const last = state.messages.at(-1);
  const message = last?.role === 'assistant' ? last : { role: 'assistant', content: [] };
  if (message !== last) state.messages.push(message);

  if (state.pendingReasoning.length > 0) {
    message.content.push(...state.pendingReasoning);
    state.pendingReasoning = [];
  }
  message.content.push(...blocks);
}

function appendUserBlocks(state, blocks) {
  const last = state.messages.at(-1);
  if (last?.role === 'user') {
    last.content.push(...blocks);
    return;
  }
  state.messages.push({ role: 'user', content: [...blocks] });
}

function appendFunctionCall(state, item) {
  appendAssistantBlocks(state, [{
    type: 'tool_use',
    id: item.call_id ?? item.id,
    name: item.name,
    input: parseJsonObject(item.arguments) ?? {},
  }]);
}

function appendFunctionCallOutput(state, item, warnings) {
  appendUserBlocks(state, [{
    type: 'tool_result',
    tool_use_id: item.call_id ?? item.id,
    content: toolResultContent(item.output, warnings),
  }]);
}

function toolResultContent(output, warnings) {
  if (typeof output === 'string') return output;
  if (output === undefined || output === null) return '';
  if (!Array.isArray(output)) {
    return typeof output === 'object' ? canonicalJson(output) : String(output);
  }

  const blocks = [];
  for (const part of output) {
    if (!isPlainObject(part)) continue;
    if (TEXT_PART_TYPES.has(part.type) && typeof part.text === 'string') {
      blocks.push({ type: 'text', text: part.text });
      continue;
    }
    const image = part.type === 'input_image' ? imageBlockFromPart(part) : null;
    if (image) blocks.push(image);
    else warnings.push({ code: WARN_UNSUPPORTED_CONTENT_PART, field: 'input' });
  }
  return blocks;
}

function imageBlockFromPart(part) {
  if (isPlainObject(part.source)) return anthropicImageFromSource(part.source);

  const url = readImageUrl(part.image_url);
  if (url === null) return null;

  const dataUri = DATA_URI_PATTERN.exec(url);
  if (dataUri) {
    return { type: 'image', source: { type: 'base64', media_type: dataUri[1], data: dataUri[2] } };
  }
  if (url.startsWith('data:')) return null;
  return { type: 'image', source: { type: 'url', url } };
}

function readImageUrl(value) {
  if (typeof value === 'string') return value;
  if (isPlainObject(value) && typeof value.url === 'string') return value.url;
  return null;
}

function anthropicImageFromSource(source) {
  if (source.type === 'base64' && typeof source.data === 'string' && typeof source.media_type === 'string') {
    return { type: 'image', source: { type: 'base64', media_type: source.media_type, data: source.data } };
  }
  if (source.type === 'url' && typeof source.url === 'string') {
    return { type: 'image', source: { type: 'url', url: source.url } };
  }
  return null;
}

function appendReasoningItem(state, item, warnings) {
  const blocks = decodeThinkingBridge(item);
  if (!blocks) {
    warnings.push({ code: WARN_REASONING_DROPPED, field: 'input' });
    return;
  }

  const last = state.messages.at(-1);
  if (last?.role === 'assistant') last.content.push(...blocks);
  else state.pendingReasoning.push(...blocks);
}

function convertTools(tools, warnings) {
  if (!Array.isArray(tools)) return null;

  const converted = [];
  for (const tool of tools) {
    if (!isPlainObject(tool) || tool.type !== 'function' || typeof tool.name !== 'string') {
      warnings.push({ code: WARN_UNSUPPORTED_TOOL, field: 'tools' });
      continue;
    }
    const entry = { name: tool.name };
    if (typeof tool.description === 'string') entry.description = tool.description;
    entry.input_schema = cleanSchema(tool.parameters);
    converted.push(entry);
  }
  return converted.length > 0 ? converted : null;
}

function applyToolChoice(target, toolChoice, body) {
  if (body.parallel_tool_calls !== false) {
    target.tool_choice = toolChoice;
    return;
  }
  target.tool_choice = typeof toolChoice === 'string'
    ? { type: toolChoice, disable_parallel_tool_use: true }
    : { ...toolChoice, disable_parallel_tool_use: true };
}

function resolveMaxTokens(maxOutputTokens) {
  const value = Number(maxOutputTokens);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_ANTHROPIC_MAX_TOKENS;
}

function applySampling(target, body) {
  if (Number.isFinite(body.temperature)) target.temperature = body.temperature;
  if (Number.isFinite(body.top_p)) target.top_p = body.top_p;
}

function applyThinking(target, body, model, maxTokens) {
  const effort = isPlainObject(body.reasoning) ? body.reasoning.effort : undefined;
  const config = thinkingForAnthropic({ model, effort, maxTokens });
  if (!config) return;

  target.thinking = config.thinking;
  if (config.outputConfig) target.output_config = config.outputConfig;

  if (!isForcedToolChoice(target.tool_choice)) {
    delete target.temperature;
    delete target.top_p;
    return;
  }
  if (thinkingCannotBeDisabled(model)) {
    throw new ConversionRequestError('该模型不允许在强制工具调用时关闭 thinking', {
      code: THINKING_CONFLICT_CODE,
      field: 'tool_choice',
    });
  }
  target.thinking = { type: 'disabled' };
  delete target.output_config;
}

function isForcedToolChoice(toolChoice) {
  if (typeof toolChoice === 'string') return FORCED_TOOL_CHOICE_TYPES.has(toolChoice.toLowerCase());
  if (!isPlainObject(toolChoice)) return false;
  return FORCED_TOOL_CHOICE_TYPES.has(toolChoice.type);
}

function collectDroppedRequestFields(body, warnings) {
  for (const field of ['previous_response_id', 'store', 'truncation', 'include']) {
    if (body[field] !== undefined && body[field] !== null) {
      warnings.push({ code: WARN_UNSUPPORTED_FIELD, field });
    }
  }
  if (isPlainObject(body.text) && body.text.format !== undefined && body.text.format !== null) {
    warnings.push({ code: WARN_UNSUPPORTED_FIELD, field: 'text.format' });
  }
}

function buildAnthropicContent(output, warnings) {
  const content = [];
  let hasToolUse = false;

  for (const item of output) {
    if (!isPlainObject(item)) continue;
    if (item.type === 'message') {
      appendOutputMessage(content, item, warnings);
    } else if (item.type === 'function_call') {
      content.push({
        type: 'tool_use',
        id: item.call_id ?? item.id,
        name: item.name,
        input: parseJsonObject(item.arguments) ?? {},
      });
      hasToolUse = true;
    } else if (item.type === 'reasoning') {
      appendOutputReasoning(content, item, warnings);
    } else {
      warnings.push({ code: WARN_UNSUPPORTED_OUTPUT_ITEM, field: 'output' });
    }
  }
  return { content, hasToolUse };
}

function appendOutputMessage(content, item, warnings) {
  const parts = Array.isArray(item.content) ? item.content : [];
  for (const part of parts) {
    if (!isPlainObject(part)) continue;
    if ((part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') {
      content.push({ type: 'text', text: part.text });
    } else {
      warnings.push({ code: WARN_UNSUPPORTED_OUTPUT_PART, field: 'output' });
    }
  }
}

function appendOutputReasoning(content, item, warnings) {
  const blocks = decodeThinkingBridge(item);
  if (blocks) content.push(...blocks);
  else warnings.push({ code: WARN_REASONING_DROPPED, field: 'output' });
}

function resolveStopReason(body, hasToolUse) {
  if (body.status === 'failed' || body.status === 'cancelled') {
    const detail = isPlainObject(body.error) && typeof body.error.message === 'string'
      ? body.error.message
      : `上游响应状态为 ${body.status}`;
    throw new ConversionError(`上游响应失败：${detail}`, { code: 'upstream_failed', field: 'status' });
  }
  if (body.status === 'incomplete' && body.incomplete_details?.reason === 'max_output_tokens') {
    return 'max_tokens';
  }
  return hasToolUse ? 'tool_use' : 'end_turn';
}

class AnthropicStreamConverter {
  #parser = new SseParser();
  #warnings = [];
  #frames = [];
  #requestModel;
  #messageId = null;
  #model = null;
  #usage = neutralFromAnthropic(null);
  #blockCounter = 0;
  #started = false;
  #terminated = false;
  #hasTextContent = false;
  #hasToolUse = false;
  #itemStates = new Map();
  #openBlocks = new Map();

  constructor(requestModel) {
    this.#requestModel = requestModel;
  }

  get done() { return this.#terminated; }

  get warnings() { return this.#warnings; }

  push(chunk) {
    if (this.#terminated) return null;
    return this.#process(this.#parser.push(chunk));
  }

  end() {
    if (this.#terminated) return null;
    const frames = this.#process(this.#parser.end());
    const tail = this.#terminated ? null : this.#finishOnEof();
    return combineFrames(frames, tail);
  }

  #process(events) {
    for (const event of events) {
      if (this.#terminated) break;
      this.#handleEvent(event);
    }
    return this.#takeFrames();
  }

  #handleEvent(event) {
    const data = parseEventData(event, this.#warnings);
    if (!data) return;

    const type = typeof data.type === 'string' ? data.type : event.event;
    if (type === 'response.created' || type === 'response.in_progress') this.#ensureMessageStart(data.response);
    else if (type === 'response.output_item.added') this.#handleItemAdded(data.item);
    else if (type === 'response.output_text.delta') this.#handleTextDelta(data);
    else if (type === 'response.function_call_arguments.delta') this.#handleToolArgumentsDelta(data);
    else if (type === 'response.reasoning_summary_text.delta') this.#handleReasoningDelta(data);
    else if (type === 'response.output_item.done') this.#handleItemDone(data.item);
    else if (type === 'response.completed') this.#complete(data.response, 'completed');
    else if (type === 'response.incomplete') this.#complete(data.response, 'incomplete');
    else if (type === 'response.failed') this.#fail(data.response ?? data);
    else if (type === 'error') this.#fail(data);
  }

  #handleItemAdded(item) {
    if (!isPlainObject(item)) return;
    this.#ensureMessageStart(null);
    if (item.type === 'message') this.#openTextItem(item);
    else if (item.type === 'function_call') this.#openToolItem(item);
    else if (item.type === 'reasoning') this.#openReasoningItem(item);
    else this.#warnings.push({ code: WARN_UNSUPPORTED_OUTPUT_ITEM, field: 'item' });
  }

  #openTextItem(item) {
    const state = { kind: 'text', itemId: item.id, index: this.#nextBlockIndex(), text: '' };
    this.#itemStates.set(item.id, state);
    this.#openBlocks.set(state.index, state);
    this.#emit('content_block_start', {
      index: state.index,
      content_block: { type: 'text', text: '' },
    });
  }

  #openToolItem(item) {
    const state = {
      kind: 'tool',
      itemId: item.id,
      index: this.#nextBlockIndex(),
      id: item.call_id ?? item.id,
      name: item.name ?? '',
      arguments: typeof item.arguments === 'string' ? item.arguments : '',
    };
    this.#itemStates.set(item.id, state);
    this.#openBlocks.set(state.index, state);
    this.#hasToolUse = true;

    this.#emit('content_block_start', {
      index: state.index,
      content_block: { type: 'tool_use', id: state.id, name: state.name, input: {} },
    });
    if (state.arguments !== '') {
      this.#emit('content_block_delta', {
        index: state.index,
        delta: { type: 'input_json_delta', partial_json: state.arguments },
      });
    }
  }

  #openReasoningItem(item) {
    const blocks = decodeThinkingBridge(item);
    if (!blocks) {
      this.#itemStates.set(item.id, { kind: 'reasoning-summary', itemId: item.id, index: null });
      return;
    }
    const state = { kind: 'reasoning', itemId: item.id, blocks, cursor: 0, openIndex: null, current: null };
    this.#itemStates.set(item.id, state);
    this.#openBridgeBlock(state);
  }

  #openBridgeBlock(state) {
    if (state.cursor >= state.blocks.length) {
      state.openIndex = null;
      return;
    }
    const block = state.blocks[state.cursor];
    const index = this.#nextBlockIndex();
    state.openIndex = index;
    state.current = block;
    this.#openBlocks.set(index, state);

    if (block.type === 'thinking') {
      this.#emit('content_block_start', { index, content_block: { type: 'thinking', thinking: '' } });
    } else {
      this.#emit('content_block_start', {
        index,
        content_block: { type: 'redacted_thinking', data: typeof block.data === 'string' ? block.data : '' },
      });
    }
  }

  #handleTextDelta(data) {
    const state = this.#itemStates.get(data.item_id);
    if (!state || state.kind !== 'text') return this.#warnUnknownItem();
    const delta = typeof data.delta === 'string' ? data.delta : '';
    if (delta === '') return;

    state.text += delta;
    this.#hasTextContent = true;
    this.#emit('content_block_delta', { index: state.index, delta: { type: 'text_delta', text: delta } });
  }

  #handleToolArgumentsDelta(data) {
    const state = this.#itemStates.get(data.item_id);
    if (!state || state.kind !== 'tool') return this.#warnUnknownItem();
    const partial = typeof data.delta === 'string' ? data.delta : '';
    if (partial === '') return;

    state.arguments += partial;
    this.#emit('content_block_delta', {
      index: state.index,
      delta: { type: 'input_json_delta', partial_json: partial },
    });
  }

  #handleReasoningDelta(data) {
    const state = this.#itemStates.get(data.item_id);
    if (!state || (state.kind !== 'reasoning' && state.kind !== 'reasoning-summary')) {
      return this.#warnUnknownItem();
    }
    const thinking = typeof data.delta === 'string' ? data.delta : '';
    if (thinking === '') return;

    let index = null;
    if (state.kind === 'reasoning-summary') index = this.#ensureSummaryBlock(state);
    else if (state.current?.type === 'thinking') index = state.openIndex;
    if (index === null) return;

    this.#hasTextContent = true;
    this.#emit('content_block_delta', { index, delta: { type: 'thinking_delta', thinking } });
  }

  #handleItemDone(item) {
    if (!isPlainObject(item)) return;
    const state = this.#itemStates.get(item.id);
    if (!state) return;
    this.#itemStates.delete(item.id);

    if (state.kind === 'reasoning') this.#closeReasoningItem(state);
    else if (state.kind === 'reasoning-summary') this.#closeSummary(state);
    else this.#closeSimpleBlock(state);
  }

  #closeReasoningItem(state) {
    while (state.openIndex !== null) this.#closeBridgeBlock(state);
  }

  #closeBridgeBlock(state) {
    const index = state.openIndex;
    if (index === null) return;

    if (state.current?.type === 'thinking') {
      const signature = typeof state.current.signature === 'string' ? state.current.signature : '';
      if (signature !== '') {
        this.#emit('content_block_delta', { index, delta: { type: 'signature_delta', signature } });
      }
    }
    this.#emit('content_block_stop', { index });
    this.#openBlocks.delete(index);

    state.openIndex = null;
    state.current = null;
    state.cursor += 1;
    if (state.cursor < state.blocks.length) this.#openBridgeBlock(state);
  }

  #closeSummary(state) {
    if (state.index !== null) return this.#closeSimpleBlock(state);
    this.#warnings.push({ code: WARN_REASONING_DROPPED, field: 'item' });
  }

  #ensureSummaryBlock(state) {
    if (state.index !== null) return state.index;

    const index = this.#nextBlockIndex();
    state.index = index;
    this.#openBlocks.set(index, state);
    this.#emit('content_block_start', { index, content_block: { type: 'thinking', thinking: '' } });
    return index;
  }

  #closeSimpleBlock(state) {
    if (state.index === null) return;
    const index = state.index;
    state.index = null;
    this.#openBlocks.delete(index);
    this.#emit('content_block_stop', { index });
  }

  #complete(response, mode) {
    this.#ensureMessageStart(response);
    if (isPlainObject(response)) {
      this.#usage = mergeNeutral(this.#usage, neutralFromResponses(response.usage));
    }
    this.#closeAllOpenBlocks();

    const stopReason = mode === 'incomplete' ? 'max_tokens' : this.#hasToolUse ? 'tool_use' : 'end_turn';
    this.#emit('message_delta', {
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: neutralToAnthropic(this.#usage),
    });
    this.#emit('message_stop', {});
    this.#terminated = true;
  }

  #fail(payload) {
    this.#ensureMessageStart(null);
    const error = isPlainObject(payload) && isPlainObject(payload.error) ? payload.error : payload;
    const message = isPlainObject(error) && typeof error.message === 'string' ? error.message : '上游响应失败';
    this.#emit('error', { error: { type: readErrorType(error), message } });
    this.#terminated = true;
  }

  #finishOnEof() {
    this.#ensureMessageStart(null);
    if (this.#hasTextContent) {
      this.#closeAllOpenBlocks();
      this.#emit('message_delta', {
        delta: { stop_reason: 'max_tokens', stop_sequence: null },
        usage: neutralToAnthropic(this.#usage),
      });
      this.#emit('message_stop', {});
    } else {
      this.#emit('error', {
        error: { type: ERROR_STREAM_TRUNCATED, message: '上游流在完成前结束' },
      });
    }
    this.#terminated = true;
    return this.#takeFrames();
  }

  #closeAllOpenBlocks() {
    const states = new Set(this.#openBlocks.values());
    for (const state of states) {
      if (state.kind === 'reasoning') this.#closeReasoningItem(state);
      else if (state.kind === 'reasoning-summary') this.#closeSummary(state);
      else this.#closeSimpleBlock(state);
    }
  }

  #ensureMessageStart(response) {
    if (this.#started) return;
    this.#started = true;

    if (isPlainObject(response)) {
      if (typeof response.id === 'string') this.#messageId = response.id;
      if (typeof response.model === 'string') this.#model = response.model;
    }
    this.#emit('message_start', {
      message: {
        id: this.#messageId ?? `msg_${this.#blockCounter}`,
        type: 'message',
        role: 'assistant',
        model: this.#model ?? this.#requestModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: neutralToAnthropic(this.#usage),
      },
    });
  }

  #nextBlockIndex() {
    const index = this.#blockCounter;
    this.#blockCounter += 1;
    return index;
  }

  #warnUnknownItem() {
    this.#warnings.push({ code: WARN_UNKNOWN_STREAM_ITEM, field: 'item_id' });
  }

  #emit(type, payload) {
    this.#frames.push(formatSseEvent({ event: type, data: JSON.stringify({ type, ...payload }) }));
  }

  #takeFrames() {
    if (this.#frames.length === 0) return null;
    const output = this.#frames.join('');
    this.#frames = [];
    return output;
  }
}

function readErrorType(error) {
  if (!isPlainObject(error)) return 'api_error';
  if (typeof error.code === 'string' && error.code !== '') return error.code;
  if (typeof error.type === 'string' && error.type !== 'error') return error.type;
  return 'api_error';
}

function parseEventData(event, warnings) {
  let data;
  try {
    data = JSON.parse(event.data);
  } catch {
    warnings.push({ code: WARN_INVALID_STREAM_EVENT, field: 'event' });
    return null;
  }
  if (!isPlainObject(data)) {
    warnings.push({ code: WARN_INVALID_STREAM_EVENT, field: 'event' });
    return null;
  }
  return data;
}

function combineFrames(first, second) {
  const combined = `${first ?? ''}${second ?? ''}`;
  return combined === '' ? null : combined;
}
