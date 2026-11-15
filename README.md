# Provider Router

本地多提供商模型网关：在同一个入口注册 OpenAI、Anthropic、Gemini、OpenRouter、Ollama 等上游，用 `provider/model` 作为下游模型名，把请求路由到指定提供商。附带浏览器图形控制台，可作为后台服务开机自启。

核心运行时零依赖，只需要 Node.js 20.11+。安装 `pi-ai` 后，提供商目录会自动切换到它维护的主流提供商与模型清单。

## 快速开始

```bash
cd provider-router
npm start
```

控制台会自动在浏览器打开：`http://127.0.0.1:4141/`

不安装任何依赖也能直接启动。`npm install` 仅用于可选的 `pi-ai` 目录（其当前版本要求 Node.js 22.19+；不安装时使用内置精选目录）。

```bash
# 可选：安装 pi-ai 目录
npm install

# 测试纯函数
npm test
```

## 核心规则

### 下游模型命名

```text
provider/model
```

第一个 `/` 之前是提供商名称，之后的所有内容完整保留为上游模型 id。因此：

| 下游模型 | 提供商 | 转发给上游的模型 |
| --- | --- | --- |
| `openai/gpt-4.1` | `openai` | `gpt-4.1` |
| `openrouter/anthropic/claude-sonnet-4.5` | `openrouter` | `anthropic/claude-sonnet-4.5` |
| `fireworks/accounts/fireworks/models/llama-v3p3-70b-instruct` | `fireworks` | `accounts/fireworks/models/llama-v3p3-70b-instruct` |

### 路由与请求改写

客户端把 OpenAI 兼容请求发到 `http://127.0.0.1:4141/v1`，例如：

```bash
curl http://127.0.0.1:4141/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer any-client-key' \
  -d '{
    "model": "openai/gpt-4.1",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

网关会：

1. 从 `model` 提取提供商与上游模型。
2. 用提供商配置中的 API 基础地址拼接请求路径；同协议透传时保留查询串，跨协议转换时改用目标协议的固定路径。
3. 把请求体里的 `model` 改为去掉前缀后的上游模型，其余字段原样保留。
4. 丢弃客户端自带的鉴权头（`authorization`、`api-key`、`x-api-key`、`x-goog-api-key`），按提供商协议写入上游密钥；其他端到端请求头（如 `anthropic-version`、`user-agent`）原样转发。
5. 流式响应按块透传，SSE 不被缓冲。
6. 客户端协议与提供商 `protocol` 不一致时，自动转换请求/响应（见下节）；同协议保持原样透传。

传输层必须做的最小处理：移除 `Host`、`Content-Length`、逐跳头，并让 Node 的 fetch 重新协商压缩与长度；上游响应中相应的传输头会被规范化，避免解压后的响应长度不一致。

网关只路由**已登记**的模型：上游模型 id 必须出现在该提供商的 `models` 列表里，否则返回 `404 model_not_registered`。在控制台“模型目录”页勾选即完成登记。

### 自动协议转换

网关按请求路径识别客户端协议：

| 客户端路径 | 客户端协议 |
| --- | --- |
| `/v1/messages` | Anthropic Messages |
| `/v1/chat/completions` | OpenAI Chat Completions |
| `/v1/responses` | OpenAI Responses |

目标协议由提供商的 `protocol` 决定：`openai`、`ollama` 视为 OpenAI Chat，`anthropic` 为 Anthropic Messages，`openai-responses` 为 Responses。客户端协议与目标协议不一致时自动转换，无需额外配置；`google` 与 `custom` 不转换，仍按原路径透传。

支持六个方向：Anthropic ↔ OpenAI Chat、Anthropic ↔ OpenAI Responses、OpenAI Chat ↔ OpenAI Responses。转换覆盖 messages、system/instructions、tools/tool_choice、tool_use/tool_result、图片、stop/长度参数、usage 与流式 SSE 事件。

- **thinking**：Anthropic `thinking` 会映射为 OpenAI 的 `reasoning_effort` / `reasoning.effort`；跨协议往返时只有带签名的 thinking 块通过内部签名桥保留，普通 reasoning 不伪造 Anthropic 签名。
- **缓存**：目标为 Anthropic 且发生转换时，网关自动注入最多 4 个 `cache_control` 断点（tools、system、最近消息、较早的 user 消息），并剥离 Claude Code 轮换的 billing header，避免破坏前缀缓存；目标为 OpenAI/Responses 时丢弃 `cache_control`，自动前缀缓存是否命中由上游决定。
- **无法映射的字段**：丢弃并在请求日志的 `conversionWarnings` 中记录 code/字段名；`previous_response_id` 不转发，依赖服务端 Responses 状态的续轮可能缺少上文。
- **count_tokens**：`/v1/messages/count_tokens` 只在目标同为 Anthropic 时透传；跨协议 token 数无法准确换算，返回 400 `conversion_unsupported_endpoint`。
- **错误**：转换失败返回 422 `conversion_error`；请求本身无效返回 400；上游错误保留原状态码，只把错误体转换成客户端协议的结构。

## 配置文件

默认位置：

| 平台 | 路径 |
| --- | --- |
| Linux | `~/.config/provider-router/config.json`（遵循 `XDG_CONFIG_HOME`） |
| macOS | `~/Library/Application Support/provider-router/config.json` |
| Windows | `%APPDATA%\provider-router\config.json` |

可用 `--config` 或 `PROVIDER_ROUTER_CONFIG` 覆盖。文件以 `0600` 权限保存，包含明文上游密钥，请勿提交到版本库。

如果配置文件中只有部分提供商条目损坏，启动时会备份原文件、保留有效条目，并在控制台显示警告；不会因为单项错误丢掉整份配置。

```json
{
  "version": 1,
  "providers": [
    {
      "name": "openai",
      "label": "OpenAI",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-...",
      "protocol": "openai",
      "models": ["gpt-4.1", "gpt-4.1-mini"],
      "enabled": true,
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

提供商字段：

- `name`：路由前缀，小写字母/数字/点/下划线/连字符，不含 `/`。
- `baseUrl`：API 基础地址，例如 `https://api.openai.com/v1`。不要填完整 endpoint；程序会把请求路径拼到它后面，并自动避免重复的 `/v1` 段。
- `apiKey`：转发时写入上游鉴权头。客户端自带的鉴权头会被丢弃，避免下游密钥外泄；留空则不发送鉴权头，适配本地无鉴权服务。
- `authStyle`：鉴权方式，`auto`（默认，按协议）、`bearer`、`api-key`、`x-api-key`、`x-goog-api-key`、`none`。Azure 这类要求 `api-key` 的自定义网关可显式指定。
- `protocol`：`openai`、`openai-responses`、`anthropic`、`google`、`ollama`、`custom`。默认鉴权头依次为 `Authorization: Bearer`、`Authorization: Bearer`、`x-api-key`、`x-goog-api-key`、`Authorization: Bearer`、`Authorization: Bearer`。同时决定跨协议转换的目标格式：`openai`/`ollama` 视为 OpenAI Chat，`google`/`custom` 不转换。
- `models`：已登记的上游模型 id，可包含 `/`，同时是路由白名单——未登记的模型请求会被拒绝。在控制台“模型目录”页勾选或手动添加即写入这里。
- `enabled`：停用后不会再被路由，也不会出现在目录聚合结果中。

控制台不会把完整 API Key 发给浏览器，只显示是否配置以及末四位提示。编辑时留空即保持原密钥；勾选“清除已保存的密钥”可删除。

## 集中模型目录

```http
GET /models             # 客户端用，只返回已登记（可路由）的模型
GET /v1/models          # 同上
GET /api/models?refresh=1  # 控制台用，返回全部并带 registered 标记
```

网关会并发请求每个启用提供商的模型目录，并合并结果：

- OpenAI/Anthropic 兼容：`GET <baseUrl>/models`，鉴权头与转发时一致；Anthropic 会附带标准 `anthropic-version`。
- Google Gemini：`GET <baseUrl>/models`，解析 `models[].name` 并去掉 `models/` 前缀。
- Ollama：读取 `<baseUrl 去掉 /v1>/api/tags`。

控制台“模型目录”页每一行都有勾选框：勾选即把该上游模型 id 写入提供商的 `models`（路由白名单），取消勾选则移出。前端客户端调用 `/models`、`/v1/models` 只会看到已登记的模型。

返回是 OpenAI 风格的 `{ object: "list", data: [...] }`。每个条目包含：

```json
{
  "id": "openrouter/anthropic/claude-sonnet-4.5",
  "object": "model",
  "owned_by": "openrouter",
  "provider": "openrouter",
  "upstream_id": "anthropic/claude-sonnet-4.5",
  "display_name": "Claude Sonnet 4.5",
  "source": "live",
  "registered": true
}
```

同时返回 `providers` 状态与 `errors`。某个提供商拉取失败时，不会影响其他提供商；它会回退到该提供商已登记的 `models`（`source: "configured"`），并在 `errors` 中报告原因。成功结果缓存 60 秒，`?refresh=1` 可强制刷新。上游失败短暂缓存 15 秒，避免连续请求反复打到故障上游。

不实现 `/models` 的上游不会出现在列表里：在目录页的“提供商”筛选里选中它，然后用下方输入框手动添加模型 id，点“添加并登记”。

## 管理接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 控制台初始状态 |
| GET/POST | `/api/providers` | 列出/新增提供商 |
| PUT/DELETE | `/api/providers/:name` | 修改/删除提供商 |
| POST | `/api/providers/:name/test` | 使用已保存配置测试模型目录 |
| POST | `/api/discover-models` | 使用表单中的临时配置测试并拉取模型 |
| GET | `/api/catalog` | 内置或 pi-ai 提供商/模型目录 |
| GET | `/api/stats` | 请求统计与最近日志 |
| GET/DELETE | `/api/logs` | 读取/清空日志 |
| GET/POST | `/api/autostart` | 查询/设置登录自启 |
| GET | `/health` | 健康检查 |

管理接口与图形控制台同源，只建议在本机使用。网关默认只绑定 `127.0.0.1`，并校验 `Host` 头以降低 DNS rebinding 风险。

## 开机自启

### 桌面登录自启（控制台开关）

设置页的“登录时自动启动”会按平台写入：

- Linux：`~/.config/autostart/provider-router.desktop`（XDG Autostart）
- macOS：`~/Library/LaunchAgents/com.provider-router.gateway.plist`
- Windows：`HKCU\Software\Microsoft\Windows\CurrentVersion\Run\ProviderRouter`

启动命令包含 `--no-open --silent`，不会打开终端或浏览器。移动项目目录或切换 Node 版本后需要重新设置一次，因为启动项保存的是当时项目与 Node 的绝对路径。

Windows 的注册表启动项由系统直接拉起 Node；若企业策略要求完全隐藏控制台，建议改用任务计划程序，在“登录时”触发 `node <项目路径>\src\server.mjs --no-open --silent`。

### Linux 开机即启动（无需登录）

```bash
bash scripts/install-user-service.sh
sudo loginctl enable-linger "$USER"
```

脚本生成用户级 systemd 服务 `~/.config/systemd/user/provider-router.service` 并立即启用。`enable-linger` 让用户服务在开机后运行，而不是等登录。若只使用桌面登录自启，不要同时启用这个服务，否则会争抢同一端口。

服务通过 `scripts/run-gateway.sh` 启动，每次启动时解析当前可用的 Node：优先使用 `PROVIDER_ROUTER_NODE`，否则读取 nvm 的 `default` 别名，最后回退到 `PATH` 里的 `node`。因此用 nvm 切换版本后只需 `systemctl --user restart provider-router.service`，无需重装服务；要固定某个 Node，在单元里加 `Environment=PROVIDER_ROUTER_NODE=/path/to/node` 即可。

查看状态与日志：

```bash
systemctl --user status provider-router.service --no-pager
journalctl --user -u provider-router.service -f
```

卸载：

```bash
systemctl --user disable --now provider-router.service
rm ~/.config/systemd/user/provider-router.service
```

## pi-ai 目录

当前维护的包：[`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai)。旧包名 [`@mariozechner/pi-ai`](https://www.npmjs.com/package/@mariozechner/pi-ai) 也兼容。

程序会按顺序尝试动态导入：

1. `@earendil-works/pi-ai/providers/all`（当前维护的目录）
2. `@mariozechner/pi-ai`（旧包名，若用户自行安装）

读取其中内置的提供商与聊天模型 id，用于添加提供商时的一键填充。核心网关不依赖 pi-ai；没有安装或导入失败时会回退到 `src/catalog.mjs` 中的精选目录。当前 `@earendil-works/pi-ai` 的引擎要求是 Node.js 22.19+，因此 Node 20 环境建议保持内置目录。

## 命令行

```text
node src/server.mjs [选项]

  --host <地址>       默认 127.0.0.1
  --port <端口>       默认 4141
  --config <路径>     配置文件路径
  --no-open           启动时不打开浏览器
  --silent            静默模式，不输出日志且不打开浏览器
  -h, --help
  -v, --version
```

也可使用环境变量 `PROVIDER_ROUTER_HOST`、`PROVIDER_ROUTER_PORT`、`PROVIDER_ROUTER_CONFIG`。额外的超时参数：

- `PROVIDER_ROUTER_MODEL_TIMEOUT_MS`：模型目录请求超时，默认 12000。
- `PROVIDER_ROUTER_CONNECT_TIMEOUT_MS`：转发请求等待响应头的超时，默认 300000。

## 安全说明

- 默认只监听回环地址；改成 `0.0.0.0` 会把模型网关暴露到网络，且下游接口没有内置鉴权，务必配合防火墙或反向代理。
- 上游密钥以明文保存在本地 JSON（权限 `0600`），不会被写入日志或返回给浏览器。
- 请求日志只包含时间、提供商、模型、路径、状态、耗时和错误摘要，不记录请求头、请求体或响应体。
- 网关不会跟随上游重定向，避免把上游密钥发给重定向目标；请填写最终 API 地址。
- 网关按协议写入标准鉴权头，并丢弃客户端自带的鉴权头；无法识别的自定义网关可在提供商配置里用 `authStyle` 指定。

## 目录结构

```text
src/
  server.mjs       HTTP 服务、控制台 API、静态资源、模型聚合入口
  config.mjs       配置加载、校验、原子写入
  protocols.mjs    模型拆分、URL 拼接、协议定义
  auth.mjs         按协议写入上游鉴权头
  upstream.mjs     上游模型目录读取与聚合缓存
  proxy.mjs        JSON 请求改写与流式转发
  catalog.mjs      内置目录与可选 pi-ai 集成
  convert/         跨协议请求/响应/流式转换
  autostart.mjs    跨平台登录自启
  logs.mjs         内存日志与统计
  util.mjs         错误类型、参数解析、JSON 响应
public/
  index.html       控制台页面
  app.js           前端入口（ES 模块）
  ui/              前端逻辑模块（状态、接口、视图、弹窗、事件）
  styles.css       样式聚合入口
  styles/          按区块拆分的样式
scripts/           systemd 用户服务安装脚本、Node 解析启动入口
test/              Node 原生测试
```

## 故障排查

**上游返回 401/403**：模型目录页的错误栈会显示拉取失败原因；若提示鉴权失败，检查提供商的协议与鉴权方式是否匹配（例如 Azure 需要 `authStyle: api-key`），以及 `baseUrl` 是否包含正确的版本路径。

**请求返回 404 `model_not_registered`**：该模型还没登记。到“模型目录”页勾选它，或在选中该提供商后手动添加并登记，然后重试。

**模型目录为空**：有些兼容网关不实现 `/models`。在“模型目录”页选中该提供商，用输入框手动添加模型 id 并登记。

**请求返回 422 `conversion_error`**：客户端协议与提供商 `protocol` 不一致时会自动转换；若某个字段无法映射，日志的 `conversionWarnings` 会给出 code。必要时改用与客户端协议相同的提供商，或调整请求字段。

**`/v1/messages/count_tokens` 返回 400 `conversion_unsupported_endpoint`**：跨协议无法准确换算 token 数，只有目标同为 Anthropic 时才支持。

**SSE 不流式**：确认没有在网关与客户端之间再套一层会缓冲响应的反向代理。网关本身逐块 pipe 上游响应。

**端口占用**：使用 `--port 其他端口`，并同步更新客户端 base URL；自启动项会保存启动时的端口。

**自启动失效**：移动项目后，自启动项里的绝对路径会失效。桌面自启请关闭再打开设置页的开关；systemd 服务重跑安装脚本。服务本身会在每次启动时解析 Node，切换 nvm 版本只需重启服务。
