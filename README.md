# Brclio Robot · Brclio 编程机器人

可以实际摆放指令、运行机器人并判断结果的浏览器编程工作台。原创机器人「布布」、12 个教学关卡和自由练习场，不需要实体硬件。默认简体中文，游客数据保存在浏览器，登录后合并历史并按需同步到账号。正式站点使用 Cloudflare Pages + Functions 提供邮箱注册、密码登录与 Google 登录，账号数据通过 GitHub App 保存在独立私有仓库；本地也可运行 Node.js 账号服务。

## 安装与运行

建议 **Node.js 24 LTS**（`.nvmrc`），最低 Node.js 24.0.0（账号服务使用内置 SQLite）。此次实际验证环境为 Node.js 26.5.0 / npm 11.17.0。

```bash
# 如使用 nvm
nvm use

npm ci
npm run dev -- --port 5174 --strictPort
# 同时启用账号 API：先配置 .env.local，再运行 npm run dev:full
```

打开终端中显示的地址，指定以上端口时是 `http://127.0.0.1:5174`。默认 `npm run dev` 使用 Vite 默认端口；若被占用会选择下一个端口。当前机器的 5173 已被其他项目使用，本项目验收端口为 5174。

```bash
npm run typecheck             # 严格 TypeScript 检查
npm test                      # 解释器、播放器、编辑算法、关卡、存储单元测试
npm run test:watch            # 开发时持续运行单元测试
npm run test:server           # 账号、验证码、安全、同步 API 集成测试
npm run test:worker           # Worker、GitHub 数据存储及邮件测试
npx playwright install chromium
npm run test:e2e              # 桌面 Chromium + 触屏 Chromium 浏览器测试
npm run build                # 类型检查 + 生产构建，产物 dist/
npm run preview -- --port 4174 --strictPort
node scripts/smoke-static.mjs # 生产包根路径/子路径实际通关检查
```

所有直接依赖均锁定精确版本，`package-lock.json` 锁定完整依赖树。浏览器测试配置会启动项目的 5174 服务；已有本项目开发服务时复用，CI 时使用独立服务。不要把其他应用运行在测试端口。

初版验收结果和覆盖范围见 [验收记录](docs/ACCEPTANCE.md)。正式部署见 [Cloudflare 全站部署](docs/CLOUDFLARE_DEPLOYMENT.md)，本地账号配置与同步规则见 [账号服务说明](docs/ACCOUNT_SETUP.md)；最新验证结果以本次执行输出为准。

## 开始玩

1. 观察左侧地图、机器人的蓝色朝向箭头与任务。
2. 点击指令库的「前进」，调整积木上的数字；或把指令拖入编程板。
3. 点击「运行」。每次运行都会从起点重新开始；「单步」一次只移动一格或转向 90 度。
4. 暂停后可继续；修改前先重置。撞到石头或越界会停在最后一个合法格子，并标出有问题的积木。
5. 程序结束时停在旗子上，且收集全部星星才能通关。任务下方提供三层提示，之后可选择把参考解放上编程板。

点击积木可前移、后移、复制、删除，并用目标菜单移动到循环或动作组合。选中积木后可用 `Alt + 方向键` 移动、`Delete` 删除；`Ctrl/⌘ + Z` 撤销、`Ctrl/⌘ + Shift + Z` 重做。拖动手柄支持鼠标和触屏；非手柄区域可正常滚动。手机通过「地图 / 编程板」切换，地图页也提供播放控制。

## 已实现

- SVG 网格、原创机器人、朝向、轨迹、障碍物、逐格星星收集与终点判断；关卡数据支持 4×4 至 12×12 地图，内置地图以 5–8 格为主。
- 前进 / 后退 1–9 格、左右转、重复 2–9 次、最多两层循环容器、动作组合 A/B 与非递归调用。
- 稳定节点 ID、按数组顺序执行、拖拽插入/排序/跨容器移动、点击编辑、参数、复制删除、清空确认、撤销重做。
- 串行运行、暂停/继续、原子单步、立即重置与切关取消；当前积木、调用路径、多格进度与循环轮次反馈；0.5/1/2 倍速度。
- 12 个分阶段教学关卡、真实解释器验证的全部参考解、分级提示、自由练习。
- 逐关草稿、通关记录和通关积木快照的本地保存；邮箱验证码注册、密码登录、Google 登录与账号云同步；5 秒防抖、至少 30 秒提交间隔、无空闲轮询、离线待同步缓存、账号隔离。声音/速度/轨迹/减少动画设置保留在本设备；严格 JSON 导入导出与存储异常恢复提示。
- 200 节点上限、统一 2000 次解释推进预算；指令/参数/函数引用/递归/关卡限制等运行前校验。
- 响应式布局、48px 主要操作按钮、键盘焦点、原生对话框焦点约束、减少动画、无追踪脚本；账号登录仅使用邮箱。

## 项目结构与扩展

```text
src/
  components/          图标、品牌机器人、对话框、帮助
  features/editor/     编程板、拖拽与纯树编辑算法
  features/simulator/  SVG 地图、播放 hook、声音、调用路径显示
  features/levels/     关卡选择
  features/auth/       登录、注册、账号对话框与 API
  features/sync/       本地缓存、登录合并与低频同步
  shared/              前后端共用的进度校验与合并
  engine/              校验器、惰性解释器、串行播放器
  data/                关卡及参考程序
  storage/             本地保存、恢复、JSON 导入导出
  types/               程序、地图、运行、播放、编辑与保存类型
  styles/              Esther App 模板改编的工作台样式
  tests/               核心验收单元测试
  App.tsx              应用组合与跨模块协调
  main.tsx             启动、StrictMode、异常边界
server/                Node HTTP、SQLite、SMTP、Google OAuth 与集成测试
worker/                共享账号 API、GitHub 数据存储与邮件发送
functions/             Pages Functions 的 /api 路由入口
e2e/                   真实浏览器验收
docs/                  架构、扩展、设计和测试记录
public/favicon.svg     本地原创图标
```

- [架构与执行语义](docs/ARCHITECTURE.md)
- [如何新增关卡和指令](docs/EXTENDING.md)
- [验收案例与实际测试结果](docs/ACCEPTANCE.md)
- [设计规范、署名和检查结果](docs/DESIGN.md)

新增关卡时在 `src/data/levels.ts` 增加地图、白名单、任务、提示和参考程序，然后运行关卡测试。新增指令必须同时扩展类型、严格校验、解释器、编辑器与测试；不要只添加一个按钮。详见扩展文档中的可运行例子。

## Cloudflare 全站部署

正式站点为 `https://bubu.brclio.com`。Cloudflare Pages 项目 `brclio-robot` 提供 `dist/` 静态资源，Pages Functions 提供 `/api`，账号、会话和通关数据通过 GitHub App 保存在私有仓库 `BrclioData/Brclio-Robot-Data`。源码继续使用 `Brclio/Brclio-Robot` 的 `main` 分支，由 Pages 原生 GitHub 集成构建和发布。

```bash
npm run build
npx wrangler pages deploy dist --project-name brclio-robot
```

GitHub App 安装、数据仓库权限、Google 回调、域名和自动部署设置见 [Cloudflare 全站部署](docs/CLOUDFLARE_DEPLOYMENT.md)。按当前维护约定，正式运行变量在 Pages 的 Production 环境以 Plaintext 保存；实际凭据不写入源码仓库，Preview 不配置生产凭据。`.env.local` 只用于本地开发。

如只需要游客模式，仍可将 `dist/` 部署到任意静态托管。构建采用 `base: './'`，游客模式支持根目录及子目录；静态目录本身不提供账号 API。本地 Node 服务的运行方式见 [账号服务说明](docs/ACCOUNT_SETUP.md)。

本项目不使用路径路由，不需要 SPA 路由重写。部署后通过 HTTP/HTTPS 访问，不能直接双击 `dist/index.html` 使用 `file://`。本地验证生产版用 `npm run preview`。需要在同一 Wi-Fi 的平板访问开发版时，可执行 `npm run dev -- --host 0.0.0.0 --port 5174`，再用电脑的局域网地址访问。

所有核心图像、图标和声音均在本地绘制/合成，无外部图片或字体请求。Google 登录按用户操作访问 Google OAuth 服务；验证码由服务端 SMTP 发送。首次加载需要能访问托管站点；没有安装离线 PWA 或 Service Worker。

## 范围与已知限制

- 账号与同步已补充；不提供付费、排行榜、多人实时协作、硬件连接或 AI 聊天。
- 暂无可视化地图编辑器；自由练习为固定 8×8 地图。开发者可以通过关卡数据增加其他 4–12 格地图。
- 游客记录只保存在当前浏览器，登录账号后同步草稿、完成记录与通关积木快照；设备设置仍仅保存在本地。导出是当前关卡程序备份，不包含整套进度。清理浏览器数据会丢失尚未确认同步的本地修改。
- 撤销历史最多保留 50 次编辑，刷新、切关或导入后重新建立。草稿可以是不完整程序；导入必须符合当前关卡与安全规则，未定义函数及递归程序不能导入。
- 积木统计包含主程序和定义区中的全部积木，每个循环/调用块计一块，定义体计一次，不按执行次数展开。某些课程可用多种算法完成，不强制使用参考解。
- 长程序与函数区域需要纵向滚动，定义区和调用积木均保持高亮；运行区同时显示完整调用位置。
- 已自动化验证 Chromium 桌面与模拟触屏，真实 iPad Safari、Firefox 和实体触屏设备尚未实测。没有无障碍认证；核心编辑提供键盘替代，但尚无面向盲童的专用空间地图交互。
- 当前声音为轻量 Web Audio 合成提示，受浏览器声音策略约束；静音不会影响执行。

## API 与设计来源

实现使用 React 19.2.8、Vite 8.2.4、TypeScript 7.0.2、dnd-kit React 0.5.0、Vitest 5.0.5、Playwright 1.63.0，并核对实际安装包的类型定义及官方文档：

- [React effect 生命周期与清理](https://react.dev/reference/react/useEffect)
- [Vite 环境要求与构建入口](https://vite.dev/guide/)
- [dnd-kit React 当前 API](https://dndkit.com/react/quickstart/)（DragDropProvider，未混用 legacy DndContext）
- [Vitest 入门](https://vitest.dev/guide/)
- [Playwright 测试文档](https://playwright.dev/docs/intro)

界面从 ESTHER不二的 [esther-design-system](https://github.com/esthersjw/esther-design-system) App 模板改编。署名与适用的 **CC BY-NC-SA 4.0** 设计许可见 `docs/DESIGN.md`；模板改编保留相同许可。机器人、地图元素与课程为本项目原创，不使用玛塔的形象或课程素材。
