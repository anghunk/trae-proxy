# trae-proxy

把 Trae / TRAE SOLO CN 桌面端已登录的模型统一转发为标准 OpenAI 兼容 API，同时支持接入 OpenAI 兼容 / Anthropic / Gemini / Ollama 等上游，统一从 `http://127.0.0.1:39310/v1` 对外提供服务，并内置 React 配置台。

特性：

- **开箱即用**：首次启动自动注册国内 / 国际 Trae provider，读取本机登录态；
- **统一端点**：所有 provider 共用 `/v1/models` 与 `/v1/chat/completions`；
- **模型带前缀**：如 `trae-cn/glm-5.3`；
- **保存即生效**：管理台修改后无需重启；
- **安全**：管理员登录 + 可吊销 API key，SQLite 本地存储；
- **用量统计**：按天 / provider / key / 模型查看请求数、Token、成功率与耗时。

> 本项目参考（改写自）[dingminhua/dsh-connect-trae](https://github.com/dingminhua/dsh-connect-trae)（MIT，Copyright (c) 2026 LaoDing）及 [weixiaokuan123/trae-proxy](https://github.com/weixiaokuan123/trae-proxy)（MIT，Copyright (c) 2026 weixiaokuan123），只读 Trae 登录态，不提供账号切换。

## 运行要求

- Node.js 22.19+ 或 24+，零第三方依赖；
- 本机已安装并登录 Trae / TRAE SOLO CN 桌面端（登录态只读）；
- 前端需构建一次：`npm install` 后执行 `npm run build`。

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
- **API Keys**：创建/复制/吊销 key，可限制可访问 provider，支持一键唤起 CC Switch 官方导入；
- **用量统计**：按今天 / 7 天 / 30 天 / 全部汇总，支持按模型统计与最近请求分页。

支持的 provider 类型：

| 类型 | 说明 |
| --- | --- |
| `trae-cn` / `trae-ai` | Trae 国内 / 国际版登录态 |
| `openai` | 任意 OpenAI 兼容服务（DeepSeek、OpenRouter、vLLM 等） |
| `anthropic` | Anthropic Messages API |
| `gemini` | Google Gemini API |
| `ollama` | 本地 Ollama |

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
| 前端空白 | 先 `npm run build` 再访问管理台 |
