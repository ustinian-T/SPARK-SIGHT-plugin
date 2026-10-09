# 第三方资源清单

本页是第三方资源的**详细清册**，说明每一项的来源、版本、许可、用途与分发边界。
许可以及商标声明汇总见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)；
本项目自身的许可范围见 [licensing.md](licensing.md)。

版本以各 `package-lock.json` 的锁定值为准（下表为发布快照时的实际值）。

## 一、随仓库分发的第三方资源

这些资源的副本**就在本仓库里**，再分发时必须一并保留其许可与声明。

| 资源 | 版本 / 路径 | 许可 | 用途 | 义务 |
|---|---|---|---|---|
| Noto Sans CJK SC Regular | Sans 2.004<br>`services/local-agent/src/fonts/NotoSansCJKsc-Regular.otf` | OFL-1.1 | 中文图表渲染；Python 直接注册，R/Cairo 用随包 fontconfig | 保留 `OFL.txt`；不单独售卖字体；不改用 Reserved Font Name |

字体校验值：SHA-256 `2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b`。

## 二、构建与运行期 npm 依赖

| 资源 | 版本 | 许可 | 用途 | 分发义务 |
|---|---|---|---|---|
| react | 18.3.1 | MIT | 共享 Web UI | 保留版权与许可声明 |
| react-dom | 18.3.1 | MIT | 共享 Web UI | 同上 |
| @vitejs/plugin-react | 6.1.1 | MIT | Vite 的 React 转换 | 同上 |
| vite | 8.3.0 | MIT | Web 构建与开发服务器 | 同上 |
| vitest | 5.0.1 | MIT | 单元测试 | 同上 |
| typescript | 5.6.3 | Apache-2.0 | 类型检查与编译 | 保留许可与 NOTICE；标明修改 |
| @types/node | ^22.10.2 | MIT | 类型声明 | 仅开发期 |
| @types/vscode | ^1.95.0 | MIT | VS Code API 类型声明 | 仅开发期 |
| @types/react | ^18.3.12 | MIT | 类型声明 | 仅开发期 |
| @types/react-dom | ^18.3.1 | MIT | 类型声明 | 仅开发期 |

**共享本地 Agent 没有任何运行时 npm 依赖**，只使用 Node 内置模块
（`node:http`、`node:crypto`、自实现 RFC6455 WebSocket 等）。这是有意的设计：
插件包不需要随附 `node_modules`。

## 三、宿主平台

| 资源 | 来源 | 许可 / 条款 | 边界 |
|---|---|---|---|
| DeepSeek Harness / `@deepseek-ai/cordis` | github.com/deepseek-ai/deepseek-harness | MIT | 宿主平台，**不随仓库分发**；本插件为独立第三方插件 |
| VS Code Extension API | code.visualstudio.com/api | 产品与 API 使用条款；类型声明 MIT | **VS Code 本身不随仓库分发** |
| Node.js | nodejs.org | MIT 及自带第三方声明 | 用户自备；安装包中的运行时副本单独携带许可 |
| Electron | electronjs.org | MIT | 仅作为 DSH desktop profile 的宿主被提及，不分发 |

## 四、用户自备的运行时（不分发）

| 资源 | 许可 | 用途 | 边界 |
|---|---|---|---|
| Python / matplotlib | PSF 基础许可 | 真实 Python 渲染 | 由用户环境提供；缺失时如实报告不可用 |
| R | GPL-2.0 或 GPL-3.0 | 可选执行生成的 R 代码 | 不随包分发；生成的 R 源码属用户输出 |
| MATLAB | MathWorks 商业条款 | 可选执行本地 MATLAB 脚本 | **不分发 MATLAB，不上传其许可证** |
| Docker Compose / Caddy | Apache-2.0 | 可选远程部署与 TLS 反代 | 仅部署示例引用，不分发镜像 |

## 五、数据与算法的参考来源

| 资源 | 来源 | 许可 | 使用方式 |
|---|---|---|---|
| ColorBrewer | colorbrewer2.org | Apache 风格的 ColorBrewer 条款，要求注明出处 | `palettes.js` 中的顺序/发散/定性色板**取值** |
| Seaborn `colorblind` | github.com/mwaskom/seaborn | BSD-3-Clause | 色盲友好定性色板**取值** |
| ggsci（NPG/NEJM/Lancet/JAMA 风格） | github.com/nanxstats/ggsci | GPL-3.0 | 期刊风格色板**取值**，不复制代码；隔离说明见 [licensing.md §4.3](licensing.md#43-ggsci-的-gpl-30-与隔离措施) |

## 六、外部服务

| 服务 | 条款 | 边界 |
|---|---|---|
| Volcano Engine Ark（`ark.cn-beijing.volces.com`） | 火山引擎服务条款 | 可选的 OpenAI / Anthropic 兼容规划提供商；**使用者自行申请并保护凭据**，服务输出需人工复核 |
| 其他 OpenAI / Anthropic 兼容端点 | 各自条款 | 由使用者在设置中自行配置 |

**本仓库不包含任何服务的凭据。** `.env.example` 中的 API Key 值为
`replace-with-server-side-key` 占位符。

## 七、自研部分

除上述资源外，以下部分为本项目自研，不含第三方代码：

- 插件适配层：命令注册、webview/Stage 宿主、postMessage 宿主桥、补丁审阅与
  逐块接受/拒绝、运行时管理与更新校验（`apps/vscode/`、`apps/dsh/`）。
- 本地 Agent：HTTP/WS 服务、CSV/Excel 解析、统计与误差口径、ChartSpec 变换、
  三方案决策（特征/MRR/MMR/权重）、代码生成、沙箱执行、证据验证、记忆与偏好。
- 共享 Web UI：工作台界面、项目管理、图表编辑、导出流程、站点页面。

生成图表可能嵌入用户本机字体的元数据；导出成果的许可与引用由使用者自行负责。

## 八、维护

新增第三方资源时，必须同步更新本文件与
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)，说明来源、版本、许可与分发义务。
优先选择 MIT / Apache-2.0 / BSD / OFL 类许可；引入 copyleft 依赖前必须先评估
与本项目 MIT + 非商业组合的兼容性。
