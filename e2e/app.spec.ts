import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { levels } from '../src/data/levels';
import { defaultSettings, STORAGE_KEY } from '../src/storage';
import { emptyProgram, type Program } from '../src/types';
async function seed(page: Page, levelId = '001', program = emptyProgram()) {
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: STORAGE_KEY, value: { version: 1, currentLevel: levelId, drafts: { [levelId]: program }, completed: {}, settings: { ...defaultSettings, speed: 2 } },
  });
}
async function selectLevel(page: Page, id: string) { await page.getByTestId('open-levels').click(); await page.getByTestId(`level-${id}`).click(); }
function blocks(page: Page) { return page.getByTestId('program-main').locator(':scope > .block-position > .program-block'); }
async function file(page: Page, text: string) {
  await page.getByLabel('导入程序文件').setInputFiles({ name: 'test.json', mimeType: 'application/json', buffer: Buffer.from(text) });
}

test('完整闭环：摆积木、执行、收星通关、刷新后恢复草稿和进度', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await page.getByTestId('library-forward').click();
  await page.getByTestId('library-forward').click();
  await page.getByLabel('播放速度').selectOption('2');
  await page.getByTestId('run').click();
  await expect(page.getByTestId('execution-message')).toContainText('你学会了');
  await expect(page.getByTestId('robot')).toHaveAttribute('data-x', '3');
  await expect(page.getByTestId('stars-count')).toHaveText('1 / 1');
  await expect(page.getByTestId('action-count')).toHaveText('2');
  await page.reload();
  await expect(blocks(page)).toHaveCount(2);
  await expect(page.getByTestId('action-count')).toHaveText('0');
  await expect(page.getByLabel('播放速度')).toHaveValue('2');
  await page.getByTestId('open-levels').click();
  await expect(page.getByTestId('level-001')).toContainText('已完成');
  expect(errors).toEqual([]);
});

test('前进3格分三次单步；最后一步立即判断；暂停锁定编辑', async ({ page }) => {
  await page.goto('/'); await page.getByTestId('library-forward').click();
  await page.getByLabel('第 1 块移动步数').selectOption('3');
  await page.getByTestId('step').click();
  await expect(page.getByTestId('robot')).toHaveAttribute('data-x', '2');
  await expect(page.getByTestId('action-count')).toHaveText('1');
  await expect(page.getByTestId('library-forward')).toBeDisabled();
  await expect(page.getByLabel('第 1 块移动步数')).toBeDisabled();
  await page.getByTestId('step').click();
  await expect(page.getByTestId('robot')).toHaveAttribute('data-x', '3');
  await expect(page.getByTestId('execution-message')).not.toContainText('你学会了');
  await page.getByTestId('step').click();
  await expect(page.getByTestId('action-count')).toHaveText('3');
  await expect(page.getByTestId('robot')).toHaveAttribute('data-x', '4');
  await expect(page.getByTestId('library-forward')).toBeEnabled();
  await expect(page.getByTestId('execution-message')).not.toContainText('你学会了');
});

test('暂停完成当前动作后停；继续沿旧进度；重置取消旧定时器', async ({ page }) => {
  await seed(page, 'free', { main: [{ id: 'f', type: 'forward', steps: 3 }, { id: 'r', type: 'right' }], functions: { A: [], B: [] } });
  await page.goto('/'); await page.clock.install();
  await page.getByTestId('run').click();
  await expect(page.getByTestId('action-count')).toHaveText('1');
  await page.getByTestId('pause').click(); await page.clock.runFor(300);
  await expect(page.getByTestId('pause')).toHaveText('继续');
  await page.clock.runFor(2000); await expect(page.getByTestId('action-count')).toHaveText('1');
  await page.getByTestId('pause').click(); await expect(page.getByTestId('action-count')).toHaveText('2');
  await page.clock.runFor(600); await expect(page.getByTestId('action-count')).toHaveText('4');
  await expect(page.getByTestId('robot')).toHaveAttribute('data-direction', 'E');
  await expect(page.getByTestId('execution-message')).toContainText('程序执行完成');
  await page.getByTestId('run').click(); await page.getByTestId('reset').click();
  await page.clock.runFor(5000);
  await expect(page.getByTestId('action-count')).toHaveText('0');
  await expect(page.getByTestId('robot')).toHaveAttribute('data-y', '5');
  await expect(page.getByTestId('stars-count')).toHaveText('0 / 3');
});

test('运行中切关取消旧任务，关卡草稿互不覆盖', async ({ page }) => {
  await page.goto('/'); await page.clock.install();
  await page.getByTestId('library-forward').click(); await page.getByLabel('第 1 块移动步数').selectOption('9');
  await page.getByTestId('run').click(); await selectLevel(page, 'free');
  await page.clock.runFor(5000);
  await expect(page.getByTestId('robot')).toHaveAttribute('data-x', '2');
  await expect(page.getByTestId('robot')).toHaveAttribute('data-y', '5');
  await expect(page.getByTestId('action-count')).toHaveText('0');
  await page.getByTestId('library-right').click();
  await selectLevel(page, '001'); await expect(blocks(page)).toHaveCount(1);
  await expect(page.getByLabel('第 1 块移动步数')).toHaveValue('9');
  await selectLevel(page, 'free'); await expect(blocks(page)).toHaveCount(1);
  await expect(blocks(page).first()).toHaveAttribute('data-instruction', 'right');
});

test('JSON下载并重新导入含义不变；损坏或越权JSON不覆盖程序', async ({ page }) => {
  await page.goto('/'); await page.getByTestId('library-forward').click();
  await page.getByLabel('第 1 块移动步数').selectOption('2');
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出', exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toMatch(/Brclio-Robot-001-.*\.json/);
  const exported = await readFile((await download.path())!, 'utf-8');
  page.on('dialog', dialog => dialog.accept());
  await page.getByLabel('清空程序').click(); await expect(blocks(page)).toHaveCount(0);
  await file(page, exported); await expect(blocks(page)).toHaveCount(1);
  await expect(page.getByLabel('第 1 块移动步数')).toHaveValue('2');
  const before = await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY);
  await file(page, '{broken'); await expect(page.getByRole('status').filter({ hasText: '原来的积木已保留' })).toBeVisible();
  expect(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY)).toEqual(before);
  await file(page, JSON.stringify({ version: 1, levelId: '001', main: [{ id: 'bad', type: 'backward', steps: 2 }], functions: { A: [], B: [] } }));
  await expect(page.getByRole('status').filter({ hasText: '这一关还不能使用' })).toBeVisible();
  await expect(page.getByLabel('第 1 块移动步数')).toHaveValue('2');
  await page.getByTestId('run').click(); await expect(page.getByTestId('execution-message')).toContainText('你学会了');
});

test('损坏存档与存储被禁用均显示说明，应用仍可编程运行', async ({ page }) => {
  await page.addInitScript(key => {
    localStorage.setItem(key, '{broken');
    Storage.prototype.setItem = () => { throw new DOMException('disabled', 'SecurityError'); };
  }, STORAGE_KEY);
  await page.goto('/');
  await expect(page.getByRole('status').filter({ hasText: '没有保存成功' })).toBeVisible();
  await page.getByTestId('library-forward').click(); await page.getByLabel('第 1 块移动步数').selectOption('2');
  await page.getByTestId('run').click(); await expect(page.getByTestId('execution-message')).toContainText('你学会了');
});

test('减少动画、轨迹与声音设置可保存，帮助对话框支持Esc关闭', async ({ page }) => {
  await page.goto('/'); await page.getByRole('button', { name: '帮助与设置' }).click();
  await page.getByRole('checkbox', { name: '减少动画' }).check();
  await page.getByRole('checkbox', { name: '声音反馈' }).check();
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('checkbox', { name: '显示轨迹' }).uncheck();
  await page.reload();
  await expect(page.locator('.app-shell')).toHaveClass(/reduce-motion/);
  await expect(page.getByRole('button', { name: '关闭声音' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: '显示轨迹' })).not.toBeChecked();
});

test('手机切换地图与编程板，地图上能暂停/单步/重置且不横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/'); await page.getByRole('tab', { name: /我的编程板/ }).click();
  await page.getByTestId('library-forward').click(); await page.getByLabel('第 1 块移动步数').selectOption('3');
  await page.clock.install(); await page.getByTestId('run').click();
  await expect(page.getByTestId('robot-map')).toBeVisible();
  await page.getByTestId('mobile-pause').click(); await page.clock.runFor(600);
  await expect(page.getByTestId('mobile-pause')).toHaveText('继续');
  await page.getByTestId('mobile-step').click(); await expect(page.getByTestId('robot')).toHaveAttribute('data-x', '3');
  await page.getByTestId('mobile-reset').click(); await page.clock.runFor(3000);
  await expect(page.getByTestId('robot')).toHaveAttribute('data-x', '1');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('tab', { name: /我的编程板/ }).click(); await expect(blocks(page)).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

for (const level of levels.filter(l => l.mode === 'challenge')) {
  test(`参考解真实浏览器执行：${level.id} ${level.title}`, async ({ page }) => {
    await seed(page, level.id, level.solution); await page.goto('/');
    await page.clock.install(); await page.getByTestId('run').click(); await page.clock.runFor(15000);
    await expect(page.getByTestId('execution-message')).toContainText('你学会了');
    await expect(page.getByTestId('robot')).toHaveAttribute('data-x', String(level.goal!.x));
    await expect(page.getByTestId('robot')).toHaveAttribute('data-y', String(level.goal!.y));
    await expect(page.getByTestId('stars-count')).toHaveText(`${level.stars.length} / ${level.stars.length}`);
  });
}

test('错误程序在界面解释原因并高亮问题积木', async ({ page }) => {
  await page.goto('/'); await page.getByTestId('run').click();
  await expect(page.getByTestId('execution-message')).toContainText('先放一块');
  await page.getByTestId('library-forward').click(); await page.getByLabel('第 1 块移动步数').selectOption('9');
  await page.clock.install(); await page.getByTestId('run').click(); await page.clock.runFor(3000);
  await expect(page.getByTestId('execution-message')).toContainText('地图外面');
  await expect(page.locator('.block-error')).toHaveCount(1);
  await expect(page.getByTestId('robot')).toHaveAttribute('data-x', '4');
  await expect(page.getByTestId('action-count')).toHaveText('3');
  await selectLevel(page, 'free'); await page.getByTestId('library-call-A').click(); await page.getByTestId('run').click();
  await expect(page.getByTestId('execution-message')).toContainText('还没有定义');
  await expect(page.locator('.block-error')).toHaveCount(1);
  await expect(page.getByTestId('library-call-A')).toBeEnabled();
});

test('单步嵌套函数同时高亮调用积木与函数内部，并显示确切调用路径', async ({ page }) => {
  const level = levels.find(l => l.id === '012')!;
  await seed(page, level.id, level.solution); await page.goto('/');
  await page.getByTestId('step').click();
  await expect(page.getByTestId('program-main').locator('.in-stack')).toHaveCount(1);
  await expect(page.getByTestId('program-fn:A').locator('.executing')).toHaveCount(1);
  await expect(page.getByTestId('program-fn:B').locator('.in-stack')).toHaveCount(2);
  await expect(page.locator('.program-panel [data-testid="execution-breadcrumb"]')).toHaveText('主程序第 1 块 · 执行B → B 中第 1.1 块 · 执行A → A 中第 1 块 · 前进');
  await expect(page.getByTestId('action-count')).toHaveText('1');
});
