import { StringDecoder } from 'node:string_decoder';

export const SSE_DONE = 'data: [DONE]\n\n';

/**
 * @typedef {{
 *   event: string | null,
 *   data: string,
 *   id: string | null,
 *   retry: string | null,
 * }} SseEvent
 */

/**
 * 增量 SSE 解析器：帧状态跨 push 保持，UTF-8 序列跨 chunk 保持。
 * 只返回完整帧（以空行收尾）；end() 负责冲刷末尾残帧。
 */
export class SseParser {
  #decoder = new StringDecoder('utf8');
  #buffer = '';
  #dataLines = [];
  #event = null;
  #id = null;
  #retry = null;

  /**
   * @param {Buffer | Uint8Array | string} chunk
   * @returns {SseEvent[]}
   */
  push(chunk) {
    if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) {
      throw new TypeError('SseParser.push 需要 Buffer 或 string');
    }
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    this.#buffer += this.#decoder.write(bytes);
    return this.#drain(false);
  }

  /**
   * @returns {SseEvent[]}
   */
  end() {
    this.#buffer += this.#decoder.end();
    return this.#drain(true);
  }

  #drain(isFinal) {
    const events = [];
    const text = this.#buffer;
    const lineBreakPattern = /\r\n|\r|\n/g;
    let lineStart = 0;

    for (let match = lineBreakPattern.exec(text); match !== null; match = lineBreakPattern.exec(text)) {
      if (!isFinal && match[0] === '\r' && match.index === text.length - 1) {
        // 末尾的 CR 可能是被 chunk 边界拆开的 CRLF，等待下一次 push 再判定。
        break;
      }
      this.#consumeLine(text.slice(lineStart, match.index), events);
      lineStart = match.index + match[0].length;
    }

    if (isFinal && lineStart < text.length) {
      this.#consumeLine(text.slice(lineStart), events);
      lineStart = text.length;
    }
    this.#buffer = text.slice(lineStart);

    if (isFinal) this.#dispatchEvent(events);
    return events;
  }

  #consumeLine(line, events) {
    if (line === '') {
      this.#dispatchEvent(events);
      return;
    }
    if (line.startsWith(':')) return;
    this.#applyFieldLine(line);
  }

  #applyFieldLine(line) {
    const colon = line.indexOf(':');
    if (colon === -1) return;
    const field = line.slice(0, colon);
    const rawValue = line.slice(colon + 1);
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;

    switch (field) {
      case 'data':
        this.#dataLines.push(value);
        break;
      case 'event':
        this.#event = value;
        break;
      case 'id':
        this.#id = value;
        break;
      case 'retry':
        this.#retry = value;
        break;
      default:
        break;
    }
  }

  #dispatchEvent(events) {
    const data = this.#dataLines.join('\n');
    if (data !== '') {
      events.push({ event: this.#event, data, id: this.#id, retry: this.#retry });
    }
    this.#dataLines = [];
    this.#event = null;
    this.#id = null;
    this.#retry = null;
  }
}

/**
 * 编码一个 SSE 帧；data 中的换行会被拆成多行 data: 字段。
 * @returns {string}
 */
export function formatSseEvent({ event = null, data, id = null, retry = null } = {}) {
  if (typeof data !== 'string') {
    throw new TypeError('formatSseEvent 需要字符串 data');
  }

  const lines = [];
  if (event) lines.push(`event: ${event}`);
  if (id) lines.push(`id: ${id}`);
  if (retry) lines.push(`retry: ${retry}`);
  for (const dataLine of data.split(/\r\n|\r|\n/)) {
    lines.push(dataLine === '' ? 'data:' : `data: ${dataLine}`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

/**
 * 编码一个 JSON 数据帧。
 * @returns {string}
 */
export function formatSseJson(payload) {
  const json = JSON.stringify(payload);
  if (json === undefined) {
    throw new TypeError('formatSseJson 需要可序列化为 JSON 的 payload');
  }
  return `data: ${json}\n\n`;
}
