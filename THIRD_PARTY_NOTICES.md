# Third-Party Notices

本仓库包含或依赖下列第三方作品。它们分别适用其原有许可，本项目的
非商业使用与署名许可**不对其追加限制**，MIT 部分也不改变其条款。

本文件是声明汇总，不替代各上游的许可全文。分发时请一并保留上游要求的
版权与许可声明。机器可读的依赖清单由 `npm run sbom` 生成。

---

## 1. 宿主平台

### DeepSeek Harness / @deepseek-ai/cordis

- 用途：`apps/dsh/` 运行其中的宿主平台与模块加载器。
- 来源：https://github.com/deepseek-ai/deepseek-harness
- 许可：MIT License，Copyright (c) 2026 DeepSeek

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

本插件是独立的第三方插件，**未获得 DeepSeek 的提供、认可、认证或赞助**。
"DeepSeek" 及相关名称、标识是 DeepSeek 的商标，MIT 许可不授予商标权。

### Visual Studio Code Extension API

- 用途：`apps/vscode/` 使用 VS Code 扩展 API。
- 来源：https://code.visualstudio.com/api
- 许可：VS Code 产品与 API 使用条款；`@types/vscode` 类型声明为 MIT。
- **VS Code 本身不随本仓库分发**，也未被本项目的条款再许可。

### Node.js

- 用途：本地 Agent、构建脚本与测试的运行时。
- 来源：https://nodejs.org/
- 许可：MIT，并附带其自带第三方声明。
- **运行时不随本仓库分发**，安装包中的运行时副本单独携带其许可文件。

---

## 2. npm 依赖（开发与构建期）

版本以 `package-lock.json` 锁定值为准。

| 组件 | 版本 | 许可 | 用途 |
|---|---|---|---|
| react | 18.3.1 | MIT | 共享 Web UI，由宿主模块表提供或由打包器内联 |
| react-dom | 18.3.1 | MIT | 同上 |
| typescript | 5.6.3 | Apache-2.0 | 类型检查与构建 |
| vite | 8.3.0 | MIT | Web 构建工具 |
| vitest | 5.0.1 | MIT | 单元测试 |
| @vitejs/plugin-react | 6.1.1 | MIT | Vite 的 React 插件 |
| @types/node | ^22.10.2 | MIT | 类型声明 |
| @types/vscode | ^1.95.0 | MIT | 类型声明 |
| @types/react / @types/react-dom | ^18.3.12 / ^18.3.1 | MIT | 类型声明 |

MIT 与 Apache-2.0 的完整条款见各依赖包内的 `LICENSE` 文件；
Apache-2.0 全文另见 [docs/licenses/Apache-2.0-legacy.txt](docs/licenses/Apache-2.0-legacy.txt)。

---

## 3. 随仓库分发的资源

### Noto Sans CJK SC Regular

- 路径：`services/local-agent/src/fonts/NotoSansCJKsc-Regular.otf`
- 版本：Sans 2.004，上游原样未修改
- 来源：https://github.com/notofonts/noto-cjk/tree/main/Sans/OTF/SimplifiedChinese
- 许可：**SIL Open Font License 1.1**，全文见
  [services/local-agent/src/fonts/OFL.txt](services/local-agent/src/fonts/OFL.txt)
- SHA-256：`2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b`

OFL 允许随软件自由再分发与嵌入，要求保留版权与许可声明、不得单独售卖字体、
不得使用 Reserved Font Name。**本项目的非商业条款不覆盖该字体**；即使你按
MIT 使用适配层，字体仍只受 OFL 约束。

---

## 4. 色板数据的来源与许可

`services/local-agent/src/palettes.js` 中的预设色板取自下列公开科研配色方案。
这些预设是**颜色取值（数据）的引用**，不是上游源代码的复制或改编。

| 来源 | 许可 | 使用方式 |
|---|---|---|
| [ColorBrewer](https://colorbrewer2.org/)（Cynthia Brewer 等） | Apache 风格的 ColorBrewer 条款，要求注明出处 | 顺序/发散/定性色板取值 |
| [Seaborn](https://github.com/mwaskom/seaborn) `colorblind` | BSD-3-Clause | 色盲友好定性色板取值 |
| [ggsci](https://github.com/nanxstats/ggsci)（NPG / NEJM / Lancet / JAMA） | GPL-3.0 | 期刊风格色板取值 |

### 关于 ggsci 的 GPL-3.0

ggsci 采用 GPL-3.0。本项目**不复制 ggsci 的源代码**，只引用其编码的期刊配色
**数值**（十六进制颜色列表）。配色数值属于事实性数据，其对应的期刊配色方案
并非 ggsci 的独创表达；本项目据此认为在 MIT / 非商业许可下引用这些数值不构成
对 GPL-3.0 代码的衍生。

**给再分发者的提示：** 这是一项基于事实的技术判断，不构成法律意见。如果你的
合规政策要求对任何 GPL 来源采取最保守立场，请在使用前自行移除
`palettes.js` 中的 `ggsci_*` 预设，其余功能不受影响（它们彼此独立）。
本项目同时保留上表出处标注。

---

## 5. 用户自备的运行时与服务（不分发）

| 组件 | 许可或条款 | 边界 |
|---|---|---|
| Python / matplotlib | PSF 基础许可 | 由用户环境提供，不随仓库分发 |
| R | GPL-2.0 或 GPL-3.0 | 由用户安装；生成的 R 代码属用户输出 |
| MATLAB | MathWorks 商业条款 | 项目不分发 MATLAB，也不上传其许可证 |
| Volcano Engine Ark | 火山引擎服务条款 | 使用者自行申请并保护凭据 |
| Docker Compose / Caddy | Apache-2.0 | 仅部署示例引用，不随仓库分发 |

MATLAB、R 与云模型接口都需要各自合法的授权或服务权益，本项目的许可不能代替
这些外部权益。**无模型、无 Python/R 时，部分内置图型仍可运行；缺失的运行时
会被如实报告为不可用，而不是伪装成执行成功。**

---

## 6. 商标

"DeepSeek"、"DeepSeek Harness" 是 DeepSeek 的商标；"Visual Studio Code" 与
"VS Code" 是 Microsoft 的商标；"MATLAB" 是 The MathWorks, Inc. 的商标；
"NPG"、"NEJM"、"The Lancet"、"JAMA" 分别是其出版机构的名称或商标。

以上名称仅用于客观描述兼容性、数据来源或配色风格，**不表示任何形式的关联、
认可、赞助或背书**。"SPARK SIGHT"、"灵感视界" 及本项目图标是本项目自己的标识，
不在上述第三方许可的授权范围内。
