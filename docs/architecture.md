# 仓库结构与架构

本页说明仓库布局、两个插件如何工作，以及共享代码是如何被打包进去的。

## 1. 仓库布局

```
.
├── apps/
│   ├── web/                  # 共享 Web UI（React + Vite）          [非商业许可]
│   ├── vscode/               # VS Code 扩展适配层                    [MIT]
│   │   ├── src/              # extension / hostBridge / patchReview / runtimeRunner / updater
│   │   ├── test/             # vitest 单元测试
│   │   ├── media/            # 扩展图标
│   │   └── scripts/          # prepare-package.mjs（打包前装配）
│   └── dsh/                  # DeepSeek Harness 插件适配层           [MIT]
│       ├── index.js          # Host 半：sidecar 生命周期 + 同源路由
│       ├── client.js         # Client 半：Module Loader 工厂 + 输入框按钮
│       ├── lib/              # sidecar.js / updater.js / paths.js
│       ├── locale/           # en.json / zh.json
│       └── scripts/          # prepare-dsh.mjs（打包前装配）
├── services/
│   └── local-agent/          # 共享本地 Agent（零运行时依赖）        [非商业许可]
│       ├── src/              # HTTP/WS 服务、统计、代码生成、沙箱、决策、记忆
│       └── test/             # node:test 单元与集成测试
├── contract/
│   └── host-protocol.schema.json   # 宿主协议权威定义
├── docs/                     # 许可、隐私、第三方清单、架构
├── scripts/                  # 仓库级检查与 SBOM
└── package.json              # 工作区命令入口
```

## 2. 两个插件共同的分层

两个插件都是**薄适配层 + 共享后端**的结构：

```
┌──────────────────────────── 宿主（VS Code / DeepSeek Harness）────────────────────────────┐
│                                                                                            │
│  ┌── 适配层（MIT，本仓库 apps/vscode 或 apps/dsh）──────────────┐                          │
│  │  · 在宿主中注册命令 / 注入按钮 / 打开 webview 或 Stage       │                          │
│  │  · 启动并守护 sidecar（boot token、/health 就绪、进程树回收）│                          │
│  │  · 宿主桥：把 webview 的调用转发给本机 Agent                 │                          │
│  │  · VS Code 额外负责：选区读取、补丁审阅、脏文件保护、更新校验│                          │
│  └───────────────────────────┬──────────────────────────────────┘                          │
│                              │ spawn (127.0.0.1, 随机端口 + 随机 token)                    │
│  ┌───────────────────────────▼──────────────────────────────────┐                          │
│  │  共享本地 Agent（非商业许可，services/local-agent）           │                          │
│  │  · HTTP + 自实现 RFC6455 WebSocket，仅绑定 127.0.0.1         │                          │
│  │  · CSV/Excel 解析、统计与误差口径、ChartSpec 变换            │                          │
│  │  · 三方案决策、Python/R 代码生成、沙箱执行、独立验证         │                          │
│  │  · 同源托管共享 Web UI 的构建产物（静态资源免 token）        │                          │
│  └───────────────────────────┬──────────────────────────────────┘                          │
│                              │ iframe / webview 加载                                        │
│  ┌───────────────────────────▼──────────────────────────────────┐                          │
│  │  共享 Web UI（非商业许可，apps/web）                          │                          │
│  │  · 工作台界面、项目管理、图表编辑、导出                       │                          │
│  │  · 通过宿主桥拿到 baseUrl + boot token，之后直接与本机 Agent  │                          │
│  │    通信（projects / tasks / WS 事件 / preview / export）      │                          │
│  └───────────────────────────────────────────────────────────────┘                          │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

**关键设计：**

- **本地优先。** Agent 只绑定 `127.0.0.1`，每次启动生成随机 token，
  `Authorization: Bearer <token>` 鉴权，WebSocket 在握手后认证，**token 从不进 URL**。
- **同源托管。** Web UI 由 Agent 同源提供，因此不需要为静态资源设计跨源策略；
  跨源只出现在宿主页与 iframe 之间，方向与 origin 都受控。
- **零运行时依赖。** Agent 只用 Node 内置模块，插件包不需要 `node_modules`。
- **诚实的降级。** 缺失 Python / R / MATLAB 时报告为不可用，不伪装成执行成功。

## 3. 共享代码如何进入插件包

`apps/vscode/` 与 `apps/dsh/` **不复制** Agent 与 Web UI 的源码；打包时由脚本装配。
这也是本仓库中这两个目录看起来“缺少”后端的原因。

### VS Code 扩展

`apps/vscode/scripts/prepare-package.mjs`：

```
apps/web/dist/            →  apps/vscode/web/dist/
services/local-agent/src/ →  apps/vscode/agent/src/
services/local-agent/package.json → apps/vscode/agent/package.json
根 LICENSE / NOTICE.md    →  apps/vscode/
（可选）desktop 运行时     →  apps/vscode/runtime/{node,python}
```

### DeepSeek Harness 插件

`apps/dsh/scripts/prepare-dsh.mjs`：

```
services/local-agent/src/  →  apps/dsh/resources/agent/src/   （仅 .js/.json/.otf/.ttf/.txt/.md/.conf）
services/local-agent/package.json → apps/dsh/resources/agent/package.json
apps/web/dist/             →  apps/dsh/resources/web/dist/
根 LICENSE / NOTICE.md     →  apps/dsh/resources/PROJECT-LICENSE / PROJECT-NOTICE.md
（可选）desktop 运行时      →  apps/dsh/resources/runtime/python/
```

装配脚本会拒绝符号链接，并跳过 `.data`、`.env`、`projects`、`tasks`、
`verified-updates`、`__pycache__` 与 `*.pem/.key/.pfx/.p12/.jks/.crt`
等敏感路径——**打包路径本身也做了防泄漏处理**。

> 装配产物目录（`apps/vscode/agent/`、`apps/vscode/web/`、`apps/dsh/resources/`）
> 已在 `.gitignore` 中排除，属于构建产物，不入库。

## 4. 协议

`contract/host-protocol.schema.json` 是宿主协议的**权威定义**：协议版本、
消息类型、Agent 状态机、宿主错误码、后端错误码与导出必备内容。

`apps/web/src/host/protocol.json` 与 `apps/vscode/src/protocol.json` 是各客户端的
声明副本，`npm run check:contract` 会校验它们与权威定义一致，防止协议漂移。

## 5. 数据落地位置

| 宿主 | 项目/任务/数据 | 说明 |
|---|---|---|
| VS Code 扩展 | `context.globalStorageUri/agent-data` | 由扩展存储目录决定 |
| DSH 插件 | `LOCAL_AGENT_DATA_DIR` | 由插件 `config.dataDir` 或 Agent 默认值决定 |

两者都通过 `LOCAL_ONLY_MODE=1`、`REMOTE_MODE=0` 关闭云同步与远程分享。
模型调用需要联网，发送的提示与必要字段摘要遵循所选提供商政策。
