/**
 * 请求日志视图：加载、筛选与渲染日志表格。
 */

import { api } from './api.js';
import { $, esc, formatDuration, formatLogTime, setText, toast } from './dom.js';
import { logStatus, state } from './state.js';

/**
 * 从 /api/logs 读取日志并渲染。
 *
 * @param {{silent?: boolean}} [options={}] silent 为 true 时不弹出错误提示
 */
export async function loadLogs({ silent = false } = {}) {
  if (state.logsLoading) return;
  state.logsLoading = true;
  try {
    const data = await api('/api/logs?limit=300');
    state.logs = Array.isArray(data?.logs) ? data.logs : [];
    state.logsLoaded = true;
    renderLogs();
  } catch (error) {
    if (!silent) toast(error.message, 'error');
    if (!state.logsLoaded) renderLogsError(error.message);
  } finally {
    state.logsLoading = false;
  }
}

/** 渲染日志表格的加载占位。 */
export function renderLogsLoading() {
  const body = $('#log-body');
  if (body) body.innerHTML = '';
  const empty = $('#log-empty');
  if (empty) {
    empty.classList.remove('hidden');
    empty.innerHTML = '<p>正在读取请求日志…</p>';
  }
  const scroll = $('.log-table')?.closest('.table-scroll');
  if (scroll) scroll.classList.add('hidden');
  setText('#log-count', '加载中…');
}

/**
 * 渲染日志读取失败状态。
 *
 * @param {string} message 错误信息
 */
export function renderLogsError(message) {
  const empty = $('#log-empty');
  if (empty) {
    empty.classList.remove('hidden');
    empty.innerHTML = `<p>日志读取失败</p><span>${esc(message)}</span>`;
  }
  const scroll = $('.log-table')?.closest('.table-scroll');
  if (scroll) scroll.classList.add('hidden');
  setText('#log-count', '读取失败');
}

/** 按当前搜索与状态筛选条件渲染日志表格。 */
export function renderLogs() {
  if (!state.logsLoaded) return;
  const body = $('#log-body');
  const empty = $('#log-empty');
  const scroll = $('.log-table')?.closest('.table-scroll');
  if (!body) return;

  const query = String($('#log-search')?.value || '').trim().toLowerCase();
  const statusFilter = $('#log-status-filter')?.value || '';
  const filtered = state.logs.filter((log) => {
    const status = logStatus(log);
    if (statusFilter === 'success' && status.className !== 'is-ok') return false;
    if (statusFilter === 'error' && status.className !== 'is-error') return false;
    if (statusFilter === 'pending' && status.className !== 'is-pending') return false;
    if (!query) return true;
    return [log.provider, log.model, log.error, log.path, log.status, status.label]
      .filter((value) => value !== null && value !== undefined)
      .some((value) => String(value).toLowerCase().includes(query));
  });

  setText('#log-count', `${filtered.length} / ${state.logs.length} 条`);

  if (!state.logs.length) {
    if (empty) {
      empty.classList.remove('hidden');
      empty.innerHTML =
        '<p>还没有请求记录。</p><span>用快速调用示例发起一次请求，日志会出现在这里。</span>';
    }
    scroll?.classList.add('hidden');
    body.innerHTML = '';
    return;
  }

  if (!filtered.length) {
    if (empty) {
      empty.classList.remove('hidden');
      empty.innerHTML = '<p>没有匹配的日志。</p><span>调整搜索或结果筛选。</span>';
    }
    scroll?.classList.add('hidden');
    body.innerHTML = '';
    return;
  }

  empty?.classList.add('hidden');
  scroll?.classList.remove('hidden');
  body.innerHTML = filtered
    .map((log) => {
      const status = logStatus(log);
      const route = `${log.provider ? `${log.provider}/` : ''}${log.model || ''}`;
      const note = log.error || log.path || '';
      return `
        <tr>
          <td class="log-time">${formatLogTime(log.at)}</td>
          <td class="log-model" title="${esc(route)}">${esc(route || '—')}</td>
          <td class="log-provider">${esc(log.provider || '—')}</td>
          <td><span class="status-code ${status.className}">${status.label}</span></td>
          <td class="log-duration">${formatDuration(log.durationMs)}</td>
          <td class="log-error" title="${esc(note)}">${esc(note || '—')}</td>
        </tr>`;
    })
    .join('');
}
