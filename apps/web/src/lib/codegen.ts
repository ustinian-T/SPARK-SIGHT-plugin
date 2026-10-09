// 三引擎代码生成（前端占位）：依据 ChartSpec 与字段生成 Python/R/MATLAB 代码。
// 后端就绪后由引擎适配层 packages/runtimes 的 generate 接口替换；MATLAB 仅在用户合法授权节点执行，不随产品打包。
import type { ChartSpec, EngineKind, PlanStrategy } from '../types'

export interface CodegenInput {
  fileName: string
  x: string
  measures: string[]
  title: string
  yLabel: string
  outputBase?: string
}

function pyList(items: string[]): string {
  return `[${items.map((m) => `"${m}"`).join(', ')}]`
}

function pythonCode(strategy: PlanStrategy, c: CodegenInput): string {
  const measures = pyList(c.measures)
  if (strategy === 'clarity') {
    return `# 方案一（信息清晰优先）· Python / Matplotlib
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt

df = pd.read_csv("${c.fileName}")
x_col = "${c.x}"
measures = ${measures}

fig, ax = plt.subplots(figsize=(7.2, 4.4), dpi=300, layout="constrained")
xi = np.arange(len(df))
width = 0.8 / len(measures)
for i, m in enumerate(measures):
    sd = df.get(f"{m}_sd")
    ax.bar(xi + (i - (len(measures) - 1) / 2) * width, df[m], width,
           yerr=sd, capsize=3, label=m)
ax.set_xticks(xi)
ax.set_xticklabels(df[x_col])
ax.set_xlabel(x_col)
ax.set_ylabel("${c.yLabel}")
ax.set_title("${c.title}")
ax.legend(frameon=False, ncol=len(measures), loc="upper left")
ax.spines[["top", "right"]].set_visible(False)
fig.savefig("plan_clarity.png", dpi=300, bbox_inches="tight", pad_inches=0.18)
`
  }
  if (strategy === 'convention') {
    return `# 方案二（论文惯例优先）· Python / Matplotlib（含误差棒，黑白打印友好）
import pandas as pd
import matplotlib.pyplot as plt

plt.rcParams.update({
    "font.family": "serif", "font.size": 10.5,
    "axes.grid": True, "grid.alpha": 0.25, "grid.linewidth": 0.6
})
df = pd.read_csv("${c.fileName}")
x_col = "${c.x}"
measures = ${measures}
markers = ["o", "s", "^", "D"]

fig, ax = plt.subplots(figsize=(6.8, 4.6), dpi=300, layout="constrained")
for i, m in enumerate(measures):
    ax.errorbar(df[x_col], df[m], yerr=df.get(f"{m}_sd"),
                marker=markers[i % len(markers)], capsize=2.5,
                linewidth=1.4, label=m)
ax.set_xlabel(x_col)
ax.set_ylabel("${c.yLabel}")
ax.set_title("${c.title}")
ax.legend(frameon=False, loc="upper left")
# 显著性/参考线等注释由 AnnotationSpec 受控生成，避免人工硬编码
fig.savefig("plan_convention.pdf", bbox_inches="tight", pad_inches=0.18)
fig.savefig("plan_convention.png", dpi=300, bbox_inches="tight", pad_inches=0.18)
`
  }
  return `# 方案三（信息密度优先）· Python / Matplotlib（双面板：原始趋势 + 相对首点变化）
import pandas as pd
import matplotlib.pyplot as plt

df = pd.read_csv("${c.fileName}")
x_col = "${c.x}"
measures = ${measures}

fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(10.2, 4.2), dpi=300, layout="constrained")
for m in measures:
    ax1.plot(df[x_col], df[m], marker="o", linewidth=1.3, label=m)
    base = df[m].iloc[0] if df[m].iloc[0] != 0 else 1
    ax2.plot(df[x_col], 100.0 * df[m] / base, marker="o", linewidth=1.3, label=m)
ax1.set_title("原始趋势")
ax1.set_ylabel("${c.yLabel}")
ax2.set_title("相对首点变化 (%)")
ax2.axhline(100, color="#888", linewidth=0.8, linestyle="--")
for ax in (ax1, ax2):
    ax.set_xlabel(x_col)
    ax.grid(alpha=0.2)
    ax.legend(frameon=False, fontsize=8.5)
fig.suptitle("${c.title}", y=1.02)
fig.savefig("plan_density.png", dpi=300, bbox_inches="tight", pad_inches=0.18)
`
}

function rCode(strategy: PlanStrategy, c: CodegenInput): string {
  const m = c.measures.map((x) => `"${x}"`).join(', ')
  if (strategy === 'clarity') {
    return `# 方案一 · R / ggplot2
library(ggplot2)
df <- read.csv("${c.fileName}")
long <- reshape(df, varying = c(${m}), v.names = "value",
                times = c(${m}), idvar = "${c.x}", direction = "long")
p <- ggplot(long, aes(x = factor(${c.x}), y = value, fill = time)) +
  geom_col(position = position_dodge(0.8), width = 0.7) +
  labs(x = "${c.x}", y = "${c.yLabel}", title = "${c.title}", fill = NULL) +
  theme_bw(base_size = 11) + theme(legend.position = "top")
ggsave("plan_clarity.png", p, width = 7.2, height = 4.4, dpi = 300)
`
  }
  if (strategy === 'convention') {
    return `# 方案二 · R / ggplot2（误差棒）
library(ggplot2)
df <- read.csv("${c.fileName}")
long <- reshape(df, varying = c(${m}), v.names = "value",
                times = c(${m}), idvar = "${c.x}", direction = "long")
p <- ggplot(long, aes(x = ${c.x}, y = value, color = time, group = time)) +
  geom_line(linewidth = 0.7) + geom_point(size = 1.6) +
  geom_errorbar(aes(ymin = value - sd, ymax = value + sd), width = 0.2) +
  labs(x = "${c.x}", y = "${c.yLabel}", title = "${c.title}", color = NULL) +
  theme_bw(base_size = 11) + theme(legend.position = "top")
ggsave("plan_convention.png", p, width = 6.8, height = 4.6, dpi = 300)
`
  }
  return `# 方案三 · R / ggplot2（双面板）
library(ggplot2)
library(tidyr)
library(dplyr)
df <- read.csv("${c.fileName}")
norm <- df %>% mutate(across(c(${m}), ~ 100 * .x / first(.x)))
p1 <- ggplot(tidyr::pivot_longer(df, c(${m})), aes(${c.x}, value, color = name)) +
  geom_line() + geom_point() + labs(title = "原始趋势", y = "${c.yLabel}")
p2 <- ggplot(tidyr::pivot_longer(norm, c(${m})), aes(${c.x}, value, color = name)) +
  geom_line() + geom_point() + geom_hline(yintercept = 100, linetype = "dashed") +
  labs(title = "相对首点变化 (%)")
ggsave("plan_density.png", patchwork::wrap_plots(p1, p2, nrow = 1), width = 10, height = 4, dpi = 300)
`
}

function matlabCode(strategy: PlanStrategy, c: CodegenInput): string {
  const head = `% 仅可在已合法安装并授权 MATLAB 的执行节点运行；产品不打包、不再分发 MATLAB 运行时。\nT = readtable("${c.fileName}");\nx = T.${c.x};\n`
  if (strategy === 'clarity') {
    return `${head}measures = {${c.measures.map((m) => `'${m}'`).join(', ')}};
figure('Color','w'); hold on;
for k = 1:numel(measures)
    bar(x + (k-(numel(measures)+1)/2)*0.25, T.(measures{k}), 0.25);
end
xticks(x); xlabel('${c.x}'); ylabel('${c.yLabel}'); title('${c.title}');
legend(measures, 'Location', 'northwest'); box off;
exportgraphics(gcf, 'plan_clarity.png', 'Resolution', 300);
`
  }
  if (strategy === 'convention') {
    return `${head}measures = {${c.measures.map((m) => `'${m}'`).join(', ')}};
figure('Color','w'); hold on; markers = 'os^d';
for k = 1:numel(measures)
    errorbar(x, T.(measures{k}), T.([measures{k} '_sd']), ['-' markers(k)], 'CapSize', 4);
end
xlabel('${c.x}'); ylabel('${c.yLabel}'); title('${c.title}');
legend(measures, 'Location', 'northwest'); grid on; box off;
exportgraphics(gcf, 'plan_convention.png', 'Resolution', 300);
`
  }
  return `${head}measures = {${c.measures.map((m) => `'${m}'`).join(', ')}};
figure('Color','w');
subplot(1,2,1); hold on;
for k = 1:numel(measures), plot(x, T.(measures{k}), '-o'); end
title('原始趋势'); ylabel('${c.yLabel}'); legend(measures); grid on;
subplot(1,2,2); hold on;
for k = 1:numel(measures), plot(x, 100*T.(measures{k})./T.(measures{k})(1), '-o'); end
yline(100,'--'); title('相对首点变化 (%)'); grid on;
sgtitle('${c.title}');
exportgraphics(gcf, 'plan_density.png', 'Resolution', 300);
`
}

export function generateCode(strategy: PlanStrategy, input: CodegenInput): Record<EngineKind, string> {
  return {
    python: pythonCode(strategy, input),
    r: rCode(strategy, input),
    matlab: matlabCode(strategy, input)
  }
}

export function generateCodeForSpec(spec: ChartSpec, input: CodegenInput): Record<EngineKind, string> {
  const kinds = spec.panels.map((panel) => panel.layers[0]?.kind ?? 'line')
  const supported = new Set(['line', 'bar', 'scatter', 'heatmap'])
  const unsupported = kinds.find((kind) => !supported.has(kind))
  if (unsupported) throw new Error(`UNSUPPORTED_CHART_KIND:${unsupported}`)
  if (kinds.some((kind) => kind === 'scatter' || kind === 'heatmap') && input.measures.length < 2) {
    throw new Error('HEATMAP_REQUIRES_TWO_NUMERIC_MEASURES')
  }
  const outputBase = /^[a-z0-9_-]+$/i.test(input.outputBase ?? '') ? input.outputBase! : 'chart_spec'
  const pyPanels = kinds.map((kind, index) => {
    const ax = `axes.flat[${index}]`
    if (kind === 'bar') return `${ax}.bar(range(len(df)), df[measures[0]])`
    if (kind === 'scatter') return `${ax}.scatter(df[measures[0]], df[measures[1]])`
    if (kind === 'heatmap') return `im = ${ax}.imshow(df[measures].corr(), vmin=-1, vmax=1, cmap="coolwarm")\nfig.colorbar(im, ax=${ax})`
    return `\nfor m in measures:\n    ${ax}.plot(df[x_col], df[m], marker="o", label=m)\n${ax}.legend(frameon=False)`
  }).join('\n')
  const python = `# ChartSpec-driven Python / Matplotlib
import pandas as pd
import matplotlib.pyplot as plt
df = pd.read_csv(${JSON.stringify(input.fileName)})
x_col = ${JSON.stringify(input.x)}
measures = ${JSON.stringify(input.measures)}
fig, axes = plt.subplots(${spec.figure.rows}, ${spec.figure.cols}, squeeze=False, dpi=${spec.figure.dpi ?? 300}, layout="constrained")
${pyPanels}
fig.suptitle(${JSON.stringify(spec.figure.title)})
fig.savefig(${JSON.stringify(`${outputBase}.png`)}, facecolor="white", pad_inches=0.18)
fig.savefig(${JSON.stringify(`${outputBase}.svg`)}, facecolor="white", pad_inches=0.18)
`
  const r = `# ChartSpec-driven R
df <- read.csv(${JSON.stringify(input.fileName)}, check.names = FALSE)
png(${JSON.stringify(`${outputBase}.png`)})
par(mfrow = c(${spec.figure.rows}, ${spec.figure.cols}), oma = c(0, 0, 3, 0))
${kinds.map((kind) => kind === 'heatmap'
    ? `heatmap(cor(df[c(${input.measures.map((m) => JSON.stringify(m)).join(', ')})], use="pairwise.complete.obs"))`
    : `plot(df[[${JSON.stringify(input.measures[0])}]], type=${JSON.stringify(kind === 'scatter' ? 'p' : 'o')})`).join('\n')}
mtext(${JSON.stringify(spec.figure.title)}, side = 3, outer = TRUE, line = 1, cex = 1.2, font = 2)
dev.off()
svg(${JSON.stringify(`${outputBase}.svg`)})
plot.new(); title(${JSON.stringify(spec.figure.title)})
dev.off()
`
  const matlab = `% ChartSpec-driven MATLAB; licensed node only.
T = readtable('${input.fileName.replace(/'/g, "''")}');
figure('Color','w'); tiledlayout(${spec.figure.rows}, ${spec.figure.cols}, 'TileSpacing','loose', 'Padding','loose');
${kinds.map((kind) => kind === 'heatmap' ? 'nexttile; imagesc(corr(table2array(T))); colorbar;' : 'nexttile; plot(T{:,1}, T{:,2}, \'-o\');').join('\n')}
_st = sgtitle('${spec.figure.title.replace(/'/g, "''")}', 'FontSize', 15, 'FontWeight', 'bold'); _st.HorizontalAlignment = 'center';
exportgraphics(gcf, '${outputBase}.png', 'Resolution', 300);
print('-dsvg', '${outputBase}.svg');
`
  return { python, r, matlab }
}
