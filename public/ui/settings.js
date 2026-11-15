/**
 * 设置视图与登录自启动开关。
 */

import { api } from './api.js';
import { $, esc, setText, toast } from './dom.js';
import { state } from './state.js';

/** 渲染设置页的运行时信息与自启动状态。 */
export function renderSettings() {
  const app = state.app;
  if (!app) return;

  setText('#settings-gateway', app.gatewayBaseUrl);
  setText('#settings-config', app.configPath);
  const config = $('#settings-config');
  if (config) config.title = app.configPath || '';
  setText('#settings-node', app.nodeVersion);
  setText('#settings-platform', `${app.platform} · ${app.arch}`);
  setText('#settings-version', `v${app.version}`);
  setText(
    '#settings-piai',
    state.piAi?.installed ? state.piAi.package || '已安装' : '内置精选目录',
  );

  const installed = Boolean(state.piAi?.installed);
  const piaiBadge = $('#settings-piai-badge');
  if (piaiBadge) {
    piaiBadge.textContent = installed ? '已安装' : '内置';
    piaiBadge.className = `badge${installed ? ' badge-signal' : ''}`;
  }
  setText(
    '#pi-ai-hint',
    installed
      ? `已检测到 ${state.piAi.package || 'pi-ai'}。添加提供商时会按需读取其维护的提供商与模型目录；加载失败时仍使用内置目录。`
      : '未安装。当前使用内置精选目录。若使用 Node 22.19+，可执行上方命令，让添加提供商时载入 pi-ai 的完整目录。',
  );

  const autostart = state.autostart;
  const toggle = $('#autostart-toggle');
  const badge = $('#autostart-scope');
  if (!autostart) {
    setText('#autostart-method', '检测中…');
    setText('#autostart-hint', '');
    return;
  }

  setText('#autostart-scope', autostart.scope || (autostart.supported ? '登录后启动' : '不支持'));
  setText('#autostart-method', autostart.method || '当前平台不支持自动启动');
  if (badge) badge.className = `badge${autostart.installed ? ' badge-signal' : ''}`;
  if (toggle) {
    toggle.checked = Boolean(autostart.installed);
    toggle.disabled = !autostart.supported || state.autostartBusy;
  }

  if (!autostart.supported) {
    setText('#autostart-hint', `当前平台 ${autostart.platform || ''} 暂不支持在界面中配置自启动。`);
  } else {
    const parts = [];
    if (autostart.path) parts.push(`启动项：${autostart.path}`);
    if (autostart.bootHint) parts.push(autostart.bootHint);
    setText('#autostart-hint', parts.join(' '));
  }
}

/** 在设置页顶部显示配置文件重置警告横幅。 */
export function renderConfigWarning() {
  const existing = document.getElementById('config-warning');
  const warning = state.app?.configWarning;
  if (!warning) {
    existing?.remove();
    return;
  }

  let node = existing;
  if (!node) {
    node = document.createElement('div');
    node.id = 'config-warning';
    node.className = 'banner banner-error';
    node.setAttribute('role', 'alert');
    const heading = $('#view-settings .section-heading');
    heading?.insertAdjacentElement('afterend', node);
  }

  const backup = state.app?.configBackupPath
    ? `<p>原文件备份：<code>${esc(state.app.configBackupPath)}</code></p>`
    : '';
  node.innerHTML = `<div><strong>配置文件曾被重置</strong><p>${esc(warning)}</p>${backup}</div>`;
}

/**
 * 切换登录自启动并同步服务端状态。
 *
 * @param {Event} event 复选框 change 事件
 */
export async function handleAutostartChange(event) {
  const toggle = event.target;
  const enabled = toggle.checked;
  state.autostartBusy = true;
  toggle.disabled = true;
  try {
    const data = await api('/api/autostart', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    });
    state.autostart = data.autostart;
    toast(enabled ? '已设置登录自启' : '已关闭登录自启');
  } catch (error) {
    toggle.checked = !enabled;
    toast(error.message, 'error');
  } finally {
    state.autostartBusy = false;
    renderSettings();
  }
}
