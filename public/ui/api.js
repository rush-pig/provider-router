/**
 * 与控制台后端通信的 JSON 请求封装。
 */

/**
 * 请求本地 API 并解析 JSON 响应。
 *
 * @param {string} path 接口路径
 * @param {RequestInit} [options={}] fetch 选项；body 为字符串时默认按 JSON 发送
 * @returns {Promise<any>} 解析后的响应体；空响应返回 null
 * @throws {Error} 网络失败或响应状态非 2xx 时抛出，附带 status 与 code
 */
export async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  let response;
  try {
    response = await fetch(path, { ...options, headers });
  } catch {
    throw new Error('无法连接本地服务，请确认 Provider Router 正在运行。');
  }

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const message =
      data?.error?.message || data?.message || `请求失败（HTTP ${response.status}）`;
    const error = new Error(message);
    error.status = response.status;
    error.code = data?.error?.code;
    throw error;
  }

  return data;
}
