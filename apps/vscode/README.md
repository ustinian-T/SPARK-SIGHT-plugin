# spark sight · 灵感视界

在 VS Code 中完成科研绘图：导入数据、比较绘图方案、审阅代码，并导出可复现的图表结果。

## 功能

- 打开 CSV、Excel 或 JSON 数据，或使用编辑器中主动选择的代码。
- 生成和比较图表方案，预览结果并导出可复现包。
- 在工作区内审阅代码修改，支持差异查看及补丁审阅。
- 使用本机 Python、R、MATLAB 或 Node 运行脚本，并查看运行诊断。
- 在统一工作区管理检查器、证据与绘图偏好。

## 开始使用

1. 安装扩展及下面列出的本机运行依赖，重启 VS Code。
2. 点击左侧活动栏的 spark sight 图标打开竖版侧边栏；可用 VS Code 的“移动视图”将它移到右侧。也可打开项目文件夹，按 `Ctrl+Alt+I`（macOS：`Cmd+Alt+I`），或在命令面板执行 **spark sight: Open**。
3. 使用 **spark sight: Open CSV / Excel / JSON** 导入数据；也可选中代码后执行 **spark sight: Use Editor Selection**。
4. 在绘图工作区生成、比较和预览方案，再导出结果。

需要排查运行环境时，执行 **spark sight: Show Diagnostics**。本地 Agent 可通过 **Start Local Agent** / **Stop Local Agent** 命令管理。

## 运行要求

- VS Code **1.95.0 或更高版本**。
- **Node.js 20 或更高版本**，`node` 必须可以从系统 PATH 调用；本地 Agent 使用它运行。
- 执行 Python 绘图需安装 Python 及绘图依赖：

  ```sh
  python -m pip install pandas matplotlib numpy seaborn
  ```

  Windows 需能通过 `python` 调用解释器；macOS / Linux 需能通过 `python3` 调用。
- R 绘图需要本机 R 及相应绘图包；MATLAB 运行需要用户自行安装并授权的 MATLAB，可通过 `deepImaging.matlabPath` 配置路径。

此发布包包含扩展、Web 界面、本地 Agent 和 Noto CJK 字体，**不内置 Node、Python、R 或 MATLAB 解释器**。未就绪的运行环境会在诊断中报告；Python 依赖不完整时无法保证真实渲染成功。

## 数据与网络

项目数据、聊天记录和模型配置由本地 Agent 保存在扩展的本地存储中。本地 Agent 监听回环地址并使用启动令牌认证。

配置第三方模型后，相应请求会发送给你选择的模型服务；使用前请检查数据和模型设置。工作区文件修改需要明确的目标和审阅；未信任工作区限制读取选择和应用补丁。

正式发布包通过发布配置连接账号、官网及更新服务；商店版本也可以通过 VS Code 扩展管理器更新。

## 许可证

本安装包包含不同许可证的组件，完整条款见 [LICENSE.txt](LICENSE.txt)：

- 扩展适配层：MIT，见 [LICENSE](LICENSE)。
- 共享 Web UI 与本地 Agent：Deep Imaging 非商业使用与署名许可 1.0，见 [LICENSE-SHARED](LICENSE-SHARED)；商业使用需事先书面授权。
- Noto CJK 字体：SIL Open Font License 1.1；其他组件保留各自许可证与署名，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 支持

[源码与使用说明](https://github.com/ustinian-T/SPARK-SIGHT-plugin) · [问题反馈](https://github.com/ustinian-T/SPARK-SIGHT-plugin/issues)

## VS Code 原生工作流

侧边栏的“选中代码”读取明确选择的代码；代码视图的“在 VS Code 中编辑”会打开原生编辑器。将代码保存为工作区内脚本后，点击“运行”，会通过 VS Code 任务在集成终端执行，输出和错误可直接查看。

正式发布包包含公开账号与官网地址，账号登录经本地 Agent 连接 HTTPS 服务。源码检出默认使用占位地址；维护者可通过被忽略的 `.release-config.local` 配置发布地址（只接受 HTTPS origin，不接受密钥字段）。
