# 贡献指南

感谢你愿意为灵感视界 SPARK SIGHT · Deep Imaging 的插件做贡献。

## 先确认许可归属

**这是一个按目录授权的仓库**，不同目录适用不同条款。提交前请确认你的改动落在
哪个目录，并同意该目录的许可：

| 改动位置 | 适用许可 | 说明 |
|---|---|---|
| `apps/vscode/`、`apps/dsh/` | MIT | 你可以自由使用、修改、再分发，包括商业用途 |
| `apps/web/`、`services/local-agent/` | 非商业使用与署名许可 1.0 | 含非商业限制，见根 [LICENSE](../LICENSE) |

提交即表示你有权提交该内容，并同意其按上述许可发布。**不要**粘贴你没有权利
提交的代码、数据或素材。详见 [docs/licensing.md](../docs/licensing.md)。

## 绝对不要提交的内容

- ❌ API Key、访问令牌、密码、会话密钥
- ❌ 私钥、证书、`.env` 文件
- ❌ 真实姓名、私人邮箱、手机号、备案号
- ❌ 生产域名或内部端点
- ❌ 真实的、机密的、临床的、个人可识别的或出口管制的研究数据

样例数据必须是**合成的**，并说明来源、许可与用途。详见
[docs/sample-data-rights.md](../docs/sample-data-rights.md)。

## 开发流程

```sh
git clone https://github.com/ustinian-T/SPARK-SIGHT-plugin.git
cd SPARK-SIGHT-plugin
npm run install:all
npm run test
npm run check
```

## 提交前必须跑通

```sh
npm run check          # 密钥与隐私扫描 + 协议一致性
npm run test           # Agent / Web / VS Code 三套测试
npm run build          # 至少确认 Web 与 VS Code 能构建
```

`npm run check:secrets` 会检查凭据形态**以及**本项目要求中性化的个人与基础设施
标识（个人邮箱域、备案号、本机盘符路径等）。如果你的改动意外引入了真实邮箱、
姓名或域名，这个检查会失败——请改成占位符，而不是放宽检查规则。

维护者可以在仓库根放一个 `.secrets-denylist.local`（已被 `.gitignore` 排除，
**不会入库**），逐行列出「曾经出现过的具体值」；脚本会在它存在时一并断言这些
值全部不存在。**不要把这个文件提交或分享。**

## 代码约定

- 语言与风格跟随所在目录的现有代码；不引入与周边不一致的新范式。
- 共享本地 Agent **保持零运行时 npm 依赖**，只使用 Node 内置模块。
- 无构建步骤的产物（`apps/dsh/index.js`、`client.js`）直接修改源文件，
  格式与现有代码保持一致。
- 协议相关改动必须同步 `contract/host-protocol.schema.json` 与各客户端的
  `protocol.json`，并跑 `npm run check:contract`。
- 中文注释与英文注释都已在用，跟随所在文件的现有语言即可。

## 提交信息

使用 Conventional Commits 风格的前缀，例如：

```
feat(vscode): 支持多根工作区的选区读取
fix(dsh): sidecar 启动失败时回收子进程
docs(license): 补充 ggsci 色板的隔离说明
```

## 测试要求

- 行为改动 → 补对应测试。
- 安全相关改动（认证、路径校验、沙箱、更新校验）→ 必须补测试，
  并在 PR 描述中说明威胁模型。
- 不为了让测试通过而放宽容忍度；如果确实需要白名单，请在 PR 中说明理由。

## 安全问题

**不要**为安全漏洞开公开 Issue。请按 [SECURITY.md](../SECURITY.md) 的渠道报告。

## 行为准则

保持技术讨论、尊重他人、就事论事。不接受骚扰、歧视或人身攻击。
