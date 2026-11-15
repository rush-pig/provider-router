import { isPlainObject } from '../../util.mjs';
import { SseParser, formatSseEvent } from '../common/sse.mjs';
import { mergeNeutral, neutralFromAnthropic, neutralToResponses } from '../common/usage.mjs';
import { ConversionError, ConversionRequestError } from '../common/errors.mjs';
import { canonicalJson, cleanSchema, mapToolChoiceToResponses } from '../common/tools.mjs';
import { encodeThinkingBridge, resolveReasoningEffort } from '../common/thinking.mjs';
import { clampReasoningEffort, supportsReasoningEffort } from '../common/model-capabilities.mjs';
import { stripLeadingBillingHeader, textFromContent } from '../common/messages.mjs';
import { RESPONSES_MIN_MAX_OUTPUT_TOKENS } from '../common/constants.mjs';

const SYSTEM_SEPARATOR = '\n\n';
const BATCH_TOOL_NAME = 'BatchTool';
const BRIDGE_BLOCK_TYPES = new Set(['thinking', 'redacted_thinking']);
const ASSISTANT_BLOCK_TYPES = new Set(['text', 'tool_use', 'thinking', 'redacted_thinking']);
const DROPPED_REQUEST_FIELDS = Object.freeze([
  'stop_sequences',
  'top_k',
  'service_tier',
  'container',
  'mcp_servers',
  'context_management',
  'betas',
]);

const WARN_UNSUPPORTED_FIELD = 'unsupported_field';
const WARN_UNSUPPORTED_TOOL = 'unsupported_tool';
const WARN_TOOL_CHOICE_WITHOUT_TOOLS = 'tool_choice_without_tools';
const WARN_UNSUPPORTED_CONTENT_BLOCK = 'unsupported_content_block';
const WARN_UNSUPPORTED_OUTPUT_BLOCK = 'unsupported_output_block';
const WARN_INVALID_STREAM_EVENT = 'invalid_stream_event';
const ERROR_STREAM_TRUNCATED = 'stream_truncated';
const ERROR_UPSTREAM_STREAM = 'upstream_stream_error';

/** Anthropic Messages 请求 → OpenAI Responses 请求。 */
export function convertRequest({ body, model }) {
  if (!isPlainObject(body)) {
    throw new ConversionRequestError('请求体必须是 JSON 对象', { field: 'body' });
  }

  const warnings = [];
  const target = {
    model: body.model ?? model,
    input: buildInput(body.messages, warnings),
  };

  const instructions = collectInstructions(body.system);
  if (instructions !== '') target.instructions = instructions;

  const tools = convertTools(body.tools, warnings);
  if (tools) {
    target.tools = tools;
    const toolChoice = mapToolChoiceToResponses(body.tool_choice);
    if (toolChoice !== undefined) target.tool_choice = toolChoice;
  } else if (body.tool_choice !== undefined) {
    warnings.push({ code: WARN_TOOL_CHOICE_WITHOUT_TOOLS, field: 'tool_choice' });
  }

  applyGenerationSettings(target, body);
  applyReasoning(target, body, model);
  collectDroppedRequestFields(body, warnings);

  return { body: target, stream: body.stream === true, warnings };
}

/** Anthropic Messages 响应 → OpenAI Responses 响应。 */
export function convertResponse({ body, request }) {
  if (!isPlainObject(body)) {
    throw new ConversionError('上游响应必须是 JSON 对象', { field: 'body' });
  }

  const warnings = [];
  const content = Array.isArray(body.content) ? body.content : [];
  const output = buildOutputItems(content, warnings);
  const incomplete = body.stop_reason === 'max_tokens';
  const response = {
    id: body.id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model: body.model ?? request?.model ?? null,
    status: incomplete ? 'incomplete' : 'completed',
    output,
    usage: neutralToResponses(neutralFromAnthropic(body.usage)),
  };
  if (incomplete) response.incomplete_details = { reason: 'max_output_tokens' };

  return { body: response, warnings };
}

/** Anthropic SSE → Responses SSE。 */
export function createStreamConverter({ request }) {
  return new ResponsesStreamConverter(request?.model ?? null);
}

function collectInstructions(system) {
  const segments = Array.isArray(system)
    ? system
      .filter(isPlainObject)
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => stripLeadingBillingHeader(block.text))
    : typeof system === 'string'
      ? [stripLeadingBillingHeader(system)]
      : [];
  return segments.filter((text) => text !== '').join(SYSTEM_SEPARATOR);
}

function convertTools(tools, warnings) {
  if (!Array.isArray(tools)) return null;

  const converted = [];
  for (const tool of tools) {
    if (!isPlainObject(tool) || typeof tool.name !== 'string') {
      warnings.push({ code: WARN_UNSUPPORTED_TOOL, field: 'tools' });
      continue;
    }
    if (tool.name === BATCH_TOOL_NAME) continue;

    const entry = { type: 'function', name: tool.name };
    if (typeof tool.description === 'string') entry.description = tool.description;
    entry.parameters = cleanSchema(tool.input_schema);
    entry.strict = false;
    converted.push(entry);
  }
  return converted.length > 0 ? converted : null;
}

function applyGenerationSettings(target, body) {
  if (body.max_tokens !== undefined && body.max_tokens !== null) {
    const maxTokens = Number(body.max_tokens);
    target.max_output_tokens = Number.isFinite(maxTokens) && maxTokens > 0
      ? Math.max(RESPONSES_MIN_MAX_OUTPUT_TOKENS, Math.floor(maxTokens))
      : RESPONSES_MIN_MAX_OUTPUT_TOKENS;
  }
  if (Number.isFinite(body.temperature)) target.temperature = body.temperature;
  if (Number.isFinite(body.top_p)) target.top_p = body.top_p;
  if (typeof body.stream === 'boolean') target.stream = body.stream;
  if (typeof body.prompt_cache_key === 'string') target.prompt_cache_key = body.prompt_cache_key;
}

function applyReasoning(target, body, model) {
  const effort = resolveReasoningEffort(body);
  if (!effort || !supportsReasoningEffort(model)) return;
  target.reasoning = { effort: clampReasoningEffort(model, effort) };
}

function collectDroppedRequestFields(body, warnings) {
  for (const field of DROPPED_REQUEST_FIELDS) {
    if (body[field] !== undefined && body[field] !== null) {
      warnings.push({ code: WARN_UNSUPPORTED_FIELD, field });
    }
  }
  if (body.cache_control !== undefined && body.cache_control !== null) {
    warnings.push({ code: WARN_UNSUPPORTED_FIELD, field: 'cache_control' });
  }
}

function buildInput(messages, warnings) {
  const input = [];
  if (!Array.isArray(messages)) return input;

  for (const message of messages) {
    if (!isPlainObject(message)) continue;
    if (message.role === 'assistant') {
      appendAssistantInput(input, message, warnings);
    } else if (message.role === 'user') {
      appendUserInput(input, message, warnings);
    } else {
      warnings.push({ code: WARN_UNSUPPORTED_CONTENT_BLOCK, field: 'messages' });
    }
  }
  return input;
}

function appendAssistantInput(input, message, warnings) {
  const blocks = contentBlocks(message.content);
  const reasoning = encodeThinkingBridge(blocks.filter(isBridgeBlock));
  if (reasoning) input.push(reasoning);

  const text = textFromContent(blocks);
  if (text !== '') {
    input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
  }

  for (const block of blocks) {
    if (block.type === 'tool_use') {
      input.push({
        type: 'function_call',
        call_id: block.id,
        name: block.name,
        arguments: canonicalJson(block.input ?? {}),
      });
    } else if (!ASSISTANT_BLOCK_TYPES.has(block.type)) {
      warnings.push({ code: WARN_UNSUPPORTED_CONTENT_BLOCK, field: 'messages' });
    }
  }
}

function appendUserInput(input, message, warnings) {
  let pendingContent = [];
  const flushPending = () => {
    if (pendingContent.length === 0) return;
    input.push({ type: 'message', role: 'user', content: pendingContent });
    pendingContent = [];
  };

  for (const block of contentBlocks(message.content)) {
    if (block.type === 'tool_result') {
      flushPending();
      input.push({
        type: 'function_call_output',
        call_id: block.tool_use_id,
        output: textFromContent(block.content),
      });
      const images = toolResultImages(block.content, warnings);
      if (images.length > 0) input.push({ type: 'message', role: 'user', content: images });
    } else if (block.type === 'text') {
      pendingContent.push({ type: 'input_text', text: typeof block.text === 'string' ? block.text : '' });
    } else if (block.type === 'image') {
      const image = inputImage(block);
      if (image) {
        pendingContent.push(image);
      } else {
        warnings.push({ code: WARN_UNSUPPORTED_CONTENT_BLOCK, field: 'messages' });
      }
    } else {
      warnings.push({ code: WARN_UNSUPPORTED_CONTENT_BLOCK, field: 'messages' });
    }
  }
  flushPending();
}

function contentBlocks(content) {
  if (Array.isArray(content)) return content.filter(isPlainObject);
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}

function isBridgeBlock(block) {
  return BRIDGE_BLOCK_TYPES.has(block.type);
}

function toolResultImages(content, warnings) {
  if (!Array.isArray(content)) return [];

  const images = [];
  for (const block of content) {
    if (!isPlainObject(block) || block.type !== 'image') continue;
    const image = inputImage(block);
    if (image) {
      images.push(image);
    } else {
      warnings.push({ code: WARN_UNSUPPORTED_CONTENT_BLOCK, field: 'messages' });
    }
  }
  return images;
}

function inputImage(block) {
  const source = block.source;
  if (!isPlainObject(source)) return null;
  if (source.type === 'base64' && typeof source.data === 'string' && typeof source.media_type === 'string') {
    return { type: 'input_image', image_url: `data:${source.media_type};base64,${source.data}` };
  }
  if (source.type === 'url' && typeof source.url === 'string') {
    return { type: 'input_image', image_url: source.url };
  }
  return null;
}

function buildOutputItems(content, warnings) {
  const output = [];
  const bridge = encodeThinkingBridge(content);
  const text = textFromContent(content);
  let reasoningEmitted = false;
  let textEmitted = false;

  for (const block of content) {
    if (!isPlainObject(block)) continue;
    switch (block.type) {
      case 'text':
        if (!textEmitted && text !== '') {
          output.push({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text }],
          });
          textEmitted = true;
        }
        break;
      case 'thinking':
      case 'redacted_thinking':
        if (!reasoningEmitted && bridge) {
          output.push(bridge);
          reasoningEmitted = true;
        }
        break;
      case 'tool_use':
        output.push({
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          arguments: canonicalJson(block.input ?? {}),
        });
        break;
      default:
        warnings.push({ code: WARN_UNSUPPORTED_OUTPUT_BLOCK, field: 'content' });
    }
  }
  return output;
}

class ResponsesStreamConverter {
  #parser = new SseParser();
  #warnings = [];
  #frames = [];
  #requestModel;
  #createdAt = Math.floor(Date.now() / 1000);
  #responseId = null;
  #model = null;
  #usage = neutralFromAnthropic(null);
  #sequence = 0;
  #outputIndex = 0;
  #started = false;
  #terminated = false;
  #stopReason = null;
  #hasTextContent = false;
  #doneItems = [];
  #blocks = new Map();

  constructor(requestModel) {
    this.#requestModel = requestModel;
  }

  get done() {
    return this.#terminated;
  }

  get warnings() {
    return this.#warnings;
  }

  push(chunk) {
    if (this.#terminated) return null;
    return this.#process(this.#parser.push(chunk));
  }

  end() {
    if (this.#terminated) return null;
    const frames = this.#process(this.#parser.end());
    let tail = null;
    if (!this.#terminated) tail = this.#finishOnEof();
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
    switch (type) {
      case 'message_start':
        this.#handleMessageStart(data);
        break;
      case 'content_block_start':
        this.#handleBlockStart(data);
        break;
      case 'content_block_delta':
        this.#handleBlockDelta(data);
        break;
      case 'content_block_stop':
        this.#handleBlockStop(data);
        break;
      case 'message_delta':
        this.#handleMessageDelta(data);
        break;
      case 'message_stop':
        this.#handleMessageStop();
        break;
      case 'error':
        this.#handleUpstreamError(data);
        break;
      default:
        break;
    }
  }

  #handleMessageStart(data) {
    const message = isPlainObject(data.message) ? data.message : {};
    this.#responseId = message.id ?? this.#responseId;
    this.#model = message.model ?? this.#model;
    this.#ensureStarted();
    this.#usage = mergeNeutral(this.#usage, neutralFromAnthropic(message.usage));
  }

  #handleBlockStart(data) {
    this.#ensureStarted();
    const index = data.index;
    const block = data.content_block;
    if (!isPlainObject(block)) {
      this.#warnings.push({ code: WARN_UNSUPPORTED_CONTENT_BLOCK, field: 'content_block' });
      return;
    }

    switch (block.type) {
      case 'text':
        this.#openTextBlock(index, block);
        break;
      case 'tool_use':
        this.#openToolBlock(index, block);
        break;
      case 'thinking':
      case 'redacted_thinking':
        this.#openThinkingBlock(index, block);
        break;
      default:
        this.#warnings.push({ code: WARN_UNSUPPORTED_CONTENT_BLOCK, field: 'content_block' });
        this.#blocks.set(index, { kind: 'ignored' });
    }
  }

  #openTextBlock(index, block) {
    const state = {
      kind: 'text',
      itemId: `msg_${this.#outputIndex}`,
      outputIndex: this.#outputIndex,
      text: typeof block.text === 'string' ? block.text : '',
    };
    this.#outputIndex += 1;
    this.#blocks.set(index, state);

    this.#emit('response.output_item.added', {
      output_index: state.outputIndex,
      item: {
        type: 'message',
        id: state.itemId,
        status: 'in_progress',
        role: 'assistant',
        content: [],
      },
    });
    this.#emit('response.content_part.added', {
      item_id: state.itemId,
      output_index: state.outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
    if (state.text !== '') {
      this.#hasTextContent = true;
      this.#emitTextDelta(state, state.text);
    }
  }

  #openToolBlock(index, block) {
    const state = {
      kind: 'tool',
      itemId: `fc_${this.#outputIndex}`,
      outputIndex: this.#outputIndex,
      callId: block.id ?? '',
      name: block.name ?? '',
      arguments: '',
    };
    this.#outputIndex += 1;
    this.#blocks.set(index, state);

    this.#emit('response.output_item.added', {
      output_index: state.outputIndex,
      item: {
        type: 'function_call',
        id: state.itemId,
        call_id: state.callId,
        name: state.name,
        arguments: '',
        status: 'in_progress',
      },
    });
  }

  #openThinkingBlock(index, block) {
    this.#blocks.set(index, {
      kind: 'reasoning',
      itemId: `rs_${this.#outputIndex}`,
      outputIndex: this.#outputIndex,
      blockType: block.type,
      thinking: '',
      signature: '',
      data: block.type === 'redacted_thinking' ? String(block.data ?? '') : null,
    });
    this.#outputIndex += 1;
  }

  #handleBlockDelta(data) {
    const state = this.#blocks.get(data.index);
    const delta = data.delta;
    if (!state || state.kind === 'ignored' || !isPlainObject(delta)) return;

    if (state.kind === 'text' && delta.type === 'text_delta') {
      const text = String(delta.text ?? '');
      if (text === '') return;
      state.text += text;
      this.#hasTextContent = true;
      this.#emitTextDelta(state, text);
    } else if (state.kind === 'tool' && delta.type === 'input_json_delta') {
      const partial = String(delta.partial_json ?? '');
      if (partial === '') return;
      state.arguments += partial;
      this.#emit('response.function_call_arguments.delta', {
        item_id: state.itemId,
        output_index: state.outputIndex,
        delta: partial,
      });
    } else if (state.kind === 'reasoning' && delta.type === 'thinking_delta') {
      const thinking = String(delta.thinking ?? '');
      if (thinking === '') return;
      state.thinking += thinking;
      this.#hasTextContent = true;
      this.#emit('response.reasoning_summary_text.delta', {
        item_id: state.itemId,
        output_index: state.outputIndex,
        summary_index: 0,
        delta: thinking,
      });
    } else if (state.kind === 'reasoning' && delta.type === 'signature_delta') {
      state.signature += String(delta.signature ?? '');
    }
  }

  #handleBlockStop(data) {
    const state = this.#blocks.get(data.index);
    if (!state) return;
    this.#blocks.delete(data.index);

    if (state.kind === 'text') this.#closeTextBlock(state);
    else if (state.kind === 'tool') this.#closeToolBlock(state);
    else if (state.kind === 'reasoning') this.#closeThinkingBlock(state);
  }

  #closeTextBlock(state) {
    this.#emit('response.output_text.done', {
      item_id: state.itemId,
      output_index: state.outputIndex,
      content_index: 0,
      text: state.text,
    });
    this.#emit('response.content_part.done', {
      item_id: state.itemId,
      output_index: state.outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: state.text, annotations: [] },
    });

    const item = {
      type: 'message',
      id: state.itemId,
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: state.text, annotations: [] }],
    };
    this.#emit('response.output_item.done', { output_index: state.outputIndex, item });
    this.#doneItems.push(item);
  }

  #closeToolBlock(state) {
    this.#emit('response.function_call_arguments.done', {
      item_id: state.itemId,
      output_index: state.outputIndex,
      arguments: state.arguments,
    });

    const item = {
      type: 'function_call',
      id: state.itemId,
      call_id: state.callId,
      name: state.name,
      arguments: state.arguments,
      status: 'completed',
    };
    this.#emit('response.output_item.done', { output_index: state.outputIndex, item });
    this.#doneItems.push(item);
  }

  #closeThinkingBlock(state) {
    const block = state.blockType === 'redacted_thinking'
      ? { type: 'redacted_thinking', data: state.data }
      : { type: 'thinking', thinking: state.thinking, signature: state.signature };
    const bridge = encodeThinkingBridge([block]);
    if (!bridge) return;

    const item = { ...bridge, id: state.itemId, status: 'completed' };
    this.#emit('response.output_item.added', {
      output_index: state.outputIndex,
      item: { ...item, status: 'in_progress' },
    });
    this.#emit('response.output_item.done', { output_index: state.outputIndex, item });
    this.#doneItems.push(item);
  }

  #handleMessageDelta(data) {
    const delta = isPlainObject(data.delta) ? data.delta : {};
    if (typeof delta.stop_reason === 'string') this.#stopReason = delta.stop_reason;
    this.#usage = mergeNeutral(this.#usage, neutralFromAnthropic(data.usage));
  }

  #handleMessageStop() {
    this.#ensureStarted();
    const incomplete = this.#stopReason === 'max_tokens';
    if (incomplete) {
      this.#emit('response.incomplete', {
        response: this.#snapshot('incomplete', {
          incomplete_details: { reason: 'max_output_tokens' },
        }),
      });
    } else {
      this.#emit('response.completed', { response: this.#snapshot('completed') });
    }
    this.#terminated = true;
  }

  #handleUpstreamError(data) {
    this.#ensureStarted();
    const error = isPlainObject(data.error) ? data.error : {};
    this.#emit('response.failed', {
      response: this.#snapshot('failed', {
        error: {
          code: typeof error.type === 'string' ? error.type : ERROR_UPSTREAM_STREAM,
          message: typeof error.message === 'string' ? error.message : '上游流处理失败',
        },
      }),
    });
    this.#terminated = true;
  }

  #finishOnEof() {
    this.#ensureStarted();
    if (this.#hasTextContent) {
      this.#emit('response.incomplete', {
        response: this.#snapshot('incomplete', {
          incomplete_details: { reason: 'max_output_tokens' },
        }),
      });
    } else {
      this.#emit('response.failed', {
        response: this.#snapshot('failed', {
          error: { code: ERROR_STREAM_TRUNCATED, message: '上游流在完成前结束' },
        }),
      });
    }
    this.#terminated = true;
    return this.#takeFrames();
  }

  #ensureStarted() {
    if (this.#started) return;
    this.#started = true;
    this.#responseId = this.#responseId ?? `resp_${this.#createdAt}`;
    this.#model = this.#model ?? this.#requestModel;
    const usage = neutralFromAnthropic(null);
    this.#emit('response.created', { response: this.#snapshot('in_progress', {}, usage) });
    this.#emit('response.in_progress', { response: this.#snapshot('in_progress', {}, usage) });
  }

  #emitTextDelta(state, text) {
    this.#emit('response.output_text.delta', {
      item_id: state.itemId,
      output_index: state.outputIndex,
      content_index: 0,
      delta: text,
    });
  }

  #snapshot(status, extra = {}, usage = this.#usage) {
    return {
      id: this.#responseId,
      object: 'response',
      created_at: this.#createdAt,
      model: this.#model,
      status,
      output: [...this.#doneItems],
      usage: neutralToResponses(usage),
      ...extra,
    };
  }

  #emit(type, payload) {
    const frame = formatSseEvent({
      event: type,
      data: JSON.stringify({ type, sequence_number: this.#sequence, ...payload }),
    });
    this.#sequence += 1;
    this.#frames.push(frame);
  }

  #takeFrames() {
    if (this.#frames.length === 0) return null;
    const output = this.#frames.join('');
    this.#frames = [];
    return output;
  }
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
