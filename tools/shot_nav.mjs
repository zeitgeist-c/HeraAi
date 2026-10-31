/* global window, document, console */
import { chromium } from 'playwright-core';
const STUB = () => {
  window.chrome = {
    storage: { onChanged: { addListener: () => {}, removeListener: () => {} }, local: {
      get: (k, cb) => { const cfg = { theme: 'dark', language: 'en', showSources: true, apiKeyUsageMode: 'primary', customPrimaryColor: '#7c5cff', systemInstruction: '', startupBehavior: 'resume' }; if (typeof cb === 'function') { cb(cfg); return; } if (typeof k === 'function') { k(cfg); return; } return Promise.resolve(cfg); },
      set: (o, cb) => { cb && cb(); }, remove: (k, cb) => { cb && cb(); },
    }},
    runtime: { onMessage: { addListener: () => {} }, onInstalled: { addListener: () => {} } },
  };
};
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage({ viewport: { width: 840, height: 2000 } });
await page.addInitScript(STUB);
const EN = () => page.waitForFunction(() => !/[çğıöşüÇĞİÖŞÜ]/.test(document.body.innerText || ''), { timeout: 20000 }).catch(() => {});
await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
await EN(); await page.waitForTimeout(1000);
await page.screenshot({ path: 'docs/screenshots/00-ana-sohbet.png' }); console.log('wrote 00');
await page.$$eval('button', els => { const b = els.find(e => (e.innerText || '').includes('Gemini 3.1 Flash Lite')); if (b) b.click(); });
await page.waitForTimeout(1200);
await page.screenshot({ path: 'docs/screenshots/03-model-secici.png' }); console.log('wrote 03');
await page.keyboard.press('Escape'); await page.waitForTimeout(500);
await page.getByRole('button', { name: 'More options' }).click();
await page.waitForTimeout(1000);
await page.getByRole('menuitem', { name: 'Settings' }).click();
await page.waitForTimeout(1500);
await page.$$eval('button', els => { const b = els.find(e => (e.innerText || '').trim() === 'My models'); if (b) b.click(); });
await page.waitForTimeout(1200);
await page.screenshot({ path: 'docs/screenshots/04-modellerim.png' }); console.log('wrote 04');
await page.$$eval('button', els => { const b = els.find(e => (e.innerText || '').trim() === 'General Settings'); if (b) b.click(); });
await page.waitForTimeout(1200);
await page.screenshot({ path: 'docs/screenshots/05-genel-ayarlar.png' }); console.log('wrote 05');
await page.keyboard.press('Escape'); await page.waitForTimeout(500);
await page.getByRole('button', { name: 'More options' }).click();
await page.waitForTimeout(1200);
await browser.close();
