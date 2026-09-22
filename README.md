# trae-proxy

把 Trae（含 TRAE SOLO CN）桌面端**已登录的模型**统一转发成标准 **OpenAI 兼容 API** 的本地模型网关，
并内置一个 **React 配置台**。它同时支持把任意第三方大模型上游（OpenAI 兼容 / Anthropic / Gemini / Ollama）
接入同一个网关，最终统一从 `http://127.0.0.1:39310/v1` 转发出去。

核心特性：

- **默认即 Trae 代理**：首次启动自动注册 `trae-cn`（国内）、`trae-ai`（国际）两个 provider，读取本机 Trae 登录态；
- **统一网关**：所有 provider 共用同一个 `/v1/models`、`/v1/chat/completions` 端点；
- **模型 id 带前缀**：形如 `trae-cn/glm-5.3`、`deepseek/deepseek-chat`；
- **保存即生效**：在管理台新增/修改 provider、API key、模型映射后无需重启；
- **登录保护**：单个管理员账户 + 多个可吊销 API key；
- **SQLite 存储**：管理员、API key、provider 配置、用量明细都在本地 `config/trae-proxy.db`；
- **用量统计**：按天、按 provider、按 key、按模型查看请求数、Token、成功率、耗时。

> **须知**：本项目**参考（改写自）[dingminhua/dsh-connect-trae](https://github.com/dingminhua/dsh-connect-trae)**
> （MIT，Copyright (c) 2026 LaoDing）及其独立改写版
> **[weixiaokuan123/trae-proxy](https://github.com/weixiaokuan123/trae-proxy)**
> （MIT，Copyright (c) 2026 weixiaokuan123）。它**只读** Trae 桌面端当前登录态，本身不提供账号切换。

## 运行要求

- Node.js **22.19+ 或 24+**：后端 TypeScript 由 Node 原生类型擦除直接运行，零第三方依赖。
- 本机已安装并登录 **Trae / TRAE SOLO CN** 桌面端（Trae provider 只读其登录态文件，不修改、不上传）。
- 前端需要构建一次（`npm install` 后 `npm run build`），构建产物由网关直接托管。

登录态读取路径（按区域 / 版本自动探测，见 `src/paths.ts`）：

| 版本 | 路径 |
| --- | --- |
| Trae CN | `%APPDATA%\Trae CN\User\globalStorage\storage.json` |
| TRAE SOLO CN | `%APPDATA%\TRAE SOLO CN\User\globalStorage\storage.json` |
| Trae（国际） | `%APPDATA%\Trae\User\globalStorage\storage.json` |
| TRAE SOLO（国际） | `%APPDATA%\TRAE SOLO\User\globalStorage\storage.json` |

> 国内区域（cn）同时探测 `Trae CN` 与 `TRAE SOLO CN`；国际区域（ai）探测另外两个。
> 另支持 CN 的 CLI 明文旁路 `%USERPROFILE%\.trae-cn\trae-jwt-token`。

## 快速开始

```bash
cd ~/code/trae-proxy
npm install
npm run build
npm start
```

启动后：

- 管理台：`http://127.0.0.1:39310/`，首次访问先创建管理员；
- 健康检查：`http://127.0.0.1:39310/healthz`；
- OpenAI 兼容端点：`http://127.0.0.1:39310/v1`；
- 数据库：`config/trae-proxy.db`。

在管理台 **API Keys** 页创建一个 key（可限制只能访问某些 provider 前缀），
然后任意 OpenAI 兼容客户端这样调用：

```bash
curl http://127.0.0.1:39310/v1/chat/completions \
  -H "Authorization: Bearer tr-xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"trae-cn/glm-5.3","messages":[{"role":"user","content":"你好"}]}'
```

模型列表：

```bash
curl -H "Authorization: Bearer tr-xxxxxxxx" http://127.0.0.1:39310/v1/models
```

## 管理台

- **概览**：provider 启用状态、模型数、累计请求与 Token；
- **Providers**：新增/编辑/停用/删除 provider；保存后立即热生效；Trae 类型无需 API Key；
- **API Keys**：创建、复制、吊销、删除网关 key，可限制可访问的 provider；列表中的“配置”可将 key 一键填充到 CC Switch；
- **用量**：按今天 / 7 天 / 30 天 / 全部查看汇总、按天图表、按 provider/key/model 分布、最近请求。

支持的 provider 类型：

| 类型 | 说明 |
| --- | --- |
| `trae-cn` | Trae 国内版登录态 |
| `trae-ai` | Trae 国际版登录态 |
| `openai` | 任意 OpenAI 兼容服务（DeepSeek、OpenRouter、vLLM 等） |
| `anthropic` | Anthropic Messages API |
| `gemini` | Google Gemini API |
| `ollama` | 本地 Ollama（默认 `http://127.0.0.1:11434/v1`） |

> 上游 provider 的 `apiKey` 按你的要求**明文**存在本地 SQLite；管理员密码和网关 API key 只存哈希。

## 注入 opencode（可选）

统一网关本身就是 OpenAI 兼容端点，可以在 opencode 里直接填 `baseURL=http://127.0.0.1:39310/v1`
和已创建的 API key。若想自动注入 provider 与实时模型目录，可运行：

```bash
TRAE_PROXY_KEY=tr-xxxxxxxx node scripts/inject-config.cjs
```

脚本会把 `trae-proxy` provider 写入 `opencode.jsonc`（自动备份为 `opencode.jsonc.bak.trae`），
模型 id 保持 `trae-cn/...`、`deepseek/...` 这类前缀形式。`TRAE_PROXY_BASE` 可覆盖默认网关地址。

## 配置项（环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `TRAE_PROXY_PORT` | `39310` | 统一网关端口 |
| `TRAE_PROXY_HOST` | `127.0.0.1` | 监听地址 |
| `TRAE_PROXY_USAGE_KEEP_DAYS` | `90` | 用量明细保留天数 |

## 安全与存储

- 默认仅监听 `127.0.0.1`；
- 管理台需要管理员登录；会话 token 只存哈希，24 小时过期；
- 网关 API key 只展示一次，数据库只存 sha256 哈希，可随时吊销；
- `config/`（SQLite）目录权限 `0700`、文件 `0600`，已被 `.gitignore` 排除；
- Trae 登录态只在本机解密与刷新，不写回、不落地、不外传。

## 排错

| 现象 | 处理 |
| --- | --- |
| `healthz` 返回但模型列表为空 | 确认 Trae 桌面端已登录；在 Providers 页点「刷新模型」 |
| `401` | 使用管理台创建的 API key，不要再用 `keys/*.key` |
| `403` | 该 key 的可访问 provider 前缀不包含目标 provider |
| `404` 模型未知 | 模型 id 必须带前缀，如 `trae-cn/glm-5.3` |
| 修改 provider 后不生效 | 保存后网关会自动热替换；确认该 provider 处于启用状态 |
| 前端空白 | 先 `npm run build`，再访问 `http://127.0.0.1:39310/` |

## 目录结构

```
trae-proxy/
  config/                  SQLite 数据库（.gitignore 排除）
  keys/                    旧版遗留的本地 bearer key（不再使用，可删除）
  logs/                    运行日志与 pid（.gitignore 排除）
  scripts/
    inject-config.cjs      把统一网关注入 opencode.jsonc
    start.ps1 / stop.ps1 / status.ps1   Windows 运维脚本
  src/
    serve.ts               统一网关入口（默认 39310）
    gateway/               统一网关：store / auth / server / providers / factory
    auth.ts / refresh.ts   Trae 登录态解密与 token 刷新
    catalog.ts / solo.ts / solo-bridge.ts   Trae 上游客户端与协议桥接
    decrypt.ts / identity.ts / paths.ts / region.ts /
    protocol.ts / reasoning.ts / sse.ts / upstream.ts
  web/
    src/                   React 配置台
    dist/                  构建产物（由网关托管）
```
