# 灵感视界 SPARK SIGHT · Deep Imaging — 插件源码

> VS Code 扩展与 DeepSeek Harness 插件的源代码。
> 把科研数据绘图工作台搬进你已经在用的编辑器与智能体宿主。

本仓库发布两个宿主插件的完整源码，以及它们共同依赖的本地 Agent 与共享 Web UI：

| 插件 | 宿主 | 适配层许可 | 安装形态 |
|---|---|---|---|
| **Deep Imaging for VS Code** | Visual Studio Code ≥ 1.95 | **MIT** | `.vsix` 扩展 |
| **SPARK SIGHT for DeepSeek Harness** | [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | **MIT** | DSH 插件包 |

两个插件都是**独立的第三方集成**，**未获得 DeepSeek 或 Microsoft 的提供、认可、
认证或赞助**。

---

## ⚠️ 先读许可：本仓库不是单一许可

**这是含非商业限制的源码，不是整个仓库都开源。** 请按目录区分：

| 路径 | 许可 | OSI 开源？ |
|---|---|---|
| `apps/vscode/` | **MIT** | ✅ 是 |
| `apps/dsh/` | **MIT** | ✅ 是 |
| `apps/web/` | 非商业使用与署名许可 1.0 | ❌ 否 |
| `services/local-agent/` | 非商业使用与署名许可 1.0 | ❌ 否 |
| `services/local-agent/src/fonts/` | SIL Open Font License 1.1 | ✅ 是 |

- **两个插件适配层（MIT）**：可自由使用、修改、再分发，**包括商业用途**。
- **共享本地 Agent 与 Web UI（非商业许可）**：个人学习、教学、非营利科研与
  社区使用免费；**收费绘图、付费 SaaS、商业产品集成需事先书面授权**。
- 完整范围、兼容性分析与常见问题见 **[docs/licensing.md](docs/licensing.md)**。

---

## 它能做什么

面向科研和教学的数据绘图工作台。上传数据、描述问题，Agent 完成字段检查、
统计分析、三方案生成、代码执行和独立验证；可以比较方案、编辑图表与代码、
重跑任务，并导出可复现材料。

- **数据检查** — 识别列类型、缺失值、唯一值与数值范围；标识列和重复测量 ID
  不当作测量系列；异常值提示不会静默删除数据。
- **可观察 Agent** — 任务步骤、错误及执行日志可查看；失败任务可重试，
  运行中任务可取消；自动修复有预算，不保证任意代码都能修复。
- **三方案比较** — 共享一份统计结果，通过配色、布局和信息密度提供不同呈现。
- **真实执行与验证** — 生成 Python/R 源码并执行，检查统计与规格的一致性。
  无 LLM 时常见图型走规则解析。
- **中文制图** — 内置 Noto Sans CJK SC（OFL-1.1），Python 直接注册随包字体，
  R 使用随包 fontconfig；缺字会在任务日志告警。
- **编辑与复现** — 编辑图标题、图层和坐标轴；代码可查看、编辑、保存重跑；
  导出可包含源码、数据、ChartSpec、证据和真实图表产物。
- **本地优先** — Agent 只绑定 `127.0.0.1`，每次启动随机 token；
  云同步与远程分享默认关闭。

**诚实的边界：** Python 与 R 是绘图引擎，需自行准备；MATLAB 需要你自己合法
授权的本地安装，项目**不分发 MATLAB**；缺失的运行时会被如实报告为不可用，
而不是伪装成执行成功。

---

## 安装

### VS Code 扩展

从 VSIX 安装：

```
VS Code → 扩展 → 右上角菜单 → 从 VSIX 安装 → 选择 Deep-Imaging-VSCode-Windows-x64.vsix
```

安装后按 `Ctrl+Alt+I`（macOS `Cmd+Alt+I`）或从命令面板搜索 **Deep Imaging**。

主要命令：打开工作台、启动/停止本地 Agent、审阅补丁、打开 CSV/Excel/JSON、
使用编辑器选区、生成两个变体、同步项目、高级导出、显示诊断、生成三套方案、
修复当前图表、预览图表、比较三套方案、导出复现包、管理偏好、
运行当前 MATLAB 脚本、运行当前 Python/R/MATLAB/Node 文件、检查更新。

| 快捷键 | 命令 |
|---|---|
| `Ctrl+Alt+I` | 打开 Deep Imaging |
| `Ctrl+Alt+O` | 打开数据文件 |
| `Ctrl+Alt+S` | 使用编辑器选区（需有选区） |
| `Ctrl+Alt+V` | 生成两个变体 |
| `Ctrl+Alt+E` | 高级导出 |

### DeepSeek Harness 插件

Harness 插件按 **profile** 安装。桌面应用用的是 `desktop` profile
（它本身通过同一套 Web UI 渲染）：

```sh
# 官方桌面应用
dsh plugin --profile desktop add sparksight-dsh

# 浏览器版 Web UI
dsh plugin --profile web add sparksight-dsh
```

开发时把包名换成本地路径，例如 `dsh plugin --profile desktop add ./apps/dsh`。
安装后重启 Harness（或退出并重开桌面应用）。

---

## 架构

两个插件都是**薄适配层 + 共享后端**：

```
宿主（VS Code / DeepSeek Harness）
  └── 适配层（MIT：apps/vscode 或 apps/dsh）
        · 注册命令 / 注入按钮 / 打开 webview 或 Stage
        · 启动并守护 sidecar（boot token、/health 就绪、进程树回收）
        · 宿主桥：转发 webview 调用到本机 Agent
              │ spawn（127.0.0.1，随机端口 + 随机 token）
              ▼
  └── 共享本地 Agent（非商业许可：services/local-agent）
        · HTTP + 自实现 RFC6455 WebSocket，零运行时 npm 依赖
        · CSV/Excel 解析、统计口径、ChartSpec、三方案决策
        · Python/R 代码生成、沙箱执行、独立验证
        · 同源托管共享 Web UI 构建产物
              │ iframe / webview 加载
              ▼
  └── 共享 Web UI（非商业许可：apps/web）
        · 工作台界面、项目管理、图表编辑、导出
        · 通过宿主桥获得 baseUrl + boot token 后直接与本机 Agent 通信
```

**关键设计：** Agent 只绑定 `127.0.0.1` 并每次生成随机 token；
API 用 `Authorization: Bearer <token>`，WebSocket 在握手后认证；
**token 从不进入 URL**。Web UI 由 Agent 同源托管，静态资源不需要 token。

细节、数据落地位置与打包装配流程见 **[docs/architecture.md](docs/architecture.md)**。

---

## 仓库结构

```text
.
├── apps/
│   ├── web/              # 共享 Web UI（React + Vite）          [非商业许可]
│   ├── vscode/           # VS Code 扩展适配层                    [MIT]
│   └── dsh/              # DeepSeek Harness 插件适配层           [MIT]
├── services/
│   └── local-agent/      # 共享本地 Agent（零运行时依赖）        [非商业许可]
├── contract/             # 宿主协议权威定义
├── docs/                 # 许可、隐私、第三方清单、架构
├── scripts/              # 密钥检查、协议检查、SBOM
├── LICENSE               # 非商业使用与署名许可 1.0（含 Apache-2.0 历史附录）
├── LICENSE-MIT           # MIT 全文
├── NOTICE.md             # 许可范围摘要、商标、署名要求
└── THIRD_PARTY_NOTICES.md
```

> **为什么 `apps/vscode/` 和 `apps/dsh/` 看起来缺少后端？**
> 它们**不复制** Agent 与 Web UI 的源码。打包时由
> `apps/vscode/scripts/prepare-package.mjs` 与
> `apps/dsh/scripts/prepare-dsh.mjs` 从 `services/local-agent/src` 与
> `apps/web/dist` 装配进去；装配产物目录已由 `.gitignore` 排除。

---

## 开发环境

需要 **Node.js 22.12+ 或 24 LTS** 与 npm。Agent 本身支持 Node 20+，
但前端锁定的构建工具需要更高版本，统一用 Node 24 可减少差异。

```sh
git clone https://github.com/ustinian-T/SPARK-SIGHT-plugin.git
cd SPARK-SIGHT-plugin
npm run install:all
```

### 启动本地 Agent 与 Web UI

终端 A —— 启动 Agent 并固定开发端口：

```powershell
# Windows PowerShell
$env:LOCAL_AGENT_PORT = '5181'
# 首次初始化时填入你自己的强密码；不要提交或写入仓库。
$env:LOCAL_AGENT_ADMIN_PASSWORD = '<your-local-admin-password>'
npm run start:agent
```

```sh
# Linux / macOS
LOCAL_AGENT_PORT=5181 LOCAL_AGENT_ADMIN_PASSWORD='<your-local-admin-password>' npm run start:agent
```

终端 B —— 启动 Web UI：

```sh
npm --prefix apps/web run dev
```

打开 `http://127.0.0.1:5180`。Vite 同源代理 `/api` 与 `/health` 到
`127.0.0.1:5181`（含 WebSocket）。Agent 换端口时，在启动 Vite 的环境里设置
`VITE_AGENT_BASE`。

**不要直接在真实用户数据目录运行实验性开发服务。**
**不要把真实 Key 写进源码、README、截图、Issue 或 CI 日志。**
**不要用 URL 传递令牌。**

### 开发 DSH 插件

插件无需构建步骤：`apps/dsh/index.js`（Host 半）与 `apps/dsh/client.js`
（Client 半）是直接提交的产物，改完即生效。

- Host 半运行在具备 Node 能力的 Harness 进程中，除 Node 内置模块与宿主的
  Connection fetch 注册表外**零运行时依赖**。
- Client 半通过浏览器 Module Loader 注册，React 与 react-dom 由 Harness
  模块表提供。

---

## 构建与打包

```sh
npm run build            # 构建 Web UI 与 VS Code 扩展
npm run build:web        # 只构建共享 Web UI
npm run build:vscode     # 只编译 VS Code 扩展（tsc）
```

### 打包 VS Code 扩展

```sh
npm run prepare:vscode
```

它会先构建 `apps/web`，再编译扩展，然后由 `prepare-package.mjs` 装配
`apps/vscode/agent/` 与 `apps/vscode/web/dist/`，并把根 `LICENSE`、`NOTICE.md`
拷入扩展目录。

### 打包 DSH 插件

```sh
npm run prepare:dsh
```

由 `prepare-dsh.mjs` 装配 `apps/dsh/resources/`。装配脚本会**拒绝符号链接**，
并跳过 `.data`、`.env`、`projects`、`tasks`、`verified-updates`、`__pycache__`
与 `*.pem/.key/.pfx/.p12/.jks/.crt`——打包路径本身也做了防泄漏处理。

### 可选：随包捆绑 Windows 运行时

设置 `DEEP_IMAGING_BUNDLE_WINDOWS_RUNTIME=1` 会把 Node 与 Python 运行时一并打入。
**本仓库不包含桌面壳（`apps/desktop`），因此没有预置运行时目录**，
该选项需要你自备运行时并放入 `apps/desktop/src-tauri/runtime/`。

### 发布源配置

插件内置的更新检查需要指向一个发布主机。本仓库的公开快照**不含生产域名**，
默认值是占位符：

| 环境变量 | 用途 | 公开快照默认值 |
|---|---|---|
| `DEEP_IMAGING_UPDATE_ORIGIN` | 更新清单与安装包来源（`<origin>/downloads/release.json`） | `https://updates.example.com` |
| `DEEP_IMAGING_ACCOUNT_URL` | 跨端账号服务地址 | `https://account.example.com` |

自建发布时请指向**你自己控制的 HTTPS 主机**。更新下载固定来源、禁止重定向、
校验字节数与 SHA-256，不匹配则不安装——但这**不等同于安装包数字签名**。

VS Code 扩展还支持：

| 环境变量 | 用途 |
|---|---|
| `DEEP_IMAGING_AGENT_ENTRY` | 显式指定本地 Agent 入口文件 |
| `DEEP_IMAGING_NODE` | 显式指定启动 Agent 的 Node 可执行文件 |

---

## 配置

### VS Code

| 设置项 | 默认值 | 说明 |
|---|---|---|
| `deepImaging.matlabPath` | `matlab` | 指向**你自己合法授权**的本地 MATLAB 可执行文件 |

### DeepSeek Harness 插件

插件行的 `config` 接受以下可选字段：

| 字段 | 类型 | 默认 | 用途 |
|---|---|---|---|
| `autoStart` | boolean | `true` | 插件挂载时启动 sidecar |
| `agentDir` | string | 自动 | 显式指定 local-agent 目录 |
| `port` | number | `0`（随机） | 固定 sidecar 端口（`LOCAL_AGENT_PORT`） |
| `dataDir` | string | Agent 默认 | 持久化目录（`LOCAL_AGENT_DATA_DIR`） |
| `webDir` | string | 自动 | 同源托管的 Web 构建目录 |
| `adminUsername` | string | `admin` | 引导管理员名（`LOCAL_AGENT_ADMIN_USERNAME`） |
| `adminPassword` | string | 随机 | 引导管理员口令（`LOCAL_AGENT_ADMIN_PASSWORD`）；默认每次随机生成并只在 Agent 日志中显示一次 |

**没有固定的默认口令。** 未设置 `adminPassword` 时，Agent 每次启动都会生成
随机口令并提示你安全保存。

---

## 数据与隐私

### 插件不做什么

- 桌面/插件使用**本地 Agent**，不自动把项目、原始数据或聊天记录上传本项目服务器。
- 云同步与远程分享默认关闭（`LOCAL_ONLY_MODE=1`、`REMOTE_MODE=0`）。

### 什么会离开本机

| 环节 | 是否离开本机 |
|---|---|
| 数据检查、统计、图表生成（无模型时） | 否 |
| 项目/任务记录 | 否，写在本地数据目录 |
| **调用大模型规划** | **是** — 提示词与必要的字段摘要发送给你配置的模型提供商 |
| 登录账号服务 | 是，**仅在你配置并主动使用账号功能时**；项目与原始数据不随登录同步 |
| 更新检查 | 是，向 `DEEP_IMAGING_UPDATE_ORIGIN` 请求发布清单 |

**“本地保存”不等于模型调用离线。** 选择模型提供商即表示你接受其数据处理政策。
上传前请去除无关个人信息，并确认数据使用权。

### 数据落地位置

| 宿主 | 项目/任务/数据 |
|---|---|
| VS Code 扩展 | 扩展的 `globalStorageUri/agent-data` |
| DSH 插件 | 插件 `config.dataDir` 或 Agent 默认数据目录 |

### 本仓库的脱敏处理

本公开快照已移除真实凭据、私钥、`.env`、真实姓名、私人邮箱、备案号与生产域名，
并替换为中性占位符。**完整的逐项处理记录与可复现的复核方法见
[docs/privacy-and-redaction.md](docs/privacy-and-redaction.md)。**

> 在中国大陆境内提供互联网信息服务需自行完成 ICP 备案。页脚中的备案号是
> **占位符**，部署时必须替换为你依法取得的信息，或移除相关页脚。
> 本项目不提供也不代传递任何备案资质。

仓库中的 CSV 夹具与演示数据**全部是合成的测试数据**，不描述真实人物、患者、
实验、机构或已发表研究。详见 [docs/sample-data-rights.md](docs/sample-data-rights.md)。

---

## 测试与检查

```sh
npm run check            # 密钥/隐私扫描 + 协议一致性
npm run check:secrets    # 只跑密钥与脱敏检查
npm run check:contract   # 只跑协议一致性检查
npm test                 # Agent + Web + VS Code 三套测试
npm run test:agent       # 本地 Agent（node:test）
npm run test:web         # 共享 Web UI（vitest）
npm run test:vscode      # VS Code 扩展（vitest）
npm run sbom             # 重新生成 sbom.spdx.json
```

`check:secrets` 会检查凭据形态**以及**本项目要求中性化的个人与基础设施标识。
如果你的改动意外引入了真实邮箱、姓名或域名，它会失败——请改成占位符，
而不是放宽规则。

依赖具体运行时的测试应说明**通过、跳过及环境**，不要把缺少 R/MATLAB 的跳过
记作验证成功。

### 常见问题

| 现象 | 排查方向 |
|---|---|
| 后端连不上 / Failed to fetch | 检查 `/health`、同源 API、登录会话、代理目标与证书；查看 Agent 日志 |
| WebSocket 失败 | 检查反向代理 Upgrade、会话身份与重连；**不要把令牌拼进 URL** |
| 中文显示方框 | 检查随包 `src/fonts/` 与沙箱字体挂载，查看缺字告警 |
| 图型或测量列不符 | 明确图型与列角色、误差口径，检查 sample/编号列及组编码 |
| 编辑代码无法执行 | 检查沙箱和语言依赖是否可用，**不要关闭隔离** |
| 代码更新后网页仍旧 | 核对提交与构建产物、浏览器缓存；`main` 更新不会自动重建旧包 |

---

## 许可、署名与第三方

### 许可范围

| 路径 | 许可 | OSI 开源？ |
|---|---|---|
| `apps/vscode/`、`apps/dsh/` | MIT | ✅ |
| `apps/web/`、`services/local-agent/` | 非商业使用与署名许可 1.0 | ❌ |
| `services/local-agent/src/fonts/` | OFL-1.1 | ✅ |
| 第三方组件 | 各自原许可 | — |

**兼容性要点：**

- **MIT 与非商业许可可以共存**于同一仓库的不同原创部分，互不“传染”。
- **Noto Sans CJK SC** 是 OFL-1.1，即使你按 MIT 使用适配层，字体仍只受 OFL 约束。
- **ggsci 色板**上游是 GPL-3.0。本项目**不复制其代码**，只引用配色数值并注明
  出处；`ggsci_*` 预设相互独立，若你的合规政策要求最保守立场，删除它们不影响
  其余功能。判断依据与提示见 [docs/licensing.md §4.3](docs/licensing.md#43-ggsci-的-gpl-30-与隔离措施)。
- **历史 Apache-2.0 代码**不追溯撤销：2026-10-09 之前发布的版本仍可按
  Apache-2.0 使用（含商业用途）；此后新增的原创修改与整体发行适用非商业许可。
  Apache-2.0 全文保留在根 `LICENSE` 附录与
  [docs/licenses/Apache-2.0-legacy.txt](docs/licenses/Apache-2.0-legacy.txt)。

### 商业授权

[仓库 Issues](https://github.com/ustinian-T/SPARK-SIGHT-plugin/issues) 联系维护者并说明用途。
**不要在该渠道提交密码、密钥或私有数据**；联系本身不构成授权。

### 怎样注明来源

> 基于灵感视界 SPARK SIGHT / Deep Imaging，来源：https://github.com/ustinian-T/SPARK-SIGHT-plugin；
> 非商业使用与署名许可 1.0；版本/提交：实际版本。

论文放方法/致谢/工具说明，教学材料放说明页，**不要求每张图加水印**。
再分发源码或二进制时保留 `LICENSE`、`NOTICE.md` 与必要的第三方声明，
并说明作者、日期与具体修改。仅使用以 MIT 发布的适配层代码时，遵守 MIT 的
保留声明要求即可。

### 第三方

完整清单见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与
[docs/third-party-resources.md](docs/third-party-resources.md)；
机器可读清单由 `npm run sbom` 生成（`sbom.spdx.json`）。

主要第三方：React（MIT）、Vite（MIT）、Vitest（MIT）、TypeScript（Apache-2.0）、
Noto Sans CJK SC（OFL-1.1）、DeepSeek Harness / `@deepseek-ai/cordis`（MIT）。
Python/matplotlib、R、MATLAB、Node.js 与云模型服务**均不随本仓库分发**，
使用者自行安装并遵守其各自许可或服务条款。

---

## 贡献与安全

- 提交前阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，并确认你的改动落在哪个许可目录。
- 提交前请跑通 `npm run check && npm test`。
- **不要为安全漏洞开公开 Issue**，按 [SECURITY.md](SECURITY.md) 的私密渠道报告。

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/licensing.md](docs/licensing.md) | 许可范围、兼容性分析、常见问题 |
| [docs/privacy-and-redaction.md](docs/privacy-and-redaction.md) | 脱敏处理记录与复核方法 |
| [docs/third-party-resources.md](docs/third-party-resources.md) | 第三方资源详细清册 |
| [docs/architecture.md](docs/architecture.md) | 仓库结构、分层、打包装配流程 |
| [docs/sample-data-rights.md](docs/sample-data-rights.md) | 样例数据权属 |
| [apps/vscode/README.md](apps/vscode/README.md) | VS Code 扩展说明、命令与审阅流程 |
| [apps/dsh/README.md](apps/dsh/README.md) | DSH 插件说明、Stage 架构与配置 |
| [apps/web/README.md](apps/web/README.md) | 共享 Web UI |
| [services/local-agent/README.md](services/local-agent/README.md) | 本地 Agent API 与运行方式 |
