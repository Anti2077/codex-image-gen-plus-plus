# codex-image-gen++

中文 · [English](README.md)

让 Codex 使用你配置的 OpenAI 兼容图片接口。`init` 配好地址和密钥后，模型、提示词、参数、保存位置都交给当前对话里的 Codex 决定。

**Windows · macOS · Linux | 中英文初始化 | MIT 开源**

## 安装

需要 **Node.js 22.13 或更新版本**（推荐 Node.js 24 LTS）、npm 和 [Codex CLI](https://developers.openai.com/codex/cli)。Codex 桌面版也可以使用注册后的 stdio MCP；自动注册需要安装 CLI。

从 [GitHub Releases](https://github.com/Anti2077/codex-image-gen-plus-plus/releases) 安装构建包：

```sh
npm install -g https://github.com/Anti2077/codex-image-gen-plus-plus/releases/latest/download/codex-image-gen-plus-plus.tgz
codex-image-gen-plus-plus init
```

不依赖 npm 仓库发包。展示名为 `codex-image-gen++`，仓库、终端命令和 MCP 配置名为 `codex-image-gen-plus-plus`。

也可以从源码安装（需要 Git）：

```sh
git clone https://github.com/Anti2077/codex-image-gen-plus-plus.git
cd codex-image-gen-plus-plus
npm ci
npm run build
npm link
codex-image-gen-plus-plus init
```

使用 `npm link` 时请保留源码目录。注册时使用 Node 和入口文件的绝对路径；移动安装目录或更换 Node 后，重新运行 `init`。

## 初始化

1. 选择 **中文 / English**。
2. 选择**导入 CC Switch 当前配置**，或手动输入 API 地址和隐藏输入的 API Key。根地址 `https://api.example.com` 会补为 `/v1`；自定义 `/gateway/v1` 路径会保留。
3. 调用 `/models` 检查连接和认证，显示模型列表。**不会自动发起收费生图**；其他 API 请求费用遵循提供商政策。
4. 选择是否注册到 Codex。通过官方 `codex mcp add` 更新同名配置；找不到 CLI 时，显示手动配置用的 TOML。
5. 建议将生成的说明手动复制到 **Codex 个性化提示词**，让图片任务优先使用本 MCP。不会自动修改个性化设置。

完成后重启 Codex 或新开对话。配置中不固定模型，也不固定保存目录。

### 导入 CC Switch 当前提供商

在 `init` 选择导入，接受默认 `~/.cc-switch` 数据目录，或输入自定义目录。也可以通过 `CODEX_IMAGE_GEN_CCS_DIR` 指定默认位置。程序读取 `settings.json`，并**只读**打开 `cc-switch.db`。优先使用本机 `currentProviderCodex`；本机记录不存在或已失效时，使用数据库唯一的 `is_current` Codex 提供商。只解析所选提供商的 `settings_config`，从激活的 TOML 模型提供商配置中提取地址和对应 API Key，不猜其他表、不默认选第一个提供商。

密钥导入后保持隐藏，接着进行正常的 `/models` 连接检查。这是**一次性复制**到本工具自己的私有配置；之后在 CC Switch 切换提供商不会自动切换图片接口，需要重新运行 `init` 导入。不会修改 CC Switch 文件。支持 API Key 提供商，不导入 ChatGPT OAuth 登录令牌或代理占位密钥；导入失败会继续手动配置。不支持旧版纯 JSON 数据库。Node.js 22 导入时可能显示内置 SQLite 的实验功能提示。

可以对 Codex 说：

> 用 codex-image-gen++ 查看当前可用图片模型，选一个生成方形水彩狐狸插画，保存到当前工作区的 output/imagegen/，生成后展示给我。

Codex 先获取模型列表，再传入准确的模型 ID。列表和名称提示不能证明实际生图权限、价格、质量或速度。`flare`、`sunburst` 等名称会原样传递，不擅自排名或映射成其他模型。

## MCP 工具

| 工具 | 用途 |
| --- | --- |
| `list_models` | 获取当前提供商对此密钥可见的模型，支持按名称筛选。 |
| `generate_image` | 提交生图请求，将图片直接保存到本地绝对路径。 |
| `edit_image` | 上传本地参考图和可选蒙版，提交图片编辑请求。 |
| `get_job` | 查询已有任务，可等待最多 20 秒；不会重新提交。 |

生图/编辑参数：`model`、`prompt`、`output_path`；可选 `size`、`quality`、`background`、`n`（1–4）。编辑额外需要 `input_paths`（1–16 张），支持可选 `mask_path`。提供商限制可能更低。

输出扩展名 `.png`、`.jpg` / `.jpeg`、`.webp` 决定 `output_format`。不会覆盖已有文件。`n: 2` 时，例如 `fox.png` 会保存为 `fox-1.png`、`fox-2.png`。返回实际尺寸、字节数、SHA-256，以及是否符合指定尺寸。尺寸来自图片文件头，不代表完整解码检查；Codex 应继续查看图片。

**推荐由 Codex 指定当前工作区内的绝对路径，默认使用 `output/imagegen/`。** MCP 进程的启动目录可能与聊天工作区不同，不能靠相对路径猜。MCP 负责写入图片字节，返回路径和元数据，避免把大段 Base64 塞入上下文。本地 MCP 使用运行账户的文件权限；工作区范围由 Codex 遵守，服务端没有强制工作区文件沙箱。

## 耗时请求与失败处理

每次生图/编辑由独立的本地 Node 后台进程处理。首次调用最多等待 15 秒，未完成就返回任务编号，Codex 使用 `get_job` 继续查询，避免普通 MCP 调用超时。MCP 连接断开后，只要后台进程和电脑仍在运行，任务可以继续。

不自动重试、不偷偷切模型、不猜协议。网络超时可能发生在上游已经接受收费请求之后；再次生成前先检查任务、输出文件和提供商日志。失败结果包含错误码、`outcome_unknown`、可用的上游请求编号，以及已经成功保存的部分文件。关机或崩溃中断的任务会提示中断，不会自动恢复；后台进程异常退出可能留下空的占位文件，需要检查后手动清理。

## 接口范围

首版支持 **OpenAI 兼容 Images API**：

- `GET {baseUrl}/models`
- `POST {baseUrl}/images/generations`，JSON 请求
- `POST {baseUrl}/images/edits`，multipart 请求（单图 `image`，多图 `image[]`）
- 返回 `data[].b64_json`、`data[].url` 或字符串形式的 `data[].image_url`

不保证兼容所有图片服务。仅支持 Responses 工具、专有异步任务接口、OAuth 或自定义请求结构的提供商，需要另做适配。提供商应支持 `output_format`，或返回与请求扩展名相符的图片格式。`size`、`quality` 等可选参数只在指定时传入；不会把质量选项锁死在旧模型的枚举上。

API 地址要求 HTTPS，本地回环开发地址允许 HTTP。带 API Key 的请求不跟随重定向；返回的图片下载链接可以带签名参数、最多跟随五次重定向，不携带提供商 API Key。单张图片上限 50 MiB，生图 JSON 响应上限 192 MiB。

## 配置与隐私

| 系统 | 默认配置文件 |
| --- | --- |
| Windows | `%APPDATA%\codex-image-gen-plus-plus\config.json` |
| macOS | `~/Library/Application Support/codex-image-gen-plus-plus/config.json` |
| Linux | `$XDG_CONFIG_HOME/codex-image-gen-plus-plus/config.json`，未设置则用 `~/.config/...` |

API Key **以明文保存在本机配置文件**，不会写进项目或 Codex TOML。POSIX 新建目录/文件权限为 700/600，Windows 使用用户目录继承的 ACL；没有集成系统钥匙串，请妥善保管。

可选环境变量：`CODEX_IMAGE_GEN_CONFIG`（建议绝对路径）、`CODEX_IMAGE_GEN_BASE_URL`、`CODEX_IMAGE_GEN_API_KEY`。不要把密钥放入命令参数、代码仓库或聊天。默认上游超时为 600 秒，配置中的 `timeoutSeconds` 可设为 1–3600。

任务记录放在配置文件旁的 `jobs/` 下，包含提示词、输入/输出路径、状态和元数据，**不另存 API Key**。记录保留至你手动删除；不再需要时可清理已完成任务的 JSON。图片和提示词会发送给配置的提供商；结果链接由本机下载。本项目没有分析统计接口。

## 常用命令

```sh
codex-image-gen-plus-plus init
codex-image-gen-plus-plus models image
codex-image-gen-plus-plus doctor
codex-image-gen-plus-plus instructions zh-CN
codex-image-gen-plus-plus instructions en
codex-image-gen-plus-plus job <job-id>
```

`doctor` 检查 `/models`，不发起收费生图。需要换地址/密钥时重新运行 `init`。PowerShell 若因脚本执行策略拦截 npm 命令，可改用 `codex-image-gen-plus-plus.cmd init`。

断开 Codex：`codex mcp remove codex-image-gen-plus-plus`。清除密钥和历史需要另行删除配置/任务目录。全局安装包可用 `npm uninstall -g codex-image-gen-plus-plus` 卸载。

## 开发

```sh
npm ci
npm run check
npm run build
npm pack
```

CI 在 Windows、macOS、Linux 的 Node.js 22/24 上构建并检查命令和安装包。它不能证明每家上游都兼容；初始化和 CI 都不消耗真实生图额度。

## 致谢

相关开源参考和官方 MCP SDK 见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目为独立实现，使用 MIT 协议。
