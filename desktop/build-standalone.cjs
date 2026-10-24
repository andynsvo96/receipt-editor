const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.join(__dirname, '..');
const distDir = path.join(projectRoot, 'desktop-dist');
const outputDir = path.join(projectRoot, 'release');
let html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');

const scriptMatch = html.match(/<script\s+type="module"[^>]*src="\.\/(assets\/[^"]+\.js)"[^>]*><\/script>/i);
const styleMatch = html.match(/<link\s+rel="stylesheet"[^>]*href="\.\/(assets\/[^"]+\.css)"[^>]*>/i);
if (!scriptMatch || !styleMatch) throw new Error('The desktop bundle did not contain the expected script and stylesheet.');

const javascript = fs.readFileSync(path.join(distDir, scriptMatch[1]), 'utf8');
const css = fs.readFileSync(path.join(distDir, styleMatch[1]), 'utf8');
if (/<\/script/i.test(javascript)) throw new Error('The application script cannot be safely inlined.');
if (/<\/style/i.test(css)) throw new Error('The application stylesheet cannot be safely inlined.');

html = html
  .replace(/\s*<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/i, '')
  .replace(scriptMatch[0], '')
  .replace(styleMatch[0], () => `<style>${css}</style>`)
  .replace('</body>', () => `<script>${javascript}</script></body>`);

fs.mkdirSync(outputDir, { recursive: true });
const outputPath = path.join(outputDir, 'Receipt-Studio-Portable-Mac.html');
fs.writeFileSync(outputPath, html, 'utf8');
console.log(`Created ${outputPath} (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB). Open this single file in a desktop browser; no installation or server is needed.`);
