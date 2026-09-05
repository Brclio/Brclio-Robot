import { expect, test, type Locator, type Page } from '@playwright/test';

const mainBlocks = (page: Page) => page.getByTestId('program-main').locator(':scope > .block-position > .program-block');
async function openFree(page: Page) {
  await page.goto('/');
  await page.getByTestId('open-levels').click();
  await page.getByTestId('level-free').click();
  const editorTab = page.getByRole('tab', { name: /我的编程板/ });
  if (await editorTab.isVisible()) await editorTab.click();
}
async function order(page: Page) { return mainBlocks(page).evaluateAll(elements => elements.map(element => element.getAttribute('data-instruction'))); }
async function dragToSlot(page: Page, source: Locator, target: Locator) {
  const from = await source.boundingBox(); const to = await target.boundingBox();
  expect(from).toBeTruthy(); expect(to).toBeTruthy();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(from!.x + from!.width / 2 + 12, from!.y + from!.height / 2, { steps: 4 });
  await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 18 });
  await expect(target).toHaveClass(/drop-target/);
  await page.mouse.up();
}

test('click editing, keyboard reordering, copy/delete and undo/redo preserve semantic order', async ({ page }) => {
  await openFree(page);
  for (const type of ['forward', 'right', 'backward']) await page.getByTestId(`library-${type}`).click();
  expect(await order(page)).toEqual(['forward', 'right', 'backward']);
  await page.getByRole('button', { name: '选择第 2 块右转', exact: true }).click();
  await page.getByRole('button', { name: '选择第 2 块右转', exact: true }).press('Alt+ArrowLeft');
  expect(await order(page)).toEqual(['right', 'forward', 'backward']);
  await page.getByRole('button', { name: '复制积木', exact: true }).click();
  expect(await order(page)).toEqual(['right', 'right', 'forward', 'backward']);
  await page.getByRole('button', { name: '删除积木', exact: true }).click();
  expect(await order(page)).toEqual(['right', 'forward', 'backward']);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  expect(await order(page)).toEqual(['right', 'right', 'forward', 'backward']);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  expect(await order(page)).toEqual(['right', 'forward', 'backward']);
  await page.getByRole('combobox', { name: '第 2 块移动步数', exact: true }).selectOption('3');
  await expect(page.getByRole('combobox', { name: '第 2 块移动步数', exact: true })).toHaveValue('3');
});

test('loop body insertion, non-drag move out, function placement and two-layer guard', async ({ page }) => {
  await openFree(page);
  await page.getByTestId('library-repeat').click();
  const repeatId = await mainBlocks(page).first().getAttribute('data-block-id');
  await page.getByTestId(`insert-repeat:${repeatId}-0`).click();
  await page.getByTestId('library-forward').click();
  await expect(page.getByTestId(`program-repeat:${repeatId}`).locator('.program-block')).toHaveCount(1);
  await page.getByRole('combobox', { name: '积木移动目标', exact: true }).selectOption('main');
  await page.getByRole('button', { name: '移动到目标区域', exact: true }).click();
  expect(await order(page)).toEqual(['repeat', 'forward']);
  await page.getByRole('combobox', { name: '积木移动目标', exact: true }).selectOption('fn:A');
  await page.getByRole('button', { name: '移动到目标区域', exact: true }).click();
  await expect(page.getByTestId('program-fn:A').locator('.program-block')).toHaveCount(1);
  await page.getByTestId(`insert-repeat:${repeatId}-0`).click();
  await page.getByTestId('library-repeat').click();
  const innerId = await page.getByTestId(`program-repeat:${repeatId}`).locator('.program-block').first().getAttribute('data-block-id');
  await page.getByTestId(`insert-repeat:${innerId}-0`).click();
  await page.getByTestId('library-repeat').click();
  await expect(page.getByRole('status').filter({ hasText: '循环最多套两层' })).toBeVisible();
  await expect(page.getByTestId(`program-repeat:${innerId}`).locator('.program-block')).toHaveCount(0);
});

test('mouse drags library blocks to explicit insert targets and reorders by data position', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1050 });
  await openFree(page);
  const source = await page.getByTestId('library-forward').boundingBox();
  const destination = await page.getByTestId('insert-main-0').boundingBox();
  expect(source).toBeTruthy(); expect(destination).toBeTruthy();
  await page.mouse.move(source!.x + source!.width / 2, source!.y + source!.height / 2);
  await page.mouse.down();
  await page.mouse.move(source!.x + source!.width / 2 + 12, source!.y + source!.height / 2, { steps: 4 });
  await page.mouse.move(destination!.x + destination!.width / 2, destination!.y + destination!.height / 2, { steps: 18 });
  await expect(page.getByTestId('insert-main-0')).toHaveClass(/drop-target/);
  await page.mouse.up();
  await expect(mainBlocks(page)).toHaveCount(1);
  await page.getByTestId('library-right').click();
  const handle = await page.getByRole('button', { name: '拖动第 2 块右转', exact: true }).boundingBox();
  const before = await mainBlocks(page).first().boundingBox();
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle!.x + handle!.width / 2 - 12, handle!.y + handle!.height / 2, { steps: 4 });
  await page.mouse.move(before!.x + 25, before!.y + 60, { steps: 18 });
  await expect(page.locator('.block-position.insert-before')).toHaveCount(1);
  await page.mouse.up();
  await expect.poll(() => order(page)).toEqual(['right', 'forward']);
});

test('responsive wrapping changes no instruction IDs or execution order', async ({ page }) => {
  await openFree(page);
  for (const type of ['forward', 'right', 'backward', 'left', 'forward', 'right']) await page.getByTestId(`library-${type}`).click();
  const originalIds = await mainBlocks(page).evaluateAll(elements => elements.map(element => element.getAttribute('data-block-id')));
  const originalOrder = await order(page);
  for (const width of [1440, 900, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const tab = page.getByRole('tab', { name: /我的编程板/ });
    if (await tab.isVisible()) await tab.click();
    expect(await mainBlocks(page).evaluateAll(elements => elements.map(element => element.getAttribute('data-block-id')))).toEqual(originalIds);
    expect(await order(page)).toEqual(originalOrder);
    expect(await mainBlocks(page).evaluateAll(elements => elements.map(element => element.getAttribute('data-order')))).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});

test('mouse moves a block into a nested container and back out to the main sequence', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1300 });
  await openFree(page);
  await page.getByTestId('library-repeat').click();
  await page.getByTestId('library-forward').click();
  const repeatId = await mainBlocks(page).first().getAttribute('data-block-id');
  await dragToSlot(page, page.getByRole('button', { name: '拖动第 2 块前进', exact: true }), page.getByTestId(`insert-repeat:${repeatId}-0`));
  await expect(mainBlocks(page)).toHaveCount(1);
  await expect(page.getByTestId(`program-repeat:${repeatId}`).locator('.program-block')).toHaveCount(1);
  await dragToSlot(page, page.getByRole('button', { name: '拖动第 1.1 块前进', exact: true }), page.getByTestId('insert-main-1'));
  await expect(mainBlocks(page)).toHaveCount(2);
  expect(await order(page)).toEqual(['repeat', 'forward']);
  await expect(page.getByTestId(`program-repeat:${repeatId}`).locator('.program-block')).toHaveCount(0);
});

test('touchscreen supports tap editing and pointer-driven drag insertion', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, hasTouch: true, viewport: { width: 1024, height: 1300 } });
  const page = await context.newPage();
  await openFree(page);
  await page.getByTestId('library-right').tap();
  await expect(mainBlocks(page)).toHaveCount(1);
  await page.getByRole('button', { name: '删除积木', exact: true }).tap();
  await expect(mainBlocks(page)).toHaveCount(0);
  const source = await page.getByTestId('library-forward').boundingBox();
  const destination = await page.getByTestId('insert-main-0').boundingBox();
  expect(source).toBeTruthy(); expect(destination).toBeTruthy();
  const session = await context.newCDPSession(page);
  const start = { x: source!.x + source!.width / 2, y: source!.y + source!.height / 2 };
  const end = { x: destination!.x + destination!.width / 2, y: destination!.y + destination!.height / 2 };
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, id: 1 }] });
  // Wait for the documented 180 ms touch activation delay before moving.
  await page.waitForTimeout(230);
  for (let i = 1; i <= 14; i++) {
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x + (end.x - start.x) * i / 14, y: start.y + (end.y - start.y) * i / 14, id: 1 }] });
    await page.waitForTimeout(20); // A finger crosses the board over several rendered frames.
  }
  await expect(page.getByTestId('insert-main-0')).toHaveClass(/drop-target/);
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(mainBlocks(page)).toHaveCount(1);
  expect(await order(page)).toEqual(['forward']);
  await context.close();
});

test('the shared 200-block limit keeps a full valid draft intact across refresh', async ({ page }) => {
  await openFree(page);
  const main = Array.from({ length: 200 }, (_, index) => ({ id: `limit-${index}`, type: 'right' }));
  const file = { version: 1, levelId: 'free', main, functions: { A: [], B: [] } };
  await page.getByLabel('导入程序文件', { exact: true }).setInputFiles({ name: 'limit-200.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
  await expect(mainBlocks(page)).toHaveCount(200);
  await page.getByTestId('library-forward').click();
  await expect(page.getByRole('status').filter({ hasText: '最多放 200 块' })).toBeVisible();
  await expect(mainBlocks(page)).toHaveCount(200);
  await page.reload();
  const tab = page.getByRole('tab', { name: /我的编程板/ });
  if (await tab.isVisible()) await tab.click();
  await expect(mainBlocks(page)).toHaveCount(200);
  expect(await order(page)).toEqual(Array(200).fill('right'));
});
