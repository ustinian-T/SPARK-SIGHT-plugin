# 安全策略

## 支持的版本

本仓库以 `main` 分支的当前提交为唯一受支持版本。插件会随宿主更新，历史提交
只作为存档，不单独提供安全修复。

## 报告漏洞

**请不要为安全漏洞开公开 Issue。**

请使用 GitHub 的私密漏洞报告通道：
[Security → Report a vulnerability](https://github.com/ustinian-T/SPARK-SIGHT-plugin/security/advisories/new)

如果该通道不可用，请开一个**不含任何漏洞细节**的 Issue，只说明你需要一个私密
联系渠道，维护者会回复你。

### 请在报告中包含

- 受影响的组件（`apps/vscode` / `apps/dsh` / `apps/web` / `services/local-agent`）
  与版本或提交号
- 问题类型（例如：认证绕过、路径穿越、命令注入、沙箱逃逸、XSS、密钥泄露）
- 复现步骤或最小复现样例
- 影响评估：攻击者能做到什么，需要什么前提
- 如果有，建议的修复方向

**不要在报告中粘贴真实的 API Key、令牌、私钥或他人个人数据。** 如果漏洞本身
涉及某个凭据，请只描述其形态与位置。

### 响应预期

维护者是志愿者，不承诺固定时限。我们会在确认后尽快发布修复，并在
GitHub Security Advisory 中致谢（除非你要求匿名）。

## 本项目的安全设计要点

如果你在评估本项目的安全性，以下几点是设计基线，偏离它们即为缺陷：

### 认证与令牌

- 本地 Agent 只绑定 `127.0.0.1`，每次启动生成**随机** boot token。
- API 使用 `Authorization: Bearer <token>`；WebSocket 在握手**之后**认证。
- **token 从不进入 URL**，也从不写入页面 query string。
- 管理员初始口令每次随机生成，**从不使用跨安装实例共享的默认口令**。

### 路径与文件

- 拒绝指向当前工作区之外的资源。
- 需要新建或其他用户态操作时，在 `127.0.0.1` 上就近启动其他服务，不做目录级放行。
- 补丁应用必须带 base hash；**脏编辑器与过期 hash 一律先打开审阅 diff，
  绝不静默覆盖**。
- 打包装配脚本拒绝符号链接，并跳过 `.data`、`.env`、`projects`、`tasks`、
  `__pycache__` 与各类密钥文件后缀。

### 执行与沙箱

- 生成的 Python / R / MATLAB 代码在受限执行环境中运行；需要强隔离时，
  Agent 会**如实报告**能力不足（`STRONG_SANDBOX_REQUIRED`），而不是降级执行。
- 缺失的运行时报告为不可用，不伪装成执行成功。
- 自动修复有预算上限，不保证任意代码都能修复。

### 更新校验

- 更新下载固定发布源，**禁止重定向**，校验字节数与 SHA-256，不匹配则不安装。
- 发布源通过 `DEEP_IMAGING_UPDATE_ORIGIN` 配置。**注意：该环境变量在你自行
  构建时会决定更新来源；请只指向你自己控制的 HTTPS 主机。**

### 内容渲染

- Web UI 由本地 Agent **同源**托管，静态资源不需要 token。
- webview 使用 nonce 保护的 CSP；跨源消息的方向与 target origin 都受控。

## 已知的非缺陷

- `services/local-agent/test/` 中出现 `AKIAIOSFODNN7EXAMPLE`、
  `-----BEGIN RSA PRIVATE KEY-----`、`sk-secret-abcdef-123456` 等字符串，
  它们是被扫描的模式字面量、AWS 官方文档示例键或测试夹具，**不是有效凭据**。
- 仓库中的默认值为 `contact@example.com`、`https://updates.example.com`
  等占位符，属于有意为之的脱敏结果，不是配置错误。

## 仓库的凭据卫生

发布快照已做脱敏处理，处理清单与复核方法见
[docs/privacy-and-redaction.md](docs/privacy-and-redaction.md)。任何人可运行：

```sh
npm run check:secrets
```

来复现这项检查。脚本只包含**类别模式**（凭据形态、个人邮箱域、备案号、本机
路径），不包含任何被抹掉的真实值——把真实值写成字面量等于又把它写回仓库。
维护者可以额外在仓库根放一个不入库的 `.secrets-denylist.local`，逐行列出
「曾经出现过的具体值」，脚本会在它存在时一并断言这些值全部不存在。
