import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
const required = [
  'service-worker.js','coordinator-core.js','project-routing.js','page-guard.js','bridge.js','overlay.js',
  'options.html','options.js','options.css','popup/popup.html','popup/popup.js','popup/popup.css',
  'content/content.js','content/cm-mount.js','content/base.css'
];
let failures = 0;
function ok(cond,msg){ if(cond) console.log('PASS',msg); else { failures++; console.error('FAIL',msg); } }
ok(manifest.version === '0.5.2','manifest 版本为 0.5.2');
ok(manifest.background?.service_worker === 'service-worker.js','后台 Service Worker 已启用');
ok(Array.isArray(manifest.permissions) && manifest.permissions.includes('webRequest'),'已声明 webRequest 只读观测权限');
for (const f of required) ok(fs.existsSync(path.join(root,f)),`运行时文件存在：${f}`);
const overlay = fs.readFileSync(path.join(root,'overlay.js'),'utf8');
ok(overlay.includes("document.addEventListener('pointerdown'"),'生命体征详情支持点击页面其他位置自动收起');
const popup = fs.readFileSync(path.join(root,'popup/popup.html'),'utf8');
for (const id of ['healthLabel','cv','cmMount','ltStatus','profileSelect','diagnose']) ok(popup.includes(`id="${id}"`),`弹窗包含 ${id}`);
const options = fs.readFileSync(path.join(root,'options.html'),'utf8');
for (const text of ['升级与配置保护','自动项目路由','会话链核验与最终回复']) ok(options.includes(text),`配置页包含：${text}`);
process.exit(failures ? 1 : 0);
