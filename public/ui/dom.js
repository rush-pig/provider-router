/**
 * DOM 查询、HTML 转义、格式化与轻量反馈工具。
 */

const clockFormatter = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const logTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * 查询首个匹配元素。
 *
 * @param {string} selector CSS 选择器
 * @param {ParentNode} [root=document] 查询根节点
 * @returns {Element|null}
 */
export const $ = (selector, root = document) => root.querySelector(selector);

/**
 * 查询全部匹配元素。
 *
 * @param {string} selector CSS 选择器
 * @param {ParentNode} [root=document] 查询根节点
 * @returns {Element[]}
 */
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/**
 * 转义用于 innerHTML 模板的文本。
 *
 * @param {unknown} value 原始值
 * @returns {string}
 */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

/**
 * 生成引用 SVG sprite 的图标标记。
 *
 * @param {string} name sprite 中的图标名
 * @returns {string}
 */
export function icon(name) {
  return `<svg class="icon" aria-hidden="true"><use href="#icon-${name}"></use></svg>`;
}

/**
 * 在右下角显示一条临时提示。
 *
 * @param {string} message 提示文案
 * @param {'info'|'error'} [type='info'] 提示类型
 */
export function toast(message, type = 'info') {
  const region = $('#toast-region');
  if (!region) return;
  const item = document.createElement('div');
  item.className = `toast${type === 'error' ? ' is-error' : ''}`;
  item.textContent = message;
  region.append(item);
  setTimeout(() => item.remove(), 4600);
}

/**
 * 复制文本到剪贴板，优先使用异步剪贴板 API。
 *
 * @param {string} text 待复制内容
 */
export async function copyText(text) {
  const value = String(text ?? '');
  if (!value) {
    toast('没有可复制的内容', 'error');
    return;
  }

  try {
    await navigator.clipboard.writeText(value);
    toast('已复制到剪贴板');
    return;
  } catch {
    // Fall through to the legacy path.
  }

  try {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    area.style.pointerEvents = 'none';
    document.body.append(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    if (!copied) throw new Error('copy failed');
    toast('已复制到剪贴板');
  } catch {
    toast('复制失败，请手动选择文本', 'error');
  }
}

/**
 * 把 ISO 时间格式化为时:分:秒。
 *
 * @param {string} iso ISO 时间字符串
 * @returns {string}
 */
export function formatClock(iso) {
  try {
    return clockFormatter.format(new Date(iso));
  } catch {
    return '—';
  }
}

/**
 * 把 ISO 时间格式化为日志使用的月-日 时:分:秒。
 *
 * @param {string} iso ISO 时间字符串
 * @returns {string}
 */
export function formatLogTime(iso) {
  try {
    return logTimeFormatter.format(new Date(iso));
  } catch {
    return '—';
  }
}

/**
 * 把毫秒时长格式化为可读文本。
 *
 * @param {number|null|undefined} ms 时长（毫秒）
 * @returns {string}
 */
export function formatDuration(ms) {
  if (ms === null || ms === undefined || Number.isNaN(Number(ms))) return '—';
  const value = Number(ms);
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} s`;
  return `${(value / 60_000).toFixed(1)} min`;
}

/**
 * 把秒数格式化为运行时长。
 *
 * @param {number} seconds 秒数
 * @returns {string}
 */
export function formatUptime(seconds) {
  const value = Number(seconds) || 0;
  if (value < 60) return `${value} 秒`;
  if (value < 3600) return `${Math.floor(value / 60)} 分钟`;
  if (value < 86_400) {
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    return `${hours} 小时${minutes ? ` ${minutes} 分` : ''}`;
  }
  return `${Math.floor(value / 86_400)} 天`;
}

/**
 * 设置元素文本，元素不存在时静默跳过。
 *
 * @param {string} selector CSS 选择器
 * @param {string|number|null|undefined} value 文本内容
 */
export function setText(selector, value) {
  const element = $(selector);
  if (element) element.textContent = value ?? '';
}

/** 隐藏启动错误横幅。 */
export function hideBootError() {
  $('#boot-error')?.classList.add('hidden');
}

/**
 * 显示启动错误横幅。
 *
 * @param {string} message 错误信息
 */
export function showBootError(message) {
  const banner = $('#boot-error');
  if (!banner) return;
  banner.classList.remove('hidden');
  setText('#boot-error-message', message);
}

/**
 * 切换按钮的忙碌状态并记住原始内容。
 *
 * @param {HTMLButtonElement|null|undefined} button 目标按钮
 * @param {boolean} busy 是否忙碌
 * @param {string} [busyText] 忙碌时的文案
 */
export function setButtonBusy(button, busy, busyText) {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.innerHTML;
    button.disabled = true;
    button.textContent = busyText;
  } else {
    button.disabled = false;
    if (button.dataset.originalText) {
      button.innerHTML = button.dataset.originalText;
      delete button.dataset.originalText;
    }
  }
}
