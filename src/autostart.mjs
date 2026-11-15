import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const LINUX_LABEL = 'Provider Router';
const MAC_LABEL = 'com.provider-router.gateway';
const WINDOWS_VALUE = 'ProviderRouter';
const WINDOWS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

function linuxAutostartPath() {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'autostart', 'provider-router.desktop');
}

function macAutostartPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${MAC_LABEL}.plist`);
}

function isAutostartSupported() {
  return ['linux', 'darwin', 'win32'].includes(process.platform);
}

function assertSafeAutostartPaths(values) {
  for (const value of values) {
    if (!value || /[\r\n\u0000]/.test(value)) {
      throw new Error('启动项路径包含不支持的控制字符');
    }
  }
}

function buildCommandArgs({ scriptPath, configPath, host, port }) {
  const args = [scriptPath, '--no-open', '--silent'];
  if (configPath) args.push('--config', configPath);
  if (host && host !== '127.0.0.1') args.push('--host', host);
  if (port && Number(port) !== 4141) args.push('--port', String(port));
  return [process.execPath, ...args];
}

function desktopExecArg(value) {
  return `"${value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('%', '%%')}"`;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function windowsCommand(args) {
  return args.map((arg) => `"${String(arg).replaceAll('"', '\\"')}"`).join(' ');
}

async function readExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function installLinux(options) {
  const filePath = linuxAutostartPath();
  const args = buildCommandArgs(options);
  assertSafeAutostartPaths([...args, filePath]);
  const exec = args.map(desktopExecArg).join(' ');
  const content = `[Desktop Entry]
Type=Application
Version=1.0
Name=${LINUX_LABEL}
Comment=Local multi-provider model gateway
Exec=${exec}
Terminal=false
NoDisplay=true
StartupNotify=false
X-GNOME-Autostart-enabled=true
`;

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, { mode: 0o644 });
}

async function removeLinux() {
  try {
    await fs.unlink(linuxAutostartPath());
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function installMac(options) {
  const filePath = macAutostartPath();
  const args = buildCommandArgs(options);
  assertSafeAutostartPaths([...args, filePath]);

  const logDir = path.join(os.homedir(), 'Library', 'Logs');
  await fs.mkdir(logDir, { recursive: true });
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const argsXml = args.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join('\n');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MAC_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(logDir, 'provider-router.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(logDir, 'provider-router.err.log'))}</string>
</dict>
</plist>
`;
  await fs.writeFile(filePath, plist, { mode: 0o644 });
}

async function removeMac() {
  try {
    await fs.unlink(macAutostartPath());
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function windowsInstalled() {
  try {
    execFileSync('reg', ['query', WINDOWS_KEY, '/v', WINDOWS_VALUE], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function installWindows(options) {
  const args = buildCommandArgs(options);
  assertSafeAutostartPaths(args);
  const command = windowsCommand(args);
  execFileSync(
    'reg',
    [
      'add',
      WINDOWS_KEY,
      '/v',
      WINDOWS_VALUE,
      '/t',
      'REG_SZ',
      '/d',
      command,
      '/f',
    ],
    { stdio: 'ignore', windowsHide: true },
  );
}

function removeWindows() {
  try {
    execFileSync('reg', ['delete', WINDOWS_KEY, '/v', WINDOWS_VALUE, '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch {
    // Not installed.
  }
}

export async function getAutostartStatus() {
  if (process.platform === 'linux') {
    const filePath = linuxAutostartPath();
    return {
      supported: true,
      installed: await readExists(filePath),
      platform: 'linux',
      method: 'XDG 桌面自启动',
      path: filePath,
      scope: '登录桌面后静默启动',
      bootHint:
        '如需开机即启动（无需登录），运行 scripts/install-user-service.sh，并按提示启用 linger；桌面自启与 systemd 服务请只启用一个。',
    };
  }

  if (process.platform === 'darwin') {
    const filePath = macAutostartPath();
    return {
      supported: true,
      installed: await readExists(filePath),
      platform: 'darwin',
      method: 'macOS LaunchAgent',
      path: filePath,
      scope: '登录后静默启动',
      bootHint: null,
    };
  }

  if (process.platform === 'win32') {
    return {
      supported: true,
      installed: windowsInstalled(),
      platform: 'win32',
      method: 'Windows 启动项',
      path: WINDOWS_KEY,
      scope: '登录后静默启动',
      bootHint: null,
    };
  }

  return {
    supported: false,
    installed: false,
    platform: process.platform,
    method: null,
    path: null,
    scope: null,
    bootHint: null,
  };
}

export async function setAutostart(enabled, options) {
  if (!isAutostartSupported()) {
    throw new Error(`当前平台 ${process.platform} 不支持自动启动设置`);
  }

  if (process.platform === 'linux') {
    if (enabled) await installLinux(options);
    else await removeLinux();
  } else if (process.platform === 'darwin') {
    if (enabled) await installMac(options);
    else await removeMac();
  } else if (process.platform === 'win32') {
    if (enabled) installWindows(options);
    else removeWindows();
  }

  return getAutostartStatus();
}
