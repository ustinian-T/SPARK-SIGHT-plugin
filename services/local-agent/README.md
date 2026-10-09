# local-agent · 科研绘图辅助智能体本地服务

依据《产品需求文档 V1.1》《算法设计说明书 V1.0》《系统架构设计说明书 V1.0》实现的**本地 Agent 后端闭环**：
接收 CSV + 自然语言需求，真实完成数据接入、体检、确定性统计、证据绑定、三套方案生成，
并生成 Python/R/MATLAB 源码；Python 由核心真实渲染，MATLAB 仅在用户授权的本地 Desktop/VS Code 宿主执行，R 在可用时执行，不可用时诚实降级。
核心产出 SVG/PNG/PDF、独立验证并按错误签名自动修复，
通过版本化 HTTP + WebSocket 向前端推送与 `apps/web/src/types/index.ts` 兼容的任务快照与结构化事件。

> 当前版本 **v0.4.1**：12 态状态机全部打通
> `INGEST → UNDERSTAND →（NEED_INPUT）→ PLAN → ANALYZE → DESIGN → EXECUTE →（REPAIR ⇄ EXECUTE）→ VERIFY → PRESENT →（ITERATE…）→ COMPLETE`，
> 失败终止于 `FAILED`；支持 answer / select / feedback（PlotRevision 版本谱系）/ complete 与幂等 DELETE。
>
> **v0.4.0 新增**：绘图前 ≥3 轮需求澄清（图型任务 → 图型偏好 → 标题/图注/排版，无要求按科研制图默认执行）、
> 热力图增强（蓝白红发散、相关性矩阵标注）与双Y轴图/三维曲面图/三维散点图三引擎模板、
> 配色学习（开源算法/公开期刊色系 + 用户历史偏好有界先验注入推荐）、
> 《数模国赛MATLAB制图规则 v0.4》通用精华规则库、独立数据/规格验证与最终渲染质检。
>
> **v0.4.1 新增**（通用科研绘图场景，不限于数模）：
> ① 长表分组形态自动识别（分组列 + 数值列 → 组均值 ± 标准误误差棒 + 95% 置信带 + Holm 校正后显著性星号标注，
> Python/R/MATLAB 三引擎同步；默认口径=标准误，可切换 sd/se/ci）；
> ② 统计推断扩展（独立样本 t 检验默认 Welch、单因素 ANOVA 含 η²、显著性星号分级、宽表系列间两两近似比较，
> 全部绑定证据账本并受 ClaimVerifier 门禁；evidence 含 `mean1/mean2/p_adjusted` 供 claim 数字溯源）；
> ③ 图表解读文案（出图后自动生成结构化解读要点 + 可改写论文分析段落 + 图注建议，数字全部可溯源到证据、
> 缺证据不编造，前端一键复制）；
> ④ 编辑即重渲染（迭代路径 spec/source/preset 一律走 spec 驱动重新生成代码 → 沙箱执行 → 独立验证与渲染质检，
> 图表随修改即时变化）。

---

## 1. 技术选型与理由

**零运行时依赖，仅使用 Node.js 内置模块**（Node ≥ 20，开发环境 Node 22 验证）：

| 能力 | 选型 | 理由 |
| --- | --- | --- |
| HTTP 服务 | `node:http` | 接口数量有限，无需 Express 路由与中间件生态，零安装即可运行 |
| 实时事件 | 手写最小 **RFC 6455 WebSocket**（`node:crypto` 握手 + 帧编解码，见 `src/ws.js`） | 架构 ADR-03 选定“版本化 HTTP + WebSocket”；事件均为小 JSON，不需要 `ws` 依赖；零依赖便于离线环境与安全审计 |
| multipart 上传 | 手写 `multipart/form-data` 解析（`src/multipart.js`） | 文件必须保留**原始字节**用于编码探测与 SHA256 指纹，不依赖 busboy/formidable |
| 沙箱执行 | `child_process.spawn` + 每任务/方案/尝试独立工作目录 | 真实调用本机 python/R/MATLAB；无容器依赖，桌面环境可直接运行 |
| ZIP 导出 | 零依赖实现（CRC32 + zlib deflateRaw，`src/zip.js`） | 代码导出 zip 无需引入 archiver/jszip |
| 文件持久化 | JSONL 事件日志 + 数据/产物落盘（`src/storage.js`） | 重启后通过事件重放恢复任务，无需数据库 |
| 自动化测试 | 内置 `node:test` + `node:assert` | 无需安装 Jest/Vitest，`npm test` 直接运行 |

零依赖的核心原因：① 离线环境也能 `npm start` / `npm test`；② 本地 Agent 处理用户数据，
最小依赖面最符合架构“安全与合规优先”原则；③ 协议保持稳定，后续可平滑替换为 Express/ws。

---

## 2. 安装、启动、测试

```bash
cd services/local-agent

npm install        # 无运行时依赖，可跳过
npm start          # 启动服务；默认随机端口、随机启动令牌，启动横幅打印实际地址与令牌
npm test           # 串行运行全部自动化测试（单元/接口/执行/持久化/平台扩展/LLM/契约/决策/集成/安全/容量/并发隔离）
npm run eval:decision  # 决策算法评测基线（评分/MMR/偏好），输出 eval/*.json、eval/*.csv
npm run eval:product   # 20 件产品量化验收基线
npm run test:capacity:heavy # 可选 50MB/100 万行容量重测
npm run smoke:matlab  # 用户已授权 MATLAB 的真实生成码冒烟
npm run contract   # 真实跑 select/feedback/complete 全流程，重新生成跨端契约 fixtures 并过前端 tsc
npm run smoke      # 端到端冒烟（创建→执行→验证→预览→导出→trace）
```

渲染依赖（Python 引擎，本机已验证）：Python 3.10+ + matplotlib（pandas/numpy 缺失时自动降级为标准库模板）。

启动横幅示例：

```
[local-agent] research-plotting local agent started (v0.4.0)
[local-agent] HTTP  http://127.0.0.1:5181/health
[local-agent] WS    ws://127.0.0.1:5181/api/tasks/:id/events?token=<TOKEN>
[local-agent] TOKEN 8f3c...
[local-agent] persist .data (restored 0 tasks)
```

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `LOCAL_AGENT_HOST` | `127.0.0.1` | 仅绑定回环地址，不监听 0.0.0.0（DESK-009） |
| `LOCAL_AGENT_PORT` | `0`（随机端口） | 可固定如 `5181` |
| `LOCAL_AGENT_TOKEN` | 每次启动随机生成 | HTTP 用 `Authorization: Bearer <TOKEN>`（也支持 `x-agent-token`），WS 用 `?token=` |
| `LOCAL_AGENT_STEP_DELAY` | `40`（ms） | 状态机步骤间隔，测试中设为 1 |
| `LOCAL_AGENT_MAX_BYTES` | `62914560`（60MB） | 上传体积上限（NFR-P01 单 CSV ≤ 50MB + 余量） |
| `LOCAL_AGENT_PERSIST` | `1` | 文件态持久化开关；设为 `0` 时纯内存态、不创建数据目录 |
| `LOCAL_AGENT_DATA_DIR` | `<cwd>/.data` | 持久化根目录 |
| `LOCAL_AGENT_ENABLE_MATLAB` | 未设置 | 设为 `1` 才允许真实调用 MATLAB（许可证需用户自有，未授权时自动切 Python） |
| `LOCAL_AGENT_LLM_BASE_URL` / `LOCAL_AGENT_LLM_API_KEY` / `LOCAL_AGENT_LLM_MODEL` | 模型默认 `ark-code-latest` | Agent Plan/OpenAI/Anthropic 兼容意图解析；URL 或密钥未配置、或认证失败时使用确定性规则 |
| `LOCAL_AGENT_LLM_PROTOCOL` | Agent Plan OpenAI 默认 `responses` | 可显式设为 `responses` 或 `chat_completions`；Anthropic provider 固定使用 Messages API |
| `LOCAL_AGENT_SANDBOX_TIMEOUT_MS` | `30000` | 单次沙箱执行超时；超时杀整个进程树并进入修复/失败流程（低性能机器可调大） |
| `REMOTE_MODE` / `REMOTE_AUTH_SECRET` / `REMOTE_USERS_JSON` | 关闭 | 开启租户会话、配额、断点上传和签名下载；生产建议使用 `deploy/docker-compose.yml` |

---

## 3. HTTP / WebSocket 协议（v1，服务 v0.4.0）

所有受保护接口需携带令牌；请求/响应均为 JSON；响应头统一带 `X-Agent-Protocol: 1`。
请求头携带不兼容的主版本号返回 `409 PROTOCOL_MISMATCH`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查（无需令牌）：`{status, service, version, protocol, time, persist, restoredTasks}` |
| GET | `/api/capabilities` | 真实探测本机 python / R / MATLAB 及绘图依赖可用性 |
| POST | `/api/tasks` | `multipart/form-data`：字段 `file`（CSV）、`prompt`、`engine`；可选 `clarify=true` 启用绘图前多轮需求澄清、`clarifyAnswers`（JSON）预填已答轮次；成功 `201 {taskId, state}` |
| GET | `/api/tasks/:id` | 任务快照，结构与前端 `AgentTask` 兼容（含 plansVersion / planVersions / planArtifacts / verification / restored） |
| WS | `/api/tasks/:id/events?token=` | 任务事件流，消息与前端 `TaskEvent` 联合类型兼容 |
| POST | `/api/tasks/:id/answer` | NEED_INPUT 澄清应答：`{answer}`；非等待状态 `409 TASK_NOT_WAITING`，终态 `409 TASK_TERMINAL` |
| POST | `/api/tasks/:id/select` | 选择方案：`{planId, weight?, scope?}`；被选方案置顶、发 `preference` + ITERATE，**其余两套方案原样保留为可恢复分支**；200 返回当前方案集与排序 |
| POST | `/api/tasks/:id/feedback` | 自然语言反馈：`{feedback, planId?}`；置 ITERATE 并异步重走 DESIGN→EXECUTE→VERIFY→PRESENT，`202 {revision:'new'}`；空反馈 400，迭代进行中 `409 TASK_BUSY` |
| POST | `/api/tasks/:id/replan` | `/feedback` 的等价别名（旧客户端兼容） |
| POST | `/api/tasks/:id/complete` | 用户确认：冻结版本、进入终态 `COMPLETE` 并发 `done`；幂等；COMPLETE 后所有变更类请求 `409 TASK_TERMINAL`（GET/preview/export/trace 只读可用） |
| DELETE | `/api/tasks/:id` | 删除任务：立即从内存与磁盘移除（原始 CSV、runs 全部产物）并关闭事件连接。**幂等**：首次 `200 {existed:true,deleted:true,deletedAt}`；重复/不存在 `200 {existed:false,deleted:false,code:'TASK_NOT_FOUND'}`；删除后 GET 404、WS 握手 404 |
| POST | `/api/tasks/:id/preferences` | 偏好反馈：`{kind, planId?, strength?}`（select_plan / reject / chart_type / color / density / annotation 等六维权重）；`select_plan` 为 `/select` 别名，终态后 409 |
| GET | `/api/preferences` | 全局偏好快照：`{paused, events}`（含 `paletteId` 的配色事件用于画像重建） |
| GET | `/api/preferences/colors` | 配色学习画像（优化 1）：`{summary, eventCount, paletteStats, eventIds}`，仅统计未撤销配色事件 |
| DELETE | `/api/preferences/colors` | 重置配色学习（优化 1）：仅清 `paletteId` 事件（含已撤销），保留其他偏好；返回 `{removed, events, paused}` |
| GET | `/api/tasks/:id/preview?planId=` | 真实渲染产物：SVG 全文 + PNG 元数据（默认取选中方案/首个 verified 方案） |
| GET | `/api/tasks/:id/export?planId=` | 复现 ZIP：三引擎源码、data.csv、ChartSpec.json、证据（JSON+MD）、README、SVG/PNG/PDF；**导出即确认**，会先幂等进入 COMPLETE 冻结 |
| GET | `/api/tasks/:id/trace` | 单任务执行 trace：状态时间线、步骤、证据 id、retries、错误签名、验证、偏好、**PlotRevision 版本谱系**、产物、指纹、耗时 |
| GET | `/api/traces` | 任务 trace 列表（验证状态、指纹、事件计数） |
| GET/POST | `/api/projects` | 保存并列出项目；`GET /api/projects/:id` 重新打开任务与数据包 |
| PUT/POST | `/api/projects/:id/locks`、`/sync` | 锁定数据处理步骤；执行带版本冲突检测的云同步 |
| POST/DELETE | `/api/projects/:id/shares` | 创建或撤销限时只读分享；公开读取使用 `/api/shares/:token` |
| GET/POST | `/api/projects/:id/comments` | 完整批注与经方法/p 值/alpha 校验的显著性标记 |
| WS | `/api/projects/:id/collaboration?token=` | 项目协作快照、在线状态与批注实时事件 |
| POST | `/api/tasks/:id/plans/:planId/variants` | 基于原方案生成两个不可变、可审阅且重新生成代码的变体 |
| POST | `/api/merge` | `base/current/incoming` 三方逐行合并，逐项返回冲突 |
| GET/POST | `/api/plugins[/category]` | 图型、样式、引擎、工具与数据格式插件元数据注册表 |
| GET/POST | `/api/remote-nodes` | 注册远程 R/MATLAB 授权节点；`/:id/check` 健康检查，凭据只读环境变量 |
| POST | `/api/tasks/:id/source/preview` / `source/apply` | 源码映射预览与重新执行；任意自定义代码需强沙箱 |
| POST | `/api/tasks/:id/data/preview` / `data/apply` | 列类型更正或数据替换，风险项需确认并保留版本谱系 |
| POST | `/api/tasks/:id/styles/apply` | 应用 6 套科研样式预设并生成可撤销修订 |
| POST/GET/PUT | `/api/uploads...` | 远程模式分块续传、状态和从已完成上传创建任务 |
| POST | `/api/tasks/:id/export/sign` | 远程模式短时 HMAC 授权下载 URL |

### 状态机（12 态）与版本语义

- 状态：`INGEST → UNDERSTAND →（NEED_INPUT ⇄ answer）→ PLAN → ANALYZE → DESIGN → EXECUTE
  →（REPAIR ⇄ EXECUTE）→ VERIFY → PRESENT →（ITERATE → DESIGN…）→ COMPLETE`；异常终态 `FAILED`。
  终态只有 `COMPLETE` / `FAILED`，终态后不再产生任何状态事件。
- `PRESENT` 是“等待 SELECT/FEEDBACK”的非终态；`select` 与 `feedback` 进入 `ITERATE`（限定作用域重规划），
  feedback 重新执行验证后回到 PRESENT，并产出新的 PlotRevision。
- **PlotRevision 版本谱系**：每次 initial / feedback 的 `plans_ready` 都在 `planVersions` 留存不可变深拷贝
  （`version` 稠密递增、`at`、`reason`、`feedback`、`selectedPlanId`、当时三方案及其 verification）；
  偏好排序（reason=`preference`）只递增事件计数器 `plansVersion`、不生成修订版本；任何反馈都不覆盖旧版本。
  首轮结束为 v1（执行前）、v2（验证后）；一次 feedback 后追加 v3、v4。
- `execution.version` 记录执行轮次（首轮 1，每次 feedback 重执行 +1）。

### WebSocket 事件与重放语义

- 事件类型：`state_delta` / `step_update` / `evidence` / `log` / `plans_ready` / `execution_update` /
  `retry` / `preference` / `need_input` / `error` / `done`，字段与 `apps/web/src/types/index.ts` 一致（服务端额外携带单调递增 `seq`；`plans_ready` 额外携带 `reason` / `feedback` / `selectedPlanId`）。
- **连接即重放**：新连接先按 `seq` 补发全部历史事件，再接收实时事件；重连不会漏事件。
- 成功任务首轮事件序列：INGEST → UNDERSTAND →（NEED_INPUT）→ PLAN → ANALYZE → DESIGN（首次 `plans_ready`，reason=initial）→
  EXECUTE（每方案 `execution_update`，可修复失败先发 REPAIR 再回 EXECUTE 并发 `retry`）→
  VERIFY（二次 `plans_ready`，回填 verification/executionStatus）→ PRESENT → `done`。
  feedback 轮：ITERATE → DESIGN（reason=feedback）→ EXECUTE → VERIFY（reason=feedback）→ PRESENT → `done`；
  select：`preference` + `plans_ready`（reason=preference）+ ITERATE，不发 `done`；
  complete/export：`preference(export)` + COMPLETE + `done`。
- 握手失败直接返回 HTTP 状态：无/错令牌 `401`，未知/已删除任务 `404`。

### 稳定错误响应

统一形状 `{ "error": { "code", "message", "details?" } }`，覆盖：空文件、二进制、编码不支持、
非表格/仅表头/重复列名、无数值列、缺文件/媒体类型错、非法 engine、未知字段（`UNKNOWN_FIELD`，任务 FAILED）、
未知任务（`TASK_NOT_FOUND`；DELETE 幂等时为 200 + `existed:false`）、非等待状态应答（`TASK_NOT_WAITING`）、
终态后变更（`TASK_TERMINAL`）、迭代进行中重复提交（`TASK_BUSY`）、方案不存在（`PLAN_NOT_FOUND`）、
产物不存在（`ARTIFACT_NOT_FOUND`）、沙箱执行全失败（`SANDBOX_EXECUTION_FAILED`）、
未授权（`UNAUTHORIZED`）、协议不符（`PROTOCOL_MISMATCH`）、体积超限（`PAYLOAD_TOO_LARGE`）。

---

## 4. 沙箱执行、验证与自动修复（EXECUTE / VERIFY / REPAIR）

### 4.1 执行

- 每个方案在独立工作目录（`.data/tasks/<id>/runs/<planId>/attempt-N/`，内存态时为系统临时目录）中运行；
  上传 CSV 以原始文件名落盘，三引擎脚本名固定为 `plot.py` / `plot.R` / `plot.m`。
- Python 使用 `Agg` 无界面后端，CJK 字体自动探测，共享 matplotlib 配置缓存目录；
  每个方案产出 SVG + PNG（convention 策略另产 300dpi PDF）。
- **静态安全扫描**在执行前拦截：网络/套接字、subprocess/os.system、shutil/rm、环境变量读取等违禁导入与调用
  （`SAFETY` 签名直接拒绝、不修复、不启动解释器）；工作目录隔离 + 超时（默认 30s）+ 输出体积上限。
  诚实声明：Windows 本地模式不声称 OS 级网络/资源隔离，仅执行 Agent 生成代码；用户自定义代码会返回 `STRONG_SANDBOX_REQUIRED`。`deploy/` 容器配置通过内部无外网网络与 CPU/内存/PID/tmpfs 限额启用强配置。
- R 不可用或 MATLAB 未授权（`LOCAL_AGENT_ENABLE_MATLAB` 未设置）时，对应方案记 `ENGINE` 签名并自动切换 Python 执行
  （方案仍保留 R/MATLAB 源码与引擎标注，仅执行引擎回退）。
- 沙箱执行成功后还要经过最终渲染质检：SVG 画布/绘图元素、PNG 实际尺寸、标题文字布局；Python/Matplotlib 的可修复布局问题会在 3 次预算内逐步增加标题安全区与导出留白并重新执行。
  质检耗尽仍失败时保留失败明细并标记为 `rendered_unverified`，不作为通过产物导出。

### 4.2 七类错误签名与修复预算

`FIELD / SYNTAX / DEPENDENCY / ENGINE / RENDER / RESOURCE / SAFETY`（`src/repair.js`）：

| 签名 | 自动修复策略 |
| --- | --- |
| FIELD | 从报错行抽取列名，按数据真实列名做精确/去空格/别名修正后重生成 |
| SYNTAX | 不做原样重试，回退到对应策略的已知良好模板重新生成 |
| DEPENDENCY（Python） | 切换**降级模板**：仅标准库 `csv` + matplotlib，不导入 pandas/numpy |
| DEPENDENCY（R/MATLAB）/ ENGINE | 切换 Python 引擎执行 |
| RENDER | 收敛画布：降低 dpi、关闭复杂特效后重试 |
| RESOURCE | dpi 每次下调 60（下限 80），减小渲染负载 |
| SAFETY | **不可修复**，直接拒绝 |

修复预算 **MAX_REPAIRS = 3**（初次执行后最多 3 次修复），每次修复都下发 `retry` 事件
（含 errorCategory / normalizedError / retries），禁止原样重试；进入修复前先发 `REPAIR` 状态、
重试前回到 `EXECUTE`。**停止策略（架构 6.3）**：同一错误签名连续出现 2 次即停止盲目重试
（修复未改变引擎与代码时签名追加 `.noop_fix`）；安全违规（SAFETY）不进入修复路径。

### 4.2.1 进程模型与并发控制（Windows 实测约束）

- 沙箱通过工作目录内的一次性 runner 脚本（`.cmd` / `.sh`）以 `stdio: ignore` + 输出重定向文件启动解释器，
  独立进程组（`detached`），退出后回收 stdout/stderr；超时用 `taskkill /T /F`（POSIX 为 SIGKILL）杀整个进程树。
  原因：本机 Node 22 + Windows 下，子进程管道句柄在解释器退出后仍可能残留，导致测试全绿后事件循环挂起。
- 进程内执行队列串行化所有沙箱运行：并发 matplotlib 进程会在共享字体缓存锁上互相饿死，
  桌面单机 Agent 不需要并行渲染；HTTP/WS 的任务处理仍并发，仅解释器执行排队。

### 4.3 独立验证与最终渲染质量门禁（VERIFY）

1. **产物存在与格式**：SVG 以 `<svg` 开头且含 `</svg>`；PNG 魔数 + 从 IHDR 解析真实宽高；PDF 魔数 `%PDF`。
2. **统计一致性**：验证器从**原始 CSV 独立重算**各系列均值，与代码所依据的描述统计证据 `ev_desc_i`
   比对（容差 1e-3），防止绘图代码引用了错误数据。
3. **跨方案独立性**：三方案 SVG 的 sha256 两两不同、PNG 尺寸至少 2 组不同、标题不同，防止“一份代码换皮”。
4. **科研制图规则符合性**（`src/plotRules.js`，提炼自《数模国赛MATLAB制图规则 v0.4》通用精华）：
   纯白底、正文最小字号 ≥10、禁用 jet/hsv/rainbow/turbo 彩虹色为**硬阻断**；
   标题/轴标签括号、同一样式跨方案复用次数（整篇同款式最多 2 次）等为建议级（warn），
   违规明细写入 `plan.verification.checks[].detail`，不阻断交付但随方案可审阅。
5. **最终渲染质量**：服务端阻断无有效 SVG 画布、缺少绘图元素、缺失/过低分辨率 PNG；浏览器预览再以原生 `getBBox()` 检查真实字体文本的越界和碰撞。
   标题/大字碰撞属于阻断项；普通刻度近似碰撞保留为建议，降低不同字体环境下的误报。
6. **质检闭环**：最终渲染阻断项会先触发 Matplotlib 确定性布局修复并重新绘制；只改边距/标题预留，不改数据、统计方法或图型。非 Python 引擎、不可安全修复或预算耗尽时诚实降级为未验证。
7. **图型语义与交付就绪度**：三维图要求三轴均有有效变化、显式按数据域限轴；森林图核验效应量字段与零效应线；热力图核验变量数量；小样本小提琴和极端双轴量程只作风险提示。最终 PNG 同时按 DPI、声明版面尺寸和像素内容检查。
8. **质量报告与回归门槛**：每套方案生成 `deep-imaging.quality.v1` 质量等级（`ready/review/revise/blocked`）、可解释的警告数与阻断数；导出包的 `quality-report.json` 会保留全部检查。自动化分数不覆盖硬错误，仍建议进行研究问题与叙事层面的人工复核。

方案级结果写入 `plan.executionStatus`：`verified` / `rendered_unverified` / `failed_execution`，
并挂 `plan.verification`（checks/artifactHash）；全部方案执行失败时任务 `FAILED / SANDBOX_EXECUTION_FAILED`。

### 4.3.1 绘图前多轮需求澄清（≥3 轮轮询，v0.4.0）

创建任务时携带 `clarify=true`，编排器在 UNDERSTAND 阶段先做确定性意图解析（字段映射），
随后按固定三轮与用户逐轮交互（每轮 `need_input` 事件携带 `round/total/key/options/hint`，`/answer` 应答）：

| 轮次 | key | 提问 | 解析 |
| --- | --- | --- | --- |
| 1 | `goal` | 图表任务与焦点（对比/趋势/相关/分布） | `parseGoal` |
| 2 | `chartType` | 图型偏好（热力图/双Y轴图/三维曲面图/三维散点图/常规图/自动） | `parseChartType` |
| 3 | `presentation` | 标题、图注、字体/字色/字号/字距、DPI、配色 | `parsePresentation`（键值对，如 `标题=…；图注=…；标题字色=#6E8FB2`） |

- **无要求按科研制图默认执行**：SimHei、标题 15pt 加粗居中（区间 14–16）、轴标签 12.5（12–13）、
  刻度 11、图例 11、图注 10.5、正文 ≥10pt、纯白底、300dpi、图注默认「图X-X 对象方法功能」。
- **预填跳过**：客户端随建任务提交 `clarifyAnswers={"goal":"trend","chartType":"dual_axis","answeredRounds":[1,2]}`
  可跳过已确认轮次，剩余轮次继续询问；三轮结果写入 `task.clarification`（快照可见），
  并驱动 `buildPlans`：用户指定图型强制进入对应策略代表（数据不满足时回退并在 `selectionAudit.clarification` 注明）。
- **第三轮结构化表单与推荐色板（优化 1+2）**：
  - 第 2 轮确定图型后，编排器经 `decorate` 钩子在第三轮 `need_input` 下发
    `recommendedPalettes`（top3，`{id,name,colors,reason}`）：综合**用户历史配色学习先验**（×2 权重）、
    **图型角色语义匹配**（heat/corr→发散、surface/3d/line/dual→连续、scatter/box/bar→分类，+0.8）与
    **色板感知质量**（minDeltaE/12，+0.5），按容量硬约束过滤后排序；理由首条标注“依据你的历史配色偏好动态调整”。
  - `parsePresentation` 增强：中文色板名（如「自然低饱和」）经 `resolvePaletteId` 唯一匹配为 id；
    「配色=推荐/自动」解析为**第一个推荐色板**；颜色键（标题字色/图注字色）仅接受 `#RGB/#RRGGBB`，
    非法 hex（如 `red`）**忽略并回落到排版默认**，防注入/错值；字距键兼容「标题字距/图注字距/全局字距」
    （全局键锚定行首/分隔符，不误匹配「标题字距/图注字距」）；第三轮推荐色板同步写入
    `task.clarification.recommendedPalettes` 供前端回显决策依据。
- 未启用 `clarify` 时保持既有行为（短 prompt 单问、长 prompt 直连），向后兼容。

### 4.3.1.1 分组形态统计推断、误差棒/置信带与解读文案（v0.4.1）

- **长表分组形态自动识别（`stats.summarizeGroups`）**：恰好一个数值列（排除 `_sd` 后缀列）+ 一个类别列
  （唯一取值 2~8 个）→ 判定为长表分组：逐组计算均值/标准差/标准误/95%CI，系列即「组均值 ± 标准误」
  （`y`/`yerr`/`n`/`sd`/`ciLow`/`ciHigh`）；多测量列宽表不误判（含备注类别列也不误判），保持宽表口径。
- **统计推断（`stats.js` 新增，均绑定证据账本）**：
  - `tTestIndependent`：默认 Welch，可选 pooled；p 值经不完全 beta 实现，对照 R 验证
    （`1,2,3 vs 4,5,6 → t=-3.674, df=4, p=0.0214`）；
  - `anovaOneWay`：SSb/SSw/F/p/η²（手算对照 `3,2,1/5,3,4/5,6,7 → F=12, p=0.008, η²=0.8`）；
  - `significanceStars`：`<0.001 *** / <0.01 ** / <0.05 * / ns`；
  - 长表分组：`ev_group_stats` + `ev_anova` + 两两 `ev_ttest_group_*`（**Holm-Bonferroni 校正**，图上星号基于校正后 p）；
    宽表多系列：两两 `ev_ttest_series_*`（独立近似口径，note 提示重复测量需复核，不输出因果）。
  - **ClaimVerifier 门禁**：t 检验 evidence value 含 `mean1/mean2/t/df/p/p_adjusted/stars`，
    claim 数字（均值与校正后 p）可在证据中溯源，缺失即拒绝发布（`CLAIM_UNVERIFIED`）。
- **误差棒/置信带/显著性标注（`codegen.js` spec 驱动分支）**：`spec.panel.groups={groupCol,measure}` 注入后，
  Python 走 `df.groupby(...).agg(mean/std/count/sem)` + `bar/errorbar(yerr=…)` + `fill_between` 置信带（line）
  + 括号+星号标注（基于 Holm 校正后 p）；R 走 dplyr `summarise` + `geom_errorbar`；MATLAB 走 `splitapply` + `errorbar`；
  `errorBarMode` 可切换 `sd/se/ci`（默认 `se`）；宽表 canonical 方案保持既有模板路径不变。
  **安全**：分组列名经引擎字面量转义；显著性配对以 JSON 字面量序列化（对象数组不能用 `pyList`）。
- **图表解读文案（`interpretation.js`，`plan.interpretation`）**：出图后自动产出
  `{insights:[{id,kind:trend|comparison|correlation|distribution|quality,title,text,evidenceId}], analysisParagraph, captionSuggestion}`；
  所有数字从证据取值、证据缺失不输出对应表述；分析段落收尾统一「仅描述观测结果，不代表因果」；
  图注建议自动追加 ANOVA/相关统计说明；前端 CompareView 渲染要点 + 可改写段落 + 图注建议并可一键复制。
- **验证器同步升级（`verify.js`）**：分组形态下从原始 CSV **独立重算每组的组均值**与 `series.y` 比对
  （series 标签是分组列取值而非列名）；宽表保持原逐系列校验；安全注入用例（指令文本仅作数据）全量回归通过。

### 4.3.2 配色学习与动态推荐（v0.4.0）- **色板库扩充**：在既有 12 套基础上新增 Nature 低饱和 9 色（`nature_lowsat`，六进制值与 v0.4 规则 §5.1 一致）、
  Okabe-Ito 色盲安全、Paul Tol bright/muted、viridis/magma 近似、brewer Set2；
  新增 `buildGradient` 生成三种规则梯度（蓝白红发散/相关、紫黄强度、蓝绿自然量，§5.2）。
- **学习模型**（`src/colorLearning.js`）：从偏好事件（select_plan=1.0 / set_default=0.8 / manual_edit=0.5 /
  browse=0.15 / reject=-0.9）在线学习，维护色板亲和、角色亲和（分类/连续/发散/成对）与图型-色板亲和三个视图；
  90 天半衰期时间衰减 + 置信度加权；结果经 tanh 有界（±1.5）作为**先验**注入 `recommendPalette`，
  与可读性/语义/容量等硬约束加权，绝不压过硬约束；推荐 reason 标注“依据你的历史配色偏好动态调整”。
- **规则引擎**（`src/plotRules.js`）：Nature 9 色、字号档、dpi 档（300–600）、禁彩虹色、
  主色上限 4、整篇同款式 ≤2 次、图注格式「图X-X …」无括号，供验证层与生成层共用。
- **撤销 / 重置闭环（优化 1+2）**：
  - `GET /api/preferences/colors`：由**未撤销**配色事件重建画像，返回
    `{summary:{topPalettes,topRoles}, eventCount, paletteStats:[{paletteId,name,positive,negative,total,lastAt}], eventIds}`，
    供前端偏好面板展示“为什么推荐这个色板”与逐色板正/负信号统计。
  - `DELETE /api/preferences/colors`：**重置配色学习**——仅移除携带 `paletteId` 的事件（含已撤销的），
    图型/排版等其他偏好保留，返回 `{removed, events, paused}` 快照；幂等。
  - **撤销即遗忘**：`colorLearning.learnFromEvent` 跳过 `reverted` 事件（修复：撤销后重建画像不再残留旧信号），
    单条撤销仍走既有 `DELETE /api/preferences/:eventId`，前端在 `revertPreference` 后同步刷新画像；
    已撤销事件不进入 `colorEvents()`（画像重建的事件源）。

### 4.4 安全基线（输入校验 / 路径隔离 / 环境与输出脱敏）

- **上传文件名净化（`safeCsvName`）**：multipart 中的文件名先取 basename（正反斜杠）、剥盘符与 UNC 前缀、
  NFKC 归一，再经白名单 `[A-Za-z0-9._-一-龥]` 过滤、`..` 收敛、强制 `.csv`、stem 限 80 字符；
  `../../x.csv`、`..\..\x.csv`、`E:\Windows\x.csv`、`/etc/passwd` 等穿越名无法逃逸任务工作目录。
- **路径片段校验（`assertSafeSegment`）**：taskId / planId / attempt / 产物名必须匹配安全段正则，
  读取产物时再做一次 `path.resolve` containment 检查，拒绝任何位于任务目录之外的路径（含 URL 编码穿越）。
- **代码生成字面量转义**：CSV 表头、文件名、prompt/feedback 派生出的标题、坐标轴名等进入三引擎源码前，
  分别按 Python/R（双引号转义反斜杠/引号/控制字符）与 MATLAB（单引号双写）规则转义；
  单元格中的公式注入（`=|@+cmd...`）与指令文本只作为**数据**读取，不进入代码、不被执行；
  静态安全扫描（`os.system`/`subprocess`/`eval` 等）保持启用，不因转义而放宽。
- **沙箱环境变量白名单**：子进程仅继承 PATH/TEMP/SYSTEMROOT 等运行必需变量，
  `*TOKEN*/*KEY*/*SECRET*/*PASSWORD*/*CREDENTIAL*/*COOKIE*` 及 `LOCAL_AGENT_*`/`LLM_*` 一律剔除。
- **输出与错误脱敏（`redactText`）**：沙箱 stdout/stderr、引擎探测路径、编排层错误消息对外前统一替换
  工作目录/临时目录/用户主目录/当前目录与密钥形态的环境变量值；非 ApiError 异常统一返回“服务内部错误”，
  不回传堆栈与绝对路径。
- **体积与空文件**：空文件 `400 EMPTY_FILE`；超过 `LOCAL_AGENT_MAX_BYTES` 立即回 `413 PAYLOAD_TOO_LARGE`
  并关闭连接（客户端可稳定读到状态码），服务端不缓存超限字节。
- **隔离验证**：`test/security.test.js`（路径穿越/越权读取/空文件/超限/指令文本/脱敏）、
  `test/concurrency.test.js`（两任务 taskId/事件/文件/证据/版本互不串扰）、
  `test/integration.test.js`（干净启动全链路 + 删除物理清理）。
  说明：Windows 桌面本地模式无 OS 级容器/网络命名空间，隔离手段为独立进程组 + 临时工作目录 +
  静态扫描 + 环境变量剔除 + 超时杀进程树；远程多租户只能使用 `deploy/` 的强沙箱容器配置。

### 4.5 候选评分 / MMR / 偏好算法与评测基线（说明书第 8、12 节）

纯函数模块 `src/decision/`（零依赖、可在浏览器同构复用）：

- `weights.js`：U(c) 六维权重（0.30/0.20/0.15/0.15/0.10/0.10）、六类相似度权重、
  λ=0.5、偏好事件权重表（1.00/0.70/0.60/0.45/-0.80/0）、权重和=1 与子分 [0,1] 校验；
- `features.js`：图型/布局/编码/统计呈现/配色/注释六类特征签名与加权 Sim；
- `mmr.js`：`Score(c)=U(c)-λ·max Sim(c,s)` 贪心选择、重复候选去重、不可执行剔除、
  差异维度 ≥2 约束、确定性 tie-break 与洗牌稳定性；
- `preference.js`：`P(v)=Σ w_event·exp(-Δt/τ)·confidence·scope_match` 三作用域聚合，
  有效事件 ≥3 且前两名分差超阈值才自动推荐；
- `candidates.js`：K=6~12 候选池（3 个 canonical 可执行 + 5 个核心变体 + 条件变体含
  双Y轴/三维曲面/三维散点/箱线/小提琴/堆叠面积/配对点；超 12 上限时按效用分确定性裁剪，
  用户可点名的双Y轴/三维图型恒保留）。
- `colorLearning.js`：用户配色画像（90 天半衰期衰减 + 置信度加权 + 图型-色板亲和），
  以 tanh 有界先验注入 `recommendPalette`（v0.4.0 新增）。

生产接线：`buildPlans` 先构造 K=6~12 候选池再跑 MMR，方案的 `mmrScore`/`diffDimensions`
由算法实时计算（不再是硬编码常量）；任务快照与 `plans_ready` 事件带 `selectionAudit`
（K、可执行数、淘汰原因、MMR trace、差异约束、告警、clarification 审计）。前端 Mock 经 `apps/web/src/lib/decision.ts`
使用同构算法（Mock 仅 K=3 演示候选）。

评测基线：`npm run eval:decision` 输出 `eval/decision-baseline.{json,csv}` 与
`eval/decision-candidates.csv`（9 场景 + λ 扫描 + 边界校验 + 本地耗时；不含商业定价）。
**基线当前暴露的真实缺口**：① 可执行候选子分仍有常量成分，选择对数据形态的敏感度仍可提升；
② 新图型（三维/双Y轴）随数据条件进入候选，但三维图型的遮挡风险与版面成本需更多实测标定；
③ 配色学习先验已接入推荐器，自动推荐阈值与撤销/重置端点尚未接入 HTTP（纯函数与测试已就绪）。
以上均为初始启发式配置，不是训练所得。

---

## 5. 持久化、LLM 与其他端点说明

- **文件态持久化**：`.data/tasks/<id>/` 保存 `data.csv`（原始字节）、`meta.json`、`events.jsonl`
  （事件日志为唯一事实源）与 `runs/` 全部尝试产物。启动时 `restore()` 重放事件、索引 runs 产物
  （含从 IHDR 恢复 PNG 宽高）、按 24h TTL 清理；重启后快照、preview、trace、export 均可用。
- **LLM 意图适配器（可选，默认关闭）**：配置 OpenAI 兼容端点后，意图解析（图表类型/变量映射/分组/误差棒）
  交由 LLM 输出 JSON，经 schema 校验与**真实列名校验**；LLM 编造的不存在变量进入 missingFields，
  上层按 `UNKNOWN_FIELD` 诚实失败；任何异常（超时 15s、坏 JSON、schema 不符）均回退确定性规则，
  快照中保留 `llmError`，UNDERSTAND 步骤摘要标注 `[llm]` / `[rule]` 来源。
- **偏好反馈**：六维效用（TaskFit/DataFit/ChartTypeFit/Convention/PreferenceFit/ComputeFit）即时重算；
  显式 `select_plan` 代表用户直接决策，被选方案固定排首位。
- **feedback / replan**：按自然语言反馈重新走 ITERATE → DESIGN + EXECUTE + VERIFY，`planVersions` 追加两条
  PlotRevision（执行前/验证后），旧版本永不覆盖，trace 可回溯完整谱系；`/replan` 是 `/feedback` 的别名。
- **complete / export**：`/complete` 显式确认冻结；`/export` 在打包前幂等进入 COMPLETE。
  COMPLETE 后 preview / export / trace / GET 等只读能力保留，所有变更类请求返回 `409 TASK_TERMINAL`。
- **DELETE 幂等与立即不可访问**：删除先置 `deleted` 并关闭全部事件订阅，再从内存 Map 移除并物理删除整个
  任务目录（原始 data.csv 与 runs）；删除后 GET 404、WS 握手 404；重复删除返回 200 `existed:false`。
  删除进行中若后台迭代仍在运行，迭代静默中止（TaskDeletedError），不会再产生事件或 FAILED。
- **export ZIP**：`plot.py` / `plot.R` / `plot.m` + `data.csv` + `ChartSpec.json` +
  `evidence.json` / `evidence.md` + `README.txt` + `artifacts/`（SVG/PNG/PDF）。

---

## 6. 目录结构

```
services/local-agent/
├─ package.json              # 零依赖；start / dev / test / smoke / contract / eval:decision 脚本
├─ examples/nitrogen_response_demo.csv
├─ eval/                      # 决策算法评测基线产物（npm run eval:decision 生成；含 README）
├─ scripts/
│  ├─ smoke.mjs              # 端到端冒烟（八状态 + preview/export/trace）
│  ├─ eval-decision.mjs      # 评分/MMR/偏好评测基线（9 场景 + λ 扫描 + 边界校验）
│  └─ gen-contract.mjs       # 生成前端 TS 契约快照
├─ contract/fixtures.ts      # 由真实响应生成，经前端 tsc 校验
├─ src/
│  ├─ server.js              # HTTP 路由 + WS 升级 + 令牌/版本协商 + 启动恢复 + CLI
│  ├─ orchestrator.js        # 12 态编排、沙箱执行/修复/验证、replan、LLM 接线、三轮澄清分支
│  ├─ taskStore.js           # 任务仓库、事件日志/订阅/重放、持久化恢复、快照聚合
│  ├─ storage.js             # 文件态存储（数据/事件/runs 产物，TTL 清理）
│  ├─ csv.js / stats.js      # 编码探测/解析/体检/指纹；确定性统计 + 证据账本（含 t/ANOVA/效应量/分组形态）
│  ├─ plans.js / preferences.js  # K=6~12 候选+MMR 组装三方案；偏好反馈实时重排序（接 clarify/userProfile）
│  ├─ clarify.js             # 绘图前 ≥3 轮需求澄清引擎（goal→chartType→presentation，科研默认回退）
│  ├─ interpretation.js      # 图表解读文案（结构化要点 + 可改写分析段落 + 图注建议，v0.4.1）
│  ├─ typography.js          # 科研排版解析与默认（SimHei/字号档/白底/300dpi，clamp 校验）
│  ├─ plotRules.js           # 《数模国赛MATLAB制图规则 v0.4》规则库（白底/字号/禁彩虹色/图注/样式复用）
│  ├─ colorLearning.js       # 配色学习画像（事件强度/90天半衰期/有界先验 profilePaletteScore）
│  ├─ decision/              # 纯函数：weights/features/mmr/preference/candidates（说明书 8、12 节）
│  ├─ codegen.js             # 三引擎代码生成 + heatmap/dual_axis/surface3d/scatter3d + 降级模板
│  ├─ safe.js                # 文件名净化/路径片段校验/输出脱敏 redactText
│  ├─ sandbox.js             # 安全扫描、工作目录隔离、环境变量白名单、spawn 执行、SVG/PNG/PDF 采集
│  ├─ repair.js / verify.js  # 七类签名修复；独立验证、SVG 布局与最终渲染质检
│  ├─ intent.js / llm.js     # 确定性意图解析；可选 OpenAI 兼容适配器
│  ├─ export.js / zip.js / trace.js
│  ├─ engines.js / multipart.js / ws.js / errors.js
├─ contract/                 # 跨端契约：gen-contract 真实跑全流程生成 fixtures.json/fixtures.ts
└─ test/                     # 单元/接口/事件/执行/端点/迭代/持久化/LLM/契约/决策/集成/安全/容量/并发
```

> 测试以 `node --test --test-concurrency=1` 串行运行测试文件，进程内沙箱队列再串行化解释器执行，
> 避免 matplotlib 字体缓存锁争用导致的不确定超时。

---

## 7. 已实现能力与诚实声明

**已真实完成（无 Mock）**：健康检查与能力探测；任务创建/快照/删除；WS 实时事件与历史重放；
真实 CSV 解析（编码/分隔符/类型/缺失率/描述统计/指纹）；12 态状态机推进（含 NEED_INPUT、REPAIR、ITERATE、COMPLETE）；
证据账本与三方案共享统计（数据包不变）；三引擎源码生成（含热力图/双Y轴/三维曲面/三维散点模板）；
**长表分组形态统计推断与误差棒/置信带/显著性星号标注（t 检验 Welch、ANOVA、Holm 校正，三引擎同步）**；
**图表解读文案（结构化要点 + 可改写论文分析段落 + 图注建议，数字可溯源）**；
**真实沙箱执行产出 SVG/PNG/PDF**；安全扫描；
七类错误签名 + 初次执行后最多 3 次修复 + 同签名停止策略；独立验证与最终渲染质检；
**绘图前 ≥3 轮需求澄清（图型任务→图型偏好→标题/图注/排版，无要求按科研默认执行；prefill 可跳过已答轮次）**；
**配色学习（开源算法/公开期刊色系 + 用户历史偏好有界先验注入推荐）**；
**answer / select / feedback（PlotRevision 版本谱系，旧版本不可变、可回溯）/ complete / 幂等 DELETE**；
偏好排序（不产生修订）；preview / 复现 ZIP 导出（导出即冻结）/ trace（含 revisions）；
文件态持久化与重启恢复；可选 LLM 意图解析（默认关闭，失败回退）；
安全基线（上传文件名白名单、路径 containment、三引擎字面量转义、沙箱环境变量剔除、输出脱敏、稳定 413）；
自动化测试（含真实 Python 执行、终态守卫、删除物理清理、跨端契约、评分/MMR/偏好决策算法、集成链路、安全攻击用例、容量与并发隔离；数量以当前测试输出为准）。

**尚未实现 / 受限（诚实标注）**：

- R 与 MATLAB 的实机执行取决于用户安装与许可证；本次主机 Rscript 不可用，MATLAB R2025b 已通过生成码 PNG/SVG 冒烟。Web 只生成 MATLAB 源码，Desktop/VS Code 才可显式调用本地 MATLAB。
- LLM 适配器默认关闭；支持 Agent Plan 的 OpenAI Chat、OpenAI Responses 与 Anthropic 兼容协议，未配置或认证失败时回退确定性规则。
- Windows 本地模式不声称容器级隔离；任意用户源码必须进入 `deploy/` 的强沙箱配置，否则返回 `STRONG_SANDBOX_REQUIRED`。
- 已实现 SpecPatch、源码预览/应用、任务取消/删除、远程租户会话、配额、限流、断点上传和签名下载；仓库未附带公网部署、外部身份提供商或计费系统。
- 任务默认 24h TTL；本地任务为文件态持久化并可由事件日志恢复。远程分块上传可恢复网络中断，但上传会话本身不承诺跨服务进程重启恢复。
- 安全测试未覆盖 multipart 头注入/CRLF、压缩炸弹、符号链接逃逸（读取侧 containment 已拦截链接指向目录外），
  这些是已知剩余风险；MATLAB 真实执行只覆盖用户当前授权环境中的代表性生成码样例。

---

## 8. 与前端的对接

前端已内置 `RealAgentClient`（`apps/web/src/client/realAgentClient.ts`），与 MockAgentClient 实现同一调用面。
真实客户端的最小流程：`start()` 只创建任务并返回 `{taskId}`（失败抛错），随后 `subscribe(onEvent)`
建立 WebSocket（保证 store 先建任务再收事件、不丢事件），`getSnapshot()` 拉取快照；
交互方法：`answerQuestion` / `selectPlan`（并拉 preview 注入 SVG）/ `rejectPlan` /
`feedback(text, planId?)` / `getPreview` / `getTrace` / `exportArtifact` / `cancel`。

### 8.1 绘图前多轮澄清的前端接入（v0.4.0）

- 建任务 multipart 增加 `clarify=true`（启用三轮澄清）与 `clarifyAnswers`（JSON，含 `answeredRounds:[1,2]` 预填跳过已答轮次）；
  `RealAgentClient.start()` 与 MockAgentClient 均已透传（Mock 以相同三轮 shape 本地模拟，便于离线联调）。
- `need_input` 事件新增 `round / total / key / hint`：前端在 NEED_INPUT 态渲染「第 X/3 轮」进度徽标、
  轮次标签（图表目标 / 图型偏好 / 标题·图注·排版）、预设选项按钮与作答提示；`answer()` 走 `/answer` 应答。
- **第三轮结构化表单（优化 2）**：`key=presentation` 且携带 `recommendedPalettes` 时，NEED_INPUT 卡片渲染
  表单（图表标题 / 图注 / 标题字色 / 标题字号 / 图注字色 / 图注字号 / 轴标签字号 / 刻度字号 / 图例字号 /
  字距 / DPI + 推荐色板 swatch 点选，色板项展示色块条与推荐理由），提交时序列化为协议键值对
  （`标题=…；图注=…；标题字色=#…；…；配色=<色板id>`）调 `answer()`；「全部按默认」一键回落科研默认。
- 方案呈现后，消息流展示需求澄清摘要（目标 / 图型 / 标题 / 图注 / 配色），未指定项标注「按科研默认执行」；
  代码视图同步展示方案图注（`图X-X 对象方法功能`）与排版参数徽标（标题/轴标签/图注字号、DPI）。
- 快照 `AgentTask.clarification` 与前端 `ClarificationResult` 同构（含 `recommendedPalettes`）；
  `PlotPlan` 携带 `caption` / `typography`；
  `FigureSpec` 排版扩展字段（titleFont/titleColor/titleFontSize/axisLabelSize/tickSize/legendSize/captionSize/letterSpacing 等）已对齐。
- **配色学习画像面板（优化 1）**：`RealAgentClient.getColorProfile()`（`GET /api/preferences/colors`）与
  `resetColorPreferences()`（`DELETE /api/preferences/colors`）已接入；偏好面板新增「配色学习画像」区块——
  展示已学习信号数、top 色板正/负信号统计与最近时间、一键「重置配色学习」；单条撤销后自动刷新画像。

### 8.2 生成代码可修改（源码编辑闭环 + 编辑即重渲染）

前端 CodeViewer 已内置「编辑 → 保存并重跑」：`previewSource`（`POST /source/preview`）→ `applySource`
（`POST /source/apply`，应用后重新生成三引擎代码、沙箱重跑并执行独立验证与渲染质检），修改后方案标记
`code_edited_unverified` 直至验证通过；`saveCode`（`POST /code`）保存草稿不重跑。无法安全逆向回
ChartSpec 的改动自动进入「代码主导」模式（`sourceMode='code'`），并保留 `sourceMap` 供定位。

- **编辑即重渲染（优化 5）**：编辑态下停止输入约 0.8s 自动触发 `saveSource`（防抖），
  `applySource` 完成后 store 立即调用 `getPreview(planId)` 拉取该方案真实渲染 SVG，并写入
  `task.execution.artifactSvg`——消息流与代码视图的预览无需手动刷新即随之变化；渲染期间显示
  「重新渲染中…」徽标，拉取失败保留上次通过图并标注原因（不回滚代码，可继续编辑重试）。
  支撑管道（previewSource → applySource → 异步重跑 → getPreview 指纹变化）已由临时端到端脚本
  实测通过（修改标题字面量后重新渲染 SVG 指纹变化），脚本验证后已删除。

### 8.3 协议字段对齐

快照与事件是前端 TS 类型的超集，契约一致性由 `npm run contract`（真实响应 → `contract/fixtures.ts` → 前端 tsc 校验）
与 `test/contract.test.js` 共同守护；v0.4.1 已补齐 `PlotPlan.interpretation`（解读要点/分析段落/图注建议）、
`PanelSpec.groups/errorBarMode/confidenceBand/significance`、`PreviewSeries.n/sd/ciLow/ciHigh`；
v0.4.0 已补齐 `TaskEvent.round/total/key/hint`、`AgentTask.clarification/projectId`、
`PlotPlan.caption/typography`、`SelectionAudit.clarification/calibrationMetrics`、`FigureSpec` 排版字段、
`LayerKind='boxplot'`、`UtilityScore.scoreBreakdown`、palette 度量（`minCvdDeltaE/cvdPass/minGrayscaleGap/grayscalePass/interpolated/redundantEncoding`）、
`TaskEvent.recommendedPalettes` 与 `ClarificationResult.recommendedPalettes`（第三轮推荐色板，优化 2）等后端真实输出。

切换到真实后端的两种方式：

1. 启动时 URL 参数：`?agent=local&url=http://127.0.0.1:<port>&token=<TOKEN>`；
2. Vite 环境变量：`VITE_LOCAL_AGENT_URL` / `VITE_LOCAL_AGENT_TOKEN` / `VITE_LOCAL_AGENT_ENGINE`。

未配置时前端默认使用浏览器内 MockAgentClient，开发体验不变。快照与事件是前端 TS 类型的超集
（服务端额外字段：`plan.evidenceIds`、事件 `seq` / `reason`、错误事件 `code` 等），不影响现有解析。
契约一致性由 `npm run contract`（真实响应 → `contract/fixtures.ts` → 前端 tsc 校验）与
`test/contract.test.js`（跨端枚举、事件名、关键字段、版本谱系）共同守护。
