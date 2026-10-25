# 账号服务与历史同步

正式站点采用 Cloudflare Pages + Functions 和 GitHub 私有数据仓库，域名为 `https://bubu.brclio.com`。源码仓库为 `Brclio/Brclio-Robot`，账号与通关数据由 GitHub App 写入 `BrclioData/Brclio-Robot-Data`。运行变量、仓库权限、域名和自动部署配置见 [Cloudflare 全站部署](CLOUDFLARE_DEPLOYMENT.md)。下方本地启动使用可选 Node 服务；同步规则适用于两种运行方式。

## 本地启动

需要 Node.js 24 或以上。SQLite 使用 Node 内置驱动，无需额外安装数据库。

```bash
npm ci
cp .env.example .env.local # 已配置 .env.local 时不要覆盖
npm run dev:full
```

打开 `http://127.0.0.1:5174`。Vite 把 `/api` 转发到本机 3001 端口。只运行 `npm run dev` 时仍可使用游客模式；启用账号功能需要同时启动账号服务。

`.env.local` 只供服务端读取，已在 Git 中忽略。邮箱应用密码和 Google Client Secret 都不能使用 `VITE_` 前缀，不能放入 `public/`、`src/` 或提交到 Git。示例配置没有真实凭据。

## 邮箱验证码注册

填写 `SMTP_USER`、`SMTP_PASS`、`SMTP_FROM`。Gmail 使用 `smtp.gmail.com:465` 和 Google 应用密码；应用密码中的空格会被移除。使用下列命令检查 SMTP 登录，检查过程不会发送邮件：

```bash
node --env-file-if-exists=.env.local server/verify-mail.mjs
```

实际注册时发送 6 位验证码，有效期 10 分钟，同一邮箱至少间隔 60 秒发送，最多尝试 5 次；另有按 IP 和邮箱的限流。邮箱通过验证后创建账号：本地 Node 服务使用带盐 scrypt，Pages Functions 使用带盐 PBKDF2 和独立 `AUTH_SECRET` 保护密码。两种后端的数据与密码格式分别管理，不直接互拷账号记录。登录采用 HttpOnly、SameSite=Lax 会话 Cookie，会话有效期为 30 天；生产 HTTPS 下启用 Secure。

## Google 注册与登录

在 Google Cloud 项目 `bornforthis-489808` 创建独立 OAuth 客户端，应用类型为 Web 应用，名称建议 `Brclio Robot Web`。本实现使用服务端授权码流程，JavaScript 来源可留空。

| 重定向 URI | 用途 |
| --- | --- |
| `https://bubu.brclio.com/api/auth/google/callback` | 正式站点 |
| `http://127.0.0.1:5174/api/auth/google/callback` | 本地开发 |

本地开发将创建所得的 Client ID 与 Client Secret 分别写入 `.env.local` 的 `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`，然后重启账号服务；正式 Cloudflare 环境按当前维护约定将其保存为 Pages Production 的 Plaintext 运行变量。后端回调 URI 由 `APP_ORIGIN` 自动生成，必须与控制台登记内容完全一致。开发时不要混用 `localhost` 和 `127.0.0.1`。

Google API 的服务端网络请求需要能访问 Google。本机开发环境已沿用系统本地代理；`.env.local` 中的 `NODE_USE_ENV_PROXY`、`HTTPS_PROXY` 属于本机配置，部署到远端时不要照搬本机 `127.0.0.1` 代理地址。

仅请求 `openid email`，使用一次性 state 和 PKCE。不请求 Drive 或 Gmail 的数据权限。同一受 Google 管理的已验证 Gmail/Workspace 邮箱可以关联已有邮箱账号，并保留原来的密码和进度；其他已存在的第三方邮箱仍需使用原密码登录。

## 历史同步规则

- 游客的逐关草稿、通关记录与通关时的积木快照保存在当前浏览器。旧版本完成记录没有快照时仍保留原记录，不会推断历史积木。
- 登录时读取云端记录，合并浏览器游客历史、该账号的本地待同步数据和云端记录，再按需上传一次；没有变化时不上传。
- 各关卡草稿分别按修改时间合并。通关记录取最新一次完成记录，保留其他已完成关卡；同步不会清空另一设备的其他关卡记录。
- 正常编辑停止 5 秒后批量同步，两次成功提交至少间隔 30 秒。连续编辑最多等待 60 秒再安排一次提交；空闲时没有轮询。只有声音、速度等设备设置变化不会触发云端提交。
- 同步失败先保存在本地，最多自动重试 4 次，间隔逐步增加；恢复联网或点击账号里的「重新同步」可以再试。登录失效或其他标签页切换账号时暂停同步，需要重新登录或刷新。
- 正在运行或暂停中的程序不会被云端合并覆盖。返回可编辑状态后再应用合并结果。
- 浏览器缓存按账号隔离。退出后恢复游客存档，账号待同步数据保留在该账号的本地缓存；下次登录继续合并。退出时只短暂尝试同步，若受提交间隔限制或网络失败，待同步数据保留到下次登录。
- 关页只尝试发送小于 60 KB 且满足提交间隔的待同步数据；浏览器不保证此请求完成，待同步标记会继续保留。未确认同步前不要清除站点数据。

Cookie 在标签页之间共享，接口同时核对标签页声明的账号 ID；切换账号的旧页面不能将原账号记录写到另一个账号。

## 正式部署：Cloudflare

默认生产方案使用 Pages 提供 `dist/`，Pages Functions 提供 `/api`，通过 GitHub App 将账号 JSON 保存到私有数据仓库。凭据哈希、注册阶段状态、会话与进度以账号为单位读写，使用文件 SHA 检查并发版本后合并提交。无需长期运行 Node 进程或本机持久化磁盘。发布步骤及 GitHub 原生自动构建见 [Cloudflare 全站部署](CLOUDFLARE_DEPLOYMENT.md)。

GitHub API 有小时配额与内容写入限流，因此登录时集中合并历史，后续沿用 5 秒防抖、至少 30 秒写入间隔和无空闲轮询的规则；触达接口配额时保留本地记录等待重试。部署不自动激活收费计划或购买配额。

## 可选部署：Node 自托管

仅选择 Node 自托管时，需要长期运行的 Node 进程和持久化磁盘。下列步骤不适用于 Pages Functions。仅上传 `dist/` 到静态托管仍可使用游客模式，但静态目录本身不能提供注册、登录和云同步。

1. 将源码与依赖部署到服务器，设置 `.env.local`，生产 `APP_ORIGIN=https://bubu.brclio.com`、`NODE_ENV=production`。
2. 执行 `npm ci && npm run build`，使用进程管理器运行 `npm start`。
3. 由 HTTPS 入口把站点请求反向代理到 `127.0.0.1:3001`。该服务可同时提供 `dist/` 和 `/api`；也可由原静态服务器提供 `dist/`，只把 `/api/` 交给 Node。
4. `DATABASE_PATH` 指向持久目录，备份完整 SQLite 数据库（使用 SQLite online backup API，或停服后复制数据库）。不要把运行中的主数据库文件单独复制而漏掉 WAL；数据库不能放入公开静态目录。

当前 SQLite 方案面向单实例服务；不要把多个独立容器的本地数据库当作共享存储。数据库目录仅限服务用户访问。

默认 `TRUST_PROXY=false`。只有 Node 绑定回环地址且前面只有一层受信本机反向代理时才开启；服务会从回环请求的最右侧 `X-Forwarded-For` 读取真实客户端 IP。不要在多级代理或直接对公网开放的后端中照搬此配置。

示例 Nginx 站点规则（已有证书的 HTTPS server 内）：

```nginx
location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
    client_max_body_size 1m;
}
```

来源核对：[Google 服务端 OAuth 流程](https://developers.google.com/identity/protocols/oauth2/web-server)、[Nodemailer Gmail 配置](https://nodemailer.com/usage/using-gmail/)、[Node SQLite](https://nodejs.org/api/sqlite.html)。

## 验证命令

```bash
npm run typecheck
npm test
npm run test:server
npm run test:worker
npm run test:e2e
npm run build
```

后端测试注入邮件服务、Google 响应和数据接口，不使用真实收件人或 OAuth 凭据。验证关注验证码期限与重放、凭据与会话、账号隔离、跨站请求、同步合并、GitHub 文件并发修改、限流及运行时兼容性；具体覆盖和通过情况以当前测试源文件与执行输出为准。
