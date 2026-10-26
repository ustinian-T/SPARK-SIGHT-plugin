// 科研绘图辅助智能体 · 共享领域模型（前端）
// 与 packages/chart-spec、services/local-agent 的任务协议保持同构；
// 字段命名与《算法设计说明书》八大结构、ChartSpec 六层及 12 态状态机对齐。

// ---------- Agent 12 态状态机 ----------
export type AgentState =
  | 'INGEST' // 数据接入与解析
  | 'UNDERSTAND' // 意图理解
  | 'NEED_INPUT' // 最少追问/澄清
  | 'PLAN' // 任务规划
  | 'ANALYZE' // 可信统计分析（仅一次）
  | 'DESIGN' // 候选生成 / 三方案设计
  | 'EXECUTE' // 代码执行与渲染
  | 'VERIFY' // 独立验证
  | 'REPAIR' // 失败自纠错（最多 3 次）
  | 'FAILED' // 终止失败
  | 'PRESENT' // 方案呈现 / 待选择
  | 'ITERATE' // 选择 / 反馈 / 多轮迭代
  | 'COMPLETE' // 完成
  | 'CANCELLED' // 用户主动取消

export const STATE_LABEL: Record<AgentState, string> = {
  INGEST: '数据接入',
  UNDERSTAND: '意图理解',
  NEED_INPUT: '等待澄清',
  PLAN: '任务规划',
  ANALYZE: '可信分析',
  DESIGN: '方案设计',
  EXECUTE: '执行渲染',
  VERIFY: '独立验证',
  REPAIR: '自纠错',
  FAILED: '已失败',
  PRESENT: '待选择',
  ITERATE: '迭代中',
  COMPLETE: '已完成',
  CANCELLED: '已取消'
}

// 终态
export const TERMINAL_STATES: ReadonlySet<AgentState> = new Set(['FAILED', 'COMPLETE', 'CANCELLED'])

// ---------- 引擎 ----------
export type EngineKind = 'python' | 'r' | 'matlab'
export const ENGINE_LABEL: Record<EngineKind, string> = {
  python: 'Python · Matplotlib/Seaborn',
  r: 'R · ggplot2',
  matlab: 'MATLAB · Engine/CLI'
}

// ---------- 数据接入与体检 ----------
export type ColumnType = 'numeric' | 'categorical' | 'datetime' | 'boolean' | 'unknown'

export interface ColumnProfile {
  name: string
  index: number
  inferredType: ColumnType
  userType?: ColumnType // 用户手动修正后的类型（CORE-002）
  missing: number
  missingRate: number
  unique: number
  // numeric
  min?: number
  max?: number
  mean?: number
  median?: number
  std?: number
  // categorical
  topValues?: { value: string; count: number }[]
}

export interface DatasetQuality {
  duplicateRows: { count: number; rowNumbers: number[] }
  outliers: { field: string; count: number; lower: number; upper: number; rowNumbers: number[] }[]
  constantColumns: string[]
  mixedTypeColumns: { field: string; numericCount: number; invalidCount: number; invalidRate: number }[]
  smallGroups: { field: string; value: string; count: number }[]
  highMissingColumns: { field: string; missing: number; rate: number }[]
}

export interface DatasetProfile {
  fileName: string
  encoding: 'UTF-8' | 'GBK' | string
  delimiter: string
  hasHeader: boolean
  rows: number
  cols: number
  sizeBytes: number
  parserConfig: string // 参与指纹的解析配置
  fingerprint: string // H = SHA256(file_bytes || parser_config)
  columns: ColumnProfile[]
  quality: DatasetQuality
  warnings: string[]
  headRows: Record<string, string>[]
}

export interface DataVersion {
  version: number
  fingerprint: string
  current: boolean
  createdAt: number
  reason: string
  fileName: string
  previousFingerprint?: string
}

export interface DataRevisionPreview {
  token: string
  expiresAt: number
  kind: 'type_override' | 'replace'
  previousFingerprint: string
  nextFingerprint: string
  profile: DatasetProfile
  risks: { code: string; field?: string; message: string }[]
  requiresConfirmation: boolean
}

// ---------- 证据账本 ----------
export interface EvidenceRecord {
  evidence_id: string
  tool: string // 确定性统计工具名
  metric: string
  fields: string[]
  scope: string // 样本范围 / 过滤条件
  value: string
  note?: string
  method?: string
  details?: Record<string, unknown>
  // 与后端一致：统计检验输出与参数
  parameters?: Record<string, unknown>
  assumptions?: string[]
  failedAssumptions?: string[]
  reproducibleInput?: unknown
  // 与后端一致：证据版本（数据修订后递增；字符串版本号为兼容保留）
  version?: number | string
}

export interface Claim {
  claimId: string
  evidenceId: string
  fields: string[]
  sampleScope: string
  numbers: number[]
  relation: 'descriptive' | 'causal' | 'significance'
  text: string
}

// ---------- PlanGraph ----------
export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface PlanStep {
  step_id: string
  tool: string // 工具注册名，如 stats.analyze / code.execute
  title: string
  status: StepStatus
  dependsOn: string[]
  inputSummary?: string
  outputSummary?: string
  durationMs?: number
  attempts?: number // 重试次数
  errorSignature?: string
  evidenceIds?: string[]
}

// ---------- ChartSpec 六层 + 稳定 ID ----------
// LayerKind 与后端 codegen 对齐：boxplot 为箱线图（前端兼容旧值 'box'）
export type LayerKind = 'line' | 'bar' | 'scatter' | 'heatmap' | 'box' | 'boxplot' | string
export type AxisKind = 'x' | 'y'

export interface LayerSpec {
  layer_id: string
  kind: LayerKind
  dataRef: string // 绑定的数据系列 id
  label: string
  color: string
  marker?: string
  lineWidth?: number
  // 与后端一致：支持 matplotlib 风格（'-','--',':','-.') 与 ggplot 风格（'solid','dashed','dotted'）
  linestyle?: '-' | '--' | ':' | '-.' | 'solid' | 'dashed' | 'dotted' | string
  showErrorBars?: boolean
  alpha?: number
}

export interface ScaleSpec {
  scale_id: string
  axis: AxisKind
  label: string
  type: 'linear' | 'categorical' | 'time'
  min?: number
  max?: number
  grid: boolean
  tickFormat?: string
}

export interface LegendSpec {
  legend_id: string
  visible: boolean
  position: 'top' | 'bottom' | 'left' | 'right' | 'center' | 'inside'
  title?: string
}

export interface AnnotationSpec {
  annotation_id: string
  kind: 'text' | 'hline' | 'vline' | 'band'
  text?: string
  x?: number | string
  y?: number
  color?: string
}

export interface PanelSpec {
  panel_id: string
  title: string
  row: number
  col: number
  layers: LayerSpec[]
  scales: ScaleSpec[]
  legend: LegendSpec
  annotations: AnnotationSpec[]
  // v0.4.1 扩展（长表分组形态）：分组列/测量列、误差棒口径（sd|se|ci）、置信带、显著性标注
  groups?: { groupCol: string; measure: string }
  errorBarMode?: 'sd' | 'se' | 'ci'
  confidenceBand?: boolean
  significance?: { left: string; right: string; stars: string; pValue?: number }[]
}

export interface FigureSpec {
  figure_id: string
  title: string
  subtitle?: string
  widthIn: number
  heightIn: number
  dpi: number
  rows: number
  cols: number
  background: string
  fontFamily: string
  theme: string
  minFontSize?: number
  avoidOverlap?: boolean
  // v0.4.0 排版扩展（与后端 typography.js 对齐）：标题/轴标签/刻度/图例/注解的独立字体、字号、字色与字距
  titleFont?: string
  titleColor?: string
  titleFontSize?: number
  titleFontWeight?: string
  titleSpacing?: number
  // 后端布局契约：多面板图由布局引擎预留总标题空间。
  layoutEngine?: 'constrained' | 'loose' | 'tight' | string
  titleReserve?: number
  colormap?: string
  axisLabelSize?: number
  axisLabelColor?: string
  axisLabelFont?: string
  tickSize?: number
  legendSize?: number
  legendFont?: string
  annotationSize?: number
  captionSize?: number
  captionColor?: string
  letterSpacing?: number
}

export interface ChartSpec {
  figure: FigureSpec
  panels: PanelSpec[]
}

// 规格补丁（界面操作 → SpecPatch → 最小代码 Diff）
export interface SpecPatch {
  patch_id: string
  targetKind: 'figure' | 'panel' | 'layer' | 'scale' | 'legend' | 'annotation'
  targetId: string
  path: string // 如 panels[0].layers[1].color
  label: string // 人类可读变更说明
  before: unknown
  after: unknown
}

export interface PatchPreview {
  token: string
  expiresAt: number
  parentVersion: number
  planId: string
  targetKind: 'figure' | 'panel'
  targetId: string
  path: string
  before: unknown
  after: unknown
  spec: ChartSpec
}

export interface SourceMapEntry {
  path: string
  line: number
  column: number
  length: number
  originalLiteral: string
}

export interface SourcePreview {
  token: string
  expiresAt: number
  parentVersion: number
  planId: string
  engine: EngineKind
  baseHash: string
  sourceHash: string
  mode: 'spec' | 'code'
  sourceMap: SourceMapEntry[]
  spec?: ChartSpec
  changedLines: number
}

export interface PreferenceSnapshot {
  paused: boolean
  events: PreferenceEvent[]
}

// ---------- 三方案 ----------
export type PlanStrategy = 'clarity' | 'convention' | 'density'
export const STRATEGY_LABEL: Record<PlanStrategy, string> = {
  clarity: '信息清晰优先',
  convention: '论文惯例优先',
  density: '信息密度优先'
}

// 效用评分六维（权重为初始配置，须用户测试调整，非训练所得）
export interface UtilityScore {
  DataFit: number
  TaskFit: number
  Readability: number
  ScientificConvention: number
  PreferenceFit: number
  Executability: number
  total: number
  // 与后端一致：六维评分明细（决策模块输出）
  scoreBreakdown?: Record<string, number | boolean>
}
export const UTILITY_WEIGHTS = {
  DataFit: 0.3,
  TaskFit: 0.2,
  Readability: 0.15,
  ScientificConvention: 0.15,
  PreferenceFit: 0.1,
  Executability: 0.1
} as const

// SVG 预览使用的结构化系列（来自确定性统计结果）
export interface PreviewSeries {
  id: string
  label: string
  color: string
  x: (number | string)[]
  y: (number | null)[]
  yerr?: (number | null)[]
  kind: LayerKind
  marker?: string
  // 与后端一致：线型（matplotlib/ggplot 两种风格）
  linestyle?: '-' | '--' | ':' | '-.' | 'solid' | 'dashed' | 'dotted' | string
  // v0.4.1 扩展（长表分组形态）：组样本量/标准差/95%CI，绘图与解读使用
  n?: number
  sd?: number | null
  ciLow?: number | null
  ciHigh?: number | null
  /** 原始组内观测，仅用于分布图预览；不会代替统计摘要。 */
  values?: number[]
}

export interface PlotPlan {
  plan_id: string
  candidateId?: string
  strategy: PlanStrategy
  comparisonRole?: 'user_request' | 'system_recommended_clarity' | 'system_recommended_convention' | 'system_recommended_density' | string
  name: string
  rationale: string // 设计理由
  chartType: string
  engine: EngineKind
  spec: ChartSpec
  series: PreviewSeries[]
  score: UtilityScore
  mmrScore: number
  mmrUtility?: number // MMR 入选时的效用值（= score.total）
  mmrMaxSimilarity?: number | null // MMR 入选时与已选方案的最大相似度（首选为 null）
  diffDimensions: string[] // 与其他方案的差异维度（≥2）
  code: Record<EngineKind, string> // 三引擎代码（当前引擎用于执行）
  dependencies: string[]
  dataProcessingSummary: string
  dataProcessingTrace?: {
    schema: string
    datasetFingerprint?: string
    inputShape?: { rows: number; columns: number }
    plottedFields?: { x: string; measures: string[] }
    operations?: { id: string; description: string; groupField?: string; measure?: string }[]
    series?: { field: string; sourceField?: string; observed: number; missing: number | null; plottedRows: number; aggregation: string }[]
    outlierPolicy?: string
    mutation?: string
  } | null
  dataSuitability?: { schema?: string; chartType?: string; executable?: boolean; warnings?: string[]; [key: string]: unknown }
  statisticalCorrectness?: { errorBarSemantics?: string; designAppropriate?: boolean; notes?: string[] } | null
  applicableScene: string
  palette?: {
    id: string
    name: string
    source: string
    colors: string[]
    reason: string
    metrics?: { capacity: number; overflow: number; minDeltaE: number; minLuminanceGap: number; luminanceRange: number; monotonicity: number; divergingCenterLift: number; minContrastOnWhite: number; minCvdDeltaE?: number; cvdPass?: boolean; minGrayscaleGap?: number; grayscalePass?: boolean; [key: string]: number | boolean | undefined }
    warnings?: string[]
    scoreBreakdown?: Record<string, number | boolean>
    // 与后端一致：冗余编码提示（颜色+线型/标记同时区分时的冗余检查）
    redundantEncoding?: { enabled: boolean; lineStyles: string[]; markers: string[] } | string[] | string
    // 与后端一致：系列数超色板容量时是否插值扩色
    interpolated?: boolean
    interpolatedCount?: number
  }
  insightSummary?: string // 图表下方的通俗数据解读
  focusExplanation?: string // 按用户侧重点展开的说明
  // local-agent 扩展（可选）：方案结论绑定的证据 id；沙箱执行/验证状态
  evidenceIds?: string[]
  executionStatus?: 'verified' | 'rendered_unverified' | 'failed_execution' | 'code_generated_not_executed' | 'code_edited_unverified' | string
  verification?: PlanVerification
  sourceMode?: 'spec' | 'code'
  sourceMap?: SourceMapEntry[]
  // v0.4.0 扩展（可选）：科研图注（「图X-X 对象方法功能」）与排版参数（字号/字色/字距/DPI）
  caption?: string
  typography?: Record<string, unknown>
  // v0.4.1 扩展（可选）：图表解读文案——结构化要点（可溯源证据 id）+ 可改写分析段落 + 图注建议
  interpretation?: {
    insights: { id: string; kind: 'trend' | 'comparison' | 'correlation' | 'distribution' | 'quality'; title: string; text: string; evidenceId: string }[]
    analysisParagraph: string
    captionSuggestion: string
    summaryText?: string
    insightTable?: { metric: string; result: string; criterion: string; evidenceId: string }[]
    qualityNotes?: string[]
    humanReview?: string[]
    chartRecommendation?: string
    recommendation?: { status: string; reason: string; alternatives: string[] }
    paperDraft?: { status: string; note?: string; text?: string }
  }
}

// 独立验证结果（规格符合性 / 证据一致性；三方案差异在任务级 verification）
export interface VerificationCheck {
  name: string
  passed: boolean
  detail: string
  // 与后端一致：规则符合性检查的违规明细（plotRules 输出）
  violations?: { rule: string; level: 'error' | 'warn'; message: string }[]
  warnings?: string[]
  issues?: string[]
  severity?: 'pass' | 'warning' | 'error'
}

export interface PlanVerification {
  passed: boolean
  checks: VerificationCheck[]
  artifactHash?: string
  codeHash?: string
  dataFingerprint?: string | null
  revision?: number
  engine?: EngineKind | string
  attempts?: number
  quality?: {
    schema: string
    score: number
    grade: 'ready' | 'review' | 'revise' | 'blocked'
    passedChecks: number
    failedChecks: number
    warningCount: number
    summary: string
  }
}

export interface PlanArtifactMeta {
  attempts: number
  verified: boolean
  artifactHash?: string
  png?: { width: number; height: number }
  svgBytes?: number
}

export interface PreviewArtifact {
  planId: string
  engine: EngineKind | string
  svg: string
  png?: { width: number; height: number; dataBase64?: string }
  width?: number
  height?: number
  verification?: PlanVerification
}

// ---------- 方案版本（PlotRevision 谱系；架构表 7-1） ----------
export type PlanRevisionReason = 'initial' | 'feedback' | 'preference' | string

export interface PlanVersion {
  version: number
  parent?: number
  at?: number
  reason: PlanRevisionReason
  feedback?: string
  selectedPlanId?: string
  dataFingerprint?: string
  patch?: Pick<PatchPreview, 'planId' | 'parentVersion' | 'targetKind' | 'targetId' | 'path' | 'before' | 'after'>
  artifacts?: Record<string, unknown> // patch 修订保留可回滚的完整产物快照
  mode?: 'spec' | 'code'
  source?: { planId: string; engine: EngineKind; baseHash: string; sourceHash: string; sourceMap: SourceMapEntry[] }
  plans: PlotPlan[] // 该版本时刻的完整方案快照（不可变，旧版本永不被覆盖）
}

// ---------- 执行记录 ----------
export interface LogLine {
  t: number
  level: 'info' | 'warn' | 'error' | 'tool'
  text: string
  location?: string // 文件:行号
}

export interface ExecutionRecord {
  version: number
  engine: EngineKind
  status: 'idle' | 'running' | 'success' | 'error' | 'cancelled'
  logs: LogLine[]
  errorCategory?: string // 七类错误归一化
  normalizedError?: string
  artifactSvg?: string
  artifactPlanId?: string
  artifactEngine?: EngineKind | string
  codeHash?: string
  startedAt?: number
  finishedAt?: number
}

// ---------- 偏好 ----------
export type PreferenceKind =
  | 'set_default'
  | 'select_plan'
  | 'manual_edit'
  | 'export'
  | 'reject'
  | 'browse'
export type PreferenceScope = 'global' | 'project' | 'chart_type' | 'task'

export interface PreferenceEvent {
  event_id: string
  kind: PreferenceKind
  weight: number // 初始权重
  scope: PreferenceScope
  summary: string // 依据
  confidence: number
  t: number
  planId?: string // local-agent 扩展：关联具体方案
  paletteId?: string // 关联配色；用于后续推荐时的可撤销偏好学习
  reverted?: boolean
  revertedAt?: number
}

// ---------- 对话 ----------
export type ChatRole = 'user' | 'assistant' | 'system' | 'tool'
export interface ChatMessage {
  id: string
  role: ChatRole
  text: string
  t: number
  attachments?: string[]
  state?: AgentState
  plans?: string[] // 关联方案 id
}

// ---------- 任务事件协议（HTTP + WebSocket/SSE 形状） ----------
export type TaskEventType =
  | 'state_delta'
  | 'step_update'
  | 'tool_call'
  | 'evidence'
  | 'log'
  | 'plans_ready'
  | 'execution_update'
  | 'need_input'
  | 'retry'
  | 'preference'
  | 'revision_applied'
  | 'revision_restored'
  | 'authenticated'
  | 'done'
  | 'error'

export interface TaskEvent {
  type: TaskEventType
  state?: AgentState
  step?: PlanStep
  evidence?: EvidenceRecord
  log?: LogLine
  plans?: PlotPlan[]
  // local-agent 扩展（可选）：候选池 MMR 选择审计（随 initial/feedback 的 plans_ready 下发）
  selectionAudit?: SelectionAudit
  // local-agent 扩展（可选）：plans_ready 的版本原因（initial/feedback/preference）、
  // 反馈文本与当时选中的方案，用于 PlotRevision 谱系
  reason?: PlanRevisionReason
  feedback?: string
  selectedPlanId?: string
  dataFingerprint?: string
  execution?: Partial<ExecutionRecord>
  question?: string
  options?: string[]
  // v0.4.0 扩展（可选）：绘图前多轮需求澄清的轮次元信息（need_input 事件）。
  // round=第几轮 / total=总轮数 / key=轮次标识（goal|chartType|presentation）/ hint=作答提示与可用键值对。
  round?: number
  total?: number
  key?: string
  hint?: string
  choiceGroups?: ClarificationChoiceGroup[]
  defaults?: { labelLanguage?: string; legendPosition?: string; paletteId?: string }
  // v0.4.0 优化：第三轮（key=presentation）随 need_input 下发推荐色板（依据用户历史配色学习）
  recommendedPalettes?: RecommendedPalette[]
  retries?: number
  preference?: PreferenceEvent
  revision?: PlanVersion
  version?: number
  cancelledAt?: number
  message?: string
  // local-agent 扩展（可选）：事件单调序号（断线重放去重）、稳定错误码
  seq?: number
  code?: string
}

// ---------- 数据概览卡（v0.4.2 增量 B） ----------
// 与 services/local-agent/src/stats.js buildDataOverview 输出同构。
// 上传 CSV 后、进入澄清轮询前由后端随任务快照下发：仅描述 + 诊断，不改写任何数据（数据包不变）。
export interface DataColumnOverview {
  name: string
  type: string // 'numeric' | 'categorical' | ...
  missing: number
  missingRate: number
  min?: number
  max?: number
  mean?: number
  unique?: number | null // numeric columns omit categorical uniqueness with explicit null
}

export interface DataOutlierHint {
  column: string
  iqr: { count: number; bounds: [number | null, number | null] }
  sigma3: { count: number; bounds: [number | null, number | null] }
}

export interface DataOverview {
  rows: number
  cols: number
  columns: DataColumnOverview[]
  preview: string[][]
  outliers: DataOutlierHint[]
  note?: string
}

// ---------- 任务聚合 ----------
export interface AgentTask {
  taskId: string
  eventSeq?: number
  state: AgentState
  title: string
  createdAt: number
  dataset?: DatasetProfile
  dataOverview?: DataOverview
  steps: PlanStep[]
  evidence: EvidenceRecord[]
  acceptedClaimIds?: string[]
  plans: PlotPlan[]
  selectedPlanId?: string
  execution: ExecutionRecord
  preferences: PreferenceEvent[]
  pendingQuestion?: {
    question: string
    options: string[]
    round?: number
    total?: number
    key?: string
    hint?: string
    choiceGroups?: ClarificationChoiceGroup[]
    defaults?: { labelLanguage?: string; legendPosition?: string; paletteId?: string }
    // v0.4.0 优化：第三轮（key=presentation）随 need_input 下发推荐色板（依据用户历史配色学习）
    recommendedPalettes?: RecommendedPalette[]
  }
  retries: number
  // local-agent 扩展（可选）：失败时的稳定错误码与信息
  error?: { code: string; message: string }
  // local-agent 扩展（可选）：方案版本（每次 plans_ready 递增）、产物元数据、任务级验证、重启恢复标记
  plansVersion?: number
  // local-agent 扩展（可选）：方案版本历史（initial/feedback 留存不可变快照，可回退到任意旧版本）
  planVersions?: PlanVersion[]
  dataVersions?: DataVersion[]
  currentRevision?: number
  cancelledAt?: number
  planArtifacts?: Record<string, PlanArtifactMeta>
  verification?: {
    passed: boolean
    difference?: { passed: boolean; name?: string; detail?: string }
    perPlan?: Record<string, PlanVerification>
    verifiedAt?: number
    // local-agent 扩展：从事件日志恢复重建时标记（跨方案差异无法仅从日志复原）
    restoredFromLog?: boolean
  }
  // local-agent 扩展（可选）：K 候选池 + MMR 选择审计（说明书 8.1/8.3，真实后端 K=8）
  selectionAudit?: SelectionAudit
  restored?: boolean
  // 与后端一致：任务归属项目
  projectId?: string
  // v0.4.0 扩展（可选）：绘图前多轮需求澄清结果（三轮：任务目标→图型偏好→排版呈现）
  clarification?: ClarificationResult
}

// ---------- 绘图前多轮需求澄清（v0.4.0） ----------
// 与 services/local-agent/src/clarify.js 输出同构。三轮固定：
// round1 key=goal（图型任务）→ round2 key=chartType（图型偏好）→ round3 key=presentation（标题/图注/排版）。

// 第三轮推荐色板（依据用户历史配色学习动态调整；前端渲染为 swatch 点选）
export interface RecommendedPalette {
  id: string
  name: string
  colors: string[]
  reason: string
  metrics?: { minDeltaE?: number; minCvdDeltaE?: number; cvdPass?: boolean; minGrayscaleGap?: number; grayscalePass?: boolean }
}

export interface ClarificationChoiceGroup {
  key: string
  label: string
  options: string[]
}

export interface ClarificationResult {
  goal: string // 图型任务（对比/趋势/相关/分布）
  chartType: string // 图型偏好（自动/热力图/双Y轴图/三维曲面图/三维散点图/常规图）
  title?: string // 用户指定的图表标题（缺省用默认标题）
  caption?: string // 图注（「图X-X 对象方法功能」）
  paletteId?: string // 用户指定的配色 id
  labelLanguage?: 'auto' | 'zh' | 'en' | 'bilingual'
  legendPosition?: 'auto' | 'top' | 'bottom' | 'right' | 'inside'
  // v0.4.0 优化：第三轮下发的推荐色板（同 need_input.pendingQuestion.recommendedPalettes）
  recommendedPalettes?: RecommendedPalette[]
  typography?: {
    titleSize?: number
    titleColor?: string
    titleFont?: string
    labelSize?: number
    labelColor?: string
    labelFont?: string
    tickSize?: number
    legendSize?: number
    captionSize?: number
    captionColor?: string
    dpi?: number
    letterSpacing?: number
  }
  source: 'clarified' | 'defaults' // 是否由用户明确提供（含预填）
  complete: boolean
  answers: Record<string, string> // 原始三轮作答（key → answer）
}

// ---------- 配色学习画像（v0.4.0 优化：撤销/重置闭环） ----------
// 与后端 GET/DELETE /api/preferences/colors 响应同构。前端用于偏好面板展示
// “为什么推荐这个色板”与一键重置入口。
export interface ColorPaletteStat {
  paletteId: string
  name: string
  positive: number
  negative: number
  total: number
  lastAt: number
}

export interface ColorProfile {
  summary: {
    topPalettes: { paletteId: string; affinity: number }[]
    topRoles: { chartType: string; affinity: number }[]
    [key: string]: unknown
  }
  eventCount: number
  paletteStats: ColorPaletteStat[]
  eventIds: string[]
}

// ---------- 项目与任务列表（阶段 2：项目切换器 + 任务列表） ----------
// 与后端 /api/projects 系列端点同构。项目是任务的顶层容器，
// 切换项目时必须重置当前任务视图，避免跨项目数据泄漏。
export interface ProjectSummary {
  projectId: string
  name: string
  description?: string
  createdAt: number
  updatedAt: number
  status: 'active' | 'archived' | 'deleted'
  taskCount?: number
  // 后端 GET /api/projects 返回的任务 id 列表；taskCount 缺失时用 taskIds.length 推导任务数徽标。
  taskIds?: string[]
  // 上云状态：cloudEnabled=true 表示已纳入云存储（豁免 7 天保留清除，多端共享）；
  // cloud.status='synced' 表示最近一次上云同步成功。
  cloudEnabled?: boolean
  cloud?: { status: string; lastSyncedAt?: number | null }
}

export interface TaskSummary {
  taskId: string
  title: string
  state: AgentState
  createdAt: number
  taskIndex: number
}

// ---------- 阶段 3：批量上传拆分 ----------
// 与后端 POST /api/projects/:pid/tasks/batch 响应同构。
// 多文件上传后由后端给出“应合并为一个任务”还是“各自独立”的建议，
// 用户可在 BatchSplitPanel 中拖拽调整后再确认创建。
export type BatchDecision = 'auto_merge' | 'independent' | 'suggest_merge'

export interface BatchFileItem {
  fileName: string
  rows?: number
  cols?: number
}

export interface BatchGroup {
  groupId: string
  files: BatchFileItem[]
  title?: string
  decision: BatchDecision
  suggestMerge: boolean
  confidence: number // 0~1
  reasons: string[]
}

export interface BatchSplitResult {
  groups: BatchGroup[]
}

// POST /api/projects/:pid/tasks/batch/confirm 请求体
export interface BatchConfirmGroup {
  groupId: string
  files: BatchFileItem[]
  title?: string
}

export interface BatchConfirmResult {
  tasks: { taskId: string; title: string; state: AgentState }[]
}

// ---------- 阶段 4：项目偏好 ----------
export interface ProjectPreferences {
  colorPalette?: string
  theme?: string
  font?: string
  dpi?: number
  chartDefaults?: Record<string, unknown>
}

export interface ProjectPreferencesResponse {
  preferences: ProjectPreferences
  // 项目内已使用的各图表类型计数，用于差异化建议
  chartUsage: Record<string, number>
}

// ---------- 阶段 5：跨任务取数授权 ----------
export type GrantScope = 'once' | 'project'

export interface GrantRecord {
  grantId: string
  fromTaskId: string
  toTaskId: string
  fields: string[]
  scope: GrantScope
  createdAt?: number
}

// WS grant_requested 事件载荷
export interface GrantRequestEvent {
  requestId: string
  fromTaskId: string
  toTaskId: string
  fields: string[]
  purpose: string
}

// WS grant_resolved 事件载荷
export interface GrantResolvedEvent {
  requestId: string
  grantId?: string
  approved: boolean
}

// ---------- 阶段 6：审批模式 ----------
export type ApprovalMode = 'user' | 'auto' | 'yolo'

export const APPROVAL_MODE_LABEL: Record<ApprovalMode, string> = {
  user: '用户审批',
  auto: '自动审批',
  yolo: '完全同意'
}

// WS approval_requested 事件载荷
export interface ApprovalRequestEvent {
  requestId: string
  taskId: string
  action: string
  reason: string
  category: string
}

// 候选池 MMR 选择审计（与后端 decision 模块输出同构）
export interface SelectionAudit {
  K: number
  lambda: number
  executableCount: number
  infeasibleCount: number
  selectedCandidateIds: string[]
  mmrTrace: { step: number; candidateId: string; utility: number; maxSimilarity: number | null; mmrScore: number }[]
  rejected: { candidateId: string; reason: string }[]
  diversityOk: boolean
  warnings: string[]
  // v0.4.0：图型偏好强制选择审计（澄清指定图型时强制保留对应候选）
  clarification?: {
    chartType: string
    forcedCandidate: string | null
    forced: boolean
    infeasible: unknown
    note: string
  }
  calibrationMetrics?: {
    candidateCount: number
    executableCount: number
    ndcgAt3Baseline: number | null
    note: string
  }
  pool: {
    candidateId: string
    strategy: string
    chartType: string
    utility: number
    executable: boolean
    infeasibleReason: string | null
  }[]
}

// ---------- 阶段 7：待办队列 ----------
// 用户在输入框输入但不立即执行、加入队列的任务；
// 可手动立即执行（在 step 边界打断当前任务）或排队依次执行。
export type BacklogStatus = 'queued' | 'blocking' | 'executing' | 'done' | 'cancelled'

export interface BacklogItem {
  id: string
  projectId: string
  taskId: string
  content: string
  attachments: string[]
  status: BacklogStatus
  createdAt: number
  priority: number // 数值越小优先级越高（排在越前）
}

export const BACKLOG_STATUS_LABEL: Record<BacklogStatus, string> = {
  queued: '排队中',
  blocking: '待打断',
  executing: '执行中',
  done: '已完成',
  cancelled: '已取消'
}

// ---------- 阶段 8：项目图库 ----------
// 按项目聚合所有任务产出的图表。缩略图优先使用任务真实渲染的 SVG；
// 若尚未渲染（planArtifacts 缺对应产物），则退化为前端 ChartPreview 占位渲染。
export interface GalleryChart {
  id: string // 稳定主键：`${taskId}:${planId}`
  taskId: string
  taskTitle: string
  planId: string
  chartType: string // 柱状图 / 折线图 / 散点图 / 箱线图 / 热力图 …
  svg?: string // 真实渲染产物 SVG 文本（优先用于缩略图与放大）
  plan?: PlotPlan // 完整方案（含 spec/series），svg 缺失时供 ChartPreview 占位渲染
  createdAt: number // 归属任务的生成时间，用于排序
}

// 图库筛选条件：按任务、按图表类型过滤；按生成时间排序。
export interface GalleryFilter {
  taskId?: string
  chartType?: string
  sort: 'newest' | 'oldest'
}
