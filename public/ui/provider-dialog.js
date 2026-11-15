/**
 * 提供商弹窗：协议/鉴权选项、目录预设、表单校验辅助与连接测试。
 */

import { api } from './api.js';
import { $, setText } from './dom.js';
import {
  AUTH_STYLE_HEADERS,
  FALLBACK_AUTH_STYLES,
  FALLBACK_PROTOCOLS,
  PROTOCOL_DEFAULT_AUTH_STYLE,
  protocolInfo,
  state,
} from './state.js';

/** 用当前协议目录重建协议下拉框，尽量保留原选中项。 */
export function populateProtocolOptions() {
  const select = $('#field-protocol');
  if (!select) return;
  const current = select.value;
  const protocols = state.protocols.length ? state.protocols : FALLBACK_PROTOCOLS;
  select.replaceChildren(
    ...protocols.map((protocol) => {
      const option = document.createElement('option');
      option.value = protocol.id;
      option.textContent = protocol.label;
      option.dataset.description = protocol.description || '';
      return option;
    }),
  );
  if (protocols.some((protocol) => protocol.id === current)) {
    select.value = current;
  } else if (protocols.length) {
    select.value = protocols[0].id;
  }
  updateProtocolHint();
}

function populateAuthStyleOptions() {
  const select = $('#field-auth-style');
  if (!select) return;
  const current = select.value;
  const styles = state.authStyles.length ? state.authStyles : FALLBACK_AUTH_STYLES;
  select.replaceChildren(
    ...styles.map((style) => {
      const option = document.createElement('option');
      option.value = style.id;
      option.textContent = style.label;
      return option;
    }),
  );
  if (styles.some((style) => style.id === current)) select.value = current;
  else if (styles.length) select.value = styles[0].id;
  updateAuthHint();
}

function resolvedAuthStyle(protocol, authStyle) {
  if (authStyle && authStyle !== 'auto') return authStyle;
  return PROTOCOL_DEFAULT_AUTH_STYLE[protocol] || 'bearer';
}

/** 更新鉴权方式说明文案。 */
export function updateAuthHint() {
  const hint = $('#auth-hint');
  if (!hint) return;
  const protocol = $('#field-protocol')?.value || 'openai';
  const style = $('#field-auth-style')?.value || 'auto';
  const resolved = resolvedAuthStyle(protocol, style);
  const header = AUTH_STYLE_HEADERS[resolved] || AUTH_STYLE_HEADERS.bearer;
  hint.textContent = `上游请求头：${header}；客户端自带的鉴权头会被丢弃。`;
}

/** 更新协议说明文案，并联动鉴权说明。 */
export function updateProtocolHint() {
  const select = $('#field-protocol');
  const hint = $('#protocol-hint');
  if (!select || !hint) return;
  const selected = select.selectedOptions?.[0];
  const protocol = protocolInfo(select.value);
  hint.textContent = selected?.dataset.description || protocol.description || '协议用于标识上游接口类型。';
  updateAuthHint();
}

/**
 * 打开提供商弹窗；传入 provider 时为编辑模式。
 *
 * @param {object|null} [provider=null] 待编辑的提供商
 */
export function openProviderDialog(provider = null) {
  const dialog = $('#provider-dialog');
  const form = $('#provider-form');
  if (!dialog || !form || dialog.open) return;

  state.editingProvider = provider;
  form.reset();
  hideFormError();
  $('#clear-key-row')?.classList.add('hidden');
  if ($('#field-clear-key')) $('#field-clear-key').checked = false;

  populateProtocolOptions();
  populateAuthStyleOptions();
  const isEdit = Boolean(provider);
  setText('#provider-dialog-title', isEdit ? '编辑提供商' : '添加提供商');
  setText(
    '#provider-dialog-subtitle',
    isEdit
      ? `更新 ${provider.name}/ 的上游接口与模型。`
      : '填写上游 API 与模型列表，保存后即可路由。',
  );

  const presetField = $('#preset-field');
  if (presetField) presetField.classList.toggle('hidden', isEdit);

  if (isEdit) {
    $('#field-name').value = provider.name;
    $('#field-label').value = provider.label || '';
    $('#field-base-url').value = provider.baseUrl || '';
    $('#field-protocol').value = provider.protocol || 'openai';
    $('#field-auth-style').value = provider.authStyle || 'auto';
    $('#field-enabled').checked = Boolean(provider.enabled);
    $('#field-api-key').value = '';
    $('#field-api-key').placeholder = provider.hasApiKey
      ? '已保存，留空保持不变'
      : '未配置上游密钥';
    setText(
      '#key-hint',
      provider.hasApiKey
        ? '已保存。留空保持不变；输入新值会覆盖。客户端自带的鉴权头会被丢弃。'
        : '网关用它替换客户端自带的鉴权头。',
    );
    $('#clear-key-row')?.classList.toggle('hidden', !provider.hasApiKey);
  } else {
    $('#field-name').value = '';
    $('#field-label').value = '';
    $('#field-base-url').value = '';
    $('#field-protocol').value = state.protocols[0]?.id || 'openai';
    $('#field-auth-style').value = 'auto';
    $('#field-enabled').checked = true;
    $('#field-api-key').value = '';
    $('#field-api-key').placeholder = '粘贴上游 api-key';
    setText('#key-hint', '网关用它替换客户端自带的鉴权头。');
  }

  updateProtocolHint();
  dialog.showModal();
  document.body.classList.add('modal-open');

  if (!isEdit) {
    ensureCatalogForDialog();
    const select = $('#preset-select');
    if (state.catalog) populatePresetOptions();
    else if (select) {
      select.innerHTML = '<option value="">正在载入目录…</option>';
      select.disabled = true;
    }
  }

  setTimeout(() => $('#field-name')?.focus(), 40);
}

/** 关闭提供商弹窗并清理编辑态。 */
export function closeProviderDialog() {
  const dialog = $('#provider-dialog');
  if (dialog?.open) dialog.close();
  document.body.classList.remove('modal-open');
  state.editingProvider = null;
}

async function ensureCatalogForDialog() {
  if (state.catalog) {
    populatePresetOptions();
    return;
  }
  const select = $('#preset-select');
  if (select) {
    select.innerHTML = '<option value="">正在载入目录…</option>';
    select.disabled = true;
  }
  setText('#preset-hint', '正在读取 pi-ai / 内置提供商目录…');

  try {
    const data = await api('/api/catalog');
    state.catalog = data;
    if (Array.isArray(data.protocols) && data.protocols.length) {
      state.protocols = data.protocols;
      populateProtocolOptions();
    }
    populatePresetOptions();
  } catch (error) {
    if (select) {
      select.innerHTML = '<option value="">目录暂不可用，可手动填写</option>';
      select.disabled = true;
    }
    setText('#preset-hint', `目录读取失败：${error.message}`);
  }
}

function populatePresetOptions() {
  const select = $('#preset-select');
  if (!select || !state.catalog) return;
  const providers = Array.isArray(state.catalog.providers) ? state.catalog.providers : [];
  const options = [new Option('选择一个提供商（可选）', '')];
  for (const provider of providers) {
    const label = `${provider.label || provider.name} · ${provider.name}（${provider.models?.length || 0} 个模型）`;
    const option = new Option(label, provider.name);
    options.push(option);
  }
  select.replaceChildren(...options);
  select.disabled = false;
  const source =
    state.catalog.source === 'pi-ai'
      ? `${state.catalog.piAi?.package || 'pi-ai'} 目录`
      : '内置精选目录';
  setText('#preset-hint', `${source} · ${providers.length} 个提供商。载入后可继续修改。`);
}

/** 将目录预设填入提供商表单。 */
export function handlePresetSelection() {
  const select = $('#preset-select');
  const name = select?.value;
  if (!name || !state.catalog) return;
  const preset = state.catalog.providers.find((provider) => provider.name === name);
  if (!preset) return;

  let candidate = String(preset.name || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'provider';
  let counter = 2;
  while (state.providers.some((provider) => provider.name === candidate)) {
    const suffix = `-${counter}`;
    candidate = `${candidate.slice(0, 64 - suffix.length)}${suffix}`;
    counter += 1;
  }

  const nameField = $('#field-name');
  const labelField = $('#field-label');
  if (!nameField.value.trim()) nameField.value = candidate;
  if (!labelField.value.trim()) labelField.value = preset.label || candidate;
  $('#field-base-url').value = preset.baseUrl || '';
  $('#field-protocol').value = state.protocols.some((item) => item.id === preset.protocol)
    ? preset.protocol
    : 'custom';
  updateProtocolHint();
  if (!preset.baseUrl) {
    setText('#preset-hint', '该目录项没有预置 API 地址，请补全后再保存。');
    $('#field-base-url')?.focus();
  } else {
    setText(
      '#preset-hint',
      `${preset.source === 'pi-ai' ? 'pi-ai' : '内置'}目录已载入；保存后到“模型目录”页勾选要启用的模型。`,
    );
  }
}

/**
 * 在弹窗内显示表单错误。
 *
 * @param {string} message 错误信息
 */
export function showFormError(message) {
  const element = $('#form-error');
  if (!element) return;
  element.textContent = message;
  element.classList.remove('hidden');
  element.scrollIntoView({ block: 'nearest' });
}

/** 隐藏弹窗内的表单错误。 */
export function hideFormError() {
  const element = $('#form-error');
  if (element) element.classList.add('hidden');
}

/** @returns {object} 由弹窗表单字段组装出的提供商请求体。 */
export function buildProviderPayload() {
  const name = $('#field-name')?.value.trim() || '';
  const label = $('#field-label')?.value.trim() || '';
  const baseUrl = $('#field-base-url')?.value.trim() || '';
  const protocol = $('#field-protocol')?.value || 'openai';
  const authStyle = $('#field-auth-style')?.value || 'auto';
  const apiKey = $('#field-api-key')?.value || '';
  const enabled = Boolean($('#field-enabled')?.checked);
  const clearKey = Boolean($('#field-clear-key')?.checked);

  const payload = { name, label, baseUrl, protocol, authStyle, enabled };
  if (apiKey) payload.apiKey = apiKey;
  else if (state.editingProvider && clearKey) payload.clearApiKey = true;
  return payload;
}
