# Cloudflare Pages 与 GitHub 数据仓库部署

Cloudflare Pages 提供 Vite 构建文件，Pages Functions 提供账号 API；账号状态通过 GitHub App 保存到独立私有数据仓库。源码仓库负责发布应用，数据仓库负责保存账号和通关记录，不需要运行 Node 进程或维护服务器磁盘。`functions/api/[[path]].js` 将 `/api/*` 请求交给 `worker/index.mjs` 的共享 API 实现。[Pages Functions 路由](https://developers.cloudflare.com/pages/functions/routing/)

| 项目 | 配置 |
| --- | --- |
| 正式域名 | `https://bubu.brclio.com` |
| Pages 项目 | `brclio-robot` |
| Pages 地址 | `https://brclio-robot.pages.dev` |
| 源码仓库 | `Brclio/Brclio-Robot`，生产分支 `main` |
| 私有数据仓库 | `BrclioData/Brclio-Robot-Data`，分支 `main` |
| 前端资源 | `dist/` |
| 服务端入口 | `functions/api/[[path]].js` |
| 数据访问身份 | GitHub App，App ID `5467364` |

项目已连接上述 GitHub 源码仓库，`main` 分支推送用于触发生产自动构建。生产运行变量统一为 Plaintext；私有数据仓库的 Installation ID 为 `175141213`。

## 准备数据仓库与 GitHub App

数据仓库保持 **Private**，初始化 `main` 分支。将 GitHub App 安装到 `BrclioData/Brclio-Robot-Data`，授予该仓库 Contents 读写权限，并记录 Installation ID。Functions 使用 App 私钥签名获取安装访问令牌，浏览器不直接访问数据仓库。

账号的注册阶段状态、凭据哈希、会话和进度按账号保存为 JSON。写入时携带 GitHub 返回的文件 SHA；遇到并发修改时重新读取并合并，再使用新 SHA 提交，避免一台设备覆盖另一台设备刚保存的记录。[GitHub 文件读写接口](https://docs.github.com/en/rest/repos/contents#create-or-update-file-contents)

| 数据路径 | 内容 |
| --- | --- |
| `accounts/<邮箱哈希>.json` | 账号、验证码状态、会话、进度和账号限流 |
| `identities/google/<Google sub 哈希>.json` | Google 身份与账号的关联 |
| `oauth/<state 哈希>.json` | 一次性 OAuth 流程状态 |
| `limits/<IP 键哈希>.json` | 请求频率限制状态 |

## 运行时环境变量

按当前维护约定，部署变量在 Pages 项目的 **Settings → Variables and Secrets → Production** 中以 **Plaintext** 保存，便于维护时查看。实际值保留在 Cloudflare 项目配置中；源码只记录变量名称和公开资源标识，不把邮箱应用密码或 App 私钥提交到 Git。Preview 环境不配置生产凭据。

| 名称 | 值或用途 |
| --- | --- |
| `APP_ORIGIN` | `https://bubu.brclio.com` |
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `465` |
| `SMTP_USER` | 验证码发件邮箱 |
| `SMTP_PASS` | Gmail 应用密码 |
| `SMTP_FROM` | 已授权的发件地址，可附显示名称 |
| `GOOGLE_CLIENT_ID` | Google Web OAuth Client ID |
| `GOOGLE_CLIENT_SECRET` | 对应 Client Secret |
| `AUTH_SECRET` | 独立随机认证密钥，至少 32 字节 |
| `GITHUB_APP_ID` | `5467364` |
| `GITHUB_INSTALLATION_ID` | App 在数据仓库的安装 ID |
| `GITHUB_APP_PRIVATE_KEY` | PKCS#8 PEM，多行 `BEGIN PRIVATE KEY` 内容 |
| `GITHUB_DATA_OWNER` | `BrclioData` |
| `GITHUB_DATA_REPO` | `Brclio-Robot-Data` |
| `GITHUB_DATA_BRANCH` | `main` |

`AUTH_SECRET` 用于保护密码和验证码，不能复用邮箱密码；更换它应作为认证凭据迁移处理。GitHub App 下载的私钥如为 `BEGIN RSA PRIVATE KEY`，先转换为 PKCS#8，再完整保存 PEM 的起止行和换行。

Pages 的生产运行变量保存在项目 `deployment_configs.production.env_vars`，类型为 `plain_text`。构建输出 `dist/`、兼容日期 `2026-10-25` 和 `nodejs_compat` 在 Pages 项目配置中维护。仓库不放根级 Wrangler 配置，避免 Git 构建时用空 `vars` 覆盖控制台中的明文变量。`.env.local` 仅用于本机，不随部署自动上传。

Google Web OAuth 客户端的正式重定向 URI 为：

```text
https://bubu.brclio.com/api/auth/google/callback
```

本地测试可额外登记 `http://127.0.0.1:5174/api/auth/google/callback`。登记地址必须与实际访问域名和 `APP_ORIGIN` 一致。

## 构建与部署

使用现有 Cloudflare 账号，在源码仓库根目录运行：

```bash
npm ci
npm run build
npx wrangler pages deploy dist --project-name brclio-robot
```

本地完整预览可运行 `npm run dev:cloudflare`；手动生产发布可运行 `npm run deploy:cloudflare`。Wrangler 会同时打包项目根目录的 `functions/`。

在 Pages 项目的 **Custom domains** 中添加 `bubu.brclio.com`。该主机名如已有 DNS 记录，处理冲突后绑定到 Pages 项目，并验证 HTTPS、首页和 `/api/auth/session`。

自动发布以源码仓库 `Brclio/Brclio-Robot` 为输入。Pages 原生 GitHub 集成使用以下设置：

| 设置 | 值 |
| --- | --- |
| Root directory | 仓库根目录 |
| Production branch | `main` |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Node.js 版本 | `24` |

连接成功后，推送源码 `main` 触发 Pages 原生构建与部署，Functions 随同前端自动打包，无需额外 Deploy command。[Pages 构建配置](https://developers.cloudflare.com/pages/configuration/build-configuration/)

数据仓库不绑定站点构建；保存通关记录不会触发网站重新发布。自动部署是否已连接，以 Pages 项目的 GitHub 来源设置及成功部署记录为准。

## 免费配额与同步频率

部署使用 Pages 免费方案，不开通 Workers Paid 或其他收费服务，也不自动升级配额。Pages Functions 使用 Workers 运行时并计入 Workers 请求额度，静态文件和 Functions 的额度分别管理；上线时核对 Functions 的实际计划与运行限制。[Pages Functions 计费与免费额度](https://developers.cloudflare.com/pages/functions/pricing/)

GitHub App 安装令牌通常至少有每小时 5,000 次 REST 请求额度，并受额外的并发和内容写入限流约束；以响应中的剩余额度和限流头为准。注册、登录与一次历史合并可能使用多次 GitHub 请求，不能将一次浏览器操作等同于一次 API 请求。[GitHub API 限流](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#primary-rate-limit-for-github-app-installations)

游客记录先保存在浏览器。登录时读取并合并历史，之后只有积木或记录变化才安排同步：停止编辑 5 秒后批量提交、两次成功提交至少间隔 30 秒，空闲时没有轮询。网络或接口限流时保留账号的本地待同步缓存；下次登录或手动重试继续合并。

## 发布验证与维护

发布后检查邮箱验证码注册、密码登录、Google 登录、退出、账号间隔离，以及另一浏览器恢复通关积木。`GET /api/auth/session` 应返回 JSON；数据仓库必须保持私有。测试命令和实际结果以当前测试源文件与执行输出为准。

数据恢复使用私有数据仓库的 Git 历史。按账号恢复前先核对文件版本；恢复旧认证状态可能恢复旧会话，因此应同时处理会话失效。回滚 Pages 部署不会自动回滚数据仓库提交。维护时在 Pages 部署详情中查看构建记录和 Functions 实时日志。
