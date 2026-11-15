/**
 * 事件绑定、动作编排与后台轮询。
 */

import { api } from './api.js';
import {
  $,
  $$,
  copyText,
  hideBootError,
  setButtonBusy,
  setText,
  showBootError,
  toast,
} from './dom.js';
import { loadLogs, renderLogs } from './logs.js';
import { bindModelViewEvents, loadModels, renderModels } from './models.js';
import {
  buildProviderPayload,
  closeProviderDialog,
  handlePresetSelection,
  hideFormError,
  openProviderDialog,
  populateProtocolOptions,
  showFormError,
  updateAuthHint,
  updateProtocolHint,
} from './provider-dialog.js';
import { handleAutostartChange } from './settings.js';
import { FALLBACK_AUTH_STYLES, FALLBACK_PROTOCOLS, state } from './state.js';
import {
  navigate,
  renderAll,
  renderRecentRequests,
  setView,
  updateLiveStats,
  viewFromHash,
} from './views.js';

async function loadInitial() {
  try {
    const data = await api('/api/state');
    applyState(data);
    hideBootError();
    const view = viewFromHash();
    if (location.hash !== `#${view}`) {
      history.replaceState(null, '', `#${view}`);
    }
    setView(view);
    startPolling();
  } catch (error) {
    showBootError(error.message);
  }
}

/**
 * 把服务端状态写入共享 state，并同步协议选项与界面。
 *
 * @param {object} data /api/state 响应体
 */
function applyState(data) {
  state.app = data?.app || null;
  state.providers = Array.isArray(data?.providers) ? data.providers : [];
  state.protocols =
    Array.isArray(data?.protocols) && data.protocols.length
      ? data.protocols
      : state.protocols.length
        ? state.protocols
        : FALLBACK_PROTOCOLS;
  state.authStyles =
    Array.isArray(data?.authStyles) && data.authStyles.length
      ? data.authStyles
      : state.authStyles.length
        ? state.authStyles
        : FALLBACK_AUTH_STYLES;
  state.stats = data?.stats || state.stats;
  state.recentLogs = Array.isArray(data?.recentLogs) ? data.recentLogs : [];
  state.autostart = data?.autostart || state.autostart;
  state.piAi = data?.piAi || state.piAi;

  if (state.app) {
    setText('#rail-version', `v${state.app.version}`);
  }

  populateProtocolOptions();
  renderAll();
}

async function reloadState({ silent = false } = {}) {
  try {
    const data = await api('/api/state');
    applyState(data);
    hideBootError();
  } catch (error) {
    if (!silent) toast(error.message, 'error');
    throw error;
  }
}

async function saveProviderForm(event) {
  event.preventDefault();
  hideFormError();
  const payload = buildProviderPayload();

  if (!payload.name) {
    showFormError('请填写路由名称。');
    $('#field-name')?.focus();
    return;
  }
  if (!payload.baseUrl) {
    showFormError('请填写 API 接口地址。');
    $('#field-base-url')?.focus();
    return;
  }
  try {
    const parsed = new URL(payload.baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error();
  } catch {
    showFormError('API 接口地址必须是有效的 http(s) URL。');
    $('#field-base-url')?.focus();
    return;
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(payload.name)) {
    showFormError('路由名称只能使用字母、数字、点、下划线或连字符，不能包含斜杠。');
    $('#field-name')?.focus();
    return;
  }

  const saveButton = $('#save-provider');
  setButtonBusy(saveButton, true, '正在保存…');
  const editing = state.editingProvider;
  try {
    const path = editing
      ? `/api/providers/${encodeURIComponent(editing.name)}`
      : '/api/providers';
    const method = editing ? 'PUT' : 'POST';
    await api(path, { method, body: JSON.stringify(payload) });
  } catch (error) {
    showFormError(error.message);
    setButtonBusy(saveButton, false);
    return;
  }

  closeProviderDialog();
  setButtonBusy(saveButton, false);
  toast(editing ? '提供商已更新' : '提供商已添加');
  state.models = null;
  try {
    await reloadState({ silent: true });
    if (state.view === 'models') await loadModels(true);
  } catch (error) {
    toast(`已保存，但界面刷新失败：${error.message}`, 'error');
  }
}

async function toggleProvider(name) {
  const provider = state.providers.find((item) => item.name === name);
  if (!provider) return;
  const payload = {
    name: provider.name,
    label: provider.label,
    baseUrl: provider.baseUrl,
    protocol: provider.protocol,
    models: provider.models,
    enabled: !provider.enabled,
  };
  try {
    await api(`/api/providers/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    state.models = null;
    await reloadState({ silent: true });
    toast(provider.enabled ? `已停用 ${name}` : `已启用 ${name}`);
    if (state.view === 'models') await loadModels(true);
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function deleteProvider(name) {
  const provider = state.providers.find((item) => item.name === name);
  if (!provider) return;
  const confirmed = window.confirm(
    `删除提供商 "${name}"？\n\n使用 ${name}/... 的请求将立即失效。此操作不可撤销。`,
  );
  if (!confirmed) return;

  try {
    await api(`/api/providers/${encodeURIComponent(name)}`, { method: 'DELETE' });
    state.models = null;
    await reloadState({ silent: true });
    toast(`已删除 ${name}`);
    if (state.view === 'models') await loadModels(true);
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function refreshCurrentView() {
  const button = $('#refresh-view');
  if (button) {
    button.disabled = true;
    button.classList.add('is-spinning');
  }
  try {
    if (state.view === 'models') {
      await reloadState({ silent: true });
      await loadModels(true);
    } else if (state.view === 'logs') {
      await reloadState({ silent: true });
      await loadLogs();
    } else {
      await reloadState();
    }
    toast('已刷新');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    if (button) {
      button.disabled = false;
      button.classList.remove('is-spinning');
    }
  }
}

async function clearAllLogs() {
  if (!window.confirm('清空全部请求日志？统计数字不会被重置。')) return;
  try {
    await api('/api/logs', { method: 'DELETE' });
    state.logs = [];
    state.logsLoaded = true;
    state.recentLogs = [];
    renderLogs();
    renderRecentRequests();
    toast('日志已清空');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function refreshLive() {
  if (state.pollBusy || !state.app) return;
  state.pollBusy = true;
  try {
    const data = await api('/api/stats');
    state.stats = data.stats || state.stats;
    state.recentLogs = Array.isArray(data.recentLogs) ? data.recentLogs : state.recentLogs;
    updateLiveStats();
    if (state.view === 'overview') renderRecentRequests();
    if (state.view === 'logs' && $('#log-autorefresh')?.checked) {
      await loadLogs({ silent: true });
    }
  } catch {
    // A transient poll failure should not interrupt the interface.
  } finally {
    state.pollBusy = false;
  }
}

function startPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => {
    if (document.hidden) return;
    refreshLive();
  }, 5000);
}

function bindEvents() {
  for (const item of $$('.nav-item')) {
    item.addEventListener('click', () => navigate(item.dataset.view));
  }
  window.addEventListener('hashchange', () => setView(viewFromHash()));

  document.addEventListener('click', (event) => {
    const closeTarget = event.target.closest('[data-close-dialog]');
    if (closeTarget) {
      closeProviderDialog();
      return;
    }

    const copyTarget = event.target.closest('[data-copy-target], [data-copy-value]');
    if (copyTarget) {
      event.preventDefault();
      const value =
        copyTarget.dataset.copyValue ??
        document.getElementById(copyTarget.dataset.copyTarget)?.textContent ??
        '';
      copyText(value);
      return;
    }

    const actionTarget = event.target.closest('[data-action]');
    if (!actionTarget) return;
    const action = actionTarget.dataset.action;
    if (action === 'add-provider') {
      openProviderDialog();
    } else if (action === 'retry-models') {
      loadModels(true);
    } else {
      const providerName = actionTarget.closest('[data-provider]')?.dataset.provider;
      if (!providerName) return;
      if (action === 'edit-provider') {
        const provider = state.providers.find((item) => item.name === providerName);
        if (provider) openProviderDialog(provider);
      } else if (action === 'delete-provider') {
        deleteProvider(providerName);
      } else if (action === 'toggle-provider') {
        toggleProvider(providerName);
      }
    }
  });

  $('#retry-boot')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    await loadInitial();
    button.disabled = false;
  });

  $('#refresh-view')?.addEventListener('click', refreshCurrentView);
  $('#refresh-models')?.addEventListener('click', () => loadModels(true));
  $('#refresh-logs')?.addEventListener('click', () => loadLogs());
  $('#clear-logs')?.addEventListener('click', clearAllLogs);
  $('#autostart-toggle')?.addEventListener('change', handleAutostartChange);

  $('#model-search')?.addEventListener('input', renderModels);
  $('#log-search')?.addEventListener('input', renderLogs);
  $('#log-status-filter')?.addEventListener('change', renderLogs);

  const autoRefresh = $('#log-autorefresh');
  if (autoRefresh) {
    try {
      const stored = localStorage.getItem('provider-router.log-autorefresh');
      if (stored !== null) autoRefresh.checked = stored === '1';
    } catch {
      // localStorage may be unavailable.
    }
    autoRefresh.addEventListener('change', () => {
      try {
        localStorage.setItem(
          'provider-router.log-autorefresh',
          autoRefresh.checked ? '1' : '0',
        );
      } catch {
        // Ignore persistence failures.
      }
      if (autoRefresh.checked) loadLogs({ silent: true });
    });
  }

  $('#provider-form')?.addEventListener('submit', saveProviderForm);
  $('#preset-select')?.addEventListener('change', handlePresetSelection);
  $('#field-protocol')?.addEventListener('change', updateProtocolHint);
  $('#field-auth-style')?.addEventListener('change', updateAuthHint);
  bindModelViewEvents();
  $('#field-api-key')?.addEventListener('input', () => {
    if ($('#field-api-key')?.value) {
      const clear = $('#field-clear-key');
      if (clear) clear.checked = false;
    }
  });
  $('#field-clear-key')?.addEventListener('change', (event) => {
    if (event.target.checked) {
      const input = $('#field-api-key');
      if (input) input.value = '';
    }
  });

  const dialog = $('#provider-dialog');
  dialog?.addEventListener('close', () => {
    document.body.classList.remove('modal-open');
    state.editingProvider = null;
  });
  dialog?.addEventListener('cancel', () => {
    document.body.classList.remove('modal-open');
  });
  dialog?.addEventListener('click', (event) => {
    if (event.target === dialog) closeProviderDialog();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshLive();
  });
}

/** 绑定事件并加载初始状态，启动控制台。 */
export function start() {
  bindEvents();
  loadInitial();
}
