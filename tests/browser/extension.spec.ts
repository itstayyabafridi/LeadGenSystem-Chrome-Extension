import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

test('built side panel can start, pause, resume, stop, and export', async ({ page }) => {
  const output = resolve('apps/extension/.output/chrome-mv3');
  await page.route('**/sidepanel.html', async route => route.fulfill({ contentType:'text/html',body:await readFile(resolve(output,'sidepanel.html'),'utf8') }));
  await page.route('**/chunks/sidepanel-*.js', async route => route.fulfill({ contentType:'text/javascript',body:await readFile(resolve(output,'chunks',new URL(route.request().url()).pathname.split('/').pop()!),'utf8') }));
  await page.route('**/assets/sidepanel-*.css', async route => route.fulfill({ contentType:'text/css',body:await readFile(resolve(output,'assets',new URL(route.request().url()).pathname.split('/').pop()!),'utf8') }));
  await page.addInitScript(() => {
    const state = { accountId:'test-user',email:'customer@example.com',checkpoint:null as null | Record<string,any>,unsynced_count:0 };
    const listeners: ((changes: Record<string,unknown>, area: string) => void)[] = [];
    const emit = () => listeners.forEach(fn => fn({ checkpoint:{} },'local'));
    (globalThis as any).browser = {
      runtime: { id:'test-extension',async sendMessage(input: Record<string,any>) {
        let data: unknown = null;
        if (input.type === 'GET_STATE') data = structuredClone(state);
        else if (input.type === 'ACCOUNT') data = { entitlement:{ active:true,credits:99,expires_at:'2099-01-01T00:00:00Z' } };
        else if (input.type === 'START') {
          state.checkpoint = { job:{ id:'job',business:input.business,area:input.area,lead_limit:input.limit,status:'running',saved_count:1,duplicate_count:0,skipped_count:0 },pending:null,reason:null,controlPending:false };
          data = state.checkpoint.job; emit();
        } else if (['PAUSE','RESUME','STOP'].includes(input.type)) {
          state.checkpoint!.job.status = { PAUSE:'paused',RESUME:'running',STOP:'stopped' }[input.type as 'PAUSE'|'RESUME'|'STOP'];
          data = state.checkpoint!.job; emit();
        } else if (input.type === 'EXPORT') data = '\uFEFF"Name"\r\n"River Dental"';
        return { ok:true,data };
      } },
      storage: { onChanged:{ addListener:(fn: typeof listeners[number]) => listeners.push(fn),removeListener:() => {} } },
      tabs:{ query:async () => [{ id:5 }] },
    };
  });
  await page.setViewportSize({ width:360,height:1000 });
  await page.goto('/sidepanel.html');
  await expect(page.getByRole('heading',{ name:'Find businesses' })).toBeVisible();
  await page.getByRole('textbox',{ name:'Business type' }).fill('Dental clinics');
  await page.getByRole('textbox',{ name:'Target area' }).fill('Lahore, Pakistan');
  await page.getByRole('button',{ name:'Start collection' }).click();
  await expect(page.getByRole('button',{ name:'Pause',exact:true })).toBeVisible();
  await page.screenshot({ path:'artifacts/extension-panel.png',fullPage:true });
  await page.getByRole('button',{ name:'Pause',exact:true }).click();
  await expect(page.getByRole('button',{ name:'Resume',exact:true })).toBeVisible();
  await page.getByRole('button',{ name:'Resume',exact:true }).click();
  await expect(page.getByRole('button',{ name:'Pause',exact:true })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button',{ name:'Export collected leads' }).click();
  expect((await download).suggestedFilename()).toBe('leadgen-Dental-clinics.csv');
  await page.getByRole('button',{ name:'Stop',exact:true }).click();
  await expect(page.getByText('stopped',{ exact:true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
});
