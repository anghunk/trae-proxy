# 第三方开源声明（Third-Party Notices）

本项目是 [dingminhua/dsh-connect-trae](https://github.com/dingminhua/dsh-connect-trae)
（MIT，Copyright (c) 2026 LaoDing）的独立改写版：去掉 DeepSeek Harness（DSH）插件外壳，
只保留其纯 Node 的 Trae 连接内核，做成 opencode 可直接使用的 OpenAI 兼容本地代理。
核心的凭据解密、设备指纹、上游协议与 SSE 桥接逻辑均沿用上游项目。

## 与 Trae 接入直接相关的参考项目

下列声明沿用上游 dsh-connect-trae 的 `THIRD_PARTY_NOTICES.md`。版权属于各自作者。

| 参考项目 | 仓库 | 参考内容 | 许可证 |
| --- | --- | --- | --- |
| `dsh-trae-api` | <https://github.com/Wang-JQ77/dsh-trae-api> | Trae 上游协议（认证、会话、模型目录）参考与失败样本分析 | MIT |
| `laojichao/trae-local-api` | <https://github.com/laojichao/trae-local-api> | `dsh-trae-api` 的直接上游，仅作为 Trae 协议调研线索，未复用其代码 | 未声明（保留所有权利） |

## 合规说明

- 上游 dsh-connect-trae 使用 **MIT** 许可，与本项目的 MIT 许可证兼容；MIT 要求保留版权声明，见 `LICENSE` 与各源码文件头部注释。
- `laojichao/trae-local-api` 未声明许可证（保留所有权利），仅作为协议调研线索，未复制、修改或分发其代码。
- 本项目**不重新打包或再分发**上述参考项目的源码。
