// Shared by normal and fallback Python generators. Measure rendered text rather
// than guessing margins from character counts; original data/labels stay intact.
export const PY_FINAL_LAYOUT = `
def _wrap_plot_text(value, font, renderer, max_width):
    lines = []
    for paragraph in str(value).split("\\n"):
        line = ""
        for char in paragraph:
            trial = line + char
            width = renderer.get_text_width_height_descent(trial, font, ismath=False)[0]
            if line and width > max_width:
                lines.append(line.rstrip())
                line = char.lstrip()
            else:
                line = trial
        lines.append(line.rstrip())
    return "\\n".join(lines)

def _finalize_plot_layout(fig):
    # Export uses the same layout for SVG, PNG and PDF. Do not shrink fonts to fit.
    fig.set_layout_engine("constrained")
    fig.get_layout_engine().set(w_pad=0.12, h_pad=0.12, wspace=0.12, hspace=0.16)
    renderer = fig.canvas.get_renderer()
    figure_legends = {}
    for ax in fig.axes:
        if getattr(ax, "name", "") != "3d" and ax.get_visible():
            ticks = ax.get_xticklabels()
            labels = [tick.get_text() for tick in ticks]
            if labels and any(any(ord(ch) > 127 or ch.isalpha() for ch in label) for label in labels):
                widest = max(tick.get_window_extent(renderer).width for tick in ticks)
                desired = widest * len(labels) / (4 * 0.82)
                deficit = max(0, desired - ax.bbox.width)
                if deficit:
                    extra_inches = deficit / fig.dpi / max(0.25, ax.get_position().width)
                    fig.set_size_inches(min(14, fig.get_figwidth() + extra_inches), fig.get_figheight(), forward=True)
        if not ax.get_visible() or getattr(ax, "_colorbar", None) is not None:
            continue
        legend = ax.get_legend()
        if legend is not None:
            position = getattr(ax, "_deep_legend_position", "right")
            if position in ("top", "bottom"):
                fig.set_size_inches(fig.get_figwidth(), max(6.4, fig.get_figheight()), forward=True)
            labels = [item.get_text() for item in legend.get_texts()]
            handles = getattr(legend, "legend_handles", None)
            if handles is None:
                handles = legend.legendHandles
            font = legend.get_texts()[0].get_fontproperties() if labels else None
            size = max(10, font.get_size_in_points()) if font else 11
            available = fig.bbox.width * (0.24 if position == "right" else 0.20)
            wrapped = [_wrap_plot_text(label, font, renderer, available) for label in labels] if font else labels
            legend.remove()
            if position in ("top", "bottom"):
                bucket = figure_legends.setdefault(position, {})
                for handle, label in zip(handles, wrapped):
                    bucket.setdefault(label, handle)
                continue
            locations = {
                "right": dict(loc="upper left", bbox_to_anchor=(1.02, 1.0)),
                "top": dict(loc="lower center", bbox_to_anchor=(0.5, 1.04)),
                "bottom": dict(loc="upper center", bbox_to_anchor=(0.5, -0.15)),
                "inside": dict(loc="upper right")
            }
            ax.legend(handles, wrapped, frameon=False, fontsize=size,
                      ncol=1 if position in ("right", "inside") else min(3, max(1, len(labels))),
                      borderaxespad=0, **locations.get(position, locations["right"]))
    for position, entries in figure_legends.items():
        title_options = {}
        if position == "top" and fig._suptitle is not None:
            title_options = dict(title=fig._suptitle.get_text(), title_fontproperties=fig._suptitle.get_fontproperties())
            fig._suptitle.set_visible(False)
        fig.legend(list(entries.values()), list(entries.keys()),
                   loc="outside upper center" if position == "top" else "outside lower center",
                   ncol=min(3, max(1, len(entries))), frameon=False, fontsize=11, **title_options)
    # Recompute after the external legend has reserved its own space.
    for attempt in range(4):
        fig.canvas.draw()
        renderer = fig.canvas.get_renderer()
        needs_height = False
        for ax in fig.axes:
            if not ax.get_visible() or getattr(ax, "_colorbar", None) is not None:
                continue
            if getattr(ax, "name", "") != "3d":
                ticks = ax.get_xticklabels()
                if ticks and not hasattr(ax, "_deep_original_xticks"):
                    ax._deep_original_xticks = (ax.get_xticks().copy(), [t.get_text() for t in ticks])
                if hasattr(ax, "_deep_original_xticks"):
                    locations, labels = ax._deep_original_xticks
                    # Only wrap category text. Keep numeric formatters/scientific notation.
                    if labels and any(any(ord(ch) > 127 or ch.isalpha() for ch in label) for label in labels):
                        slot = ax.get_window_extent(renderer).width / max(1, len(labels))
                        font = ticks[0].get_fontproperties()
                        wrapped = [_wrap_plot_text(label, font, renderer, max(16, slot * 0.82)) for label in labels]
                        ax.set_xticks(locations, wrapped, rotation=0, ha="center")
                for label in [ax.xaxis.label, ax.yaxis.label]:
                    if not hasattr(label, "_deep_original_text"):
                        label._deep_original_text = label.get_text()
                    label.set_text(_wrap_plot_text(label._deep_original_text, label.get_fontproperties(), renderer, max(80, ax.get_window_extent(renderer).width * 0.85)))
            legend = ax.get_legend()
            if legend is not None:
                position = getattr(ax, "_deep_legend_position", "right")
                if position == "bottom":
                    decorations = ax.xaxis.get_tightbbox(renderer)
                    gap = max(0.06, (ax.bbox.y0 - decorations.y0 + 14) / max(1, ax.bbox.height)) if decorations else 0.15
                    legend.set_bbox_to_anchor((0.5, -gap))
                elif position == "top" and ax.title.get_text():
                    gap = max(0.04, (ax.title.get_window_extent(renderer).y1 - ax.bbox.y1 + 10) / max(1, ax.bbox.height))
                    legend.set_bbox_to_anchor((0.5, 1 + gap))
                if legend.get_window_extent(renderer).height > ax.bbox.height and position == "right":
                    needs_height = True
        if needs_height and fig.get_figheight() < 12:
            fig.set_size_inches(fig.get_figwidth(), min(12, fig.get_figheight() * 1.2), forward=True)
    fig.canvas.draw()
`
