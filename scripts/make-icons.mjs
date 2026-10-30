/**
 * 生成 tabBar 图标 + Logo（用 Chrome 无头渲染 SVG -> PNG，透明底，抗锯齿）
 *
 * 为什么不用 canvas/sharp：本机没有这些库；而 Chrome 已经在机器上，
 * 用 playwright-core 直接渲染 SVG 是最省事且质量最高的做法（矢量->位图，边缘干净）。
 * 图标规范：tabBar 81x81，Logo 512x512，透明背景。
 *
 * 用法：node scripts/make-icons.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'miniprogram', 'assets', 'tabbar');
fs.mkdirSync(outDir, { recursive: true });

const NORMAL = '#8ba3c7';
const ACTIVE = '#4ea1ff';

/** 图标 SVG（stroke 风格，2.2 线宽，viewBox 0 0 32 32） */
function iconSvg(kind, color) {
  const stroke = `stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"`;
  const fill = `fill="${color}"`;
  let body = '';

  if (kind === 'clock') {
    body = `
      <circle cx="16" cy="16" r="11" ${stroke}/>
      <path d="M16 9.5V16l4.6 3" ${stroke}/>`;
  } else if (kind === 'list') {
    body = `
      <circle cx="6.5" cy="9" r="1.7" ${fill}/>
      <circle cx="6.5" cy="16" r="1.7" ${fill}/>
      <circle cx="6.5" cy="23" r="1.7" ${fill}/>
      <path d="M11.5 9h15M11.5 16h15M11.5 23h15" ${stroke}/>`;
  } else if (kind === 'stats') {
    body = `
      <path d="M5 26h22" ${stroke}/>
      <path d="M8 26V15M15 26V9M22 26V18M27 26V12" ${stroke}/>`;
  } else if (kind === 'me') {
    body = `
      <circle cx="16" cy="11" r="5" ${stroke}/>
      <path d="M6.5 26c0-4.9 4.3-8 9.5-8s9.5 3.1 9.5 8" ${stroke}/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="81" height="81">${body}</svg>`;
}

/** Logo：渐变圆角块 + 时钟 + 对勾（512） */
const logoSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1b2b47"/>
      <stop offset="1" stop-color="#0b1220"/>
    </linearGradient>
    <linearGradient id="b" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6fbcff"/>
      <stop offset="1" stop-color="#2f7fe0"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="512" height="512" rx="112" fill="url(#g)"/>
  <circle cx="256" cy="224" r="118" fill="none" stroke="url(#b)" stroke-width="20"/>
  <path d="M256 150V224l54 34" fill="none" stroke="#e8f1ff" stroke-width="20" stroke-linecap="round" stroke-linejoin="round" opacity="0.92"/>
  <path d="M168 384l48 44 128-140" fill="none" stroke="#34d399" stroke-width="26" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const icons = ['clock', 'list', 'me'];

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 600, height: 600 }, deviceScaleFactor: 1 });

async function renderSvg(svg, size, outPath) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent"><div style="width:${size}px;height:${size}px">${svg}</div></body></html>`,
    { waitUntil: 'load' }
  );
  await page.screenshot({ path: outPath, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

for (const kind of icons) {
  await renderSvg(iconSvg(kind, NORMAL), 81, path.join(outDir, `${kind}.png`));
  await renderSvg(iconSvg(kind, ACTIVE), 81, path.join(outDir, `${kind}-active.png`));
}
await renderSvg(logoSvg, 512, path.join(root, 'miniprogram', 'assets', 'logo.png'));

await browser.close();

const files = fs.readdirSync(outDir).map((f) => path.join(outDir, f));
files.push(path.join(root, 'miniprogram', 'assets', 'logo.png'));
console.log('generated', files.length, 'files');
files.forEach((f) => console.log('  ', path.relative(root, f), (fs.statSync(f).size / 1024).toFixed(1) + 'KB'));
