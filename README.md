<p align="center">
  <img src="web/public/logo.svg" alt="trae-proxy" width="128" />
</p>

# trae-proxy

把 Trae / TRAE SOLO CN 桌面端已登录的模型统一转发为标准 OpenAI 兼容 API，同时支持接入 OpenAI 兼容 / Anthropic / Gemini / Ollama 等上游，统一从 `http://127.0.0.1:39310/v1` 对外提供服务，并内置 React 配置台。

特性：

- **开箱即用**：首次启动自动注册国内 / 国际 Trae 与本地 Ollama provider，读取本机登录态；
- **统一端点**：所有 provider 共用 `/v1/models` 与 `/v1/chat/completions`；
- **模型带前缀**：如 `trae-cn/glm-5.3`；
- **保存即生效**：管理台修改后无需重启；
- **安全**：管理员登录 + 可吊销 API key，SQLite 本地存储；
- **用量统计**：按天 / provider / key / 模型查看请求数、Token、成功率与耗时；
- **使用日志**：独立查看最近请求的状态、Token、耗时与流式信息；
- **明暗主题**：管理台支持明亮 / 黑夜切换，默认跟随系统外观，选择保存在本地。

> 本项目参考（改写自）[dingminhua/dsh-connect-trae](https://github.com/dingminhua/dsh-connect-trae)（MIT，Copyright (c) 2026 LaoDing）及 [weixiaokuan123/trae-proxy](https://github.com/weixiaokuan123/trae-proxy)（MIT，Copyright (c) 2026 weixiaokuan123），只读 Trae 登录态，不提供账号切换。

<img width="2612" height="1332" alt="image" src="https://github.com/user-attachments/assets/3bda1374-9558-4515-a5ba-26a992ded6cf" />

<img width="2612" height="1332" alt="image" src="https://github.com/user-attachments/assets/851422a8-f7ae-4260-8cb1-764d0f202426" />

## 运行要求

- Node.js 22.19+ 或 24+，零第三方依赖；
- 本机已安装并登录 Trae / TRAE SOLO CN 桌面端（登录态只读）；
- 使用本地 Ollama 时需安装 `ollama` CLI，网关会在服务未运行时自动调用 CLI 启动；
- 前端需构建一次：在仓库根目录执行 `npm install` 后执行 `npm run build`（`npm install` 会通过 npm workspaces 一并安装 `web/` 的依赖）。

Trae 登录态按区域自动探测，见 `src/paths.ts`。

## 快速开始

```bash
npm install
npm run build
npm start
```

启动后：

- 管理台：`http://127.0.0.1:39310/`，首次访问创建管理员；
- OpenAI 兼容端点：`http://127.0.0.1:39310/v1`；
- 健康检查：`http://127.0.0.1:39310/healthz`。

在管理台 **API Keys** 页创建 key 后即可调用：

```bash
curl http://127.0.0.1:39310/v1/chat/completions \
  -H "Authorization: Bearer tr-xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"trae-cn/glm-5.3","messages":[{"role":"user","content":"你好"}]}'
```

## 管理台

- **控制台**：渠道状态、模型数、累计请求与 Token；
- **渠道模型**：新增/编辑/启停/删除 provider，保存后热生效，Trae 类型无需 API Key；
- **渠道状态**：定时主动探活每个渠道，按小时查看可用性与异常时段；
- **API Keys**：创建/复制/吊销 key，可限制可访问 provider，支持一键唤起 CC Switch 官方导入；
- **用量统计**：按今天 / 7 天 / 30 天 / 全部汇总，支持按 key 与模型统计；
- **使用日志**：按日期、密钥、模型、状态筛选最近请求记录，支持分页与手动刷新。

侧栏左下角（登录页为视口左下角）的按钮可在明亮 / 黑夜主题间切换：未选择时跟随系统（`prefers-color-scheme`），手动选择后写入 `localStorage`（键 `trae-proxy-theme`），刷新不闪白。

支持的 provider 类型：

| 类型 | 说明 |
| --- | --- |
| `trae-cn` / `trae-ai` | Trae 国内 / 国际版登录态 |
| `openai` | 任意 OpenAI 兼容服务（DeepSeek、OpenRouter、vLLM 等） |
| `anthropic` | Anthropic Messages API |
| `gemini` | Google Gemini API |
| `ollama` | 本地 Ollama，服务未运行时自动调用本机 CLI |
| `workbuddy` | 复用 WorkBuddy 登录态，直连官方接口做流式转发 |

> 上游 API key 明文存于本地 SQLite；管理员密码与网关 API key 只存哈希。

## 注入 opencode（可选）

自动写入 opencode provider 与实时模型目录：

```bash
TRAE_PROXY_KEY=tr-xxxxxxxx node scripts/inject-config.cjs
```

也可手动在 opencode 中填写 `baseURL=http://127.0.0.1:39310/v1` 与 API key。脚本会自动备份原 `opencode.jsonc`，`TRAE_PROXY_BASE` 可覆盖网关地址。

## 配置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `TRAE_PROXY_PORT` | `39310` | 网关端口 |
| `TRAE_PROXY_HOST` | `127.0.0.1` | 监听地址 |
| `TRAE_PROXY_USAGE_RETENTION_DAYS` | `180` | 用量明细保留天数，`0` 表示永久保留 |
| `TRAE_PROXY_PROBE_INTERVAL_MINUTES` | `15` | 渠道主动探活间隔（分钟），`0` 表示关闭 |
| `OLLAMA_BIN` | 自动探测 | `ollama` CLI 可执行文件路径 |

### WorkBuddy 渠道

WorkBuddy 不提供 API Key；桌面端 5.6 起还把登录凭据以 `$wbEncrypted` 信封加密落盘，
密钥在系统钥匙串里，外部进程读不出来。桌面端 daemon 虽然开放了一条本地转发通道，
但它是 call 型 RPC，宿主硬编码 **50 秒超时**且协议 v1 没有任何 stream 方法——
这也是此前本机代理“长回答必断”的根因。

因此本渠道改用 WorkBuddy 官方（浏览器）OAuth：在管理台完成一次授权，网关保存
token 后直连 `https://copilot.tencent.com/v2` 做真正的 SSE 流式转发：

```
OpenAI /v1/chat/completions
  → 网关按 WorkBuddy 客户端协议补齐请求头与请求体
    → https://copilot.tencent.com/v2/chat/completions（真流式，无 50s 限制）
```

首次使用：新增 `workbuddy` 渠道 → 保存 → 在渠道详情页点「登录 WorkBuddy」，
浏览器里完成腾讯登录页授权即可。登录态、access token 到期时间与来源会显示在
该面板，过期前会自动刷新。

如果本机已经用 magpie / OpenCode 登录过 WorkBuddy，网关会**自动导入**它保存的
access token 作为兜底（刻意不取一次性的 refresh token，避免把对方挤下线）；
导入的登录态不能自动续期，面板会明确提示。

请求体兼容层与参考实现一致：强制 `stream: true`、`max_completion_tokens` →
`max_tokens`、`developer` → `system`、工具名安全化与回写、JSON Schema 修补
（`enum` 补类型、根 schema 归一到 object）、以及规避上游对 Codex / Claude Code
提示词的渠道校验。

**模型清单与客户端保持一致**：登录后目录来自上游 `GET /v3/config` 的
`agents[cli].models`，即 WorkBuddy 客户端模型下拉框的数据源；未登录时退回桌面端
缓存的运行时产品配置（`~/.workbuddy/local_storage/`）。默认暴露该账号全部可选模型；
若只想开放其中几个，在渠道的「模型映射」里勾选即可。

可用 `settings.credentialPath` 覆盖登录态文件路径（默认 `config/workbuddy-<id>.json`），
`settings.configDir` 覆盖桌面端配置目录（默认 `~/.workbuddy`）。

## 安全

- 默认仅监听 `127.0.0.1`；
- 管理台需要登录，会话 token 只存哈希、24 小时过期；
- 网关 API key 只展示一次，数据库存哈希，可随时吊销；
- `config/` 权限收紧且不入库；Trae 登录态不写回、不外传。

## 排错

| 现象 | 处理 |
| --- | --- |
| 模型列表为空 | 确认 Trae 已登录，在 Providers 页刷新模型 |
| `401` | 使用管理台创建的 API key |
| `403` | key 的可访问范围未包含目标 provider |
| `404` 模型未知 | 模型 id 需带前缀，如 `trae-cn/glm-5.3` |
| Ollama 模型为空 | 安装 `ollama` CLI 并执行 `ollama pull <model>`；网关会自动探测常见安装位置 |
| WorkBuddy 报 `authentication` | 登录态缺失或已失效；到渠道详情页点「登录 WorkBuddy」重新授权 |
| WorkBuddy 一直“未登录” | 管理台详情页的登录面板会显示原因；点击登录后需在浏览器完成授权 |
| WorkBuddy 模型为空 | 先在详情页完成登录，再点「刷新模型」 |
| 前端空白 | 先 `npm run build` 再访问管理台 |
