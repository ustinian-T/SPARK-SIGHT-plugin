# 隐私与脱敏说明

本仓库是面向公开发布的源码快照。本页记录发布前做了哪些脱敏处理、依据是什么，
以及任何人都可以复现的复核方法。

---

## 1. 结论

这份快照**不包含**：

- ❌ 任何真实 API Key、访问令牌、会话密钥或密码
- ❌ 任何私钥（`.pem` / `.key`）或证书（`.pfx` / `.p12` / `.crt`）
- ❌ 任何 `.env` 文件（只保留无值的 `.env.example`）
- ❌ 真实个人姓名、私人邮箱、手机号
- ❌ ICP 备案号与公安联网备案号
- ❌ 生产环境域名与内部端点
- ❌ 用户上传的数据、项目、任务记录、聊天记录
- ❌ 第三方运行时（Node / Python / R / MATLAB）与其许可文件

---

## 2. 逐项处理记录

发布快照相对主项目源码，做了以下**明确的、可审阅的**替换。
每一处修改都在代码中留有注释，便于与主项目 diff 对照。

### 2.1 历史默认管理员口令（真实凭据）

| 位置 | 原内容 | 处理 |
|---|---|---|
| `services/local-agent/test/api.test.js` | 旧版固定管理员用户名与口令字面量 | 替换为中性占位符 `admin` / `legacy-default-password`，并加注释 |

该用例的**目的**是验证“旧版固定口令已失效”（断言 401），与具体凭据取值无关，
因此替换后测试语义不变。真实的旧默认口令**不出现在本仓库的任何位置**。

### 2.2 默认管理员用户名（真实姓名）

| 位置 | 原内容 | 处理 |
|---|---|---|
| `services/local-agent/src/server.js` | 默认管理员名取自真实姓名拼音 | 默认值改为 `admin` |
| `apps/dsh/README.md` | 配置表记录了该默认值 | 同步更新为 `admin` |

仍可通过 `LOCAL_AGENT_ADMIN_USERNAME` 环境变量或插件的 `adminUsername` 配置项
覆盖。**默认口令始终是每次启动随机生成的**，从不写死。

### 2.3 个人姓名、联系方式与备案号

| 位置 | 原内容 | 处理 |
|---|---|---|
| `apps/web/src/site/Chrome.tsx` | 版权行含真实姓名 | 改为 `© 2026 SPARK SIGHT contributors` |
| `apps/web/src/site/Chrome.tsx` | 真实 ICP 备案号 | 改为 `ICP备-示例-0000000号` |
| `apps/web/src/site/Chrome.tsx` | 真实公安联网备案号 | 改为 `公网安备-示例-00000000000号` |
| `apps/web/src/site/Chrome.tsx` | 私人邮箱 | 改为 `contact@example.com` |
| `apps/web/src/site/AgreementDocument.tsx` | 私人邮箱常量 | 改为 `contact@example.com` |

备案号的查询入口 URL（`beian.miit.gov.cn`、`beian.mps.gov.cn`）是政府公开服务地址，
予以保留。

> **部署方注意：** 在中国大陆境内提供互联网信息服务需自行完成 ICP 备案，
> 经营性服务还需 ICP 许可证。**本项目不提供、也不代传递任何备案资质**，
> 页脚的占位符必须替换为你依法取得的备案信息，或移除相关页脚。

### 2.4 生产域名与基础设施

| 位置 | 原内容 | 处理 |
|---|---|---|
| `apps/vscode/src/updater.ts` | 硬编码的官方更新源 | 改为读取 `DEEP_IMAGING_UPDATE_ORIGIN`，默认 `https://updates.example.com` |
| `apps/dsh/lib/updater.js` | 硬编码的官方更新源 | 同上 |
| `apps/vscode/src/extension.ts` | 硬编码的账号服务地址 | 改为读取 `DEEP_IMAGING_ACCOUNT_URL`，默认 `https://account.example.com` |
| `apps/dsh/lib/sidecar.js` | 硬编码的账号服务地址 | 同上 |
| `apps/vscode/test/updater.test.ts` | 断言具体生产 URL | 改为断言 `${UPDATE_ORIGIN}/downloads/${ARTIFACT_NAME}`，仍验证“地址被固定在配置的发布源、不接受用户输入拼接” |
| `apps/web/src/site/session.test.ts` | 测试桩用了生产 origin | 改为 `https://example.com` |

**保留的公开链接：** `apps/web/src/components/ActivityBar.tsx` 中指向主项目仓库
`https://github.com/ustinian-T/deep_imaging` 的“项目仓库与文档”按钮。这是产品的
公开主页，属于有意公开的信息。

### 2.5 从主项目排除、未复制的内容

以下内容在**主项目中存在**，但**没有**进入本快照：

| 内容 | 原因 |
|---|---|
| `deep.pem` | 私钥文件 |
| `.env` 及各类密钥文件 | 凭据；主项目 `.gitignore` 已排除 |
| `.data/`、`.preview/`、`.doc-txt/` | 本地数据与预览产物，含用户数据 |
| `node_modules/`、`dist/`、`target/` | 依赖与构建产物，可复现 |
| 主项目的站点部署目录 | 部署配置，不属于插件源码 |
| `apps/desktop/` | 桌面壳（Tauri），不属于本次发布范围 |
| 各插件的打包产物目录（`apps/vscode/agent/`、`apps/vscode/web/`、`apps/dsh/resources/`） | 构建期从 `services/local-agent` 与 `apps/web` 生成，不应入库 |

---

## 3. 数据与测试夹具的权属

仓库中的 CSV 夹具、决策基线、评估数据与浏览器演示数据**全部是合成的测试数据**，
不描述真实人物、患者、实验、机构或已发表研究，可按本仓库许可再分发。

贡献者**不得**在未取得书面许可的情况下加入机密、个人、临床、出口管制或第三方
研究数据。新增样例必须注明来源、许可/授权、用途与必要的署名。详见
[sample-data-rights.md](sample-data-rights.md)。

**用户上传的数据始终由用户控制。** 本地模式下数据存放于配置的数据目录，删除或
TTL 到期后清理任务数据与产物；远程部署方需自行负责保留告知、访问控制、备份、
物理删除保证与适用的数据保护法律合规。

---

## 4. 运行时的数据流向（诚实说明）

| 环节 | 是否离开本机 |
|---|---|
| 数据检查、统计、图表生成（无模型时） | 否 |
| 本地 Agent 的项目/任务记录 | 否，写在配置的数据目录 |
| 调用大模型规划 | **是** — 提示词与必要的字段摘要发送给你配置的模型提供商 |
| 登录官方账号服务 | **是** — 仅在与账号服务交互时；项目与原始数据不随登录同步 |
| 更新检查 | **是** — 向配置的更新源请求发布清单 |

“本地保存”**不等于**模型调用离线。选择模型提供商即表示你接受其数据处理政策。
本快照已经把账号服务与更新源改为可配置，你可以指向自己的服务，或保持占位符
默认值使相关功能不可用。

---

## 5. 如何自行复核

### 自动扫描

```sh
npm run check:secrets
```

该脚本扫描仓库全部文本文件，做两类检查：

**1. 通用类别模式** —— 描述「形状」，不指向任何具体的人或服务：

| 类别 | 覆盖 |
|---|---|
| 凭据形态 | Ark 凭据、OpenAI 风格密钥、AWS key id、GitHub token、Google API key、Slack token、私钥块、JWT、被赋值的 `API_KEY`/`AUTH_TOKEN`/`SECRET_KEY` |
| 个人标识 | 个人邮箱域（163/126/qq/sina/sohu/foxmail/139/189）、中国大陆手机号字面量、`C:\Users\<真实账号>` 形式的本机路径 |
| 备案号 | 各省简称 + `ICP备` + 数字，以及 `公网安备` + 数字 |

**2. 本地黑名单（可选）** —— 若仓库根存在 `.secrets-denylist.local`，脚本会
逐行读取其中的字面量并断言**全部不存在**。该文件已被 `.gitignore` 排除，
**不会入库**。

> **为什么具体值不写在检查脚本里？** 检查脚本本身会被公开。如果把真实口令或
> 姓名写成字面量，等于把要保护的数据又写回仓库——这正是本页要防止的事。
> 所以具体值只留在本机黑名单中，脚本里只有类别模式。

脚本带有显式的测试夹具白名单（如 `AKIAIOSFODNN7EXAMPLE`、工信部公开测试号段
`13800138000`），但**不会**放行任何厂商形态的真实密钥。发布流程中该检查必须通过。

### 人工复核

```sh
git log --all --full-history -- '*.pem' '*.key' '*.env'   # 历史上是否出现过凭据文件
git ls-files | findstr /i ".env .pem .key .pfx .p12 .crt"  # 当前是否跟踪了凭据文件
```

再按下表逐类搜索：

| 目标 | 建议搜索 |
|---|---|
| 私钥 | `BEGIN .*PRIVATE KEY` |
| 云凭据 | `AKIA`、`sk-`、`ark-`、`ghp_`、`github_pat_`、`AIza` |
| 凭据赋值 | `API_KEY`、`AUTH_TOKEN`、`password` 后跟长字符串字面量 |
| 个人身份 | 真实姓名、`@163.com`、`@qq.com`、`@gmail.com`、手机号 |
| 备案 | `ICP备`、`公网安备` |
| 生产域名 | 本项目实际使用的自有域名（本文件刻意不复述），以及任何自建域名 |
| 本地路径 | `C:\Users\`、`D:\`、`E:\` 等盘符绝对路径 |

**也可以直接对暂存内容做门禁**，确认真正进入提交的内容是干净的：

```sh
git grep --cached -I -n -E '个人邮箱域|备案号|盘符绝对路径'
```

**已知并接受的例外：** `services/local-agent/test/memory.test.js` 与
`security.test.js` 中出现 `AKIAIOSFODNN7EXAMPLE`、`-----BEGIN RSA PRIVATE KEY-----`
等字符串——它们是被扫描的**模式字面量**或 AWS 官方文档中的示例键，
不是有效凭据。手机号夹具 `13800138000`、`13900139000`、`13700137000` 是
工信部公开的测试号段。`C:\Users\zhangsan\...` 使用通用占位名。

---

## 6. 如果你发现了问题

若你认为本仓库仍然泄露了凭据或个人信息，请**不要**在公开 Issue 中粘贴该内容。
通过仓库的私密安全报告渠道或直接联系维护者说明位置，我们会尽快修正并评估
是否需要轮换相关凭据。详见 [SECURITY.md](../SECURITY.md)。
