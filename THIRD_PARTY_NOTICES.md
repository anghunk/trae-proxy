# 第三方开源声明（Third-Party Notices）

本项目是 [dingminhua/dsh-connect-trae](https://github.com/dingminhua/dsh-connect-trae)
（MIT，Copyright (c) 2026 LaoDing）的独立改写版：去掉 DeepSeek Harness（DSH）插件外壳，
只保留其纯 Node 的 Trae 连接内核，做成 opencode 可直接使用的 OpenAI 兼容本地代理。
核心的凭据解密、设备指纹、上游协议与 SSE 桥接逻辑均沿用上游项目。

## 直接上游项目

本项目的**直接上游**为 [weixiaokuan123/trae-proxy](https://github.com/weixiaokuan123/trae-proxy)
（MIT，Copyright (c) 2026 weixiaokuan123），它是上述
[dingminhua/dsh-connect-trae](https://github.com/dingminhua/dsh-connect-trae) 的独立改写版。
本仓库在该 `trae-proxy` 独立改写版的基础上继续修改而成，并保留其 MIT 版权声明（见 `LICENSE`）。

## 与 Trae 接入直接相关的参考项目

下列声明沿用上游 dsh-connect-trae 的 `THIRD_PARTY_NOTICES.md`。版权属于各自作者。

| 参考项目 | 仓库 | 参考内容 | 许可证 |
| --- | --- | --- | --- |
| `trae-proxy`（weixiaokuan123） | <https://github.com/weixiaokuan123/trae-proxy> | 本项目的直接上游：dsh-connect-trae 的独立改写版，去 DSH 插件外壳、保留纯 Node 连接内核 | MIT |
| `dsh-trae-api` | <https://github.com/Wang-JQ77/dsh-trae-api> | Trae 上游协议（认证、会话、模型目录）参考与失败样本分析 | MIT |
| `laojichao/trae-local-api` | <https://github.com/laojichao/trae-local-api> | `dsh-trae-api` 的直接上游，仅作为 Trae 协议调研线索，未复用其代码 | 未声明（保留所有权利） |

## 合规说明

- 上游 dsh-connect-trae 使用 **MIT** 许可，与本项目的 MIT 许可证兼容；MIT 要求保留版权声明，见 `LICENSE` 与各源码文件头部注释。
- `laojichao/trae-local-api` 未声明许可证（保留所有权利），仅作为协议调研线索，未复制、修改或分发其代码。
- 本项目**不重新打包或再分发**上述参考项目的源码。

## 前端依赖

管理台使用以下 npm 依赖（构建时打包进 `web/dist`），各自版权与许可如下：

| 依赖 | 版本 | 许可证 | 用途 |
| --- | --- | --- | --- |
| React | 19.x | MIT | UI 组件库 |
| React DOM | 19.x | MIT | DOM 渲染 |
| Vite | 8.x | MIT | 前端构建工具 |
| @vitejs/plugin-react | 6.x | MIT | React 插件 |
| TypeScript | 7.x | Apache-2.0 | 类型检查/编译 |

完整许可证文本见各依赖的 `LICENSE` 文件（`node_modules`）与
[React License](https://github.com/facebook/react/blob/main/LICENSE)、
[Vite License](https://github.com/vitejs/vite/blob/main/LICENSE)。

后端运行时保持零第三方 npm 依赖；SQLite 使用 Node.js 内置 `node:sqlite`。
