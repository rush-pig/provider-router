/**
 * 主视图渲染：视图切换、概览面板与提供商列表。
 */

import {
  $,
  $$,
  esc,
  formatClock,
  formatDuration,
  formatUptime,
  icon,
  setText,
} from './dom.js';
import { loadLogs, renderLogs, renderLogsLoading } from './logs.js';
import {
  loadModels,
  renderModels,
  renderModelsLoading,
  updateModelProviderFilter,
} from './models.js';
import { renderConfigWarning, renderSettings } from './settings.js';
import {
  VIEW_META,
  buildQuickstart,
  enabledProviders,
  firstModelReference,
  logStatus,
  protocolInfo,
  state,
  totalConfiguredModels,
} from './state.js';

/** @returns {string} 当前 hash 对应的合法视图标识。 */
export function viewFromHash() {
  const value = location.hash.replace(/^#/, '');
  return VIEW_META[value] ? value : 'overview';
}

/**
 * 跳转到指定视图，并同步地址栏 hash。
 *
 * @param {string} view 视图标识
 */
export function navigate(view) {
  if (!VIEW_META[view]) return;
  if (location.hash === `#${view}`) {
    setView(view);
  } else {
    location.hash = view;
  }
}

/**
 * 切换当前视图，并处理模型与日志的按需加载。
 *
 * @param {string} view 视图标识
 */
export function setView(view) {
  if (!VIEW_META[view]) view = 'overview';
  state.view = view;
  for (const section of $$('.view')) {
    section.classList.toggle('is-active', section.dataset.view === view);
  }
  for (const item of $$('.nav-item')) {
    const active = item.dataset.view === view;
    item.classList.toggle('is-active', active);
    if (active) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }

  const meta = VIEW_META[view];
  setText('#view-kicker', meta.kicker);
  setText('#view-title', meta.title);
  document.title = `${meta.title} · Provider Router`;

  if (view === 'models') {
    if (state.models) renderModels();
    else renderModelsLoading();
    if (!state.models && !state.modelsLoading) loadModels();
  }
  if (view === 'logs') {
    if (state.logsLoaded) renderLogs();
    else renderLogsLoading();
    loadLogs({ silent: true });
  }

  window.scrollTo({ top: 0, behavior: 'auto' });
}

/** 重新渲染当前已加载的所有面板。 */
export function renderAll() {
  if (!state.app) return;
  renderOverview();
  renderProviders();
  renderSettings();
  renderConfigWarning();
  updateModelProviderFilter();
  if (state.models) renderModels();
  if (state.logsLoaded) renderLogs();
}

function renderOverview() {
  const app = state.app;
  if (!app) return;

  setText('#gateway-url', app.gatewayBaseUrl);
  setText('#ops-listen', `${app.host}:${app.port}`);
  setText('#ops-config', app.configPath);
  const configElement = $('#ops-config');
  if (configElement) configElement.title = app.configPath || '';
  setText('#ops-piai', state.piAi?.installed ? '已安装' : '内置目录');

  renderSwitchboard();
  renderRecentRequests();
  renderQuickstart();
  updateLiveStats();
}

function renderSwitchboard() {
  const board = $('#switchboard');
  if (!board) return;

  const providers = state.providers;
  const sample = providers.length ? firstModelReference() : 'provider/model';
  let html = `
    <div class="switchboard-head">
      <span>路由交换</span>
      <span class="switch-live"><i></i>LIVE</span>
    </div>
    <div class="switch-origin">
      <span class="origin-tag">下游模型</span>
      <code title="${esc(sample)}">${esc(sample)}</code>
    </div>`;

  if (providers.length === 0) {
    html += `
      <div class="switch-empty">
        <strong>交换机还没有线路</strong>
        <p>注册第一个提供商，路由会在这里展开。</p>
        <button class="button" type="button" data-action="add-provider">${icon('plus')}添加提供商</button>
      </div>`;
    board.innerHTML = html;
    return;
  }

  html += '<div class="switch-paths">';
  for (const provider of providers.slice(0, 5)) {
    const disabled = !provider.enabled;
    const protocol = protocolInfo(provider.protocol);
    html += `
      <div class="switch-path${disabled ? ' is-disabled' : ''}" title="${esc(provider.name)}/${esc(provider.models?.[0] || 'model')}">
        <div class="switch-path-main">
          <span class="switch-node"></span>
          <code>${esc(provider.name)}</code>
        </div>
        <small>${esc(protocol.shortLabel)} · ${provider.models?.length || 0} 个模型${disabled ? ' · 停用' : ''}</small>
      </div>`;
  }
  if (providers.length > 5) {
    html += `<div class="switch-more">另有 ${providers.length - 5} 个提供商</div>`;
  }
  html += '</div>';
  board.innerHTML = html;
}

/** 渲染概览页的最近请求列表。 */
export function renderRecentRequests() {
  const container = $('#recent-requests');
  if (!container) return;

  if (!state.recentLogs.length) {
    container.innerHTML = `
      <div class="mini-empty">
        <strong>还没有请求。</strong>
        用下方的 curl 命令发起一次调用，路由记录会出现在这里。
      </div>`;
    return;
  }

  container.innerHTML = state.recentLogs
    .map((log) => {
      const status = logStatus(log);
      const route = `${log.provider ? `${log.provider}/` : ''}${log.model || ''}`;
      return `
        <div class="request-row" title="${esc(route)}${log.error ? ` · ${esc(log.error)}` : ''}">
          <span class="request-time">${formatClock(log.at)}</span>
          <span class="request-model"><strong>${esc(log.provider ? `${log.provider}/` : '')}</strong>${esc(log.model || '—')}</span>
          <span class="request-status ${status.className}">${status.label}</span>
        </div>`;
    })
    .join('');
}

function renderQuickstart() {
  const element = $('#quickstart-code');
  if (element) element.textContent = buildQuickstart();
}

/** 更新概览页的统计数字与成功率指示条。 */
export function updateLiveStats() {
  const stats = state.stats;
  if (!stats) return;

  const totalProviders = state.providers.length;
  const activeProviders = enabledProviders().length;
  setText('#stat-providers', String(totalProviders));
  setText(
    '#stat-providers-note',
    totalProviders === 0
      ? '尚未注册'
      : activeProviders === totalProviders
        ? '全部启用'
        : `${activeProviders} / ${totalProviders} 启用`,
  );
  setText('#stat-models', String(totalConfiguredModels()));
  setText('#stat-requests', String(stats.requests || 0));
  setText('#stat-requests-note', `运行 ${formatUptime(stats.uptimeSeconds)}`);
  setText('#stat-latency', formatDuration(stats.averageDurationMs));

  const rate = stats.successRate;
  setText('#ops-success-rate', rate === null || rate === undefined ? '—' : `${Math.round(rate * 100)}%`);
  const meter = $('#ops-success-meter');
  if (meter) {
    const percent = rate === null || rate === undefined ? 0 : Math.max(0, Math.min(1, rate));
    meter.style.width = `${percent * 100}%`;
    meter.className = rate === null || rate === undefined ? '' : rate >= 0.95 ? 'is-good' : rate < 0.8 ? 'is-bad' : '';
  }

  let note = '还没有经过网关的请求。';
  if (stats.requests > 0) {
    note = `${stats.success} 个成功 · ${stats.errors} 个失败`;
    if (stats.pending > 0) note += ` · ${stats.pending} 个进行中`;
  }
  setText('#ops-request-note', note);
  setText('#ops-piai', state.piAi?.installed ? '已安装' : '内置目录');
}

function renderProviders() {
  const container = $('#provider-list');
  if (!container) return;

  if (!state.providers.length) {
    container.innerHTML = `
      <div class="empty-state">
        <strong>还没有提供商</strong>
        <p>添加一个上游 API，然后就可以使用 <code>provider/model</code> 调用它。</p>
        <span>支持 OpenAI、Anthropic、Gemini、Ollama 与自定义兼容接口。</span>
        <button class="button button-dark" type="button" data-action="add-provider">${icon('plus')}添加第一个提供商</button>
      </div>`;
    return;
  }

  container.innerHTML = state.providers
    .map((provider) => {
      const enabled = provider.enabled;
      const protocol = protocolInfo(provider.protocol);
      const keyState = provider.hasApiKey
        ? `<span class="key-state is-set" title="已配置上游密钥">${icon('key')}${esc(provider.apiKeyHint || '已配置')}</span>`
        : `<span class="key-state" title="未配置密钥">${icon('key')}无密钥</span>`;

      return `
        <article class="provider-card${enabled ? '' : ' is-disabled'}" data-provider="${esc(provider.name)}">
          <div class="provider-identity">
            <div class="provider-route">
              <code>${esc(provider.name)}</code><span>/</span>
            </div>
            <div class="provider-label-line">
              <span>${esc(provider.label)}</span>
              <span class="badge${enabled ? ' badge-signal' : ''}">${enabled ? '已启用' : '已停用'}</span>
              ${keyState}
            </div>
          </div>
          <div class="provider-endpoint">
            <span>API 接口</span>
            <code title="${esc(provider.baseUrl)}">${esc(provider.baseUrl)}</code>
          </div>
          <div class="provider-meta provider-meta--protocol">
            <span>协议</span>
            <strong>${esc(protocol.shortLabel)}</strong>
            <small>${esc(protocol.label)}</small>
          </div>
          <div class="provider-meta provider-meta--models">
            <span>模型</span>
            <strong>${provider.models?.length || 0}</strong>
            <small>本地登记</small>
          </div>
          <div class="provider-actions">
            <button class="icon-button" type="button" data-action="toggle-provider" title="${enabled ? '停用提供商' : '启用提供商'}" aria-label="${enabled ? '停用提供商' : '启用提供商'}">
              ${icon('power')}
            </button>
            <button class="icon-button" type="button" data-action="edit-provider" title="编辑提供商" aria-label="编辑提供商">
              ${icon('edit')}
            </button>
            <button class="icon-button is-danger" type="button" data-action="delete-provider" title="删除提供商" aria-label="删除提供商">
              ${icon('trash')}
            </button>
          </div>
        </article>`;
    })
    .join('');
}
