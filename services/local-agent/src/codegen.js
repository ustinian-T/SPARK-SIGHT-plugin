// 引擎适配层：依据真实字段生成 Python / R / MATLAB 三引擎源码（确定性模板，供沙箱执行）。
// 设计要点：
//  - Python 代码统一注入 Agg 后端与 CJK 字体自动探测（RENDER 类问题前置规避）；
//  - 每个方案同时输出 PNG 与 SVG（SVG 供前端预览与证据核验）；
//  - pythonFallbackCode 仅依赖标准库 csv + matplotlib（DEPENDENCY 修复：pandas/numpy 缺失时使用）；
//  - expectedArtifacts 声明沙箱必须回收的产物，缺失即判定 RENDER 失败。

// 字符串字面量转义：列名、文件名、标题（来自 CSV 表头/上传文件名/prompt）均为不可信输入，
// 严禁直接拼进源码字符串（引号逃逸即可注入任意代码）。所有插值必须经过对应引擎的转义函数。
// 科研规则 §5.1：Nature 低饱和九色板（规则包 v0.4 强制默认配色；分类数据从第 1 色依次取，禁止 jet 彩虹色）
const NATURE_COLORS = ['#6E8FB2', '#7DA494', '#EAB67A', '#E5A79A', '#C16E71', '#ABCCE5', '#D8A0C1', '#9F8DB8', '#D0D08A']
function escapeForQuoted(s, { matlab = false } = {}) {
  return String(s ?? '')
    .replace(/\\/g, matlab ? '\\' : '\\\\')
    .replace(/"/g, matlab ? '"' : '\\"')
    .replace(/'/g, matlab ? "''" : "'")
    .replace(/\r/g, matlab ? ' ' : '\\r')
    .replace(/\n/g, matlab ? ' ' : '\\n')
    .replace(/\t/g, matlab ? ' ' : '\\t')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, matlab ? ' ' : '')
}
// Python / R 双引号字符串字面量
function pyQ(s) {
  return `"${escapeForQuoted(s)}"`
}
const rQ = pyQ
// MATLAB 单引号字符向量（'' 转义；MATLAB 不支持 \n 转义，控制字符直接替换为空格）
function mQ(s) {
  return `'${escapeForQuoted(s, { matlab: true })}'`
}

function pyList(items) {
  return `[${items.map((m) => pyQ(m)).join(', ')}]`
}

// Agg 后端 + CJK 字体回退（跨平台候选字体，找不到则保持默认并由验证器记录字形风险）
// v0.4.2：matplotlib 环境设置与 CJK 字体统一片段（降级模板复用，不引入 numpy 依赖）
const PY_PLOT_SETUP = `import matplotlib
matplotlib.use("Agg")
from matplotlib import font_manager as _fm
def _setup_cjk_font():
    try:
        _fm.fontManager.addfont(".deep-imaging-fonts/NotoSansCJKsc-Regular.otf")
    except (OSError, RuntimeError) as _font_error:
        print("WARNING CJK_FONT_BUNDLE_UNAVAILABLE: 中文字体资源未就绪，尝试系统字体回退。")
    candidates = ["Noto Sans CJK SC", "Source Han Sans SC", "Microsoft YaHei", "SimHei", "WenQuanYi Zen Hei",
                  "PingFang SC", "Hiragino Sans GB", "Arial Unicode MS"]
    installed = {f.name for f in _fm.fontManager.ttflist}
    for name in candidates:
        if name in installed:
            matplotlib.rcParams["font.sans-serif"] = [name, "DejaVu Sans"]
            break
    else:
        print("WARNING CJK_FONT_MISSING: 未找到可用中文字体，中文可能显示为方框；请修复安装包字体资源。")
    matplotlib.rcParams["axes.unicode_minus"] = False
_setup_cjk_font()
def _fit_title(s, max_chars=24):
    import textwrap
    return "\\n".join(textwrap.wrap(s, max_chars)) if len(s) > max_chars else s
# 科研规则 §4.3 字号体系：标题 15 加粗 / 轴标签 12.5 / 刻度 10.5 / 图例 10.5（任何文字 ≥10pt）；§4.1 三层纯白底
plt.rcParams.update({
    "font.size": 11,
    "axes.labelsize": 12.5,
    "axes.titlesize": 15,
    "axes.titleweight": "bold",
    "xtick.labelsize": 10.5,
    "ytick.labelsize": 10.5,
    "legend.fontsize": 10.5,
    "figure.facecolor": "white",
    "axes.facecolor": "white",
    "savefig.facecolor": "white"
})
`
const PY_PREAMBLE = `import numpy as np
${PY_PLOT_SETUP}`

function pythonCode(strategy, c) {
  const dpi = c.dpi ?? 160
  const measures = pyList(c.measures)
  const colors = pyList(c.colors?.length ? c.colors : NATURE_COLORS.slice(0, 4))
  if (strategy === 'clarity') {
    return `# 方案一（信息清晰优先）· Python / Matplotlib
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from matplotlib.colors import LinearSegmentedColormap
${PY_PREAMBLE}
df = pd.read_csv(${pyQ(c.fileName)})
x_col = ${pyQ(c.x)}
measures = ${measures}
colors = ${colors}

fig, ax = plt.subplots(figsize=(7.2, 4.4), dpi=${dpi}, layout="constrained")
xi = np.arange(len(df))
width = 0.8 / len(measures)
for i, m in enumerate(measures):
    sd = df.get(f"{m}_sd")
    ax.bar(xi + (i - (len(measures) - 1) / 2) * width, df[m], width,
           yerr=sd, capsize=3, label=m, color=colors[i % len(colors)])
ax.set_xticks(xi)
ax.set_xticklabels(df[x_col])
ax.set_xlabel(${pyQ(c.xLabel ?? c.x)})
ax.set_ylabel(${pyQ(c.yLabel)})
ax.set_title(_fit_title(${pyQ(c.title)}), pad=14)
ax.legend(frameon=False, ncol=min(len(measures), 3), loc="upper left")
ax.spines[["top", "right"]].set_visible(False)
ax.grid(True, linestyle="--", color="#C8C8C8", alpha=0.35, linewidth=0.6)
${''} # 图注由结果分析区展示，不叠加到图内
${''}
fig.savefig("plan_clarity.png", dpi=${dpi}, facecolor="white")
fig.savefig("plan_clarity.svg", facecolor="white")
`
  }
  if (strategy === 'convention') {
    return `# 方案二（论文惯例优先）· Python / Matplotlib（含误差棒，黑白打印友好）
import pandas as pd
import matplotlib.pyplot as plt
${PY_PREAMBLE}
plt.rcParams.update({
    "axes.grid": True, "grid.linestyle": "--", "grid.alpha": 0.3, "grid.linewidth": 0.6, "grid.color": "#C8C8C8"
})
df = pd.read_csv(${pyQ(c.fileName)})
x_col = ${pyQ(c.x)}
measures = ${measures}
colors = ${colors}
markers = ["o", "s", "^", "D"]

fig, ax = plt.subplots(figsize=(6.8, 4.6), dpi=${dpi}, layout="constrained")
for i, m in enumerate(measures):
    ax.errorbar(df[x_col], df[m], yerr=df.get(f"{m}_sd"),
                marker=markers[i % len(markers)], capsize=2.5,
                linewidth=1.4, label=m, color=colors[i % len(colors)])
ax.set_xlabel(${pyQ(c.xLabel ?? c.x)})
ax.set_ylabel(${pyQ(c.yLabel)})
ax.set_title(_fit_title(${pyQ(c.title)}), pad=14)
ax.legend(frameon=False, loc="upper left")
# 显著性/参考线等注释由 AnnotationSpec 受控生成，避免人工硬编码
${''} # 图注由结果分析区展示，不叠加到图内
${''}
fig.savefig("plan_convention.pdf", facecolor="white")
fig.savefig("plan_convention.png", dpi=300, facecolor="white")
fig.savefig("plan_convention.svg", facecolor="white")
`
  }
  return `# 方案三（信息密度优先）· Python / Matplotlib（双面板：原始趋势 + 相对首点变化）
import pandas as pd
import matplotlib.pyplot as plt
${PY_PREAMBLE}
df = pd.read_csv(${pyQ(c.fileName)})
x_col = ${pyQ(c.x)}
measures = ${measures}
colors = ${colors}

fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(10.2, 4.2), dpi=${dpi}, layout="constrained")
for i, m in enumerate(measures):
    ax1.plot(df[x_col], df[m], marker="o", linewidth=1.3, label=m, color=colors[i % len(colors)])
    base = df[m].iloc[0] if df[m].iloc[0] != 0 else 1
    ax2.plot(df[x_col], 100.0 * df[m] / base, marker="o", linewidth=1.3, label=m, color=colors[i % len(colors)])
ax1.set_title("原始趋势", pad=12)
ax1.set_ylabel(${pyQ(c.yLabel)})
ax2.set_title("相对首点变化 (%)", pad=12)
ax2.axhline(100, color="#888", linewidth=0.8, linestyle="--")
for ax in (ax1, ax2):
    ax.set_xlabel(${pyQ(c.xLabel ?? c.x)})
    ax.grid(True, linestyle="--", color="#C8C8C8", alpha=0.3, linewidth=0.6)
    ax.legend(frameon=False, fontsize=8.5)
fig.suptitle(_fit_title(${pyQ(c.title)}))
${''} # 图注由结果分析区展示，不叠加到图内
${''}
fig.savefig("plan_density.png", dpi=${dpi}, facecolor="white")
fig.savefig("plan_density.svg", facecolor="white")
`
}

// DEPENDENCY 修复：仅用标准库 csv + matplotlib（numpy 随 matplotlib 安装，不依赖 pandas）
function pythonFallbackCode(strategy, c) {
  const dpi = Math.min(c.dpi ?? 120, 120)
  const measures = pyList(c.measures)
  const colors = pyList(c.colors?.length ? c.colors : NATURE_COLORS.slice(0, 4))
  const head = `# 降级模板（无 pandas）· 标准库 csv + matplotlib
import csv
import matplotlib.pyplot as plt
${PY_PLOT_SETUP}
rows = list(csv.DictReader(open(${pyQ(c.fileName)}, encoding="utf-8-sig")))
x_col = ${pyQ(c.x)}
measures = ${measures}
colors = ${colors}
x = [r[x_col] for r in rows]
def col(m):
    return [float(r[m]) if r[m] not in ("", None) else 0.0 for r in rows]
xi = list(range(len(x)))
`
  if (strategy === 'clarity') {
    return `${head}
fig, ax = plt.subplots(figsize=(7.2, 4.4), dpi=${dpi}, layout="constrained")
width = 0.8 / len(measures)
for i, m in enumerate(measures):
    y = col(m)
    sd = col(m + "_sd") if rows and (m + "_sd") in rows[0] else None
    ax.bar([t + (i - (len(measures) - 1) / 2) * width for t in xi], y, width,
           yerr=sd, capsize=3, label=m, color=colors[i % len(colors)])
ax.set_xticks(xi); ax.set_xticklabels(x)
ax.set_xlabel(${pyQ(c.xLabel ?? c.x)}); ax.set_ylabel(${pyQ(c.yLabel)}); ax.set_title(_fit_title(${pyQ(c.title)}), pad=14)
ax.legend(frameon=False, ncol=min(len(measures), 3), loc="upper left")
ax.spines[["top", "right"]].set_visible(False)
ax.grid(True, linestyle="--", color="#C8C8C8", alpha=0.35, linewidth=0.6)
fig.savefig("plan_clarity.png", dpi=${dpi}, facecolor="white")
fig.savefig("plan_clarity.svg", facecolor="white")
`
  }
  if (strategy === 'convention') {
    return `${head}
markers = ["o", "s", "^", "D"]
fig, ax = plt.subplots(figsize=(6.8, 4.6), dpi=${dpi}, layout="constrained")
for i, m in enumerate(measures):
    y = col(m)
    sd = col(m + "_sd") if rows and (m + "_sd") in rows[0] else None
    ax.errorbar(xi, y, yerr=sd, marker=markers[i % 4], capsize=2.5,
                linewidth=1.4, label=m, color=colors[i % len(colors)])
ax.set_xticks(xi); ax.set_xticklabels(x)
ax.set_xlabel(${pyQ(c.xLabel ?? c.x)}); ax.set_ylabel(${pyQ(c.yLabel)}); ax.set_title(_fit_title(${pyQ(c.title)}), pad=14)
ax.grid(alpha=0.25); ax.legend(frameon=False, loc="upper left")
fig.savefig("plan_convention.png", dpi=300, facecolor="white")
fig.savefig("plan_convention.svg", facecolor="white")
# PDF 矢量稿由 matplotlib 内置 pdf 后端生成，无需 pandas；expectedArtifacts 要求随附
fig.savefig("plan_convention.pdf", facecolor="white")
`
  }
  return `${head}
fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(10.2, 4.2), dpi=${dpi}, layout="constrained")
for i, m in enumerate(measures):
    y = col(m)
    base = y[0] if y[0] != 0 else 1.0
    ax1.plot(xi, y, marker="o", linewidth=1.3, label=m, color=colors[i % len(colors)])
    ax2.plot(xi, [100.0 * v / base for v in y], marker="o", linewidth=1.3, label=m, color=colors[i % len(colors)])
for ax in (ax1, ax2):
    ax.set_xticks(xi); ax.set_xticklabels(x); ax.set_xlabel(${pyQ(c.xLabel ?? c.x)}); ax.grid(True, linestyle="--", color="#C8C8C8", alpha=0.3, linewidth=0.6)
    ax.legend(frameon=False, fontsize=8.5)
ax1.set_title("原始趋势", pad=12); ax1.set_ylabel(${pyQ(c.yLabel)})
ax2.set_title("相对首点变化 (%)", pad=12); ax2.axhline(100, color="#888", linewidth=0.8, linestyle="--")
fig.suptitle(_fit_title(${pyQ(c.title)}))
fig.savefig("plan_density.png", dpi=${dpi}, facecolor="white")
fig.savefig("plan_density.svg", facecolor="white")
`
}

function rCode(strategy, c) {
  const m = c.measures.map((x) => rQ(x)).join(', ')
  const palette = `c(${(c.colors?.length ? c.colors : NATURE_COLORS.slice(0, 4)).map((x) => rQ(x)).join(', ')})`
  if (strategy === 'clarity') {
    return `# 方案一 · R / ggplot2
library(ggplot2)
df <- read.csv(${rQ(c.fileName)}, check.names = FALSE)
long <- reshape(df, varying = c(${m}), v.names = "value",
                times = c(${m}), idvar = ${rQ(c.x)}, direction = "long")
p <- ggplot(long, aes(x = factor(.data[[${rQ(c.x)}]]), y = value, fill = time)) +
  geom_col(position = position_dodge(0.8), width = 0.7) +
  labs(x = ${rQ(c.xLabel ?? c.x)}, y = ${rQ(c.yLabel)}, title = paste(strwrap(${rQ(c.title)}, 24), collapse = "\\n"), fill = NULL) +
  scale_fill_manual(values = ${palette}) +
  theme_bw(base_size = 11) + theme(legend.position = "top")
ggsave("plan_clarity.png", p, width = 7.2, height = 4.4, dpi = 300)
ggsave("plan_clarity.svg", p, width = 7.2, height = 4.4)
`
  }
  if (strategy === 'convention') {
    return `# 方案二 · R / ggplot2（误差棒）
library(ggplot2)
df <- read.csv(${rQ(c.fileName)}, check.names = FALSE)
long <- reshape(df, varying = c(${m}), v.names = "value",
                times = c(${m}), idvar = ${rQ(c.x)}, direction = "long")
long$sd <- mapply(function(series, observation) {
  error_col <- paste0(series, "_sd")
  if (error_col %in% names(df)) as.numeric(df[[error_col]][match(observation, df[[${rQ(c.x)}]])]) else 0
}, as.character(long$time), long[[${rQ(c.x)}]])
p <- ggplot(long, aes(x = .data[[${rQ(c.x)}]], y = value, color = time, group = time)) +
  geom_line(linewidth = 0.7) + geom_point(size = 1.6) +
  geom_errorbar(aes(ymin = value - sd, ymax = value + sd), width = 0.2) +
  labs(x = ${rQ(c.xLabel ?? c.x)}, y = ${rQ(c.yLabel)}, title = paste(strwrap(${rQ(c.title)}, 24), collapse = "\\n"), color = NULL) +
  scale_color_manual(values = ${palette}) +
  theme_bw(base_size = 11) + theme(legend.position = "top")
ggsave("plan_convention.png", p, width = 6.8, height = 4.6, dpi = 300)
ggsave("plan_convention.svg", p, width = 6.8, height = 4.6)
`
  }
  return `# 方案三 · R / ggplot2（双面板）
library(ggplot2)
library(tidyr)
library(dplyr)
df <- read.csv(${rQ(c.fileName)}, check.names = FALSE)
norm <- df %>% mutate(across(c(${m}), ~ 100 * .x / first(.x)))
p1 <- ggplot(tidyr::pivot_longer(df, c(${m})), aes(x = .data[[${rQ(c.x)}]], value, color = name)) +
  geom_line() + geom_point() + scale_color_manual(values = ${palette}) + labs(title = "原始趋势", y = ${rQ(c.yLabel)})
p2 <- ggplot(tidyr::pivot_longer(norm, c(${m})), aes(x = .data[[${rQ(c.x)}]], value, color = name)) +
  geom_line() + geom_point() + geom_hline(yintercept = 100, linetype = "dashed") +
  scale_color_manual(values = ${palette}) + labs(title = "相对首点变化 (%)")
ggsave("plan_density.png", patchwork::wrap_plots(p1, p2, nrow = 1), width = 10, height = 4, dpi = 300)
ggsave("plan_density.svg", patchwork::wrap_plots(p1, p2, nrow = 1), width = 10, height = 4)
`
}

function matlabCode(strategy, c) {
  const colors = (c.colors?.length ? c.colors : NATURE_COLORS.slice(0, 4)).map((hex) => {
    const raw = hex.replace('#', '')
    return `${parseInt(raw.slice(0, 2), 16)} ${parseInt(raw.slice(2, 4), 16)} ${parseInt(raw.slice(4, 6), 16)}`
  }).join('; ')
  const head = `% 仅可在已合法安装并授权 MATLAB 的执行节点运行；产品不打包、不再分发 MATLAB 运行时。\nT = readtable(${mQ(c.fileName)});\nx = T.(${mQ(c.x)});\nplotColors = [${colors}] / 255;\nset(groot,'defaultAxesColorOrder',plotColors);
% 科研规则 §9.2 字体统一黑体 SimHei；§4.3 字号体系
set(0,'DefaultAxesFontName','SimHei'); set(0,'DefaultTextFontName','SimHei');
set(0,'DefaultAxesFontSize',11); set(0,'DefaultTextFontSize',11);\n`
  if (strategy === 'clarity') {
    return `${head}measures = {${c.measures.map((x) => mQ(x)).join(', ')}};
figure('Color','w'); hold on;
for k = 1:numel(measures)
    bar(x + (k-(numel(measures)+1)/2)*0.25, T.(measures{k}), 0.25);
end
xticks(x); xlabel(${mQ(c.xLabel ?? c.x)},'FontSize',12.5); ylabel(${mQ(c.yLabel)},'FontSize',12.5); title(${mQ(c.title)},'FontSize',15,'FontWeight','bold','HorizontalAlignment','center');
legend(measures, 'Location', 'northwest', 'FontSize', 11); grid on; set(gca,'GridAlpha',0.3,'GridLineStyle','--'); box on;
exportgraphics(gcf, 'plan_clarity.png', 'Resolution', 300, 'BackgroundColor', 'w');
print('-dsvg', 'plan_clarity.svg');
`
  }
  if (strategy === 'convention') {
    return `${head}measures = {${c.measures.map((x) => mQ(x)).join(', ')}};
figure('Color','w'); hold on; markers = 'os^d';
for k = 1:numel(measures)
    errorbar(x, T.(measures{k}), T.([measures{k} '_sd']), ['-' markers(k)], 'CapSize', 4);
end
xlabel(${mQ(c.xLabel ?? c.x)},'FontSize',12.5); ylabel(${mQ(c.yLabel)},'FontSize',12.5); title(${mQ(c.title)},'FontSize',15,'FontWeight','bold','HorizontalAlignment','center');
legend(measures, 'Location', 'northwest', 'FontSize', 11); grid on; set(gca,'GridAlpha',0.3,'GridLineStyle','--'); box on;
exportgraphics(gcf, 'plan_convention.png', 'Resolution', 300, 'BackgroundColor', 'w');
print('-dsvg', 'plan_convention.svg');
`
  }
  return `${head}measures = {${c.measures.map((x) => mQ(x)).join(', ')}};
figure('Color','w');
subplot(1,2,1); hold on;
for k = 1:numel(measures), plot(x, T.(measures{k}), '-o'); end
title('原始趋势','FontSize',13,'FontWeight','bold'); ylabel(${mQ(c.yLabel)},'FontSize',12.5); legend(measures,'FontSize',11); grid on; set(gca,'GridAlpha',0.3,'GridLineStyle','--');
subplot(1,2,2); hold on;
for k = 1:numel(measures), plot(x, 100*T.(measures{k})./T.(measures{k})(1), '-o'); end
yline(100,'--'); title('相对首点变化 (%)','FontSize',13,'FontWeight','bold'); grid on; set(gca,'GridAlpha',0.3,'GridLineStyle','--');
sgtitle(${mQ(c.title)},'FontSize',15,'FontWeight','bold');
exportgraphics(gcf, 'plan_density.png', 'Resolution', 300, 'BackgroundColor', 'w');
print('-dsvg', 'plan_density.svg');
`
}

function specKinds(spec) {
  return spec.panels.map((panel) => panel.layers?.[0]?.kind ?? 'line')
}

// ---------- v0.4.1 分组模式（长表：分组列 + 数值列 → 组均值 ± 误差棒 + 显著性标注） ----------
// spec.panel.groups = { groupCol, measure } 存在时启用；errorBarMode 取 sd/se/ci，默认 se。
// significance 为 Holm 校正后显著的配对 [{left, right, stars, pValue}]，图上以括号 + 星号标注。
function pyErrorColumn(panel) {
  const mode = panel.errorBarMode ?? 'se'
  if (mode === 'sd') return { expr: 'grouped["std"]', note: '' }
  if (mode === 'ci') return { expr: '1.96 * grouped["sem"]', note: '  # 95% CI（1.96×SE 近似，大样本口径）' }
  return { expr: 'grouped["sem"]', note: '' }
}

function significancePython(panel, ax) {
  const pairs = (panel.significance ?? []).filter((p) => p.stars && p.stars !== 'ns')
  if (!pairs.length) return ''
  // 对象数组不能用 pyList（会把对象转成 "[object Object]"）；用 JSON 字面量（Python dict/list 语法兼容）
  const serialized = JSON.stringify(pairs.map((p) => ({ left: p.left, right: p.right, stars: p.stars })))
    .replace(/\btrue\b/g, 'True').replace(/\bfalse\b/g, 'False').replace(/\bnull\b/g, 'None')
  return `
# 组间显著性标注（Holm 校正后 p 值；* p<0.05, ** p<0.01, *** p<0.001）
_y_max = float(grouped["mean"].max())
for _k, _s in enumerate(${serialized}):
    _i = list(grouped.index).index(_s["left"])
    _j = list(grouped.index).index(_s["right"])
    _y = max(float(grouped["mean"].iloc[_i]), float(grouped["mean"].iloc[_j])) + (0.06 + 0.06 * _k) * _y_max
    _h = 0.05 * _y_max
    ${ax}.plot([_i, _i, _j, _j], [_y, _y + _h, _y + _h, _y], color="#333333", linewidth=0.9)
    ${ax}.text((_i + _j) / 2, _y + _h, _s["stars"], ha="center", va="bottom", fontsize=10)`
}

function groupedPython(panel, ax, kind) {
  const g = panel.groups
  const err = pyErrorColumn(panel)
  // 时间×分组长表必须按“时间、组别”聚合；只按组别聚合会把组值错误地变成横轴。
  if (g.xCol) {
    const timeHead = `grouped = df.groupby([${pyQ(g.xCol)}, ${pyQ(g.groupCol)}], sort=False)[${pyQ(g.measure)}].agg(mean="mean", std="std", count="count", sem="sem").reset_index()
_xvals = list(pd.unique(df[${pyQ(g.xCol)}]))
_groups = list(pd.unique(df[${pyQ(g.groupCol)}]))
_xpos = np.arange(len(_xvals))`
    const errCol = pyQ(panel.errorBarMode === 'sd' ? 'std' : 'sem')
    if (kind === 'bar') {
      return `${timeHead}
_bw = 0.8 / max(1, len(_groups))
for _gi, _gn in enumerate(_groups):
    _sub = grouped[grouped[${pyQ(g.groupCol)}] == _gn].set_index(${pyQ(g.xCol)}).reindex(_xvals)
    ${ax}.bar(_xpos + (_gi - (len(_groups) - 1) / 2) * _bw, _sub["mean"], _bw, yerr=_sub[${errCol}], capsize=3, label=str(_gn), color=colors[_gi % len(colors)], alpha=${Number(panel.barAlpha ?? 1)})
${ax}.set_xticks(_xpos, [str(_v) for _v in _xvals], rotation=30, ha="right")
${ax}.legend(frameon=False)`
    }
    const band = panel.confidenceBand
      ? `\n    ${ax}.fill_between(_xpos, _sub["mean"] - _sub[${errCol}], _sub["mean"] + _sub[${errCol}], alpha=0.16, color=colors[_gi % len(colors)])`
      : ''
    return `${timeHead}
for _gi, _gn in enumerate(_groups):
    _sub = grouped[grouped[${pyQ(g.groupCol)}] == _gn].set_index(${pyQ(g.xCol)}).reindex(_xvals)
    ${ax}.errorbar(_xpos, _sub["mean"], yerr=_sub[${errCol}], marker="o", markersize=3.8, markeredgewidth=0.45, capsize=2, elinewidth=0.8, linewidth=1.35, alpha=0.96, zorder=3, label=str(_gn), color=colors[_gi % len(colors)])${band}
${ax}.set_xticks(_xpos, [str(_v) for _v in _xvals], rotation=30, ha="right")
${ax}.legend(frameon=False)`
  }
  const head = `grouped = df.groupby(${pyQ(g.groupCol)}, sort=False)[${pyQ(g.measure)}].agg(mean="mean", std="std", count="count", sem="sem")
xi = range(len(grouped))`
  if (kind === 'bar') {
    return `${head}
${ax}.bar(xi, grouped["mean"], yerr=${err.expr}, capsize=3, color=colors[0], edgecolor="#555555", linewidth=0.6,
          hatch=${pyQ(panel.barHatch ?? '')}, alpha=${Number(panel.barAlpha ?? 1)})${err.note}
${panel.showObservations ? `for _gi, _gn in enumerate(grouped.index):
    _gv = df.loc[df[${pyQ(g.groupCol)}] == _gn, ${pyQ(g.measure)}].dropna().to_numpy()
    ${ax}.scatter(_gi + np.linspace(-0.12, 0.12, len(_gv)), _gv, s=20, color="#333333", zorder=5)` : ''}
${ax}.set_xticks(range(len(grouped)), grouped.index.astype(str), rotation=30, ha="right")${significancePython(panel, ax)}`
  }
  const band = panel.confidenceBand
    ? `
${ax}.fill_between(xi, grouped["mean"] - ${err.expr}, grouped["mean"] + ${err.expr}, alpha=0.18, color=colors[0])${err.note}`
    : ''
  return `${head}${band}
${ax}.errorbar(xi, grouped["mean"], yerr=${err.expr}, marker="o", capsize=3, linewidth=1.4, color=colors[0])${err.note}
${ax}.set_xticks(range(len(grouped)), grouped.index.astype(str), rotation=30, ha="right")${significancePython(panel, ax)}`
}

function groupedR(panel, kind) {
  const g = panel.groups
  const errCol = panel.errorBarMode === 'sd' ? 'g_sd' : panel.errorBarMode === 'ci' ? '1.96 * g_se' : 'g_se'
  const agg = `grp <- df %>% group_by(.data[[${rQ(g.groupCol)}]]) %>%
  summarise(g_mean = mean(.data[[${rQ(g.measure)}]], na.rm = TRUE),
            g_sd = sd(.data[[${rQ(g.measure)}]], na.rm = TRUE),
            g_se = g_sd / sqrt(sum(!is.na(.data[[${rQ(g.measure)}]]))))`
  if (kind === 'bar') {
    return `${agg}
p <- ggplot(grp, aes(x = .data[[${rQ(g.groupCol)}]], y = g_mean)) +
  geom_col(fill = ${rQ(panel.layers?.[0]?.color ?? '#6E8FB2')}, width = 0.65, alpha = ${Number(panel.barAlpha ?? 1)}) +
  geom_errorbar(aes(ymin = g_mean - ${errCol}, ymax = g_mean + ${errCol}), width = 0.22) +
  ${panel.showObservations ? `geom_point(data = df, aes(y = .data[[${rQ(g.measure)}]]), position = position_jitter(width = 0.1, height = 0, seed = 42), size = 1.8, color = "#333333") +` : ''}
  labs(x = ${rQ(panel.scales?.find(s => s.axis === 'x')?.label ?? g.groupCol)}, y = ${rQ(panel.scales?.find(s => s.axis === 'y')?.label ?? g.measure)}, title = NULL) +
  theme_bw(base_size = 11)
print(p)`
  }
  return `${agg}
p <- ggplot(grp, aes(x = .data[[${rQ(g.groupCol)}]], y = g_mean)) +
  geom_line(color = "#6E8FB2", linewidth = 0.8) +
  geom_point(color = "#6E8FB2", size = 2) +
  geom_errorbar(aes(ymin = g_mean - ${errCol}, ymax = g_mean + ${errCol}), width = 0.14) +
  labs(x = ${rQ(g.groupCol)}, y = ${rQ(g.measure)}, title = NULL) +
  theme_bw(base_size = 11)
print(p)`
}

function groupedMatlab(panel, kind) {
  const g = panel.groups
  const errExpr = panel.errorBarMode === 'sd' ? 'grpSD' : panel.errorBarMode === 'ci' ? '1.96 * grpSE' : 'grpSE'
  const agg = `[grpID, grpName] = grp2idx(T.(${mQ(g.groupCol)}));
grpMean = splitapply(@mean, T.(${mQ(g.measure)}), grpID);
grpSD = splitapply(@(x) std(x, 0, 'omitnan'), T.(${mQ(g.measure)}), grpID);
grpN = splitapply(@(x) sum(~isnan(x)), T.(${mQ(g.measure)}), grpID);
grpSE = grpSD ./ sqrt(grpN);`
  if (kind === 'bar') {
    return `nexttile;
${agg}
bar(grpMean); hold on;
errorbar(1:numel(grpName), grpMean, ${errExpr}, 'k', 'linestyle', 'none');
xticks(1:numel(grpName)); xticklabels(grpName); ylabel(${mQ(g.measure)});
hold off;`
  }
  return `nexttile;
${agg}
errorbar(1:numel(grpName), grpMean, ${errExpr}, '-o', 'CapSize', 4);
xticks(1:numel(grpName)); xticklabels(grpName); ylabel(${mQ(g.measure)});`
}

export function validateChartSpec(spec, input) {
  if (!spec?.figure || !Array.isArray(spec.panels) || spec.panels.length === 0) {
    throw new Error('INVALID_CHART_SPEC')
  }
  const supported = new Set(['line', 'bar', 'scatter', 'bubble', 'lollipop', 'waterfall', 'heatmap', 'histogram', 'boxplot', 'dual_axis', 'surface3d', 'scatter3d', 'cone3d', 'line3d', 'filled_line3d', 'box_jitter', 'violin', 'dotplot', 'paired', 'stacked', 'forest'])
  const kinds = specKinds(spec)
  const unsupported = kinds.find((kind) => !supported.has(kind))
  if (unsupported) throw new Error(`UNSUPPORTED_CHART_KIND:${unsupported}`)
  if (kinds.some((kind) => ['surface3d', 'scatter3d', 'cone3d', 'line3d', 'filled_line3d'].includes(kind)) && input.measures.length < 3) {
    throw new Error('SURFACE_REQUIRES_THREE_NUMERIC_MEASURES')
  }
  if (kinds.some((kind) => kind === 'dual_axis') && input.measures.length < 2) {
    throw new Error('DUAL_AXIS_REQUIRES_TWO_MEASURES')
  }
  if (kinds.some((kind) => kind === 'bubble') && input.measures.length < 2) {
    throw new Error('BUBBLE_REQUIRES_TWO_NUMERIC_MEASURES')
  }
  if (kinds.some((kind) => ['paired', 'stacked'].includes(kind)) && input.measures.length < 2) {
    throw new Error('PAIRED_STACKED_REQUIRES_TWO_MEASURES')
  }
  if (kinds.some((kind) => kind === 'heatmap') && input.measures.length < 2) {
    throw new Error('HEATMAP_REQUIRES_TWO_NUMERIC_MEASURES')
  }
}

function specPython(spec, c, outputBase) {
  const rows = Math.max(1, Number(spec.figure.rows) || 1)
  const cols = Math.max(1, Number(spec.figure.cols) || 1)
  const measures = pyList(c.measures)
  const colors = pyList(c.colors?.length ? c.colors : spec.panels.flatMap((panel) => panel.layers ?? []).map((layer) => layer.color).filter(Boolean))
  const f = spec.figure
  const is3d = (kind) => ['surface3d', 'scatter3d', 'cone3d', 'line3d', 'filled_line3d'].includes(kind)
  const figureWidth = specKinds(spec).some(is3d) ? Math.max(8.4, cols * 5.4) : Math.max(6.4, cols * 4.4)
  const statements = specKinds(spec).map((kind, index) => {
    const ax = `axes.flat[${index}]`
    const panel = spec.panels[index]
    if (kind === 'bar') {
      if (panel.groups) return groupedPython(panel, ax, 'bar')
      return `_bx = np.arange(len(df))
_bw = 0.8 / max(1, len(measures))
for _bi, _bm in enumerate(measures):
    ${ax}.bar(_bx + (_bi - (len(measures) - 1) / 2) * _bw, df[_bm], _bw,
             yerr=df.get(_bm + "_sd"), capsize=3, label=_bm, color=colors[_bi % len(colors)])
${ax}.legend(frameon=False)
${ax}.set_xticks(range(len(df)), df[x_col].astype(str), rotation=30, ha="right")`
    }
    if (kind === 'scatter') {
      return `${ax}.scatter(df[measures[0]], df[measures[1]], alpha=0.8)
${ax}.set_xlabel(measures[0]); ${ax}.set_ylabel(measures[1])`
    }
    if (kind === 'bubble') {
      return `_bx = df[measures[0]].to_numpy(dtype=float)
_by = df[measures[1]].to_numpy(dtype=float)
_bs = df[measures[2]].to_numpy(dtype=float) if len(measures) > 2 else np.ones(len(df), dtype=float)
_bm = np.isfinite(_bx) & np.isfinite(_by) & np.isfinite(_bs)
if _bm.sum() < 3 or len(np.unique(_bx[_bm])) < 2 or len(np.unique(_by[_bm])) < 2: raise ValueError("气泡图需要至少 3 个完整观测且横纵坐标均有变化")
_size = 90 + 520 * (_bs[_bm] - np.min(_bs[_bm])) / max(np.ptp(_bs[_bm]), 1e-9)
_bubble = ${ax}.scatter(_bx[_bm], _by[_bm], s=_size, c=_by[_bm], cmap="plasma", alpha=0.78, edgecolors="white", linewidths=0.9)
${ax}.set_xlabel(measures[0]); ${ax}.set_ylabel(measures[1])
_cb = fig.colorbar(_bubble, ax=${ax}, fraction=0.046, pad=0.04)
_cb.set_label(measures[1])`
    }
    if (kind === 'lollipop') {
      const categoryCol = panel.categoryCol ? pyQ(panel.categoryCol) : null
      return `_lp = df[[x_col, measures[0]${categoryCol ? `, ${categoryCol}` : ''}]].dropna().copy()
_lp = _lp.sort_values(measures[0], ascending=True)
_ly = np.arange(len(_lp))
_lv = _lp[measures[0]].to_numpy(dtype=float)
${ax}.hlines(_ly, 0, _lv, color="#B8C7D9", linewidth=2.2, zorder=1)
${categoryCol ? `_cats = _lp[${categoryCol}].astype(str).to_numpy()
_cat_names = list(dict.fromkeys(_cats.tolist()))
_cat_colors = { _cat: colors[_ci % len(colors)] for _ci, _cat in enumerate(_cat_names) }
_dot_colors = [_cat_colors[_cat] for _cat in _cats]` : `_dot_colors = [colors[0]] * len(_lp)`}
${ax}.scatter(_lv, _ly, s=115, color=_dot_colors, edgecolors="white", linewidths=1.2, zorder=3)
for _v, _y in zip(_lv, _ly):
    ${ax}.text(_v, _y, f"  {_v:.2f}", va="center", ha="left", fontsize=10, color="#334155")
${ax}.set_yticks(_ly, _lp[x_col].astype(str))
${ax}.set_xlabel(measures[0])
${ax}.spines["top"].set_visible(False); ${ax}.spines["right"].set_visible(False); ${ax}.spines["left"].set_visible(False)
${categoryCol ? `for _cat, _color in _cat_colors.items(): ${ax}.scatter([], [], color=_color, s=70, label=_cat)
${ax}.legend(frameon=False, loc="lower right")` : ''}`
    }
    if (kind === 'waterfall') {
      return `_wf = df[[x_col, measures[0]]].dropna().copy()
_wf[measures[0]] = _wf[measures[0]].astype(float)
_wf = _wf.reset_index(drop=True)
_wf_vals = _wf[measures[0]].to_numpy(dtype=float)
_wf_cum = np.concatenate(([0.0], np.cumsum(_wf_vals)))
_wf_bottom = _wf_cum[:-1].copy()
_wf_height = _wf_vals.copy()
_wf_colors = [('#2A9D8F' if _v >= 0 else '#E76F51') for _v in _wf_vals]
${ax}.bar(range(len(_wf_vals)), _wf_height, bottom=_wf_bottom, color=_wf_colors, edgecolor='white', linewidth=0.6)
${ax}.plot(range(len(_wf_vals)), _wf_cum[1:], color='#334155', linewidth=1.0, marker='o', markersize=3)
_wf_lo, _wf_hi = float(np.min(_wf_cum)), float(np.max(_wf_cum))
_wf_pad = max((_wf_hi - _wf_lo) * 0.1, 1.0)
${ax}.set_ylim(_wf_lo - _wf_pad, _wf_hi + _wf_pad)
${ax}.set_xticks(range(len(_wf_vals)), _wf[x_col].astype(str), rotation=30, ha='right')
${ax}.set_ylabel(measures[0]); ${ax}.axhline(0, color='#64748B', linewidth=0.8)`
    }
    if (kind === 'heatmap') {
      // 科研规则 §10.5：相关性热力图默认蓝白红发散（白为 0）；矩阵较小（≤8 维）时标注数值
      const cmap = f.colormap === 'user_ocean'
        ? 'LinearSegmentedColormap.from_list("user_ocean_corr", ["#DDF2F0", "#A6EBDD", "#88C9D0", "#929ED2", "#5E8CBE", "#3E5682", "#0F1633"], N=256)'
        : f.colormap === 'viridis_like'
        ? 'plt.get_cmap("viridis")'
        : f.colormap === 'magma_like'
          ? 'plt.get_cmap("magma")'
          : f.colormap === 'teal_gold'
        ? 'LinearSegmentedColormap.from_list("teal_gold_corr", ["#203A43", "#2A9D8F", "#F4E9CD", "#E9C46A", "#C44536"], N=256)'
        : f.colormap === 'inspiration'
          ? 'LinearSegmentedColormap.from_list("inspiration_corr", ["#3B4C6B", "#7FAED7", "#F7F4EA", "#E89A82", "#8F2D56"], N=256)'
          : `plt.get_cmap(${pyQ(f.colormap ?? 'viridis')})`
      const annotate = c.measures.length <= 8
      return `corr = df[measures].corr(min_periods=3)
if len(measures) < 2 or int(np.isfinite(corr.to_numpy(dtype=float)).sum()) < 4: raise ValueError("热力图需要至少 2 个数值字段且存在有效成对观测")
im = ${ax}.imshow(corr, vmin=-1, vmax=1, cmap=${cmap})
${ax}.set_xticks(range(len(measures)), measures, rotation=35, ha="right")
${ax}.set_yticks(range(len(measures)), measures)
${ax}.set_aspect("equal")
${annotate ? `for _i in range(len(measures)):
    for _j in range(len(measures)):
        _cell_value = float(corr.iloc[_i, _j])
        _cell_rgba = im.cmap(im.norm(_cell_value))
        _cell_luminance = 0.2126 * _cell_rgba[0] + 0.7152 * _cell_rgba[1] + 0.0722 * _cell_rgba[2]
        _cell_text_color = "white" if _cell_luminance < 0.48 else "#111827"
        ${ax}.text(_j, _i, f"{_cell_value:.2f}", ha="center", va="center", fontsize=${Number(f.annotationSize ?? 8.5)}, color=_cell_text_color)` : ''}
_cb = fig.colorbar(im, ax=${ax}, fraction=0.046, pad=0.04)
_cb.set_label("相关系数")`
    }
    if (kind === 'histogram') return `${ax}.hist(df[measures[0]].dropna(), bins="auto", alpha=0.82, edgecolor="white")\n${ax}.set_xlabel(measures[0]); ${ax}.set_ylabel("Frequency")`
    if (kind === 'boxplot') return `${ax}.boxplot([df[m].dropna() for m in measures], tick_labels=measures, showmeans=True)\n${ax}.tick_params(axis="x", rotation=30)`
    if (kind === 'box_jitter') {
      // 箱线 + 抖动散点：科研论文展示原始分布 + 中位数/均值，分组形态按组绘制
      if (panel.groups) {
        const g = panel.groups
        return `grouped = df.groupby(${pyQ(g.groupCol)}, sort=False)[${pyQ(g.measure)}].agg(mean="mean", std="std", count="count", sem="sem")
_gparts = [df.loc[df[${pyQ(g.groupCol)}] == _nm, ${pyQ(g.measure)}].dropna().to_numpy() for _nm in grouped.index]
_bp = ${ax}.boxplot(_gparts, tick_labels=grouped.index.astype(str), showmeans=True, patch_artist=True,
             medianprops={"color": "#263238", "linewidth": 1.6}, boxprops={"facecolor": "white", "alpha": 0.82})
for _vi, _box in enumerate(_bp["boxes"]):
    _box.set_facecolor(colors[_vi % len(colors)])
_jrng = np.random.default_rng(2026)
for _bi, _vals in enumerate(_gparts):
    ${ax}.scatter(np.full(len(_vals), _bi + 1) + _jrng.uniform(-0.13, 0.13, len(_vals)), _vals, s=22, alpha=0.68, color=colors[_bi % len(colors)], edgecolors="white", linewidths=0.45, zorder=3)
${ax}.set_xticks(range(1, len(grouped) + 1), grouped.index.astype(str), rotation=30, ha="right")${significancePython(panel, ax)}`
      }
      return `_bparts = [df[m].dropna().to_numpy() for m in measures]
${ax}.boxplot(_bparts, tick_labels=measures, showmeans=True, patch_artist=True,
             medianprops={"color": "#333333"}, boxprops={"facecolor": colors[0], "alpha": 0.32})
_jrng = np.random.default_rng(2026)
for _bi, _vals in enumerate(_bparts):
    ${ax}.scatter(np.full(len(_vals), _bi + 1) + _jrng.uniform(-0.13, 0.13, len(_vals)), _vals, s=8, alpha=0.55, color=colors[_bi % len(colors)], zorder=3)
${ax}.tick_params(axis="x", rotation=30)`
    }
    if (kind === 'violin') {
      // 小提琴：分布密度 + 中位数/均值标记；分组形态按组绘制
      if (panel.groups) {
        const g = panel.groups
        return `grouped = df.groupby(${pyQ(g.groupCol)}, sort=False)[${pyQ(g.measure)}].agg(mean="mean", std="std", count="count", sem="sem")
_vparts = [df.loc[df[${pyQ(g.groupCol)}] == _nm, ${pyQ(g.measure)}].dropna().to_numpy() for _nm in grouped.index]
_vp = ${ax}.violinplot(_vparts, positions=range(len(grouped)), showmeans=True, showmedians=True, showextrema=True, bw_method=0.28)
for _vi, _vb in enumerate(_vp["bodies"]):
    _vb.set_facecolor(colors[_vi % len(colors)]); _vb.set_alpha(0.60); _vb.set_edgecolor("white"); _vb.set_linewidth(1.0)
for _vi, _vals in enumerate(_vparts):
    ${ax}.scatter(np.full(len(_vals), _vi) + np.random.default_rng(2026 + _vi).uniform(-0.08, 0.08, len(_vals)), _vals, s=14, color=colors[_vi % len(colors)], alpha=0.45, edgecolors="white", linewidths=0.3, zorder=3)
${ax}.set_xticks(range(len(grouped)), grouped.index.astype(str), rotation=30, ha="right")${significancePython(panel, ax)}`
      }
      return `_vparts = [df[m].dropna().to_numpy() for m in measures]
_vp = ${ax}.violinplot(_vparts, positions=range(len(measures)), showmeans=True, showextrema=False)
for _vi, _vb in enumerate(_vp["bodies"]):
    _vb.set_facecolor(colors[_vi % len(colors)]); _vb.set_alpha(0.38); _vb.set_edgecolor("#333333")
${ax}.set_xticks(range(len(measures)), measures, rotation=30, ha="right")`
    }
    if (kind === 'dotplot') {
      // 误差棒点图（组/系列均值 ± 标准误）：Nature/PNAS 最高频样式
      if (panel.groups) {
        const g = panel.groups
        return `grouped = df.groupby(${pyQ(g.groupCol)}, sort=False)[${pyQ(g.measure)}].agg(mean="mean", std="std", count="count", sem="sem")
${ax}.errorbar(range(len(grouped)), grouped["mean"], yerr=grouped["sem"], fmt="o", capsize=3, markersize=6, color=colors[0])
${ax}.set_xticks(range(len(grouped)), grouped.index.astype(str), rotation=30, ha="right")${significancePython(panel, ax)}`
      }
      return `_dmeans = [df[m].mean() for m in measures]
_dsems = [df[m].sem() for m in measures]
${ax}.errorbar(range(len(measures)), _dmeans, yerr=_dsems, fmt="o", capsize=3, markersize=6, color=colors[0])
${ax}.set_xticks(range(len(measures)), measures, rotation=30, ha="right")`
    }
    if (kind === 'paired') {
      // 配对连线：逐观测连接前/后（或两条件），叠加组均值 ± 标准误与均值差标注（数据驱动）
      return `_plo = df[measures[0]].to_numpy(dtype=float)
_phi = df[measures[1]].to_numpy(dtype=float)
for _pi in range(len(df)):
    ${ax}.plot([0, 1], [_plo[_pi], _phi[_pi]], color="#8A8A8A", alpha=0.4, linewidth=0.9, zorder=1)
    ${ax}.scatter([0, 1], [_plo[_pi], _phi[_pi]], s=16, color=colors[0], alpha=0.75, zorder=3)
_pm0 = float(df[measures[0]].mean()); _pm1 = float(df[measures[1]].mean())
_ps0 = float(df[measures[0]].sem()); _ps1 = float(df[measures[1]].sem())
${ax}.errorbar([0, 1], [_pm0, _pm1], yerr=[_ps0, _ps1], fmt="o", capsize=4, markersize=7, color="#333333", zorder=4)
${ax}.set_xticks([0, 1]); ${ax}.set_xticklabels([measures[0], measures[1]])
${ax}.text(0.5, max(_pm0 + _ps0, _pm1 + _ps1), f"Δmean={_pm0 - _pm1:+.2f}", ha="center", va="bottom", fontsize=10, color="#333333")`
    }
    if (kind === 'stacked') {
      // 堆叠柱状：多系列正值累加为总量，展示构成（非负校验由数据体检提示，不在代码层硬改数据）
      return `_sbottom = np.zeros(len(df))
for _si, _sm in enumerate(measures):
    ${ax}.bar(range(len(df)), df[_sm], bottom=_sbottom, label=_sm, color=colors[_si % len(colors)], edgecolor="white", linewidth=0.4)
    _sbottom = _sbottom + df[_sm].to_numpy(dtype=float)
${ax}.set_xticks(range(len(df)), df[x_col].astype(str), rotation=30, ha="right")
${ax}.legend(frameon=False, fontsize=${Number(f.legendSize ?? 11)})`
    }
    if (kind === 'forest') {
      // 森林图：逐条目均值 ± 95% CI + 参考线（CI 列缺失时按 _sd/_se 后缀近似，数据驱动不编造）
      const fm = panel.forest
      const meanCol = fm?.mean ? pyQ(fm.mean) : 'measures[0]'
      const ciExpr = fm?.ciLow && fm?.ciHigh
        ? `_flo = df[${pyQ(fm.ciLow)}].to_numpy(dtype=float)
_fhi = df[${pyQ(fm.ciHigh)}].to_numpy(dtype=float)`
        : `if f"${String(fm?.mean ?? measures[0])}_sd" in df.columns:
    _fcol = df[f"${String(fm?.mean ?? measures[0])}_sd"].to_numpy(dtype=float)
    _flo = _fmv - 1.96 * _fcol; _fhi = _fmv + 1.96 * _fcol
elif f"${String(fm?.mean ?? measures[0])}_se" in df.columns:
    _fcol = df[f"${String(fm?.mean ?? measures[0])}_se"].to_numpy(dtype=float)
    _flo = _fmv - 1.96 * _fcol; _fhi = _fmv + 1.96 * _fcol
else:
    raise ValueError("森林图需要 CI 列或对应 _sd/_se 列")`
      return `_fmv = df[${meanCol}].to_numpy(dtype=float)
${ciExpr}
_fyv = np.arange(len(df))
${ax}.errorbar(_fmv, _fyv, xerr=np.array([_fmv - _flo, _fhi - _fmv]), fmt="o", capsize=3, markersize=5, color=colors[0], ecolor="#555555")
${ax}.axvline(0, color="#333333", linewidth=0.9, linestyle="--")
${ax}.set_yticks(_fyv); ${ax}.set_yticklabels(df[x_col].astype(str))
${ax}.invert_yaxis()`
    }
    if (kind === 'dual_axis') {
      // 双 Y 轴：左轴 measures[0]，右轴 measures[1]（twinx 自动独立量程，配色取前两色）
      return `_dual_df = df
if _dual_df[x_col].duplicated().any():
    _dual_df = _dual_df.groupby(x_col, as_index=False)[measures[:2]].mean()
${ax}.plot(_dual_df[x_col], _dual_df[measures[0]], marker="o", linewidth=1.3, color=colors[0], label=measures[0])
${ax}.fill_between(range(len(_dual_df)), _dual_df[measures[0]].to_numpy(dtype=float), 0, color=colors[0], alpha=0.10, zorder=0)
ax2_${index} = ${ax}.twinx()
ax2_${index}.plot(_dual_df[x_col], _dual_df[measures[1]], marker="s", linewidth=1.3, color=colors[1 % len(colors)], label=measures[1])
${ax}.set_xlabel(x_col); ${ax}.set_ylabel(measures[0], color=colors[0]); ax2_${index}.set_ylabel(measures[1], color=colors[1 % len(colors)])
${ax}.tick_params(axis="y", colors=colors[0]); ax2_${index}.tick_params(axis="y", colors=colors[1 % len(colors)])
${ax}.set_xticks(range(len(_dual_df)), _dual_df[x_col].astype(str), rotation=30, ha="right")
_h1_${index}, _l1_${index} = ${ax}.get_legend_handles_labels()
_h2_${index}, _l2_${index} = ax2_${index}.get_legend_handles_labels()
${ax}.legend(_h1_${index} + _h2_${index}, _l1_${index} + _l2_${index}, frameon=False, loc="upper left")`
    }
    if (['surface3d', 'scatter3d', 'cone3d', 'line3d', 'filled_line3d'].includes(kind)) {
      // 三维图：删除占位 2D 轴并新建 3D 轴（单面板使用，循环按 ax3d_<index> 引用）
      const ax3d = `ax3d_${index}`
      const cmap3d = f.colormap === 'inspiration'
        ? 'LinearSegmentedColormap.from_list("inspiration_surface", ["#243B53", "#2A9D8F", "#E9C46A", "#E76F51"])'
        : `plt.get_cmap(${pyQ(f.colormap ?? 'viridis')})`
      const fillCode = kind === 'filled_line3d'
        ? `_base = float(np.nanmin(_z3[_m3]))
    for _xx, _zz in zip(_xs, _zs):
        ${ax3d}.plot([_xx, _xx], [_yv, _yv], [_base, _zz], color=_cmap3(_ri / max(1, len(_ys) - 1)), alpha=0.16, linewidth=3.0)`
        : ''
      return `from mpl_toolkits.mplot3d import Axes3D  # noqa: F401
fig.delaxes(${ax})
${ax3d} = fig.add_subplot(${rows}, ${cols}, ${index + 1}, projection="3d")
${kind === 'surface3d'
    ? `_x3, _y3, _z3 = (df[measures[0]].to_numpy(dtype=float), df[measures[1]].to_numpy(dtype=float), df[measures[2]].to_numpy(dtype=float))
_m3 = np.isfinite(_x3) & np.isfinite(_y3) & np.isfinite(_z3)
if _m3.sum() < 8 or len(np.unique(_x3[_m3])) < 2 or len(np.unique(_y3[_m3])) < 2 or np.linalg.matrix_rank(np.column_stack((_x3[_m3], _y3[_m3]))) < 2: raise ValueError('3D 曲面需要至少 8 个完整且非共线的 XY 观测')
${f.secondaryProcessing === 'interpolate'
  ? `_xu, _yu = np.unique(_x3[_m3]), np.unique(_y3[_m3])
_zgrid = np.full((len(_yu), len(_xu)), np.nan)
for _xx, _yy, _zz in zip(_x3[_m3], _y3[_m3], _z3[_m3]):
    _zgrid[np.where(_yu == _yy)[0][0], np.where(_xu == _xx)[0][0]] = _zz
if np.isnan(_zgrid).any():
    print('WARNING 3D_INTERPOLATION_FALLBACK: XY 网格不完整，使用原始三角曲面')
    _surf = ${ax3d}.plot_trisurf(_x3[_m3], _y3[_m3], _z3[_m3], cmap=${cmap3d}, linewidth=0.18, edgecolor='#ffffff', antialiased=True, alpha=0.94)
else:
    _gx = np.linspace(float(_xu.min()), float(_xu.max()), 45)
    _gy = np.linspace(float(_yu.min()), float(_yu.max()), 45)
    _row_interp = np.vstack([np.interp(_gx, _xu, _row) for _row in _zgrid])
    _GZ = np.vstack([np.interp(_gy, _yu, _row_interp[:, _j]) for _j in range(len(_gx))]).T
    _GX, _GY = np.meshgrid(_gx, _gy)
    _surf = ${ax3d}.plot_surface(_GX, _GY, _GZ, cmap=${cmap3d}, linewidth=0, antialiased=True, alpha=0.94, rcount=45, ccount=45)`
  : `_surf = ${ax3d}.plot_trisurf(_x3[_m3], _y3[_m3], _z3[_m3], cmap=${cmap3d}, linewidth=0.18, edgecolor='#ffffff', antialiased=True, alpha=0.94)`}
fig.colorbar(_surf, ax=${ax3d}, shrink=0.58, pad=0.22, label=measures[2])`
    : kind === 'scatter3d'
      ? `_x3, _y3, _z3 = (df[measures[0]].to_numpy(dtype=float), df[measures[1]].to_numpy(dtype=float), df[measures[2]].to_numpy(dtype=float))
_m3 = np.isfinite(_x3) & np.isfinite(_y3) & np.isfinite(_z3)
if _m3.sum() < 4 or any(len(np.unique(_v)) < 2 for _v in (_x3[_m3], _y3[_m3], _z3[_m3])): raise ValueError('三维散点需要至少 4 个完整观测且三轴均有变化，停止输出以避免伪图')
${ax3d}.scatter(_x3[_m3], _y3[_m3], _z3[_m3], c=_z3[_m3], cmap=${cmap3d}, alpha=0.88, s=34, edgecolors='white', linewidths=0.35)
fig.colorbar(${ax3d}.collections[-1], ax=${ax3d}, shrink=0.72, pad=0.12, label=measures[2])`
      : kind === 'cone3d'
      ? `_x3, _y3, _z3 = (df[measures[0]].to_numpy(dtype=float), df[measures[1]].to_numpy(dtype=float), df[measures[2]].to_numpy(dtype=float))
_m3 = np.isfinite(_x3) & np.isfinite(_y3) & np.isfinite(_z3)
if _m3.sum() < 4 or any(len(np.unique(_v)) < 2 for _v in (_x3[_m3], _y3[_m3], _z3[_m3])): raise ValueError('三维锥状图需要至少 4 个完整观测且三轴均有变化')
_zmin, _zmax = float(np.min(_z3[_m3])), float(np.max(_z3[_m3]))
_span = max(_zmax - _zmin, 1e-9)
_norm3 = plt.Normalize(_zmin, _zmax)
_theta = np.linspace(0, 2 * np.pi, 28)
for _xx, _yy, _zz in zip(_x3[_m3], _y3[_m3], _z3[_m3]):
    _radius = max(float(np.ptp(_x3[_m3])) * 0.035, float(np.ptp(_y3[_m3])) * 0.035, _span * 0.018, 0.05)
    _tt = np.linspace(0, 1, 16)[:, None]
    _X = _xx + _radius * (1 - _tt) * np.cos(_theta)[None, :]
    _Y = _yy + _radius * (1 - _tt) * np.sin(_theta)[None, :]
    _Z = _zmin + _tt * (_zz - _zmin)
    ${ax3d}.plot_surface(_X, _Y, _Z, color=${cmap3d}(_norm3(_zz)), alpha=0.78, linewidth=0, antialiased=True)
    ${ax3d}.scatter([_xx], [_yy], [_zz], c=[${cmap3d}(_norm3(_zz))], s=18, edgecolors='white', linewidths=0.3)
${ax3d}.plot([], [], [], color='#6E8FB2', linewidth=7, alpha=0.7, label='样本锥体')
${ax3d}.legend(frameon=False, loc='upper left')
sm3 = plt.cm.ScalarMappable(norm=_norm3, cmap=${cmap3d}); sm3.set_array(_z3[_m3])
fig.colorbar(sm3, ax=${ax3d}, shrink=0.64, pad=0.24, label='信号强度')`
      : `_x3, _y3, _z3 = (df[measures[0]].to_numpy(dtype=float), df[measures[1]].to_numpy(dtype=float), df[measures[2]].to_numpy(dtype=float))
_m3 = np.isfinite(_x3) & np.isfinite(_y3) & np.isfinite(_z3)
if _m3.sum() < 4: raise ValueError('三维折线需要至少 4 个完整观测')
_ys = np.unique(_y3[_m3])
_cmap3 = plt.get_cmap('viridis')
for _ri, _yv in enumerate(_ys):
    _rm = _m3 & (_y3 == _yv)
    _ord = np.argsort(_x3[_rm])
    _xs, _zs = _x3[_rm][_ord], _z3[_rm][_ord]
    ${ax3d}.plot(_xs, np.full(len(_xs), _yv), _zs, color=_cmap3(_ri / max(1, len(_ys) - 1)), linewidth=2.2, marker='o', markersize=3.5, alpha=0.95)
    ${fillCode}`}
${ax3d}.set_xlabel(measures[0], labelpad=10); ${ax3d}.set_ylabel(measures[1], labelpad=10); ${ax3d}.set_zlabel(measures[2], labelpad=24)
${ax3d}.set_box_aspect((1.0, 1.0, 0.82)); ${ax3d}.view_init(elev=28, azim=-58); ${ax3d}.grid(True, alpha=0.18)
for _axis, _values in zip(('x', 'y', 'z'), (_x3[_m3], _y3[_m3], _z3[_m3])):
    _lo, _hi = float(np.min(_values)), float(np.max(_values))
    _pad = max((_hi - _lo) * 0.06, abs(_lo) * 0.01, 1e-9)
    getattr(${ax3d}, f'set_{_axis}lim')(_lo - _pad, _hi + _pad)`
    }
    return (panel.groups
      ? groupedPython(panel, ax, 'line')
      : `
for i, m in enumerate(measures):
    ${ax}.plot(df[x_col], df[m], marker="o", linewidth=1.3, label=m, color=colors[i % len(colors)])
${ax}.legend(frameon=False, fontsize=${Number(f.legendSize ?? 11)})`)
  }).join('\n')
  const titles = spec.panels.map((panel) => panel.title ?? '')
  // 每个面板绑定实际轴（3D 用 ax3d_<i>），逐面板设置标题与网格
  const axesExpr = specKinds(spec).map((kind, index) => (is3d(kind) ? `ax3d_${index}` : `axes.flat[${index}]`))
  const loopBody = specKinds(spec).map((kind, index) => {
    const title = titles[index]
    const lines = [`ax = ${axesExpr[index]}`]
    if (['bar', 'line'].includes(specKinds(spec)[index])) {
      lines.push(`ax.set_xlabel(${pyQ(spec.panels[index].scales?.find(s => s.axis === 'x')?.label ?? c.xLabel ?? c.x)}, labelpad=8)`)
      lines.push(`ax.set_ylabel(${pyQ(spec.panels[index].scales?.find(s => s.axis === 'y')?.label ?? c.yLabel)})`)
      lines.push('ax.tick_params(axis="x", pad=5)')
    }
    if (title) {
      lines.push(`ax.set_title(_fit_title(${pyQ(title)}), color=${pyQ(f.titleColor ?? '#000000')}, fontsize=${Number(f.titleFontSize ?? 15)}, pad=14)`)
    }
    const legend = spec.panels[index].legend
    const locations = { right: 'loc="center left", bbox_to_anchor=(1.02, 0.5)', top: 'loc="lower center", bbox_to_anchor=(0.5, 1.02)', bottom: 'loc="upper center", bbox_to_anchor=(0.5, -0.2)', inside: 'loc="upper right"' }
    if (legend?.visible !== false && (legend?.userSpecified || f.labelLanguage && f.labelLanguage !== 'auto') && locations[legend?.position]) {
      lines.push('_handles, _labels = ax.get_legend_handles_labels()')
      const replacements = Object.fromEntries((spec.panels[index].layers ?? []).filter(layer => layer.label).map(layer => [layer.sourceLabel ?? layer.label, layer.label]))
      lines.push(`_display_labels = ${JSON.stringify(replacements)}`)
      lines.push(`if _handles:\n    ax.legend(_handles, [_display_labels.get(_label, _label) for _label in _labels], frameon=False, ${locations[legend.position]}, fontsize=${Number(f.legendSize ?? 11)})`)
    }
    if (!is3d(kind)) lines.push('ax.grid(True, linestyle="--", color="#C8C8C8", alpha=0.3, linewidth=0.6)')
    return lines.join('\n')
  }).join('\n')
  const rcLines = [
    `"font.family": [${pyQ(f.fontFamily ?? 'SimHei')}, *plt.rcParams["font.serif"], *plt.rcParams["font.sans-serif"]]`,
    `"font.size": ${Number(f.tickSize ?? f.minFontSize ?? 11)}`,
    `"axes.titlesize": ${Number(f.titleFontSize ?? 15)}`,
    `"axes.labelsize": ${Number(f.axisLabelSize ?? 12.5)}`,
    `"xtick.labelsize": ${Number(f.tickSize ?? 11)}`,
    `"ytick.labelsize": ${Number(f.tickSize ?? 11)}`,
    `"legend.fontsize": ${Number(f.legendSize ?? 11)}`,
    `"figure.facecolor": ${pyQ(f.background ?? '#FFFFFF')}`,
    `"axes.facecolor": ${pyQ(f.background ?? '#FFFFFF')}`,
    `"savefig.facecolor": ${pyQ(f.background ?? '#FFFFFF')}`
  ].join(',\n    ')
  return `# ChartSpec-driven Python / Matplotlib
import pandas as pd
import matplotlib.pyplot as plt
from matplotlib.colors import LinearSegmentedColormap
${PY_PREAMBLE}
df = pd.read_csv(${pyQ(c.fileName)})
x_col = ${pyQ(c.x)}
measures = ${measures}
colors = ${colors}
plt.rcParams.update({
    ${rcLines}
})
fig, axes = plt.subplots(${rows}, ${cols}, squeeze=False, figsize=(${figureWidth}, ${Math.max(4.8, rows * 3.8)}), dpi=${c.dpi ?? 160}, layout="constrained")
${statements}
panel_titles = ${pyList(titles)}
${loopBody}
for _i in range(len(panel_titles), len(axes.flat)):
    axes.flat[_i].set_visible(False)
fig.suptitle(_fit_title(${pyQ(spec.figure.title ?? c.title)}), y=0.98, color=${pyQ(f.titleColor ?? '#000000')}, fontsize=${Number(f.titleFontSize ?? 15)}, fontweight=${f.titleFontWeight === 'normal' ? '"normal"' : '"bold"'})
fig.set_constrained_layout(False)
fig.subplots_adjust(top=0.86, bottom=0.30, left=0.10, right=0.90, wspace=0.28, hspace=0.32)
${''} # 图注由结果分析区展示，不叠加到图内
fig.savefig(${pyQ(`${outputBase}.png`)}, dpi=${c.dpi ?? 160}, facecolor="white")
fig.savefig(${pyQ(`${outputBase}.svg`)}, facecolor="white")
${outputBase === 'plan_convention' ? `fig.savefig(${pyQ(`${outputBase}.pdf`)}, facecolor="white")` : ''}
`
}

function specR(spec, c, outputBase) {
  const rows = Math.max(1, Number(spec.figure.rows) || 1)
  const cols = Math.max(1, Number(spec.figure.cols) || 1)
  const measures = `c(${c.measures.map((item) => rQ(item)).join(', ')})`
  const fontFamily = rQ(c.fontFamily ?? spec.figure.fontFamily ?? 'sans')
  const plots = specKinds(spec).map((kind, index) => {
    const panel = spec.panels[index]
    if (kind === 'bar') {
      if (panel.groups) return groupedR(panel, 'bar')
      return `bar_pos <- barplot(t(as.matrix(df[measures])), beside = TRUE, names.arg = df[[x_col]],
  col = c(${(c.colors?.length ? c.colors : NATURE_COLORS).map(rQ).join(', ')}), legend.text = measures, args.legend = list(x = "topright", bty = "n"),
  xlab = ${rQ(c.xLabel ?? c.x)}, ylab = ${rQ(c.yLabel)}, las = 2)
for (mi in seq_along(measures)) {
  ec <- paste0(measures[mi], "_sd")
  if (ec %in% names(df)) {
    bp <- if (is.matrix(bar_pos)) bar_pos[mi, ] else bar_pos
    arrows(bp, df[[measures[mi]]] - df[[ec]], bp, df[[measures[mi]]] + df[[ec]], angle = 90, code = 3, length = 0.05)
  }
}`
    }
    if (kind === 'scatter') return `plot(df[[measures[1]]], df[[measures[2]]], xlab = measures[1], ylab = measures[2], pch = 19)`
    if (kind === 'heatmap') {
      // 科研规则 §10.5：相关性热力图蓝白红发散（白为 0），禁用 R 默认红黄
      return `corr <- cor(df[measures], use = "pairwise.complete.obs")
heatmap(corr, Rowv = NA, Colv = NA, scale = "none",
        col = colorRampPalette(c("#6E8FB2", "#FFFFFF", "#C16E71"))(128),
        main = "Correlation Matrix", xlab = ${rQ(c.xLabel ?? c.x)})`
    }
    if (kind === 'histogram') return `hist(df[[measures[1]]], breaks = "FD", xlab = measures[1], main = "Distribution")`
    if (kind === 'boxplot') return `boxplot(df[measures], las = 2, outline = TRUE)`
    if (kind === 'box_jitter') {
      // 箱线 + 抖动散点（base R；stripchart 抖动叠加在箱线上）
      if (panel.groups) {
        const g = panel.groups
        return `boxplot(${rQ(g.measure)} ~ ${rQ(g.groupCol)}, data = df, las = 2, outline = TRUE, col = rgb(0.42, 0.55, 0.70, 0.35))
stripchart(${rQ(g.measure)} ~ ${rQ(g.groupCol)}, data = df, method = "jitter", vertical = TRUE, add = TRUE, pch = 20, col = rgb(0.2, 0.2, 0.2, 0.5))`
      }
      return `boxplot(df[measures], las = 2, outline = TRUE)
stripchart(as.list(df[measures]), method = "jitter", vertical = TRUE, add = TRUE, pch = 20, col = rgb(0.2, 0.2, 0.2, 0.5))`
    }
    if (kind === 'violin') {
      // 小提琴：优先 vioplot 包；缺失时诚实降级为箱线 + 抖动（MATLAB/R 无内置 violin）
      if (panel.groups) {
        const g = panel.groups
        return `if (requireNamespace("vioplot", quietly = TRUE)) {
  vioplot::vioplot(${rQ(g.measure)} ~ ${rQ(g.groupCol)}, data = df, las = 2, col = rgb(0.42, 0.55, 0.70, 0.35))
} else {
  boxplot(${rQ(g.measure)} ~ ${rQ(g.groupCol)}, data = df, las = 2, outline = TRUE)
  stripchart(${rQ(g.measure)} ~ ${rQ(g.groupCol)}, data = df, method = "jitter", vertical = TRUE, add = TRUE, pch = 20, col = rgb(0.2, 0.2, 0.2, 0.5))
}`
      }
      return `if (requireNamespace("vioplot", quietly = TRUE)) {
  vioplot::vioplot(df[measures], las = 2, col = rgb(0.42, 0.55, 0.70, 0.35))
} else {
  boxplot(df[measures], las = 2, outline = TRUE)
  stripchart(as.list(df[measures]), method = "jitter", vertical = TRUE, add = TRUE, pch = 20, col = rgb(0.2, 0.2, 0.2, 0.5))
}`
    }
    if (kind === 'dotplot') {
      // 误差棒点图（base R）：组/系列均值 ± 标准误
      if (panel.groups) {
        const g = panel.groups
        return `gm <- tapply(df[[${rQ(g.measure)}]], df[[${rQ(g.groupCol)}]], mean, na.rm = TRUE)
gs <- tapply(df[[${rQ(g.measure)}]], df[[${rQ(g.groupCol)}]], sd, na.rm = TRUE)
gn <- tapply(df[[${rQ(g.measure)}]], df[[${rQ(g.groupCol)}]], function(v) sum(!is.na(v)))
gse <- gs / sqrt(gn)
xi <- seq_along(gm)
plot(xi, gm, pch = 19, xaxt = "n", xlab = ${rQ(g.groupCol)}, ylab = ${rQ(g.measure)})
arrows(xi, gm - gse, xi, gm + gse, angle = 90, code = 3, length = 0.06)
axis(1, at = xi, labels = names(gm), las = 2)`
      }
      return `dm <- sapply(df[measures], mean, na.rm = TRUE)
ds <- sapply(df[measures], sd, na.rm = TRUE)
dn <- colSums(!is.na(df[measures]))
dse <- ds / sqrt(dn)
xi <- seq_along(dm)
plot(xi, dm, pch = 19, xaxt = "n", xlab = "", ylab = ${rQ(c.yLabel)})
arrows(xi, dm - dse, xi, dm + dse, angle = 90, code = 3, length = 0.06)
axis(1, at = xi, labels = measures, las = 2)`
    }
    if (kind === 'paired') {
      // 配对连线（base R）：逐观测连线 + 均值差标注（数据驱动）
      return `pm1 <- measures[1]; pm2 <- measures[2]
plot(NA, xlim = c(0.5, 2.5), ylim = range(c(df[[pm1]], df[[pm2]]), na.rm = TRUE), xaxt = "n", xlab = "", ylab = ${rQ(c.yLabel)})
for (pi in seq_len(nrow(df))) lines(c(1, 2), c(df[[pm1]][pi], df[[pm2]][pi]), col = rgb(0, 0, 0, 0.35))
points(rep(1, nrow(df)), df[[pm1]], pch = 19, col = ${rQ('#6E8FB2')})
points(rep(2, nrow(df)), df[[pm2]], pch = 19, col = ${rQ('#C16E71')})
axis(1, at = 1:2, labels = c(pm1, pm2))
pmd <- mean(df[[pm1]] - df[[pm2]], na.rm = TRUE)
text(1.5, max(c(df[[pm1]], df[[pm2]]), na.rm = TRUE), sprintf("Δmean=%+.2f", pmd), pos = 3)`
    }
    if (kind === 'stacked') {
      // 堆叠柱状（base R）：多系列正值累加
      const paletteR = `c(${(c.colors?.length ? c.colors : NATURE_COLORS.slice(0, 4)).map((x) => rQ(x)).join(', ')})`
      return `barplot(t(as.matrix(df[measures])), col = ${paletteR}, las = 2, legend.text = measures, args.legend = list(x = "topright", bty = "n", cex = 0.8))`
    }
    if (kind === 'forest') {
      // 森林图（base R）：逐条目均值 ± 95% CI + 参考线
      const fm = panel.forest
      const meanCol = fm?.mean ?? measures[0]
      const loCol = fm?.ciLow ? `df[[${rQ(fm.ciLow)}]]` : `df[[${rQ(meanCol)}]] - 1.96 * df[[${rQ(`${meanCol}_sd`)}]]`
      const hiCol = fm?.ciHigh ? `df[[${rQ(fm.ciHigh)}]]` : `df[[${rQ(meanCol)}]] + 1.96 * df[[${rQ(`${meanCol}_sd`)}]]`
      return `fyv <- seq_len(nrow(df))
fmv <- df[[${rQ(meanCol)}]]
flo <- ${loCol}
fhi <- ${hiCol}
plot(fmv, fyv, pch = 19, xlim = range(c(flo, fhi), na.rm = TRUE), yaxt = "n", xlab = ${rQ('效应量/均值 (95% CI)')}, ylab = "")
arrows(flo, fyv, fhi, fyv, angle = 90, code = 3, length = 0.05)
abline(v = 0, lty = 2, col = "gray40")
axis(2, at = fyv, labels = df[[${rQ(c.x)}]], las = 2)`
    }
    if (kind === 'dual_axis') {
      // 双 Y 轴（ggplot2 sec_axis）：左轴原始值，右轴按量程比例换算
      return `s <- max(df[[measures[1]]], na.rm = TRUE) / max(df[[measures[2]]], na.rm = TRUE)
p <- ggplot(df, aes(x = .data[[x_col]])) +
  geom_line(aes(y = .data[[measures[1]]], color = ${rQ('左轴')}), linewidth = 0.8) +
  geom_line(aes(y = .data[[measures[2]]] * s, color = ${rQ('右轴')}), linewidth = 0.8, linetype = "dashed") +
  scale_y_continuous(name = measures[1], sec.axis = sec_axis(~ . / s, name = measures[2])) +
  scale_color_manual(values = c(${rQ('#6E8FB2')}, ${rQ('#C16E71')})) +
  theme_bw(base_size = 11) + theme(legend.position = "top")
print(p)`
    }
    if (kind === 'surface3d') {
      // 三维曲面：akima 插值网格 + persp；无 akima 时降级为散点透视
      return `if (requireNamespace("akima", quietly = TRUE)) {
  g <- akima::interp(df[[measures[1]]], df[[measures[2]]], df[[measures[3]]], duplicate = "mean")
  persp(g$x, g$y, g$z, theta = 30, phi = 25, expand = 0.6,
        xlab = measures[1], ylab = measures[2], zlab = measures[3],
        col = colorRampPalette(c("#6E8FB2", "#EAB67A"))(64), border = NA)
} else if (requireNamespace("scatterplot3d", quietly = TRUE)) {
  scatterplot3d::scatterplot3d(df[[measures[1]]], df[[measures[2]]], df[[measures[3]]],
    xlab = measures[1], ylab = measures[2], zlab = measures[3], pch = 19)
} else {
  warning("akima/scatterplot3d 缺失：3D 曲面降级为两两散点")
  pairs(df[measures])
}`
    }
    if (kind === 'scatter3d') {
      return `if (requireNamespace("scatterplot3d", quietly = TRUE)) {
  scatterplot3d::scatterplot3d(df[[measures[1]]], df[[measures[2]]], df[[measures[3]]],
    pch = 19, xlab = measures[1], ylab = measures[2], zlab = measures[3])
} else {
  pairs(df[measures])
}`
    }
    if (kind === 'line3d' || kind === 'filled_line3d') {
      return `if (requireNamespace("scatterplot3d", quietly = TRUE)) {
  d3 <- df[order(df[[measures[1]]], df[[measures[2]]]), ]
  s3 <- scatterplot3d::scatterplot3d(d3[[measures[1]]], d3[[measures[2]]], d3[[measures[3]]],
    type = "l", lwd = 2, pch = 19, color = "#2A9D8F",
    xlab = measures[1], ylab = measures[2], zlab = measures[3])
} else {
  warning("scatterplot3d 缺失：三维折线降级为二维序列")
  plot(df[[measures[1]]], df[[measures[3]]], type = "l", xlab = measures[1], ylab = measures[3])
}`
    }
    return (panel.groups
      ? groupedR(panel, 'line')
      : `matplot(df[[x_col]], df[measures], type = "o", pch = 1, lty = 1, xlab = ${rQ(panel.scales?.find(scale => scale.axis === 'x')?.label ?? c.xLabel ?? c.x)}, ylab = ${rQ(panel.scales?.find(scale => scale.axis === 'y')?.label ?? c.yLabel)})`)
  }).map((source, index) => {
    const panel = spec.panels[index]
    const position = panel.legend?.userSpecified ? panel.legend.position : null
    const language = spec.figure.labelLanguage
    if (!position && (!language || language === 'auto')) return source
    const labels = (panel.layers ?? []).map(layer => layer.label)
    if (source.includes('print(p)')) {
      const ggPosition = position === 'inside' ? 'c(0.85, 0.85)' : rQ(position ?? 'top')
      return source.replaceAll('print(p)', `print(p + labs(title = ${rQ(spec.figure.title ?? c.title)}, x = ${rQ(panel.scales?.find(scale => scale.axis === 'x')?.label ?? c.xLabel ?? c.x)}, y = ${rQ(panel.scales?.find(scale => scale.axis === 'y')?.label ?? c.yLabel)}) + theme(legend.position = ${ggPosition}, text = element_text(family = plot_font), plot.title = element_text(hjust = 0.5)))`)
    }
    if (position && ['bar', 'line', 'stacked'].includes(specKinds(spec)[index])) {
      const basePosition = { right: 'topright', top: 'top', bottom: 'bottom', inside: 'topright' }[position]
      source = source.replace('legend.text = measures', 'legend.text = FALSE')
      source += `\nlegend(${rQ(basePosition)}, legend = c(${labels.map(rQ).join(', ')}), col = c(${(c.colors?.length ? c.colors : NATURE_COLORS).map(rQ).join(', ')}), lty = 1, bty = "n"${position === 'right' ? ', inset = c(-0.25, 0), xpd = TRUE' : ''})`
    }
    return source
  }).join('\n')
  const usesGroupPlot = spec.panels.some(panel => panel.groups)
  const draw = usesGroupPlot
    ? plots.replaceAll('print(p)', `print(p + labs(title = ${rQ(spec.figure.title ?? c.title)}) + theme(text = element_text(family = plot_font), plot.title = element_text(hjust = 0.5, face = "bold")))`)
    : `par(mfrow = c(${rows}, ${cols}), mar = c(5, 4, 3, 1), oma = c(0, 0, 3, 0))\n${plots}\nmtext(${rQ(spec.figure.title ?? c.title)}, side = 3, outer = TRUE, line = 1, cex = 1.2, font = 2)`
  return `# ChartSpec-driven R
library(ggplot2)
library(dplyr)
df <- read.csv(${rQ(c.fileName)}, check.names = FALSE)
x_col <- ${rQ(c.x)}
measures <- ${measures}
plot_font <- ${fontFamily}
if (file.exists(".deep-imaging-fonts/NotoSansCJKsc-Regular.otf") && capabilities("cairo")) {
  font_available <- requireNamespace("systemfonts", quietly = TRUE) &&
    any(tolower(systemfonts::font_info(family = plot_font)$family) == tolower(plot_font))
  if (!font_available) plot_font <- "Noto Sans CJK SC"
} else {
  warning("CJK_FONT_UNAVAILABLE: 中文字体或 Cairo 未就绪，请检查运行时安装。")
}
par(family = plot_font)
if (requireNamespace("ggplot2", quietly = TRUE)) ggplot2::theme_set(ggplot2::theme_gray(base_family = plot_font))
png(${rQ(`${outputBase}.png`)}, width = ${cols * 1200}, height = ${rows * 900}, res = 180, type = if (capabilities("cairo")) "cairo" else getOption("bitmapType"))
${draw}
dev.off()
svg(${rQ(`${outputBase}.svg`)}, width = ${cols * 5}, height = ${rows * 4})
${draw}
dev.off()
`
}

function specMatlab(spec, c, outputBase) {
  const rows = Math.max(1, Number(spec.figure.rows) || 1)
  const cols = Math.max(1, Number(spec.figure.cols) || 1)
  const measures = `{${c.measures.map((item) => mQ(item)).join(', ')}}`
  const panelTitles = `{${spec.panels.map((panel) => mQ(panel.title ?? '')).join(', ')}}`
  const plots = specKinds(spec).map((kind, index) => {
    const panel = spec.panels[index]
    if (kind === 'bar') {
      if (panel.groups) return groupedMatlab(panel, 'bar')
      return `nexttile; bar(T.(measures{1}));`
    }
    if (kind === 'scatter') return `nexttile; scatter(T.(measures{1}), T.(measures{2}), 'filled'); xlabel(measures{1}); ylabel(measures{2});`
    if (kind === 'heatmap') {
      // 科研规则 §10.5：相关性热力图蓝白红发散，caxis [-1,1]；128 级插值色带
      return `nexttile;
C = corr(table2array(T(:, measures)), 'Rows', 'pairwise');
imagesc(C, [-1 1]);
colormap(gca, interp1(linspace(0,1,3), [0.431 0.561 0.698; 1 1 1; 0.757 0.431 0.443], linspace(0,1,128)));
cb = colorbar; cb.Label.String = '相关系数'; cb.Location = 'eastoutside'; % 'Location', 'eastoutside'
axis square;
xticks(1:numel(measures)); yticks(1:numel(measures));
xticklabels(measures); yticklabels(measures);`
    }
    if (kind === 'histogram') return `nexttile; histogram(T.(measures{1}), 'BinMethod', 'auto'); xlabel(measures{1}); ylabel('Frequency');`
    if (kind === 'boxplot') return `nexttile; boxchart(table2array(T(:, measures))); xticklabels(measures);`
    if (kind === 'box_jitter') {
      // 箱线 + 抖动散点（Statistics Toolbox boxplot；抖动用 rand 固定种子保证可复现）
      if (panel.groups) {
        const g = panel.groups
        return `nexttile;
[gid, gname] = grp2idx(T.(${mQ(g.groupCol)}));
boxplot(T.(${mQ(g.measure)}), gid, 'Labels', gname, 'Colors', 'k'); hold on;
rng(2026);
for k = 1:numel(gname)
    vals = T.(${mQ(g.measure)})(gid == k);
    scatter(repmat(k, numel(vals), 1) + (rand(numel(vals), 1) - 0.5) * 0.25, vals, 12, 'filled', 'MarkerFaceAlpha', 0.45);
end
hold off;`
      }
      return `nexttile;
boxplot(table2array(T(:, measures)), 'Labels', measures, 'Colors', 'k'); hold on;
rng(2026);
for k = 1:numel(measures)
    vals = T.(measures{k}); vals = vals(~isnan(vals));
    scatter(repmat(k, numel(vals), 1) + (rand(numel(vals), 1) - 0.5) * 0.25, vals, 12, 'filled', 'MarkerFaceAlpha', 0.45);
end
hold off;`
    }
    if (kind === 'violin') {
      // MATLAB 无内置小提琴；诚实降级为箱线 + 抖动（与 box_jitter 同实现）
      if (panel.groups) {
        const g = panel.groups
        return `nexttile;
[gid, gname] = grp2idx(T.(${mQ(g.groupCol)}));
boxplot(T.(${mQ(g.measure)}), gid, 'Labels', gname, 'Colors', 'k'); hold on;
rng(2026);
for k = 1:numel(gname)
    vals = T.(${mQ(g.measure)})(gid == k);
    scatter(repmat(k, numel(vals), 1) + (rand(numel(vals), 1) - 0.5) * 0.25, vals, 12, 'filled', 'MarkerFaceAlpha', 0.45);
end
hold off;`
      }
      return `nexttile;
boxplot(table2array(T(:, measures)), 'Labels', measures, 'Colors', 'k'); hold on;
rng(2026);
for k = 1:numel(measures)
    vals = T.(measures{k}); vals = vals(~isnan(vals));
    scatter(repmat(k, numel(vals), 1) + (rand(numel(vals), 1) - 0.5) * 0.25, vals, 12, 'filled', 'MarkerFaceAlpha', 0.45);
end
hold off;`
    }
    if (kind === 'dotplot') {
      // 误差棒点图：组/系列均值 ± 标准误
      if (panel.groups) {
        const g = panel.groups
        return `nexttile;
[grpID, grpName] = grp2idx(T.(${mQ(g.groupCol)}));
grpMean = splitapply(@mean, T.(${mQ(g.measure)}), grpID);
grpSD = splitapply(@(x) std(x, 0, 'omitnan'), T.(${mQ(g.measure)}), grpID);
grpN = splitapply(@(x) sum(~isnan(x)), T.(${mQ(g.measure)}), grpID);
grpSE = grpSD ./ sqrt(grpN);
errorbar(1:numel(grpName), grpMean, grpSE, 'o', 'CapSize', 4, 'MarkerSize', 6);
xticks(1:numel(grpName)); xticklabels(grpName); ylabel(${mQ(g.measure)});`
      }
      return `nexttile;
dmean = varfun(@mean, T(:, measures)); dstd = varfun(@std, T(:, measures));
dn = sum(~isnan(table2array(T(:, measures))), 1); dse = table2array(dstd) ./ sqrt(dn);
errorbar(1:numel(measures), table2array(dmean), dse, 'o', 'CapSize', 4, 'MarkerSize', 6);
xticks(1:numel(measures)); xticklabels(measures);`
    }
    if (kind === 'paired') {
      // 配对连线：逐观测连线 + 组均值 ± 标准误 + 均值差标注（数据驱动）
      return `nexttile;
m0 = T.(measures{1}); m1 = T.(measures{2}); n = height(T);
plot([ones(n, 1), 2 * ones(n, 1)]', [m0, m1]', 'Color', [0.5 0.5 0.5 0.4]); hold on;
scatter(ones(n, 1), m0, 18, 'filled', 'MarkerFaceAlpha', 0.7);
scatter(2 * ones(n, 1), m1, 18, 'filled', 'MarkerFaceAlpha', 0.7);
pse0 = std(m0, 0, 'omitnan') / sqrt(sum(~isnan(m0)));
pse1 = std(m1, 0, 'omitnan') / sqrt(sum(~isnan(m1)));
errorbar(1, mean(m0, 'omitnan'), pse0, 'k', 'CapSize', 4); errorbar(2, mean(m1, 'omitnan'), pse1, 'k', 'CapSize', 4);
xticks([1 2]); xticklabels({measures{1}, measures{2}});
pmd = mean(m0 - m1, 'omitnan');
text(1.5, max([m0; m1], [], 'omitnan'), sprintf('Δmean=%+.2f', pmd), 'HorizontalAlignment', 'center', 'VerticalAlignment', 'bottom');
hold off;`
    }
    if (kind === 'stacked') {
      // 堆叠柱状：多系列正值累加
      return `nexttile;
h = bar((1:height(T))', table2array(T(:, measures)), 'stacked');
xticks(1:height(T)); xticklabels(string(T.(${mQ(c.x)}))); legend(measures, 'Location', 'northeast');`
    }
    if (kind === 'forest') {
      // 森林图：逐条目均值 ± 95% CI + 参考线
      const fm = panel.forest
      const meanCol = fm?.mean ?? measures[0]
      const loExpr = fm?.ciLow ? `T.(${mQ(fm.ciLow)})` : `T.(${mQ(meanCol)}) - 1.96 * T.(${mQ(`${meanCol}_sd`)})`
      const hiExpr = fm?.ciHigh ? `T.(${mQ(fm.ciHigh)})` : `T.(${mQ(meanCol)}) + 1.96 * T.(${mQ(`${meanCol}_sd`)})`
      return `nexttile;
fmv = T.(${mQ(meanCol)}); flo = ${loExpr}; fhi = ${hiExpr};
fyv = (1:height(T))';
errorbar(fmv, fyv, fmv - flo, fhi - fmv, 'horizontal', 'o', 'CapSize', 3); hold on;
xline(0, '--', 'Color', [0.4 0.4 0.4]);
yticks(fyv); yticklabels(string(T.(${mQ(c.x)}))); set(gca, 'YDir', 'reverse');
xlabel('效应量/均值 (95% CI)'); hold off;`
    }
    if (kind === 'dual_axis') {
      // 双 Y 轴（yyaxis）：左轴 measures{1}，右轴 measures{2}
      return `nexttile; hold on;
yyaxis left; plot(T.(${mQ(c.x)}), T.(measures{1}), '-o', 'LineWidth', 1.2); ylabel(measures{1});
yyaxis right; plot(T.(${mQ(c.x)}), T.(measures{2}), '-s', 'LineWidth', 1.2); ylabel(measures{2});
grid on; hold off;`
    }
    if (kind === 'surface3d') {
      // 三维曲面：不规则散点用 Delaunay 三角化 + trisurf
      return `nexttile;
tri = delaunay(T.(measures{1}), T.(measures{2}));
trisurf(tri, T.(measures{1}), T.(measures{2}), T.(measures{3}), 'EdgeColor', 'none');
xlabel(measures{1}); ylabel(measures{2}); zlabel(measures{3});
colormap(gca, 'parula'); colorbar; axis tight; daspect([1 1 0.8]); view(35, 25); grid on;`
    }
    if (kind === 'scatter3d') {
      return `nexttile; scatter3(T.(measures{1}), T.(measures{2}), T.(measures{3}), 40, T.(measures{3}), 'filled', 'MarkerEdgeColor', [1 1 1]);
xlabel(measures{1}); ylabel(measures{2}); zlabel(measures{3});
colormap(gca, 'parula'); colorbar; axis tight; daspect([1 1 0.8]); view(35, 25); grid on;`
    }
    if (kind === 'line3d' || kind === 'filled_line3d') {
      return `nexttile; hold on; [~, ord] = sortrows([T.(measures{2}), T.(measures{1})]);
plot3(T.(measures{1})(ord), T.(measures{2})(ord), T.(measures{3})(ord), '-o', 'LineWidth', 1.6, 'MarkerSize', 3, 'Color', [0.16 0.62 0.56]);
xlabel(measures{1}); ylabel(measures{2}); zlabel(measures{3}); axis tight; daspect([1 1 0.8]); view(35, 25); grid on; hold off;`
    }
    return (panel.groups
      ? groupedMatlab(panel, 'line')
      : `nexttile; hold on; for k = 1:numel(measures), plot(T.(${mQ(c.x)}), T.(measures{k}), '-o'); end; hold off;`)
  }).join('\n')
  return `% ChartSpec-driven MATLAB; only run on a licensed MATLAB node.
T = readtable(${mQ(c.fileName)});
measures = ${measures};
set(groot, 'defaultAxesFontName', ${mQ(c.fontFamily ?? spec.figure.fontFamily ?? 'SimHei')}); set(groot, 'defaultTextFontName', ${mQ(c.fontFamily ?? spec.figure.fontFamily ?? 'SimHei')});
figure('Color','w','Position',[100 100 ${Math.max(800, cols * 520)} ${Math.max(560, rows * 430)}]); tiledlayout(${rows}, ${cols}, 'TileSpacing','loose', 'Padding','loose');
${plots}
panelTitles = ${panelTitles};
${spec.panels.map((panel, index) => {
  if (!panel.legend?.userSpecified && (!spec.figure.labelLanguage || spec.figure.labelLanguage === 'auto')) return ''
  const location = { right: 'eastoutside', top: 'northoutside', bottom: 'southoutside', inside: 'northeast' }[panel.legend?.position]
  const labels = (panel.layers ?? []).map(layer => layer.label)
  const kind = specKinds(spec)[index]
  return `nexttile(${index + 1});\n${['bar', 'line'].includes(kind) ? `xlabel(${mQ(panel.scales?.find(scale => scale.axis === 'x')?.label ?? c.xLabel ?? c.x)}); ylabel(${mQ(panel.scales?.find(scale => scale.axis === 'y')?.label ?? c.yLabel)});` : ''}\n${location && ['bar', 'line', 'dual_axis'].includes(kind) ? `legend({${labels.map(mQ).join(', ')}}, 'Location', ${mQ(location)});` : ''}`
}).join('\n')}
for _panelIndex = 1:min(numel(panelTitles), ${rows * cols})
    nexttile(_panelIndex);
    if ~isempty(panelTitles{_panelIndex})
        title(panelTitles{_panelIndex}, 'FontSize', 15, 'FontWeight', 'bold', 'HorizontalAlignment', 'center');
    end
end
_st = sgtitle(${mQ(spec.figure.title ?? c.title)}, 'FontSize', 15, 'FontWeight', 'bold', 'Color', [0 0 0]);
_st.HorizontalAlignment = 'center';
exportgraphics(gcf, ${mQ(`${outputBase}.png`)}, 'Resolution', 300);
print('-dsvg', ${mQ(`${outputBase}.svg`)});
`
}

export function generateCodeForSpec(spec, input) {
  validateChartSpec(spec, input)
  const outputBase = /^[a-z0-9_-]+$/i.test(input.outputBase ?? '') ? input.outputBase : 'chart_spec'
  const displayInput = { ...input, xLabel: spec.panels[0]?.scales?.find(scale => scale.axis === 'x')?.label ?? input.xLabel, yLabel: spec.panels[0]?.scales?.find(scale => scale.axis === 'y')?.label ?? input.yLabel }
  return attachSourceMetadata({
    python: specPython(spec, displayInput, outputBase),
    r: specR(spec, displayInput, outputBase),
    matlab: specMatlab(spec, displayInput, outputBase)
  }, spec)
}

export function attachSourceMetadata(code, spec) {
  const encoded = Buffer.from(JSON.stringify(spec), 'utf8').toString('base64url')
  return Object.fromEntries(Object.entries(code).map(([engine, source]) => {
    const prefix = engine === 'matlab' ? '%' : '#'
    const marker = `${prefix} @deep-imaging-spec:${encoded}`
    return [engine, String(source).includes('@deep-imaging-spec:') ? source : `${marker}\n${source}`]
  }))
}

export function generateCode(strategy, input) {
  return {
    python: pythonCode(strategy, input),
    r: rCode(strategy, input),
    matlab: matlabCode(strategy, input)
  }
}

// DEPENDENCY 修复模板（无 pandas）
export function generateFallbackCode(strategy, input) {
  return pythonFallbackCode(strategy, input)
}

// 各方案/引擎必须产出的文件（沙箱据此回收与判定 RENDER 成败）
export function expectedArtifacts(strategy, engine) {
  const base = `plan_${strategy}`
  if (engine === 'r' || engine === 'matlab' || engine === 'python') {
    const list = [`${base}.png`, `${base}.svg`]
    if (strategy === 'convention' && engine === 'python') list.push(`${base}.pdf`)
    return list
  }
  return [`${base}.png`]
}

export const SCRIPT_NAME = { python: 'plot.py', r: 'plot.R', matlab: 'plot.m' }
