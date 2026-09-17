# trae-proxy

在 opencode 里使用 Trae（含 TRAE SOLO CN）桌面端已登录模型的一个**纯 Node、零第三方依赖**本地代理。

它把 Trae 桌面端的本地登录态转成 opencode 可直接调用的 **OpenAI 兼容** 端点：

- 国内版（cn）：`http://127.0.0.1:39303/v1`
- 国际版（ai）：`http://127.0.0.1:39304/v1`

一个进程同时服务两个区域，每个区域用独立的持久 `bearer key` 做本地鉴权。实测：
登录态解密、模型目录（SOLO 通道约 39 个）、SSE 流式对话、工具调用（`finish_reason=tool_calls`）均可用。

> **须知**：本项目**参考（改写自）[dingminhua/dsh-connect-trae](https://github.com/dingminhua/dsh-connect-trae)**
> （MIT，Copyright (c) 2026 LaoDing），去掉了 DeepSeek Harness（DSH）插件外壳，只保留纯 Node 连接内核。
> 它**只读** Trae 桌面端当前登录态，本身不提供账号切换。

## 它做了什么

Trae 桌面端把凭据加密存放在本地 `storage.json`，并使用私有的 SSE 事件协议。本代理：

1. 用纯 `node:crypto` 离线解密本地登录态（硬编码盐 + AES-128-CBC + SHA-512 KDF），无需安装 Trae 之外的任何东西；
2. 复刻设备指纹请求头（machineId / deviceId / appVersion 等）与 SOLO 通道请求；
3. 把 Trae 私有的 SSE 事件桥接成标准 OpenAI `/v1/chat/completions`（含流式增量、`tool_calls`、`usage`）；
4. token 刷新只在进程内存中进行，**绝不写回桌面端文件、不落地副本**。

仅使用已验证的 SOLO 通道：模型目录 `get_detail_param` + 对话 `llm_utils_chat`。

## 来源与许可

参考（改写自）[dingminhua/dsh-connect-trae](https://github.com/dingminhua/dsh-connect-trae)（MIT）。
其协议调研参考了 [Wang-JQ77/dsh-trae-api](https://github.com/Wang-JQ77/dsh-trae-api)（MIT）等项目。
版权与署名详见 `LICENSE` 与 `THIRD_PARTY_NOTICES.md`，各源码文件头部亦有标注。

## 运行要求

- Node.js **22.19+ 或 24+**：TypeScript 由 Node 原生类型擦除直接运行，**无需构建、无需 `npm install`**。
- 本机已安装并登录 **Trae / TRAE SOLO CN** 桌面端（代理只读其登录态文件，不修改、不上传）。
- 操作系统：Windows（提供 PowerShell 脚本）；macOS / Linux 可直接 `node src/serve.ts`。

登录态读取路径（按区域 / 版本自动探测，见 `src/paths.ts`）：

| 版本 | 路径 |
| --- | --- |
| Trae CN | `%APPDATA%\Trae CN\User\globalStorage\storage.json` |
| TRAE SOLO CN | `%APPDATA%\TRAE SOLO CN\User\globalStorage\storage.json` |
| Trae（国际） | `%APPDATA%\Trae\User\globalStorage\storage.json` |
| TRAE SOLO（国际） | `%APPDATA%\TRAE SOLO\User\globalStorage\storage.json` |

> 国内区域（cn）同时探测 `Trae CN` 与 `TRAE SOLO CN`；国际区域（ai）探测另外两个。
> 另支持 CN 的 CLI 明文旁路 `%USERPROFILE%\.trae-cn\trae-jwt-token`。

## 安装

### 1. 克隆到 opencode 配置目录

**Windows（PowerShell）**

```powershell
git clone https://github.com/weixiaokuan123/trae-proxy.git "$env:USERPROFILE\.config\opencode\trae-proxy"
```

**macOS / Linux**

```bash
git clone https://github.com/weixiaokuan123/trae-proxy.git ~/.config/opencode/trae-proxy
```

### 2. 启动并注入配置（手动分步）

```powershell
cd "$env:USERPROFILE\.config\opencode\trae-proxy"

# 后台启动（隐藏窗口，写 logs\proxy.pid，首次自动生成 keys\*.key）
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start.ps1

# 把 trae-cn / trae-ai 两个 provider 注入 opencode.jsonc（自动备份为 .bak.trae）
node .\scripts\inject-config.cjs

# 查看两个区域的登录状态与模型数
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\status.ps1
```

> `.ps1` 若在 Windows PowerShell 5.1 下出现中文乱码，跑一次 `node add-bom.cjs` 补 UTF-8 BOM。

### 3. 重启 opencode

**必须重启 opencode** 才会加载新注入的 provider。重启后在模型列表里选择
`Trae 国内版` 或 `Trae 国际版` 下的模型（默认推荐 `trae-cn/glm-5.3`）。

macOS / Linux 下直接：

```bash
node src/serve.ts                 # 前台启动
node scripts/inject-config.cjs    # 注入 provider
KEY=$(cat keys/cn.key)            # 状态自检
curl -H "Authorization: Bearer $KEY" http://127.0.0.1:39303/status
```

## 切换账号

本代理**每次请求都实时重读**对应区域的 `storage.json`（无缓存）。要换账号时，
直接在 Trae / TRAE SOLO CN 客户端里切换登录即可，**无需重启本代理**，下一次请求自动跟随。

## 日常运维（Windows）

| 操作 | 命令 |
| --- | --- |
| 启动 | `scripts\start.ps1` |
| 前台调试 | `scripts\start.ps1 -Foreground` |
| 停止 | `scripts\stop.ps1` |
| 状态 | `scripts\status.ps1` |
| 开机自启 | `scripts\install-autostart.ps1` |
| 取消自启 | `scripts\uninstall-autostart.ps1` |

自启通过「登录时触发的计划任务 + `wscript` 静默 VBS」实现，无黑框。

## 配置项（环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `TRAE_CN_PORT` | `39303` | 国内端点端口 |
| `TRAE_AI_PORT` | `39304` | 国际端点端口 |

## 安全模型

- 仅监听 `127.0.0.1`，四重回环校验：Host、Origin、`Content-Type: application/json`、bearer 常量时间比对。
- `keys/*.key` 首次启动随机生成（建议 0600），`keys/`、`logs/` 均已在 `.gitignore` 排除，**仓库不含任何凭据**。
- 请求体上限 64 MB；上游错误映射为 401/402/429/502/503 等状态码。
- 登录态只在本机解密与刷新，不写回、不落地、不联网外传至除 Trae 官方网关外的任何地址。

## 目录结构

```
trae-proxy/
  add-bom.cjs              给 .ps1 补 UTF-8 BOM（PowerShell 5.1 中文兼容）
  keys/                    运行时生成的持久 bearer key（.gitignore 排除）
  logs/                    运行日志与 pid（.gitignore 排除）
  scripts/
    start.ps1 / stop.ps1 / status.ps1
    install-autostart.ps1 / uninstall-autostart.ps1
    inject-config.cjs      把两个 provider 注入 opencode.jsonc（自动备份，路径相对推导）
    probe.cjs / probe-chat.cjs / list-ids.cjs   本机联调脚本（可选）
  src/
    serve.ts               守护入口（cn / ai 双区域）
    shim.ts                OpenAI 兼容回环端点（鉴权 + SSE 透传）
    auth.ts                只读桌面端登录态、内存内 token 刷新（本项目重写）
    catalog.ts             模型目录（静态 fallback + SOLO 刷新）
    solo.ts / solo-bridge.ts   SOLO 上游客户端与 SSE 协议桥接
    decrypt.ts / identity.ts / paths.ts / region.ts / refresh.ts /
    protocol.ts / reasoning.ts / sse.ts / upstream.ts
```

## 排错

| 现象 | 处理 |
| --- | --- |
| `status` 显示未登录 / 503 `unconfigured` | 先在对应区域登录 Trae / TRAE SOLO CN；确认上表中的 `storage.json` 存在 |
| 国际区域不可用 | 国际版需登录国际版 Trae；未登录时该区域仅返回内置 fallback，属正常 |
| 端口未监听 | 看 `logs\proxy.err.log`；确认 Node 为 22.19+/24+ |
| 某模型报 400 / not_found | 该模型须经由列出它的 directory function 调用；只用 `/v1/models` 返回的 id |
| opencode 里看不到新模型 | 重启 opencode；再确认 `inject-config.cjs` 注入成功 |
| `.ps1` 中文乱码 | 跑 `node add-bom.cjs` 补 BOM |

## 免责声明

本项目仅用于学习研究与在本机复用自己已登录的合法账号，请遵守 Trae 服务条款与当地法律法规。
使用者自行承担使用风险。

## 许可

MIT。原始版权归 dingminhua（LaoDing）等项目作者所有，详见 `LICENSE`、`THIRD_PARTY_NOTICES.md`
及源码文件头部注释。
