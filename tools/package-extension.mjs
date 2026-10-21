import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
const outRoot = path.join(root,'dist');
const folder = `longchat-perf-v${manifest.version}`;
const out = path.join(outRoot, folder);
fs.rmSync(outRoot,{recursive:true,force:true});
fs.mkdirSync(out,{recursive:true});
const entries = [
  'manifest.json','icons','content','popup','service-worker.js','coordinator-core.js','project-routing.js',
  'page-guard.js','bridge.js','overlay.js','options.html','options.js','options.css','README.zh-CN.md','PRIVACY.md','LICENSE'
];
for (const rel of entries) {
  const src = path.join(root,rel);
  if (!fs.existsSync(src)) throw new Error(`缺少打包文件: ${rel}`);
  fs.cpSync(src,path.join(out,rel),{recursive:true});
}
console.log(JSON.stringify({version:manifest.version,folder,out},null,2));
