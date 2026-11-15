/**
 * 模型目录视图：加载、筛选与渲染聚合后的模型列表。
 */

import { api } from './api.js';
import { $, esc, icon, setText, toast } from './dom.js';
import { state } from './state.js';

/** 同步模型目录页的提供商筛选下拉框。 */
export function updateModelProviderFilter() {
  const select = $('#model-provider-filter');
  if (!select) return;
  const current = select.value;
  const summaries =
    state.models?.providers ||
    state.providers
      .filter((provider) => provider.enabled)
      .map((provider) => ({
        name: provider.name,
        label: provider.label,
        count: provider.models?.length || 0,
      }));

  const options = [new Option('全部提供商', '')];
  for (const provider of summaries) {
    options.push(new Option(`${provider.label || provider.name} (${provider.count ?? 0})`, provider.name));
  }
  select.replaceChildren(...options);
  if (summaries.some((provider) => provider.name === current)) select.value = current;
  else select.value = '';
}

/**
 * 从 /api/models 读取模型目录并渲染。
 *
 * @param {boolean} [force=false] 是否强制刷新上游缓存
 */
export async function loadModels(force = false) {
  if (state.modelsLoading) return;
  state.modelsLoading = true;
  const button = $('#refresh-models');
  if (button) {
    button.disabled = true;
    button.classList.add('is-spinning');
  }
  if (!state.models) renderModelsLoading();

  try {
    const data = await api(`/api/models${force ? '?refresh=1' : ''}`);
    state.models = data;
    renderModels();
    updateModelProviderFilter();
  } catch (error) {
    if (state.models) {
      const errors = $('#model-errors');
      if (errors) {
        errors.innerHTML = `
          <div class="error-item">
            <strong>刷新失败</strong>
            <span>${esc(error.message)}</span>
          </div>`;
      }
      setText('#models-summary', '刷新失败 · 正在显示上次结果');
      if (state.view === 'models') toast(error.message, 'error');
    } else {
      renderModelsError(error.message);
      if (state.view === 'models') toast(error.message, 'error');
    }
  } finally {
    state.modelsLoading = false;
    if (button) {
      button.disabled = false;
      button.classList.remove('is-spinning');
    }
  }
}

/** 渲染模型目录的加载占位。 */
export function renderModelsLoading() {
  const container = $('#model-list');
  const errors = $('#model-errors');
  if (errors) errors.innerHTML = '';
  if (!container) return;
  container.innerHTML = `
    <div class="empty-state">
      <strong>正在读取模型目录</strong>
      <p>网关正在并发请求各提供商的 /models，并合并本地登记的模型。</p>
    </div>`;
  setText('#models-summary', '加载中…');
}

/**
 * 渲染模型目录读取失败状态。
 *
 * @param {string} message 错误信息
 */
export function renderModelsError(message) {
  const container = $('#model-list');
  const errors = $('#model-errors');
  if (errors) errors.innerHTML = '';
  if (!container) return;
  container.innerHTML = `
    <div class="empty-state">
      <strong>模型目录读取失败</strong>
      <p>${esc(message)}</p>
      <button class="button button-outline" type="button" data-action="retry-models">${icon('refresh')}重试</button>
    </div>`;
  setText('#models-summary', '读取失败');
}

/** 按当前搜索与筛选条件渲染模型列表。 */
export function renderModels() {
  const data = state.models;
  const container = $('#model-list');
  const errors = $('#model-errors');
  if (!data || !container) return;

  updateModelProviderFilter();

  if (errors) {
    errors.innerHTML = (data.errors || [])
      .map(
        (item) => `
          <div class="error-item">
            <strong>${esc(item.provider)}</strong>
            <span>${esc(item.message)}</span>
          </div>`,
      )
      .join('');
  }

  const query = String($('#model-search')?.value || '').trim().toLowerCase();
  const providerFilter = $('#model-provider-filter')?.value || '';
  const all = Array.isArray(data.data) ? data.data : [];
  const filtered = all.filter((model) => {
    if (providerFilter && model.provider !== providerFilter) return false;
    if (!query) return true;
    return [model.id, model.display_name, model.provider, model.provider_label]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query));
  });

  const liveCount = all.filter((model) => model.source === 'live').length;
  const registeredCount = all.filter((model) => model.registered).length;
  const suffix = filtered.length === all.length ? '' : ` · 显示 ${filtered.length}`;
  setText(
    '#models-summary',
    `${all.length} 个路由${suffix} · 已登记 ${registeredCount} · 实时 ${liveCount} · 本地 ${all.length - liveCount}`,
  );
  updateManualAddVisibility();

  if (!all.length) {
    const hasProviders = state.providers.length > 0;
    container.innerHTML = `
      <div class="empty-state">
        <strong>${hasProviders ? '还没有可用模型' : '还没有提供商'}</strong>
        <p>${hasProviders ? '上游没有返回模型，也没有登记过的模型。选择提供商后可手动添加模型 id，或稍后重试。' : '先添加一个提供商，模型目录会自动汇总到这里。'}</p>
        <button class="button ${hasProviders ? 'button-outline' : 'button-dark'}" type="button" data-action="${hasProviders ? 'retry-models' : 'add-provider'}">
          ${hasProviders ? `${icon('refresh')}重新读取` : `${icon('plus')}添加提供商`}
        </button>
      </div>`;
    return;
  }

  if (!filtered.length) {
    container.innerHTML = `
      <div class="empty-state">
        <strong>没有匹配的模型</strong>
        <p>调整搜索关键词或提供商筛选。</p>
      </div>`;
    return;
  }

  container.innerHTML = filtered
    .map(
      (model) => `
        <div class="model-row">
          <label class="model-check" title="${model.registered ? '已登记；取消勾选后不再允许路由' : '勾选后登记该模型，允许路由'}">
            <input type="checkbox" data-register-model data-provider="${esc(model.provider)}" data-upstream-id="${esc(model.upstream_id)}"${model.registered ? ' checked' : ''} aria-label="登记 ${esc(model.id)}" />
          </label>
          <div class="model-id">
            <code title="${esc(model.id)}">${esc(model.id)}</code>
          </div>
          <div class="model-name" title="${esc(model.display_name || model.id)}">${esc(model.display_name || model.id)}</div>
          <div class="model-provider">${esc(model.provider)}</div>
          <span class="source-badge${model.source === 'live' ? ' is-live' : ''}">${model.source === 'live' ? '实时' : '本地'}</span>
          <button class="model-copy" type="button" data-copy-value="${esc(model.id)}" title="复制模型 id" aria-label="复制 ${esc(model.id)}">
            ${icon('copy')}
          </button>
        </div>`,
    )
    .join('');
}

function updateManualAddVisibility() {
  const block = $('#model-manual');
  if (!block) return;
  block.classList.toggle('hidden', !$('#model-provider-filter')?.value);
}

function setRegistered(providerName, models) {
  const provider = state.providers.find((item) => item.name === providerName);
  if (provider) provider.models = models;
  for (const model of state.models?.data || []) {
    if (model.provider !== providerName) continue;
    model.registered = models.includes(model.upstream_id);
  }
}

async function saveProviderModels(provider, models) {
  const data = await api(`/api/providers/${encodeURIComponent(provider.name)}`, {
    method: 'PUT',
    body: JSON.stringify({ models }),
  });
  const next = Array.isArray(data?.provider?.models) ? data.provider.models : models;
  setRegistered(provider.name, next);
  return next;
}

async function toggleRegistration(box) {
  const providerName = box.dataset.provider || '';
  const upstreamId = box.dataset.upstreamId || '';
  const provider = state.providers.find((item) => item.name === providerName);
  if (!provider || !upstreamId) {
    box.checked = !box.checked;
    return;
  }

  const current = Array.isArray(provider.models) ? provider.models : [];
  const next = box.checked
    ? [...new Set([...current, upstreamId])]
    : current.filter((id) => id !== upstreamId);

  box.disabled = true;
  try {
    await saveProviderModels(provider, next);
    renderModels();
    updateModelProviderFilter();
  } catch (error) {
    box.checked = !box.checked;
    toast(error.message, 'error');
  } finally {
    box.disabled = false;
  }
}

async function addManualModel() {
  const providerName = $('#model-provider-filter')?.value || '';
  const input = $('#model-manual-input');
  const id = String(input?.value || '').trim();
  if (!providerName) {
    toast('先在“提供商”筛选里选择一个提供商', 'error');
    return;
  }
  if (!id) {
    input?.focus();
    return;
  }

  const provider = state.providers.find((item) => item.name === providerName);
  if (!provider) {
    toast('提供商不存在，请刷新后重试', 'error');
    return;
  }

  const current = Array.isArray(provider.models) ? provider.models : [];
  if (current.includes(id)) {
    toast('该模型已登记', 'error');
    if (input) input.value = '';
    return;
  }

  try {
    await saveProviderModels(provider, [...current, id]);
    const list = state.models?.data;
    if (
      Array.isArray(list) &&
      !list.some((model) => model.provider === providerName && model.upstream_id === id)
    ) {
      list.push({
        id: `${providerName}/${id}`,
        object: 'model',
        owned_by: providerName,
        provider: providerName,
        provider_label: provider.label,
        upstream_id: id,
        display_name: id,
        source: 'configured',
        registered: true,
      });
    }
    if (input) input.value = '';
    renderModels();
    updateModelProviderFilter();
    toast(`已登记 ${id}`);
  } catch (error) {
    toast(error.message, 'error');
  }
}

/** 绑定目录页的勾选登记、提供商筛选与手动添加。 */
export function bindModelViewEvents() {
  $('#model-list')?.addEventListener('change', (event) => {
    const box = event.target.closest('[data-register-model]');
    if (box) toggleRegistration(box);
  });

  $('#model-provider-filter')?.addEventListener('change', () => {
    updateManualAddVisibility();
    renderModels();
  });

  $('#model-manual-add')?.addEventListener('click', addManualModel);
  $('#model-manual-input')?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    addManualModel();
  });
}
