# 许可、署名与范围

本页说明本仓库的许可结构、每种许可覆盖的确切范围，以及再分发时的义务。
正式条款以各目录内的 `LICENSE` 文件为准；本页只做解释，不额外扩大或缩小授权。

> **一句话总结**：本仓库**不是单一许可**。两个插件适配层是 **MIT（真开源）**；
> 共享的本地 Agent 与 Web UI 是**含非商业限制的源码可用许可（不是 OSI 开源）**；
> 内置字体是 **OFL-1.1**；第三方组件各归其主。

---

## 1. 目录与许可对照表

| 路径 | 内容 | 许可 | SPDX 标识 | 是否 OSI 开源 |
|---|---|---|---|---|
| `apps/vscode/` | VS Code 扩展适配层（命令、webview 宿主、补丁审阅、运行时管理、更新检查） | MIT | `MIT` | ✅ 是 |
| `apps/dsh/` | DeepSeek Harness 插件适配层（Host 半、Client 半、sidecar 管理、locale、图标） | MIT | `MIT` | ✅ 是 |
| `apps/web/` | 共享 Web UI（React 界面、站点页面、宿主桥、客户端 SDK） | 非商业使用与署名许可 1.0 | `LicenseRef-Deep-Imaging-NC-Attribution-1.0` | ❌ 否 |
| `services/local-agent/` | 共享本地 Agent（HTTP/WS 服务、图表引擎、统计与验证、决策模块） | 非商业使用与署名许可 1.0 | `LicenseRef-Deep-Imaging-NC-Attribution-1.0` | ❌ 否 |
| `services/local-agent/src/fonts/` | Noto Sans CJK SC Regular | SIL Open Font License 1.1 | `OFL-1.1` | ✅ 是 |
| `contract/` | 宿主协议模式定义 | 同其服务的实现（适配层 MIT / 共享 Agent 非商业） | 见上 | — |
| `docs/`、根 `*.md` | 文档 | 非商业使用与署名许可 1.0 | 同上 | ❌ 否 |

许可文件位置：

- 根 [LICENSE](../LICENSE) — 非商业使用与署名许可 1.0 全文（含 Apache-2.0 历史附录）
- [LICENSE-MIT](../LICENSE-MIT) — MIT 全文（适配层使用）
- [apps/vscode/LICENSE](../apps/vscode/LICENSE)、[apps/dsh/LICENSE](../apps/dsh/LICENSE) — 各自目录生效的 MIT
- [apps/web/LICENSE](../apps/web/LICENSE)、[services/local-agent/LICENSE](../services/local-agent/LICENSE) — 指向根许可的说明
- [services/local-agent/src/fonts/OFL.txt](../services/local-agent/src/fonts/OFL.txt) — 字体许可

---

## 2. MIT 覆盖的部分（`apps/vscode/`、`apps/dsh/`）

这是**真正的开源许可**，也是 OSI 批准的许可。

**你可以：** 出于任何目的（含商业目的）使用、复制、修改、合并、发布、分发、
再许可和/或销售这些代码；可以闭源分发自己的修改。

**你必须：** 在软件的所有副本或实质性部分中，保留上述版权声明与本许可声明。

**保障：** 软件按“现状”提供，作者不承担任何担保与责任。

**不受 MIT 覆盖的内容：** 适配层在运行时**打包进去的**共享 Agent 与 Web UI
构建产物，仍受非商业许可约束；适配层里指向它们的路径、加载逻辑本身是 MIT。

---

## 3. 非商业使用与署名许可 1.0 覆盖的部分（`apps/web/`、`services/local-agent/`）

这是**源码可用的自定义许可**，包含非商业限制。按 OSI 的定义（
[Open Source Definition 第 6 条](https://opensource.org/osd)，不得按商业领域限制用途），
**它不是开源许可**。我们公开源码供学习、研究与改进，同时如实说明限制。

### 可以如何使用

| 场景 | 是否授权 |
|---|---|
| 个人学习、练习制图 | ✅ 允许，项目说明中保留来源 |
| 正常课堂教学 | ✅ 允许，材料中注明来源 |
| 非营利科研、论文发表 | ✅ 允许，方法/致谢/工具说明中注明来源 |
| 学术研究有一般研究资助或正常学费 | ✅ 不自动变成商业使用；用途仍须非商业 |
| 免费分享非商业修改版 | ✅ 允许，保留许可与声明，标明修改并注明来源 |
| 收费绘图、付费 SaaS、商业产品集成 | ❌ 需事先书面商业授权 |
| 免费引流服务、为企业客户有偿交付 | ❌ 需商业授权，“免费”不等于非商业 |
| 把共享 Agent/UI 换皮成自有商业产品 | ❌ 需商业授权 |

### 必须注明来源

推荐文字：

> 基于灵感视界 SPARK SIGHT / Deep Imaging，来源：https://github.com/ustinian-T/SPARK-SIGHT-plugin；
> 非商业使用与署名许可 1.0；版本/提交：实际版本。

- 使用软件或托管界面：在关于、帮助或说明页提供可见来源。
- 论文、教学材料：放在方法、致谢或工具说明，**不要求每张图加水印**。
- 再分发源码或二进制：保留 `LICENSE`、`NOTICE.md` 与必要的第三方声明，
  并说明作者、日期与具体修改。
- 不得暗示原作者认可你的研究或衍生产品；许可不提供品牌背书权。

### 你的数据不是许可对象

上传的数据、API Key、聊天记录、原始素材与生成的统计结果不因使用本工具而
转让给项目方，也不强制附带本软件许可。生成图表的许可与引用由使用者自行确认。

### 商业授权

通过[仓库 Issues](https://github.com/ustinian-T/SPARK-SIGHT-plugin/issues) 联系维护者并说明用途。
**不要在该渠道提交密码、密钥或私有数据**；联系本身不构成授权。

---

## 4. 许可兼容性分析

选择这套组合的理由，以及各项的边界：

### 4.1 为什么可以同时存在 MIT 与非商业许可

同一仓库的不同原创部分由同一权利人提供，权利人**可以**对不同部分授予不同条款
（即“按目录授权”，每个子目录声明自己生效的许可）。因此：

- `apps/vscode/`、`apps/dsh/` 的原创适配代码 → MIT（权利人主动授予的最宽松条款）。
- `apps/web/`、`services/local-agent/` 的原创代码 → 非商业许可（权利人保留商业授权）。

**没有任何条款把非商业限制“传染”给 MIT 部分**，反之亦然：MIT 部分不因被
非商业代码调用而丧失 MIT 地位，非商业部分也不因与 MIT 代码同处一个仓库而
变成开源。

### 4.2 与第三方许可的关系

| 第三方 | 许可 | 是否影响本项目许可选择 |
|---|---|---|
| React、Vite、Vitest、@types/* | MIT | 无。MIT 允许再许可与闭源分发，只需保留声明。 |
| TypeScript | Apache-2.0 | 无。Apache-2.0 与 MIT / 自定义许可兼容，需保留 NOTICE 与许可。 |
| Noto Sans CJK SC | OFL-1.1 | 无。OFL 允许嵌入与随软件分发，只约束字体本身。 |
| ColorBrewer | Apache 风格 | 无。仅引用配色数值并注明出处。 |
| Seaborn 色板 | BSD-3-Clause | 无。仅引用配色数值并注明出处。 |
| **ggsci** | **GPL-3.0** | **已隔离**：不复制其代码，只引用配色数值。详见下节。 |
| Python/matplotlib、R、MATLAB、Node.js | PSF / GPL / 商业 / MIT | 无。**均不随仓库分发**，使用者自行安装。 |

### 4.3 ggsci 的 GPL-3.0 与隔离措施

GPL-3.0 是强 copyleft：如果本项目包含 ggsci 的**代码**，整个作品就需要以
GPL-3.0 分发，这与当前的 MIT + 非商业组合冲突。

因此本项目采取的措施是：

1. **不复制 ggsci 源代码**，`palettes.js` 中只包含十六进制颜色**取值**。
2. 配色数值是事实性数据；期刊配色方案由各出版机构确立，并非 ggsci 的独创表达。
3. 保持 `ggsci_*` 预设相互独立，移除它们不影响其余功能。
4. 在 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) 中如实标注来源与许可。

> **合规提示：** 这是基于事实与通行技术判断的取舍，**不构成法律意见**。
> 若你的组织采用最保守的 GPL 政策，请在使用前删除 `palettes.js` 中的
> `ggsci_*` 预设。若你计划把本项目用于商业场景，请先取得商业授权并自行完成
> 合规审查。

### 4.4 历史 Apache-2.0 代码

主项目在 2026-10-09 之前按 Apache License 2.0 发布。**已生效的授权不追溯撤销**，
因此：

- 此前获得的 Apache-2.0 代码，仍可按 Apache-2.0 使用，包括商业使用。
- 当前版本中**新增的原创修改与整体发行**适用非商业许可。
- Apache-2.0 的再分发义务（保留许可、NOTICE、标明修改）继续有效。
- 全文保留在根 [LICENSE](../LICENSE) 附录与
  [docs/licenses/Apache-2.0-legacy.txt](licenses/Apache-2.0-legacy.txt)。

不要把历史代码说成“一律禁止商业使用”，也不要把当前版本说成纯粹的 Apache-2.0。

---

## 5. 常见问题

**Q：我可以把插件用在自己的商业项目里吗？**
A：`apps/vscode/` 与 `apps/dsh/` 的适配层代码可以（MIT）。但插件运行时需要
共享 Agent 与 Web UI，它们是非商业许可；商业使用需另行取得授权。

**Q：我可以把共享 Agent 换皮成自己的产品发布吗？**
A：非商业场景可以（保留许可与署名、标明修改）。商业场景需事先书面授权。

**Q：我改了代码，需要开源我的修改吗？**
A：不需要。非商业许可不要求你公开修改，只要求保留许可与署名、标明修改。
MIT 部分同样不要求。

**Q：可以去掉非商业限制吗？**
A：不可以。你可以在自己新增的原创部分采用任何许可，但不得取消本许可对
覆盖部分的要求。

**Q：只用到字体可以吗？**
A：可以。字体是 OFL-1.1，与项目的非商业条款无关，遵守 OFL 即可。

**Q：为什么不直接整个仓库用 MIT？**
A：共享 Agent 与 Web UI 是项目的主要成果，维护者选择保留商业授权通道。
适配层用 MIT 是为了让社区能自由地为两个宿主写扩展、做集成。

**Q：怎样确认仓库里没有密钥？**
A：运行 `npm run check:secrets`，并参见
[docs/privacy-and-redaction.md](privacy-and-redaction.md)。

---

## 6. 贡献

新贡献应有权提交，并接受其所在目录适用的许可：

- 改 `apps/vscode/`、`apps/dsh/` → 以 MIT 提交。
- 改 `apps/web/`、`services/local-agent/` → 以非商业许可提交。

不得删除或弱化他人的版权与许可声明。详见 [CONTRIBUTING.md](../CONTRIBUTING.md)。
