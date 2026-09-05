# 验收案例与执行证据

这里将需求中的验收案例映射到实际测试。测试断言通过不等于所有设备上都已验证；单元测试、浏览器模拟和真实设备验证分别记录。

## 验收映射

| 需求案例 | 实际测试文件与关键测试 | 断言内容 |
| --- | --- | --- |
| 1. 顺序与朝向 | `src/tests/engine.test.ts`：`1. sequence ends at (2,1), east, from (1,3), north` | 从 `(1,3)` 朝北执行前进 2、右转、前进 1 后，坐标为 `(2,1)`、朝东，动作数 4 |
| 2. 循环 | 同文件：`2. repeat four [forward 2, right] returns home with exactly 12 actions` | 5 × 5 空地图 `(1,1)` 朝东，重复 4 次后回原点、原方向，恰好 12 个原子动作 |
| 3. 多格碰撞 | 同文件：`3. multi-cell movement stops before obstacle and does not run remaining blocks` | 障碍位于 `(3,1)`，前进 3 格只到 `(2,1)`，保留第 2/3 步错误位置并停止后续指令 |
| 4. 后退 | 同文件：`4. backward moves south when facing north without turning` | 中心朝北后退后 `y` 加 1，朝向不变 |
| 5. 函数 | 同文件：`5. a function called four times returns to original position and direction` | A 为前进 1、右转，调用 4 次回到原位置和原朝向；定义区未调用不执行另有断言 |
| 6. 单步 | 同文件：`6. forward 3 needs three steps and finishes on the third without an extra click`；`src/tests/engine-player.test.ts`：`single stepping is atomic and immediately completes the final action` | 三次分别走一格，第三次立即结束，不需第四次点击；循环与函数单步另有覆盖 |
| 7. 暂停继续 | `src/tests/engine-player.test.ts`：`7. pause waits for the current display interval, then resume keeps exact progress` | 完成当前展示间隔后暂停，额外推进 60 秒虚拟时钟不增加动作；继续从原进度前进 |
| 8. 重置切关 | 同文件：两个 `8.` 测试，以及 `disposed players never emit or accept new work`、`reset then starting a new run does not mix timers from two generations` | 清理旧任务，重置恢复星星和坐标，旧定时器不能修改新关卡；页面卸载对应的 dispose 不再回调 |
| 9. 通关条件 | `src/tests/engine.test.ts`：`9. success is evaluated only after normal termination` 测试组 | 终点外、缺星星、经过终点后离开、经过终点再撞墙均不成功；自由练习正常结束没有闯关失败 |
| 10. 异常程序 | 同文件：`10. malformed programs and bounded interpretation` 测试组 | 空程序、非法参数、空循环、未定义函数、直接/间接递归、节点/深度/关卡限制、预算耗尽均友好拒绝；控制结构与调用计入预算 |
| 11. 保存与导入 | `src/tests/storage.test.ts`：`independent local drafts and browser storage recovery`、`safe versioned JSON programs` | 重新 load 恢复独立草稿及设置；全部参考解 JSON 往返后实际执行快照一致；损坏文件不返回替换程序；存储读取/写入异常不抛出 |
| 12. 编辑交互与顺序 | `src/features/editor/tree.test.ts`：`structured block editing` | 插入、同容器排序、非拖拽前后移动、循环与主程序互移、函数容器移动、复制子树新 ID、不可变历史、两层嵌套限制；`e2e/editor.spec.ts` 已实际验证鼠标/触屏、非拖拽、跨容器移动和 1440/900/390 宽度换行顺序 |

## 超出基础案例的保护

`src/tests/levels.test.ts` 对每个实际关卡检查网格、障碍、星星 ID、起点、终点、提示与可用指令。所有 12 个挑战及自由练习的参考解均传入 `Interpreter`，逐步执行到结束；挑战断言 `outcome === 'success'` 且收集全部星星，自由练习断言 `outcome === 'free'`。测试前后比较关卡 JSON，确保没有修改原始课程数据。

播放器还测试重复运行按钮不会创建多个计时器、暂停期间外部修改源程序不影响本轮、函数及循环进度保留、订阅回调中触发重置不会泄漏下一个定时器，以及 0.5/1/2 倍播放得到相同位置、朝向、动作数和预算。

导入还测试过大文件、未知版本、未知字段、HTML/代码/资源字段、危险属性、非法类型、缺失/重复 ID、超过 200 节点、超过两层循环、当前关卡未学指令与积木数限制。本地存储测试区分损坏条目和正常条目，并确认未完成函数、空循环与超出关卡目标的安全草稿仍能恢复。

## 实际执行记录

以下命令已在 2026-09-05 本次开发环境实际执行。环境：macOS、Node.js 26.5.0、npm 11.17.0；依赖版本以锁文件为准。

| 命令 | 最终实际结果 |
| --- | --- |
| `npm test -- src/tests/levels.test.ts src/tests/storage.test.ts` | 2 个测试文件、26 项测试通过；包含全部 13 个内置参考程序的真实解释与往返验证 |
| `npm run typecheck` | 通过，TypeScript 无错误 |
| `npm test` | 5 个测试文件、125 项测试全部通过；另含 4×4、12×12 与矩形地图边界验收 |
| `npm run build` | 通过；45 个模块构建，输出 HTML、约 28.3 KB CSS、358.7 KB JS（JS gzip 116.3 KB） |
| `npm run test:e2e` | 70 项全部通过（35 个案例 × Chromium 桌面/触屏两个项目），总耗时 24.5 秒 |
| `npm ci` | 从锁文件安装成功；审计 0 个已知依赖漏洞 |
| `node scripts/smoke-static.mjs` | 生产包根路径 `/`、子路径 `/robot/` 均加载成功并实际完成第一关；无外部资源请求、失败资源或浏览器错误 |

已执行的浏览器验收覆盖：鼠标从库拖入及重排、触屏拖动和页面滚动、点击/键盘编辑、循环移入移出、参数调整、撤销重做、清空确认、完整运行与碰撞、单步、暂停继续、重置切关、刷新恢复、损坏 JSON 不替换，以及桌面/平板/手机宽度下顺序不变。另含 React StrictMode 下重跑、卸载和旧回调取消测试，函数调用积木与函数体双高亮及精确调用路径。触屏拖动由 Chromium CDP touch 事件驱动，非简单鼠标代替。

**未执行**：真实 iPad/iPhone/Android 硬件操作、Safari/WebKit、Firefox、辅助技术完整无障碍审计。模拟设备结果不能代替这些实机验证。

全量浏览器套件通过后，额外修复了「关闭保存失败提示后，保存标记不应错误显示已保存」的界面状态；桌面/触屏对应 2 项回归测试再次通过，随后重新通过类型检查、生产构建与两个生产路径 smoke 检查。

## 复现命令

在项目根目录使用 Node.js 22.12 或以上版本：

```sh
npm ci
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

测试使用固定依赖版本和提交的锁文件。若 Playwright 尚未安装浏览器，需要先执行安装命令；安装浏览器成功本身不代表端到端测试通过。若增加其他浏览器项目，需要安装对应浏览器并重新记录执行结果。

## 当前范围与验收限制

已实现的产品范围是本地浏览器内的关卡编程工作台，没有后端或登录依赖。12 个内置挑战和固定 8 × 8 自由地图均使用同一引擎。程序运行状态不跨刷新续跑，编辑撤销历史不持久化；刷新恢复当前草稿、已完成关卡和设置。导入要求当前关卡 ID 匹配，不自动转换地图或程序版本。

没有账户、付费、排行榜、多人同步、实体硬件、AI 聊天、后台和云数据库，也没有地图编辑器或任意数量函数。静态资源首次加载需要网络；尚未实现 Service Worker 安装离线缓存。真实设备、Safari/WebKit、Firefox 验收未执行，已在上方明确记录。
