const BILLING_HEADER_LINE = /^x-anthropic-billing-header:[^\r\n]*(?:\r?\n|$)/;
const TEXT_BLOCK_SEPARATOR = '\n';

function isObject(value) {
  return value !== null && typeof value === 'object';
}

function isTextBlock(block) {
  return isObject(block) && block.type === 'text';
}

function isToolUseBlock(block) {
  return isObject(block) && block.type === 'tool_use';
}

function isToolResultBlock(block) {
  return isObject(block) && block.type === 'tool_result';
}

function isBlankText(text) {
  return typeof text !== 'string' || text.trim() === '';
}

/**
 * Removes the "x-anthropic-billing-header:" line that Claude Code executes as
 * part of the system prompt. Only the first line is inspected, so lookalikes
 * deeper in the prompt are preserved verbatim.
 */
export function stripLeadingBillingHeader(text) {
  return typeof text === 'string' ? text.replace(BILLING_HEADER_LINE, '') : '';
}

/**
 * Flattens Anthropic content into plain text: strings pass through unchanged,
 * arrays contribute their text blocks joined by newlines, and any other shape
 * yields an empty string.
 */
export function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => isTextBlock(block) && typeof block.text === 'string')
    .map((block) => block.text)
    .join(TEXT_BLOCK_SEPARATOR);
}

function collectToolResultIds(message) {
  if (!isObject(message) || message.role !== 'user' || !Array.isArray(message.content)) {
    return new Set();
  }
  const answeredIds = message.content
    .filter(isToolResultBlock)
    .map((block) => block.tool_use_id)
    .filter((id) => typeof id === 'string');
  return new Set(answeredIds);
}

function removeUnansweredToolUses(message, nextMessage) {
  if (!isObject(message) || message.role !== 'assistant' || !Array.isArray(message.content)) {
    return message;
  }
  if (!message.content.some(isToolUseBlock)) return message;

  const answeredIds = collectToolResultIds(nextMessage);
  const remainingBlocks = message.content.filter(
    (block) => !isToolUseBlock(block) || answeredIds.has(block.id),
  );
  if (remainingBlocks.length === message.content.length) return message;
  return { ...message, content: remainingBlocks };
}

function dropUnansweredToolUses(messages) {
  return messages.map((message, index) => removeUnansweredToolUses(message, messages[index + 1]));
}

function isEmptyMessage(message) {
  const content = message.content;
  if (content === undefined || content === null) return true;
  if (typeof content === 'string') return isBlankText(content);
  if (!Array.isArray(content)) return false;
  if (content.length === 0) return true;
  return content.every((block) => isTextBlock(block) && isBlankText(block.text));
}

function dropLeadingAssistants(messages) {
  let start = 0;
  while (start < messages.length && messages[start].role === 'assistant') {
    start += 1;
  }
  return messages.slice(start);
}

function isTextOnlyContent(content) {
  if (typeof content === 'string') return true;
  return Array.isArray(content) && content.every(isTextBlock);
}

function dropTrailingAssistantText(messages) {
  let end = messages.length;
  while (end > 0) {
    const last = messages[end - 1];
    if (last.role !== 'assistant' || !isTextOnlyContent(last.content)) break;
    end -= 1;
  }
  return messages.slice(0, end);
}

/**
 * Applies the cc-switch repair pipeline to an Anthropic messages array without
 * mutating the input: unanswered tool_use blocks are unwound (unanswered tool
 * rounds make the whole request invalid), empty turns disappear, the
 * conversation must start with a user turn, and assistant-only continuations at
 * the tail are trimmed so upstream prefill rules are not violated.
 */
export function normalizeAnthropicMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const wellFormed = messages.filter(isObject);
  const answered = dropUnansweredToolUses(wellFormed);
  const nonEmpty = answered.filter((message) => !isEmptyMessage(message));
  return dropTrailingAssistantText(dropLeadingAssistants(nonEmpty));
}
