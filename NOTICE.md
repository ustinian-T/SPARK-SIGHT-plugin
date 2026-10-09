# Notices

灵感视界 SPARK SIGHT · Deep Imaging — 插件源码
Copyright 2026 Deep Imaging contributors

本仓库发布 Deep Imaging 的两个宿主插件源码：Visual Studio Code 扩展与
DeepSeek Harness 插件，以及它们共同依赖的本地 Agent 与共享 Web UI。

## 许可范围（摘要）

本仓库**不是单一许可**。不同目录适用不同条款，以下为摘要；正式条款以各目录
内的 LICENSE 文件与根目录 LICENSE 为准，完整映射见 [docs/licensing.md](docs/licensing.md)。

| 路径 | 内容 | 许可 |
|---|---|---|
| `apps/vscode/` | VS Code 扩展适配层 | **MIT** — 见 [apps/vscode/LICENSE](apps/vscode/LICENSE) |
| `apps/dsh/` | DeepSeek Harness 插件适配层 | **MIT** — 见 [apps/dsh/LICENSE](apps/dsh/LICENSE) |
| `apps/web/` | 共享 Web UI | 非商业使用与署名许可 1.0 — 见根 [LICENSE](LICENSE) |
| `services/local-agent/` | 共享本地 Agent | 非商业使用与署名许可 1.0 — 见根 [LICENSE](LICENSE) |
| `services/local-agent/src/fonts/` | Noto Sans CJK SC | SIL Open Font License 1.1 — 见 [OFL.txt](services/local-agent/src/fonts/OFL.txt) |
| `contract/` | 宿主协议模式定义 | 随其服务的实现，见 [docs/licensing.md](docs/licensing.md) |

**说明：** 根目录的非商业使用与署名许可 1.0 是**源码可用的自定义许可**，
包含非商业限制，**不是 OSI 批准的开源许可**。两个插件适配层（`apps/vscode/`、
`apps/dsh/`）以 MIT 发布，是真正的开源许可。

历史说明：主项目在 2026-10-09 之前按 Apache License 2.0 发布。此前发布的代码
继续保留原许可授予的权利，本仓库不追溯撤销。附录保留 Apache-2.0 全文；
另见 [docs/licenses/Apache-2.0-legacy.txt](docs/licenses/Apache-2.0-legacy.txt)。

## 公开仓库的内容边界

本仓库是面向公开发布的源码快照，已做以下处理：

- **不含任何真实凭据。** 未包含 API Key、令牌、私钥、证书、`.env` 文件或
  历史默认密码。测试中的口令均为显式占位符或业界通用示例值。
- **不含个人身份信息。** 已移除真实姓名、私人邮箱与备案号，替换为中性占位符
  （`admin`、`contact@example.com`、`示例`），部署方须替换为自己的信息。
- **不含生产基础设施。** 账号服务与更新源的地址改为环境变量可配置，默认值为
  中性占位符；未公开任何私有域名或内部端点。
- **不含用户数据。** 仓库中的 CSV 夹具与演示数据均为合成的测试数据，不描述
  真实人物、患者、实验、机构或已发表研究。详见
  [docs/sample-data-rights.md](docs/sample-data-rights.md)。
- **不含第三方运行时。** Node.js、Python、R、MATLAB、云模型服务均由使用者
  自行安装并遵守其各自的许可或服务条款。

处理细节与复核方式见 [docs/privacy-and-redaction.md](docs/privacy-and-redaction.md)。

## 第三方组件

第三方库、运行时、云服务与用户自有的商业工具分别适用其原有许可，本项目的
条款不对其追加限制。完整清单见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
与 [docs/third-party-resources.md](docs/third-party-resources.md)。

## 商标

"DeepSeek"、"DeepSeek Harness" 及相关名称与标识是 DeepSeek 的商标，其 MIT
许可不授予商标权；本项目仅在描述所运行宿主平台时引用。"Visual Studio Code"
与 "VS Code" 是 Microsoft 的商标。"MATLAB" 是 MathWorks 的商标。
"SPARK SIGHT"、"灵感视界" 与本项目图标是本项目自己的标识。

本项目是独立的第三方插件，**未获得 DeepSeek 或 Microsoft 的提供、认可、
认证或赞助**。

## 注明来源

使用或分享本项目时，请在使用场景中注明：

> 基于灵感视界 SPARK SIGHT / Deep Imaging，来源：https://github.com/ustinian-T/SPARK-SIGHT-plugin；
> 非商业使用与署名许可 1.0。

软件或托管界面在关于、帮助或说明页标注；教学材料及公开科研成果在方法、致谢
或工具说明中标注。不要求每张图添加水印。再分发必须保留 LICENSE、NOTICE.md
与必要的第三方声明，并清楚标明修改内容、作者与日期。

仅使用以 MIT 发布的适配层代码时，遵守 MIT 的保留版权与许可声明要求即可。
