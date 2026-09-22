import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const base = process.env.SWIVEL_TEST_URL || 'http://127.0.0.1:4700';
const browser = await chromium.launch({...(process.env.SWIVEL_CHROMIUM_PATH ? { executablePath: process.env.SWIVEL_CHROMIUM_PATH } : {}),headless:true});
await mkdir('test-results',{recursive:true});
const results=[];
for (const width of [1440, 768, 390]) {
 const page = await browser.newPage({viewport:{width,height:width===390?844:1000}});
 const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base); await page.getByRole('button',{name:'Open interactive demo'}).waitFor();
 await page.screenshot({path:`test-results/welcome-${width}.png`,fullPage:true});
 await page.getByRole('button',{name:'Open interactive demo'}).click();
 await page.getByRole('heading',{name:'From a goal to a reliable action.'}).waitFor();
 await page.screenshot({path:`test-results/workspace-${width}.png`,fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`Overflow ${width}`);
 for (const [name, heading] of [['Capabilities','Capabilities'],['Runs','Runs'],['Operator queue','Operator queue'],['Tenants','Tenants']]) {
   await page.locator('.sidebar').getByRole('link',{name:new RegExp(`^${name}`)}).click();
   await page.waitForTimeout(450);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${name} overflow ${width}`);
 }
 assert.deepEqual(errors,[]);
 results.push({width,errors,overflow:false}); await page.close();
}
await writeFile('test-results/ui-check.json',JSON.stringify(results,null,2));
await browser.close(); console.log(JSON.stringify(results));
