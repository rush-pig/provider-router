import { isPlainObject } from '../../util.mjs';
import { PROTOCOLS } from './constants.mjs';
import { ConversionError } from './errors.mjs';
import {
  SSE_DONE,
  SseParser,
  formatSseEvent,
  formatSseJson,
} from './sse.mjs';

/**
 * 流式/非流式桥接：
 * - synthesizeSse：非流式上游响应 → 同协议客户端 SSE 帧；
 * - aggregateSse：上游 SSE 文本 → 同协议非流式响应。
 * 两侧都只在同协议内做结构搬运，不做跨协议字段映射。
 */

const DONE_PAYLOAD = '[DONE]';

const ANTHROPIC_BLOCK = Object.freeze({
  TEXT: 'text',
  TOOL_USE: 'tool_use',
  THINKING: 'thinking',
});

const ANTHROPIC_DELTA = Object.freeze({
  TEXT: 'text_delta',
  THINKING: 'thinking_delta',
  SIGNATURE: 'signature_delta',
  INPUT_JSON: 'input_json_delta',
});

const RESPONSES_ITEM = Object.freeze({
  MESSAGE: 'message',
  FUNCTION_CALL: 'function_call',
  REASONING: 'reasoning',
  OUTPUT_TEXT: 'output_text',
});

const SYNTHESIZERS = new Map([
  [PROTOCOLS.ANTHROPIC, synthesizeAnthropicSse],
  [PROTOCOLS.OPENAI, synthesizeOpenAiSse],
  [PROTOCOLS.RESPONSES, synthesizeResponsesSse],
]);

const AGGREGATORS = new Map([
  [PROTOCOLS.ANTHROPIC, aggregateAnthropicSse],
  [PROTOCOLS.OPENAI, aggregateOpenAiSse],
  [PROTOCOLS.RESPONSES, aggregateResponsesSse],
]);

/**
 * 把非流式上游响应拆成同协议的 SSE 帧。
 * @param {{ protocol: string, response: object }} params
 * @returns {string[]} 可直接写入客户端的 SSE 帧
 * @throws {ConversionError} 协议不支持或响应不是 JSON 对象
 */
export function synthesizeSse({ protocol, response }) {
  const synthesize = SYNTHESIZERS.get(protocol);
  if (!synthesize) throw unsupportedProtocol(protocol);
  if (!isPlainObject(response)) throw new ConversionError('响应体必须是 JSON 对象');
  return synthesize(response);
}

/**
 * 把上游 SSE 文本聚合为同协议的非流式响应。
 * @param {{ protocol: string, text: string }} params
 * @returns {object} 上游协议的非流式响应对象
 * @throws {ConversionError} 协议不支持、数据帧损坏或流缺少必要事件
 */
export function aggregateSse({ protocol, text }) {
  const aggregate = AGGREGATORS.get(protocol);
  if (!aggregate) throw unsupportedProtocol(protocol);
  if (typeof text !== 'string') throw new TypeError('aggregateSse 需要字符串 text');
  return aggregate(collectPayloads(text));
}

function unsupportedProtocol(protocol) {
  return new ConversionError(`不支持的协议：${protocol}`);
}

/**
 * 解析全部完整帧与末尾残帧；注释、空 data 由 SseParser 忽略，[DONE] 在此屏蔽。
 * 非 JSON 数据帧说明流已损坏，直接失败而不是静默丢内容。
 */
function collectPayloads(text) {
  const parser = new SseParser();
  const frames = [...parser.push(text), ...parser.end()];
  const payloads = [];
  for (const frame of frames) {
    if (frame.data === DONE_PAYLOAD) continue;
    const payload = parseJsonFrame(frame.data);
    if (isPlainObject(payload)) payloads.push(payload);
  }
  return payloads;
}

function parseJsonFrame(data) {
  try {
    return JSON.parse(data);
  } catch {
    throw new ConversionError('SSE 数据帧不是有效的 JSON');
  }
}

// ---------------------------------------------------------------------------
// 非流式 → SSE
// ---------------------------------------------------------------------------

function synthesizeAnthropicSse(response) {
  const blocks = Array.isArray(response.content) ? response.content : [];
  const frames = [
    anthropicFrame('message_start', {
      type: 'message_start',
      message: { ...response, type: 'message', content: [] },
    }),
  ];

  blocks.forEach((block, index) => {
    if (!isPlainObject(block)) throw new ConversionError('Anthropic content block 必须是 JSON 对象');
    frames.push(anthropicFrame('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: anthropicStartingBlock(block),
    }));
    for (const delta of anthropicBlockDeltas(block)) {
      frames.push(anthropicFrame('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta,
      }));
    }
    frames.push(anthropicFrame('content_block_stop', { type: 'content_block_stop', index }));
  });

  frames.push(anthropicFrame('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: response.stop_reason ?? null, stop_sequence: null },
    usage: isPlainObject(response.usage) ? response.usage : {},
  }));
  frames.push(anthropicFrame('message_stop', { type: 'message_stop' }));
  return frames;
}

function anthropicFrame(event, payload) {
  return formatSseEvent({ event, data: JSON.stringify(payload) });
}

function anthropicStartingBlock(block) {
  switch (block.type) {
    case ANTHROPIC_BLOCK.TEXT:
      return { type: ANTHROPIC_BLOCK.TEXT, text: '' };
    case ANTHROPIC_BLOCK.TOOL_USE:
      return { type: ANTHROPIC_BLOCK.TOOL_USE, id: block.id, name: block.name, input: {} };
    case ANTHROPIC_BLOCK.THINKING:
      return { type: ANTHROPIC_BLOCK.THINKING, thinking: '' };
    default:
      // 未识别的 block（如 redacted_thinking）整体透传，聚合端会原样还原。
      return { ...block };
  }
}

function anthropicBlockDeltas(block) {
  switch (block.type) {
    case ANTHROPIC_BLOCK.TEXT:
      return [{ type: ANTHROPIC_DELTA.TEXT, text: block.text ?? '' }];
    case ANTHROPIC_BLOCK.TOOL_USE:
      return [{
        type: ANTHROPIC_DELTA.INPUT_JSON,
        partial_json: JSON.stringify(block.input ?? {}),
      }];
    case ANTHROPIC_BLOCK.THINKING: {
      const deltas = [{ type: ANTHROPIC_DELTA.THINKING, thinking: block.thinking ?? '' }];
      if (typeof block.signature === 'string' && block.signature !== '') {
        deltas.push({ type: ANTHROPIC_DELTA.SIGNATURE, signature: block.signature });
      }
      return deltas;
    }
    default:
      return [];
  }
}

function synthesizeOpenAiSse(response) {
  const choices = Array.isArray(response.choices) ? response.choices : [];
  const choice = isPlainObject(choices[0]) ? choices[0] : null;
  if (!choice) throw new ConversionError('OpenAI Chat 响应缺少 choices');

  const message = isPlainObject(choice.message) ? choice.message : {};
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.filter(isPlainObject).map((call, index) => ({ index, ...call }))
    : [];

  const delta = {
    role: typeof message.role === 'string' && message.role !== '' ? message.role : 'assistant',
    content: typeof message.content === 'string' && message.content !== '' ? message.content : null,
  };
  if (toolCalls.length > 0) delta.tool_calls = toolCalls;
  if (typeof message.reasoning_content === 'string' && message.reasoning_content !== '') {
    delta.reasoning_content = message.reasoning_content;
  }

  const chunk = {
    id: response.id ?? null,
    object: 'chat.completion.chunk',
    // 上游缺省 created 时用当前时间，保证 chunk 结构合法。
    created: response.created ?? Math.floor(Date.now() / 1000),
    model: response.model ?? null,
    choices: [{ index: 0, delta, finish_reason: choice.finish_reason ?? null }],
    usage: isPlainObject(response.usage) ? response.usage : null,
  };
  return [formatSseJson(chunk), SSE_DONE];
}

function synthesizeResponsesSse(response) {
  const writeFrame = createResponsesFrameWriter();
  const output = Array.isArray(response.output) ? response.output : [];
  const frames = [writeFrame('response.created', {
    response: {
      ...response,
      status: 'in_progress',
      output: [],
      usage: zeroResponsesUsage(),
    },
  })];

  output.forEach((item, outputIndex) => {
    // 完成事件里会携带完整 output，非法 item 只跳过增量帧即可。
    if (!isPlainObject(item)) return;
    frames.push(...responsesItemFrames(writeFrame, item, outputIndex));
  });

  const incomplete = response.status === 'incomplete';
  const finalResponse = incomplete
    ? {
      ...response,
      status: 'incomplete',
      output,
      incomplete_details: response.incomplete_details ?? null,
    }
    : { ...response, status: 'completed', output };
  frames.push(writeFrame(incomplete ? 'response.incomplete' : 'response.completed', {
    response: finalResponse,
  }));
  return frames;
}

function createResponsesFrameWriter() {
  let sequence = 0;
  return function writeFrame(type, body) {
    return formatSseEvent({
      event: type,
      data: JSON.stringify({ type, ...body, sequence_number: sequence++ }),
    });
  };
}

function responsesItemFrames(writeFrame, item, outputIndex) {
  const frames = [writeFrame('response.output_item.added', {
    output_index: outputIndex,
    item: responsesStartingItem(item),
  })];

  if (item.type === RESPONSES_ITEM.MESSAGE) {
    const parts = Array.isArray(item.content) ? item.content : [];
    parts.forEach((part, contentIndex) => {
      if (!isPlainObject(part) || part.type !== RESPONSES_ITEM.OUTPUT_TEXT) return;
      frames.push(...responsesTextPartFrames(writeFrame, {
        item,
        outputIndex,
        contentIndex,
        part,
      }));
    });
  } else if (item.type === RESPONSES_ITEM.FUNCTION_CALL) {
    frames.push(writeFrame('response.function_call_arguments.done', {
      item_id: item.id ?? null,
      output_index: outputIndex,
      arguments: item.arguments ?? '',
    }));
  }

  frames.push(writeFrame('response.output_item.done', { output_index: outputIndex, item }));
  return frames;
}

function responsesTextPartFrames(writeFrame, { item, outputIndex, contentIndex, part }) {
  const location = {
    item_id: item.id ?? null,
    output_index: outputIndex,
    content_index: contentIndex,
  };
  return [
    writeFrame('response.content_part.added', {
      ...location,
      part: { type: RESPONSES_ITEM.OUTPUT_TEXT, text: '', annotations: [] },
    }),
    writeFrame('response.output_text.done', {
      ...location,
      text: part.text ?? '',
    }),
    writeFrame('response.content_part.done', {
      ...location,
      part,
    }),
  ];
}

function responsesStartingItem(item) {
  switch (item.type) {
    case RESPONSES_ITEM.MESSAGE:
      return { ...item, status: 'in_progress', content: [] };
    case RESPONSES_ITEM.FUNCTION_CALL:
      return { ...item, status: 'in_progress', arguments: '' };
    case RESPONSES_ITEM.REASONING:
      return { ...item, status: 'in_progress', summary: [] };
    default:
      return { ...item };
  }
}

function zeroResponsesUsage() {
  return {
    input_tokens: 0,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 0,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 0,
  };
}

// ---------------------------------------------------------------------------
// SSE → 非流式
// ---------------------------------------------------------------------------

function aggregateAnthropicSse(payloads) {
  let message = null;
  const blocks = new Map();

  for (const payload of payloads) {
    switch (payload.type) {
      case 'message_start':
        if (!isPlainObject(payload.message)) {
          throw new ConversionError('Anthropic 流的 message_start 缺少 message');
        }
        message = { ...payload.message, content: [] };
        break;
      case 'content_block_start':
        if (!isValidIndex(payload.index) || !isPlainObject(payload.content_block)) break;
        blocks.set(payload.index, {
          block: anthropicAggregateStartBlock(payload.content_block),
          partialJson: '',
        });
        break;
      case 'content_block_delta': {
        const state = blocks.get(payload.index);
        if (state && isPlainObject(payload.delta)) applyAnthropicDelta(state, payload.delta);
        break;
      }
      case 'content_block_stop': {
        const state = blocks.get(payload.index);
        if (state && state.block.type === ANTHROPIC_BLOCK.TOOL_USE) {
          state.block.input = parseToolInput(state.partialJson);
        }
        break;
      }
      case 'message_delta':
        if (message) applyAnthropicMessageDelta(message, payload);
        break;
      default:
        break;
    }
  }

  if (!message) throw new ConversionError('Anthropic SSE 流缺少 message_start');

  return {
    id: message.id ?? null,
    type: 'message',
    role: 'assistant',
    model: message.model ?? null,
    content: orderedBlocks(blocks),
    stop_reason: message.stop_reason ?? null,
    stop_sequence: message.stop_sequence ?? null,
    usage: isPlainObject(message.usage) ? message.usage : {},
  };
}

function anthropicAggregateStartBlock(block) {
  switch (block.type) {
    case ANTHROPIC_BLOCK.TEXT:
      return { ...block, text: typeof block.text === 'string' ? block.text : '' };
    case ANTHROPIC_BLOCK.TOOL_USE:
      return { ...block, input: {} };
    case ANTHROPIC_BLOCK.THINKING:
      return { ...block, thinking: typeof block.thinking === 'string' ? block.thinking : '' };
    default:
      return { ...block };
  }
}

function applyAnthropicDelta(state, delta) {
  switch (delta.type) {
    case ANTHROPIC_DELTA.TEXT:
      if (typeof delta.text === 'string') {
        state.block.text = `${state.block.text ?? ''}${delta.text}`;
      }
      break;
    case ANTHROPIC_DELTA.THINKING:
      if (typeof delta.thinking === 'string') {
        state.block.thinking = `${state.block.thinking ?? ''}${delta.thinking}`;
      }
      break;
    case ANTHROPIC_DELTA.SIGNATURE:
      if (typeof delta.signature === 'string') state.block.signature = delta.signature;
      break;
    case ANTHROPIC_DELTA.INPUT_JSON:
      if (typeof delta.partial_json === 'string') state.partialJson += delta.partial_json;
      break;
    default:
      // 未知增量类型（如 citations_delta）无法映射到聚合结构，跳过以保持流可继续。
      break;
  }
}

function applyAnthropicMessageDelta(message, payload) {
  const delta = isPlainObject(payload.delta) ? payload.delta : {};
  if ('stop_reason' in delta) message.stop_reason = delta.stop_reason;
  if ('stop_sequence' in delta) message.stop_sequence = delta.stop_sequence;
  if (isPlainObject(payload.usage)) {
    const baseUsage = isPlainObject(message.usage) ? message.usage : {};
    message.usage = { ...baseUsage, ...payload.usage };
  }
}

function orderedBlocks(blocks) {
  return [...blocks.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, state]) => state.block);
}

function parseToolInput(partialJson) {
  if (partialJson.trim() === '') return {};
  try {
    const parsed = JSON.parse(partialJson);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function aggregateOpenAiSse(payloads) {
  if (payloads.length === 0) {
    throw new ConversionError('OpenAI Chat SSE 流没有任何有效 chunk');
  }

  const state = {
    id: null,
    model: null,
    created: null,
    finishReason: null,
    usage: null,
    content: null,
    reasoning: null,
    toolCalls: new Map(),
  };

  for (const payload of payloads) {
    if (payload.id != null) state.id = payload.id;
    if (payload.model != null) state.model = payload.model;
    if (payload.created != null) state.created = payload.created;
    if (isPlainObject(payload.usage)) {
      const baseUsage = state.usage ?? {};
      state.usage = { ...baseUsage, ...payload.usage };
    }
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const choice = isPlainObject(choices[0]) ? choices[0] : null;
    if (!choice) continue;
    if (isPlainObject(choice.delta)) applyOpenAiDelta(state, choice.delta);
    if (choice.finish_reason != null) state.finishReason = choice.finish_reason;
  }

  return {
    id: state.id,
    object: 'chat.completion',
    created: state.created,
    model: state.model,
    choices: [{
      index: 0,
      message: buildOpenAiMessage(state),
      finish_reason: state.finishReason,
    }],
    usage: state.usage,
  };
}

function applyOpenAiDelta(state, delta) {
  if (typeof delta.content === 'string' && delta.content !== '') {
    state.content = `${state.content ?? ''}${delta.content}`;
  }
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
    state.reasoning = `${state.reasoning ?? ''}${delta.reasoning_content}`;
  }
  if (Array.isArray(delta.tool_calls)) {
    delta.tool_calls.forEach((call, position) => {
      mergeOpenAiToolCall(state.toolCalls, call, position);
    });
  }
}

function mergeOpenAiToolCall(toolCalls, call, position) {
  if (!isPlainObject(call)) return;
  const index = isValidIndex(call.index) ? call.index : position;
  const merged = toolCalls.get(index) ?? {
    id: null,
    type: 'function',
    function: { name: '', arguments: '' },
  };
  if (typeof call.id === 'string' && call.id !== '') merged.id = call.id;
  if (typeof call.type === 'string' && call.type !== '') merged.type = call.type;
  if (isPlainObject(call.function)) {
    if (typeof call.function.name === 'string' && call.function.name !== '') {
      merged.function.name += call.function.name;
    }
    if (typeof call.function.arguments === 'string') {
      merged.function.arguments += call.function.arguments;
    }
  }
  toolCalls.set(index, merged);
}

function buildOpenAiMessage(state) {
  const message = { role: 'assistant', content: state.content };
  const toolCalls = [...state.toolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => call);
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  if (state.reasoning !== null) message.reasoning_content = state.reasoning;
  return message;
}

function aggregateResponsesSse(payloads) {
  const state = {
    baseline: null,
    finalResponse: null,
    items: new Map(),
    parts: new Map(),
  };

  for (const payload of payloads) {
    switch (payload.type) {
      case 'response.created':
        if (!state.baseline && isPlainObject(payload.response)) state.baseline = payload.response;
        break;
      case 'response.completed':
      case 'response.incomplete':
        if (!state.finalResponse && isPlainObject(payload.response)) {
          state.finalResponse = payload.response;
        }
        break;
      case 'response.output_item.added':
      case 'response.output_item.done':
        storeResponsesItem(state, payload);
        break;
      case 'response.content_part.added':
      case 'response.content_part.done':
        storeResponsesPart(state, payload);
        break;
      case 'response.output_text.done':
        applyResponsesText(state, payload);
        break;
      case 'response.function_call_arguments.done':
        applyResponsesArguments(state, payload);
        break;
      default:
        break;
    }
  }

  // 完成事件携带完整 response，直接采用；缺失时才按增量事件还原。
  if (state.finalResponse) return state.finalResponse;
  if (!state.baseline) {
    throw new ConversionError('Responses SSE 流缺少 response.created 与完成事件');
  }
  return {
    ...state.baseline,
    status: 'completed',
    output: buildResponsesOutput(state),
  };
}

function storeResponsesItem(state, payload) {
  if (!isValidIndex(payload.output_index) || !isPlainObject(payload.item)) return;
  state.items.set(payload.output_index, { ...payload.item });
}

function storeResponsesPart(state, payload) {
  if (!isValidIndex(payload.output_index) || !isValidIndex(payload.content_index)) return;
  if (!isPlainObject(payload.part)) return;
  contentPartMap(state.parts, payload.output_index)
    .set(payload.content_index, { ...payload.part });
}

function applyResponsesText(state, payload) {
  if (!isValidIndex(payload.output_index) || !isValidIndex(payload.content_index)) return;
  const contentParts = contentPartMap(state.parts, payload.output_index);
  const part = contentParts.get(payload.content_index) ?? {
    type: RESPONSES_ITEM.OUTPUT_TEXT,
    text: '',
    annotations: [],
  };
  part.text = typeof payload.text === 'string' ? payload.text : '';
  contentParts.set(payload.content_index, part);
}

function applyResponsesArguments(state, payload) {
  if (!isValidIndex(payload.output_index)) return;
  const item = state.items.get(payload.output_index) ?? {
    type: RESPONSES_ITEM.FUNCTION_CALL,
    id: payload.item_id ?? null,
    arguments: '',
  };
  item.arguments = typeof payload.arguments === 'string' ? payload.arguments : '';
  state.items.set(payload.output_index, item);
}

function contentPartMap(parts, outputIndex) {
  let contentParts = parts.get(outputIndex);
  if (!contentParts) {
    contentParts = new Map();
    parts.set(outputIndex, contentParts);
  }
  return contentParts;
}

function buildResponsesOutput(state) {
  return [...state.items.entries()]
    .sort(([left], [right]) => left - right)
    .map(([outputIndex, item]) => withResponsesParts(item, state.parts.get(outputIndex)));
}

function withResponsesParts(item, contentParts) {
  if (item.type !== RESPONSES_ITEM.MESSAGE) return item;
  if (!contentParts || contentParts.size === 0) return item;
  const content = [...contentParts.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, part]) => part);
  return { ...item, content };
}

function isValidIndex(value) {
  return Number.isInteger(value) && value >= 0;
}
