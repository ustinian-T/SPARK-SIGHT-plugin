# 科研绘图辅助智能体 · Web 端（@deep-imaging/web）

“一核三端”共享 Web UI 的网页端实现：上传数据 → 数据体检 → 可观察的 Agent 规划 → 三候选方案并排比较 →
三引擎源码与错误定位 → 受控可视化编辑（SpecPatch 反向生成最小代码 Diff）→ 证据与偏好 → 导出。
桌面端（Tauri 壳）与科研软件插件（webview）复用同一套 React 组件与任务协议。

当前默认运行**浏览器内 Mock Agent 运行时**：用符合任务协议的 Mock 客户端真实驱动
状态机、CSV 体检、三方案生成与一次依赖错误自纠错；同时已内置可直接切换的真实后端客户端
`RealAgentClient`（对接 `services/local-agent`，见下文“替换为真实 Agent”）。

## 技术栈

- Vite 5 + React 18 + TypeScript 5
- 运行时依赖仅 `react` / `react-dom`；不引入重型 UI、图表或图标库
- 主题（浅绿 + 液态玻璃）与全部图表（SVG）均手写，便于三端一致与离线运行

## 快速开始

```bash
npm install        # 安装依赖
npm run dev        # 本地开发，默认 http://127.0.0.1:5180
npm run build      # 类型检查 + 生产构建（tsc --noEmit && vite build），产物在 dist/
npm run preview    # 预览生产构建
```

要求 Node 18+（开发环境为 Node 22 / npm 10）。

## 目录结构

```
apps/web
├─ index.html
├─ src
│  ├─ main.tsx                 入口
│  ├─ App.tsx                  IDE 式多栏布局、视图路由、?demo 走查
│  ├─ types/index.ts           领域类型：12 态、ChartSpec 六层、PlotPlan、TaskEvent 协议
│  ├─ lib
│  │  ├─ csv.ts                CSV 解析与分隔符/编码探测
│  │  ├─ summarize.ts          列画像（缺失率、唯一值、范围、均值、类型推断）
│  │  ├─ codegen.ts            Python / R / MATLAB 三引擎代码生成
│  │  ├─ patch.ts              SpecPatch → 最小 unified diff（可映射项）/ 代码主导模式
│  │  └─ format.ts             数值/指纹/编号等格式化
│  ├─ mock
│  │  ├─ sample.ts             内置合成示例 CSV（仅演示，非真实实验结论）
│  │  └─ plans.ts              三候选方案（清晰优先 / 惯例优先 / 信息密度优先）
│  ├─ client/agentClient.ts    AgentClient 协议 + MockAgentClient；末尾附真实后端端点约定
│  ├─ state/store.tsx          Context + Reducer：任务状态、偏好、补丁、视图
│  ├─ styles                   tokens.css（主题/玻璃令牌）、app.css（布局与组件样式）
│  └─ components               18 个组件：标题栏/活动栏/侧栏/对话/时间线/比较/代码/
│                              检测器/证据/偏好（左侧固定导航进入主工作区）/补丁弹窗/控制台/状态栏/图表预览 等
└─ dist                        生产构建产物
```

## 功能闭环（对应需求条目）

- **WEB-001** 网页独立闭环；**WEB-002** 实时步骤、工具节点、重试与取消（12 态状态机 + 时间线 + 控制台）
- **WEB-003 / CORE-021** 三方案并排、缩略图放大、六维效用评分与 MMR 差异化维度
- **WEB-004** 三引擎源码高亮、依赖清单、错误行高亮与错误定位
- **WEB-005 / CORE-002** 侧栏数据体检：编码/分隔符/字节数/内容指纹、逐列缺失率/唯一值/范围均值、列类型可手动修正；24h 清理提示
- **WEB-009** 六层（Figure/Panel/Layer/Scale/Legend/Annotation）受控编辑 → SpecPatch：
  可安全反推的属性给出最小 unified diff，无法安全反推的高自由度属性（如颜色）进入“代码主导模式”，
  仅即时更新预览并提示，不静默改写源码；补丁可预览、接受并重新验证、撤销
- **WEB-010** 多轮反馈、版本与偏好（权重与时间窗衰减、可暂停学习、可查看依据、可重置），偏好绝不静默改图
- **CORE-020** 每方案含预览、说明、源码、引擎、依赖与数据处理摘要
- 证据面板：描述统计、分位数、相关、OLS、置信区间、效应量和前提受控显著性结论共享 EvidenceLedger（相关 ≠ 因果）
- 状态栏呈现沙箱、禁网、资源配额、内容指纹与自纠错次数

## Mock 运行时与数据声明

- `MockAgentClient` 在浏览器内按任务协议异步派发 `TaskEvent`，覆盖完整 12 态；
  在执行阶段注入一次 `plan_convention.py:3 ModuleNotFoundError: No module named 'seaborn'`，
  归一化为 DEPENDENCY 错误后回退 Matplotlib 内置实现并重试成功，用于演示自纠错闭环。
- 内置 CSV（`src/mock/sample.ts`）与三方案、评分、证据均为**合成示例数据**，仅用于演示与走查，
  不代表任何真实实验结论。
- 需求过短（少于 6 个字符）会进入 NEED_INPUT，给出澄清选项。

## 替换为真实 Agent

`src/client/realAgentClient.ts` 已实现与 `MockAgentClient` 相同调用面的真实客户端
（multipart 上传、WS 连接即重放 + 断线重连、澄清应答、方案选择/切回、拒绝、反馈多轮迭代、preview、trace、ZIP 导出、删除）。
调用流程：`start()` 只创建任务并返回 `{taskId}`，随后 `subscribe(onEvent)` 建立 WS（保证先建任务再收事件），
`getSnapshot()` 拉取快照。正式网页始终连接当前站点同源的服务器 API；后端不可用时显示真实错误，不回退到 Mock。
真实后端端点（`services/local-agent`，v0.3.0）：

```
GET    /health                       健康检查（含持久化与恢复任务数）
GET    /api/capabilities             本机解释器真实探测
POST   /api/tasks                    创建任务（multipart：CSV + prompt + engine）
GET    /api/tasks/:id                任务快照（含 planVersions PlotRevision 谱系）
WS     /api/tasks/:id/events         订阅 TaskEvent（连接即从 seq=0 重放）
POST   /api/tasks/:id/answer         NEED_INPUT 应答
POST   /api/tasks/:id/select         选择方案（置顶，其余两套保留为可恢复分支，进入 ITERATE）
POST   /api/tasks/:id/feedback       自然语言反馈重规划（202；生成新 PlotRevision，旧版本不覆盖）
POST   /api/tasks/:id/replan         /feedback 的等价别名
POST   /api/tasks/:id/complete       确认冻结 → COMPLETE 终态（幂等）
POST   /api/tasks/:id/preferences    拒绝方案与六维偏好反馈（select_plan 为 /select 别名）
GET    /api/tasks/:id/preview        真实渲染产物（SVG 全文 + PNG 元数据）
GET    /api/tasks/:id/export         复现 ZIP（导出即幂等进入 COMPLETE）
GET    /api/tasks/:id/trace          执行 trace（时间线、错误签名、验证、偏好、revisions、产物）
DELETE /api/tasks/:id                删除任务（内存+磁盘立即不可访问；幂等，重复删除 200 existed:false）
```

网页由部署网关把 `/api/*`、`/health` 和 WebSocket 转发到服务器 Agent；模型 API 在管理员控制台保存于服务器，管理员可按用户授权自填或使用统一配置。桌面端与 VS Code 插件通过宿主桥接连接各自本机 Agent，不受网页同源路由影响。后端真实载荷与前端类型的一致性由
`services/local-agent` 的 `npm run contract`（真实响应 → 契约快照 → tsc 校验）守护。

## 测试构建走查参数

仅显式设置 `VITE_TEST_WEB=1` 的测试构建允许走查参数；正式站点不能用 URL 参数跳过登录：

```
?demo=1                              默认进入三方案比较并选中方案一
&view=compare|code|chat              定位主视图（code 默认选中方案二）
&select=plan_clarity|plan_convention|plan_density   指定选中方案
&right=inspector|evidence|preferences               兼容旧走查参数，打开相应工具工作区
&console=1                           展开运行日志控制台
&patch=title                         自动发起一次图标题补丁（最小 Diff）
&patch=color                         自动发起一次颜色补丁（代码主导模式）
&prompt=...                          自定义需求文本
```

## 三端复用

- 网页端即本工程；
- 桌面端用 Tauri 壳加载本构建产物，文件与本地 Agent 走 Tauri sidecar；
- 科研软件插件以 webview 承载同一产物，通过 `postMessage` / 注入式 `AgentClient` 桥接宿主能力。
- 布局以 1280px 以上桌面优先，窄屏降级为可查看模式。

## 能力边界

- 安全反向映射的修改回到 ChartSpec；无法确定映射的修改进入显式代码主导模式。任意用户代码只能在声明并强制 OS 级隔离的强沙箱中执行。
- Web 只生成 MATLAB 源码，不上传或执行 MATLAB；Desktop/VS Code 宿主可对受信任项目内 `.m` 文件调用用户自有许可的本地 MATLAB。
- 远程服务的认证、租户隔离、续传、限流与签名下载已有部署实现，但仓库不声称已部署公网实例。

## 工作区布局与滚动

右栏及其收起按钮已移除，检测器、证据和偏好作为主视图固定在左侧竖栏。项目与数据侧栏可独立收起；窄屏采用左侧抽屉。主工作区使用受约束的 flex 高度，各长内容区允许滚动；导航在矮窗口下可滚动，不让底部设置入口被裁掉。检测器规格树和表单在小屏下上下排列。

使用许可与署名见根目录 [LICENSE](../../LICENSE) 及 [许可指南](../../docs/licensing.md)。
