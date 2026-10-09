// 阶段 6：审批引擎 ApprovalEngine。
// 三种模式（D.1）：
//   - user ：默认保守，所有非平凡动作都向用户 ask；
//   - auto ：单任务内/沙箱内/可逆动作自动放行；跨任务/删除/导出/外部API/数据替换 ask；
//   - yolo ：除全局安全底线外全部 auto。
// 六条全局安全底线（D.3）：即使 yolo 也必须 ask/deny，见 GLOBAL_FLOOR。

// 15 类动作分类（与 D.1 动作清单对齐）
export const ACTIONS = {
  CODE_EXECUTE: 'code_execute',               // 沙箱内代码执行
  DATA_EDIT: 'data_edit',                     // 单任务内可逆数据编辑
  DATA_REPLACE: 'data_replace',               // 整表数据替换
  CHART_RENDER: 'chart_render',               // 图表渲染
  PLAN_GENERATE: 'plan_generate',             // 方案生成
  CROSS_TASK_READ: 'cross_task_read',         // 项目内跨任务取数
  CROSS_PROJECT_READ: 'cross_project_read',   // 跨项目取数
  DELETE_TASK: 'delete_task',                 // 删除任务
  DELETE_PROJECT: 'delete_project',           // 删除项目
  EXPORT_SHARE: 'export_share',               // 外发分享/导出
  EXTERNAL_API: 'external_api',               // 外部 API 调用
  PREFERENCE_UPDATE: 'preference_update',     // 偏好更新
  AUDIT_VIEW: 'audit_view',                   // 审计查看（只读）
  GRANT_CREATE: 'grant_create',               // 创建跨任务授权
  GRANT_REVOKE: 'grant_revoke',               // 吊销授权
  BULK_DATA_MODIFY: 'bulk_data_modify'        // 批量数据修改
}

export const MODES = { USER: 'user', AUTO: 'auto', YOLO: 'yolo' }

// 模式 × 动作矩阵（D.1）：auto=自动放行，ask=弹窗等用户确认
const MODE_MATRIX = {
  user: {
    // 只读/纯内部可逆操作可自动；其余一律 ask
    [ACTIONS.AUDIT_VIEW]: 'auto',
    [ACTIONS.CHART_RENDER]: 'auto',
    [ACTIONS.PLAN_GENERATE]: 'auto',
    [ACTIONS.PREFERENCE_UPDATE]: 'auto',
    [ACTIONS.DATA_EDIT]: 'auto',
    [ACTIONS.CODE_EXECUTE]: 'ask',
    [ACTIONS.DATA_REPLACE]: 'ask',
    [ACTIONS.CROSS_TASK_READ]: 'ask',
    [ACTIONS.CROSS_PROJECT_READ]: 'ask',
    [ACTIONS.DELETE_TASK]: 'ask',
    [ACTIONS.DELETE_PROJECT]: 'ask',
    [ACTIONS.EXPORT_SHARE]: 'ask',
    [ACTIONS.EXTERNAL_API]: 'ask',
    [ACTIONS.GRANT_CREATE]: 'ask',
    [ACTIONS.GRANT_REVOKE]: 'ask',
    [ACTIONS.BULK_DATA_MODIFY]: 'ask'
  },
  auto: {
    // 单任务内/沙箱内/可逆 = auto
    [ACTIONS.AUDIT_VIEW]: 'auto',
    [ACTIONS.CHART_RENDER]: 'auto',
    [ACTIONS.PLAN_GENERATE]: 'auto',
    [ACTIONS.PREFERENCE_UPDATE]: 'auto',
    [ACTIONS.DATA_EDIT]: 'auto',
    [ACTIONS.CODE_EXECUTE]: 'auto',
    // 跨任务/删除/导出/外部API/数据替换 = ask
    [ACTIONS.DATA_REPLACE]: 'ask',
    [ACTIONS.CROSS_TASK_READ]: 'ask',
    [ACTIONS.CROSS_PROJECT_READ]: 'ask',
    [ACTIONS.DELETE_TASK]: 'ask',
    [ACTIONS.DELETE_PROJECT]: 'ask',
    [ACTIONS.EXPORT_SHARE]: 'ask',
    [ACTIONS.EXTERNAL_API]: 'ask',
    [ACTIONS.GRANT_CREATE]: 'ask',
    [ACTIONS.GRANT_REVOKE]: 'ask',
    [ACTIONS.BULK_DATA_MODIFY]: 'ask'
  },
  yolo: {
    // 除全局安全底线外全部 auto
    [ACTIONS.AUDIT_VIEW]: 'auto',
    [ACTIONS.CHART_RENDER]: 'auto',
    [ACTIONS.PLAN_GENERATE]: 'auto',
    [ACTIONS.PREFERENCE_UPDATE]: 'auto',
    [ACTIONS.DATA_EDIT]: 'auto',
    [ACTIONS.CODE_EXECUTE]: 'auto',
    [ACTIONS.DATA_REPLACE]: 'auto',
    [ACTIONS.CROSS_TASK_READ]: 'auto',
    [ACTIONS.CROSS_PROJECT_READ]: 'ask',
    [ACTIONS.DELETE_TASK]: 'ask',
    [ACTIONS.DELETE_PROJECT]: 'ask',
    [ACTIONS.EXPORT_SHARE]: 'ask',
    [ACTIONS.EXTERNAL_API]: 'auto',
    [ACTIONS.GRANT_CREATE]: 'auto',
    [ACTIONS.GRANT_REVOKE]: 'auto',
    [ACTIONS.BULK_DATA_MODIFY]: 'auto'
  }
}

// 危险系统命令正则（D.3 第 4 条）：即使 yolo 也 deny
const DANGEROUS_PATTERNS = [
  /rm\s+-rf\s+\//i,          // rm -rf /
  /curl[^\n|]*\|.*\b(sh|bash)\b/i,  // curl ... | sh
  /\bmkfs(\.\w+)?\b/i,       // mkfs / mkfs.ext4
  /\bdd\s+if=/i              // dd if=
]

/** 检测命令是否为危险系统命令 */
export function isDangerousCommand(cmd) {
  if (typeof cmd !== 'string' || !cmd) return false
  return DANGEROUS_PATTERNS.some((re) => re.test(cmd))
}

export class ApprovalEngine {
  /**
   * @param {{getMode?: () => string}} [opts] getMode 返回当前模式（默认 'user'）
   */
  constructor(opts = {}) {
    this.getMode = opts.getMode ?? (() => MODES.USER)
  }

  /**
   * 审批决策入口。
   * @param {string} action ACTIONS 之一
   * @param {{taskId?:string, projectId?:string, command?:string, rowCount?:number,
   *           secretWrite?:boolean, crossProject?:boolean}} [context]
   * @returns {{decision:'auto'|'ask'|'deny', reason:string, category:string}}
   */
  check(action, context = {}) {
    // ---- 全局安全底线（D.3）：优先级最高，覆盖任何模式 ----
    // 4. 危险系统命令 → deny
    if (context.command && isDangerousCommand(context.command)) {
      return { decision: 'deny', reason: '检测到危险系统命令（rm -rf /、curl|sh、mkfs、dd if=），已强制拒绝', category: action }
    }
    // 1. 跨项目取数 → ask
    if (action === ACTIONS.CROSS_PROJECT_READ || context.crossProject === true) {
      return { decision: 'ask', reason: '跨项目取数属于全局安全底线，需用户确认', category: action }
    }
    // 2. 删除项目/任务 → ask
    if (action === ACTIONS.DELETE_TASK || action === ACTIONS.DELETE_PROJECT) {
      return { decision: 'ask', reason: '删除操作不可逆，属于全局安全底线，需用户确认', category: action }
    }
    // 3. 外发分享/导出 → ask
    if (action === ACTIONS.EXPORT_SHARE) {
      return { decision: 'ask', reason: '外发分享/导出属于全局安全底线，需用户确认', category: action }
    }
    // 5. API Key/密钥写入 → ask
    if (context.secretWrite === true) {
      return { decision: 'ask', reason: '检测到密钥/API Key 写入，属于全局安全底线，需用户确认', category: action }
    }
    // 6. 批量数据修改 >1000 行 → ask
    if (action === ACTIONS.BULK_DATA_MODIFY && Number(context.rowCount) > 1000) {
      return { decision: 'ask', reason: `批量修改 ${context.rowCount} 行（>1000 行阈值），属于全局安全底线，需用户确认`, category: action }
    }

    // ---- 模式矩阵 ----
    const mode = this.getMode()
    const matrix = MODE_MATRIX[mode] ?? MODE_MATRIX[MODES.USER]
    const decision = matrix[action] ?? 'ask'
    const reason = decision === 'auto'
      ? `当前审批模式 ${mode}：动作 ${action} 属自动放行范围`
      : `当前审批模式 ${mode}：动作 ${action} 需用户确认`
    return { decision, reason, category: action }
  }
}
