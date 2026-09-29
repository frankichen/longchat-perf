const KEY = 'devhubConfigV4';
const LOCAL_SECRETS_KEY = 'devhubSecretsV4';
const BUILTIN_RULES = [
  { aliases:['sxt加速A'], devhubProject:'sxt', targetSlot:'WORKER-A' },
  { aliases:['sxt加速B'], devhubProject:'sxt', targetSlot:'WORKER-B' },
  { aliases:['sxt加速C'], devhubProject:'sxt', targetSlot:'WORKER-C' },
  { aliases:['sxt评审'], devhubProject:'sxt', targetSlot:'REVIEWER-A' },
  { aliases:['XYZL-A开发'], devhubProject:'xyzl', targetSlot:'WORKER-A' },
  { aliases:['XYZL-B开发'], devhubProject:'xyzl', targetSlot:'WORKER-B' },
  { aliases:['XYZL-C开发'], devhubProject:'xyzl', targetSlot:'WORKER-C' }
];
const DEFAULTS = {
  enabled:false,
  baseUrl:'https://devhub.sgk.555044.xyz',
  submitOnOpen:true,
  submitOnStateChange:true,
  minSubmitGapMs:60000,
  profiles:[],
  bindings:{},
  autoProjectMapping:true,
  autoRules:BUILTIN_RULES
};
const PROBE_DEFAULTS = {
  streamProbeEnabled:true,
  streamProbeFailureThreshold:2,
  streamProbeMinGapMs:15000,
  streamProbeStaleStreamingEnabled:true,
  streamProbeStaleStreamingAfterMs:90000,
  streamProbeStaleStreamingGapMs:60000,
  autoPersistenceCheckEnabled:true,
  autoPersistenceCheckDelayMs:5000,
  autoPersistenceCheckMinGapMs:60000,
  terminalPersistenceGraceMs:30000
};
const $ = id => document.getElementById(id);

function friendlyError(value) {
  const v = String(value || '').trim();
  const lower = v.toLowerCase();
  if (!v) return '未知原因';
  if (lower.includes('permission') || lower.includes('denied')) return '浏览器权限不足或权限申请被拒绝';
  if (lower.includes('invalid url') || lower.includes('地址无效')) return 'DevHub 地址无效';
  if (lower.includes('json')) return '配置文件格式不正确';
  if (lower.includes('token')) return '访问令牌配置有误';
  return /[一-鿿]/.test(v) ? v : '操作失败，请检查配置、网络和浏览器权限。';
}

function displayProfileName(p) {
  const raw = String(p?.name || p?.id || '未命名配置');
  const m = raw.match(/^(.+?)\s+Manager\s+evidence$/i);
  if (m) return `${m[1]} 主管旁证`;
  return raw.replace(/Manager/ig, '主管').replace(/evidence/ig, '旁证');
}
let cfg = { ...DEFAULTS };

function uid() { return `p-${Date.now()}-${Math.random().toString(36).slice(2,8)}`; }
function originPattern(url) { try { return `${new URL(url).origin}/*`; } catch { return ''; } }
async function requestPermission(url) {
  const origin = originPattern(url);
  if (!origin) throw new Error('DevHub 地址无效');
  const has = await chrome.permissions.contains({ origins:[origin] });
  if (has) return true;
  return chrome.permissions.request({ origins:[origin] });
}
function escapeHtml(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function rulesToText(rules) {
  return (Array.isArray(rules) && rules.length ? rules : BUILTIN_RULES)
    .flatMap(r => (Array.isArray(r.aliases) ? r.aliases : [r.name]).filter(Boolean).map(a => `${a} => ${r.devhubProject} / ${r.targetSlot}`))
    .join('\n');
}
function textToRules(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(.+?)\s*=>\s*([^/\s]+)\s*\/\s*([^\s]+)\s*$/);
    if (!m) throw new Error(`路由规则格式错误：${line}`);
    out.push({ aliases:[m[1].trim()], devhubProject:m[2].trim().toLowerCase(), targetSlot:m[3].trim().toUpperCase() });
  }
  if (!out.length) throw new Error('至少需要一条自动路由规则');
  return out;
}
function modeText(mode) {
  return mode === 'manager_evidence' ? '主管旁证模式' : (mode === 'heartbeat' ? '槽位心跳模式' : String(mode || ''));
}

async function loadConfig() {
  const stored = await chrome.storage.local.get(KEY);
  cfg = { ...DEFAULTS, ...(stored[KEY] || {}) };
  cfg.profiles = Array.isArray(cfg.profiles) ? cfg.profiles : [];
  cfg.bindings = { ...(cfg.bindings || {}) };
  cfg.autoRules = Array.isArray(cfg.autoRules) && cfg.autoRules.length ? cfg.autoRules : BUILTIN_RULES;
  render();
}
async function loadProbe() {
  const p = await chrome.storage.sync.get(PROBE_DEFAULTS);
  $('streamProbeEnabled').checked = Boolean(p.streamProbeEnabled);
  $('probeFailureThreshold').value = String(Number(p.streamProbeFailureThreshold || 2));
  $('probeMinGap').value = String(Math.round(Number(p.streamProbeMinGapMs || 15000) / 1000));
  $('staleStreamingProbeEnabled').checked = p.streamProbeStaleStreamingEnabled !== false;
  $('staleStreamingAfter').value = String(Math.round(Number(p.streamProbeStaleStreamingAfterMs || 90000) / 1000));
  $('staleStreamingGap').value = String(Math.round(Number(p.streamProbeStaleStreamingGapMs || 60000) / 1000));
  $('autoPersistenceCheckEnabled').checked = Boolean(p.autoPersistenceCheckEnabled);
  $('persistenceDelay').value = String(Math.round(Number(p.autoPersistenceCheckDelayMs || 5000) / 1000));
  $('persistenceMinGap').value = String(Math.round(Number(p.autoPersistenceCheckMinGapMs || 60000) / 1000));
  $('persistenceGrace').value = String(Math.round(Number(p.terminalPersistenceGraceMs || 30000) / 1000));
}
async function saveConfig() { await chrome.storage.local.set({ [KEY]:cfg }); }

function render() {
  $('devhubEnabled').checked = Boolean(cfg.enabled);
  $('autoProjectMapping').checked = cfg.autoProjectMapping !== false;
  $('baseUrl').value = cfg.baseUrl || DEFAULTS.baseUrl;
  $('submitOnOpen').checked = Boolean(cfg.submitOnOpen);
  $('submitOnStateChange').checked = Boolean(cfg.submitOnStateChange);
  $('minGap').value = String(Math.round(Number(cfg.minSubmitGapMs || 60000) / 1000));
  $('autoRules').value = rulesToText(cfg.autoRules);
  const list = $('profileList');
  list.innerHTML = '';
  for (const p of cfg.profiles) {
    const row = document.createElement('div');
    row.className = 'profile';
    const text = document.createElement('div');
    text.innerHTML = `<strong>${escapeHtml(displayProfileName(p))}</strong><small>项目=${escapeHtml(p.projectKey || '-')} / ${escapeHtml(modeText(p.mode))} / 默认槽位=${escapeHtml(p.slotName || '-')} / 会话代次=${escapeHtml(p.sessionGeneration || '-')}</small>`;
    const edit = document.createElement('button');
    edit.textContent = '编辑';
    edit.addEventListener('click', () => fill(p));
    const del = document.createElement('button');
    del.className = 'secondary';
    del.textContent = '删除';
    del.addEventListener('click', () => removeProfile(p.id));
    row.append(text, edit, del);
    list.appendChild(row);
  }
}

function fill(p) {
  $('profileId').value = p.id;
  $('profileName').value = p.name || '';
  $('projectKey').value = p.projectKey || '';
  $('profileMode').value = p.mode || 'manager_evidence';
  $('slotName').value = p.slotName || '';
  $('sessionGeneration').value = p.sessionGeneration || '';
  $('profileBaseUrl').value = p.baseUrl || '';
  $('token').value = '';
  $('rememberToken').checked = false;
  $('profileStatus').textContent = '正在编辑此配置。出于安全原因不会显示已有令牌；令牌留空即可保留原值。';
}
function clearForm() {
  $('profileId').value = '';
  $('profileName').value = '';
  $('projectKey').value = '';
  $('profileMode').value = 'manager_evidence';
  $('slotName').value = 'MANAGER';
  $('sessionGeneration').value = '';
  $('profileBaseUrl').value = '';
  $('token').value = '';
  $('rememberToken').checked = false;
  $('profileStatus').textContent = '';
}
async function removeProfile(id) {
  if (!confirm('确定删除这个 DevHub 配置吗？')) return;
  cfg.profiles = cfg.profiles.filter(x => x.id !== id);
  for (const [cid, pid] of Object.entries(cfg.bindings)) if (pid === id) delete cfg.bindings[cid];
  await saveConfig();
  await chrome.runtime.sendMessage({ type:'DELETE_DEVHUB_SECRET', profileId:id });
  render();
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type:'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function buildExport(includeSecrets) {
  const syncSettings = await chrome.storage.sync.get(null);
  const payload = {
    format:'chatgpt-task-vital-monitor-config',
    version:1,
    exportedAt:new Date().toISOString(),
    pluginVersion:'0.5.0',
    devhubConfig:cfg,
    syncSettings
  };
  if (includeSecrets) {
    const stored = await chrome.storage.local.get(LOCAL_SECRETS_KEY);
    payload.persistentSecrets = stored[LOCAL_SECRETS_KEY] || {};
  }
  return payload;
}

async function importPayload(payload) {
  if (!payload || payload.format !== 'chatgpt-task-vital-monitor-config') throw new Error('不是本插件导出的配置文件');
  const importedCfg = { ...DEFAULTS, ...(payload.devhubConfig || {}) };
  importedCfg.profiles = Array.isArray(importedCfg.profiles) ? importedCfg.profiles : [];
  importedCfg.bindings = { ...(importedCfg.bindings || {}) };
  importedCfg.autoRules = Array.isArray(importedCfg.autoRules) && importedCfg.autoRules.length ? importedCfg.autoRules : BUILTIN_RULES;
  const urls = new Set([importedCfg.baseUrl, ...importedCfg.profiles.map(p => p.baseUrl).filter(Boolean)]);
  for (const url of urls) {
    if (!url) continue;
    const granted = await requestPermission(url);
    if (!granted) throw new Error(`没有取得 DevHub 域名权限：${url}`);
  }
  await chrome.storage.local.set({ [KEY]:importedCfg });
  if (payload.persistentSecrets && typeof payload.persistentSecrets === 'object') {
    await chrome.storage.local.set({ [LOCAL_SECRETS_KEY]:payload.persistentSecrets });
  }
  if (payload.syncSettings && typeof payload.syncSettings === 'object') {
    await chrome.storage.sync.set(payload.syncSettings);
  }
  cfg = importedCfg;
  render();
  await loadProbe();
}

$('saveGlobal').addEventListener('click', async () => {
  try {
    const url = $('baseUrl').value.trim().replace(/\/+$/, '');
    const granted = await requestPermission(url);
    if (!granted) throw new Error('没有取得 DevHub 域名访问权限');
    cfg.enabled = $('devhubEnabled').checked;
    cfg.autoProjectMapping = $('autoProjectMapping').checked;
    cfg.baseUrl = url;
    cfg.submitOnOpen = $('submitOnOpen').checked;
    cfg.submitOnStateChange = $('submitOnStateChange').checked;
    cfg.minSubmitGapMs = Math.max(15000, Number($('minGap').value || 60) * 1000);
    await saveConfig();
    $('globalStatus').textContent = '已保存，并已取得 DevHub 域名访问权限。';
  } catch (e) { $('globalStatus').textContent = friendlyError(e?.message || e); }
});

$('saveRules').addEventListener('click', async () => {
  try {
    cfg.autoRules = textToRules($('autoRules').value);
    await saveConfig();
    render();
    $('rulesStatus').textContent = '自动路由规则已保存。';
  } catch (e) { $('rulesStatus').textContent = friendlyError(e?.message || e); }
});
$('restoreRules').addEventListener('click', async () => {
  cfg.autoRules = BUILTIN_RULES.map(x => ({ ...x, aliases:[...x.aliases] }));
  await saveConfig();
  render();
  $('rulesStatus').textContent = '已恢复内置 SXT / XYZL 路由规则。';
});

$('saveProbe').addEventListener('click', async () => {
  try {
    await chrome.storage.sync.set({
      streamProbeEnabled:$('streamProbeEnabled').checked,
      streamProbeFailureThreshold:Math.max(1, Math.min(8, Number($('probeFailureThreshold').value || 2))),
      streamProbeMinGapMs:Math.max(5000, Math.min(300000, Number($('probeMinGap').value || 15) * 1000)),
      streamProbeStaleStreamingEnabled:$('staleStreamingProbeEnabled').checked,
      streamProbeStaleStreamingAfterMs:Math.max(30000, Math.min(600000, Number($('staleStreamingAfter').value || 90) * 1000)),
      streamProbeStaleStreamingGapMs:Math.max(30000, Math.min(600000, Number($('staleStreamingGap').value || 60) * 1000))
    });
    $('probeStatus').textContent = '独立探针设置已保存。';
  } catch (e) { $('probeStatus').textContent = friendlyError(e?.message || e); }
});

$('savePersistence').addEventListener('click', async () => {
  try {
    await chrome.storage.sync.set({
      autoPersistenceCheckEnabled:$('autoPersistenceCheckEnabled').checked,
      autoPersistenceCheckDelayMs:Math.max(1000, Math.min(60000, Number($('persistenceDelay').value || 5) * 1000)),
      autoPersistenceCheckMinGapMs:Math.max(15000, Math.min(1800000, Number($('persistenceMinGap').value || 60) * 1000)),
      terminalPersistenceGraceMs:Math.max(5000, Math.min(300000, Number($('persistenceGrace').value || 30) * 1000))
    });
    $('persistenceStatus').textContent = '最终回复落盘核验设置已保存。';
  } catch (e) { $('persistenceStatus').textContent = friendlyError(e?.message || e); }
});

$('saveProfile').addEventListener('click', async () => {
  try {
    const id = $('profileId').value || uid();
    const mode = $('profileMode').value;
    const slotName = $('slotName').value.trim();
    const projectKey = $('projectKey').value.trim().toLowerCase();
    if (mode === 'manager_evidence' && !slotName && !projectKey) throw new Error('主管旁证模式至少需要 DevHub 项目标识或默认目标槽位');
    const base = $('profileBaseUrl').value.trim().replace(/\/+$/, '');
    const effectiveBase = (base || cfg.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, '');
    const granted = await requestPermission(effectiveBase);
    if (!granted) throw new Error('没有取得 DevHub 域名访问权限');
    const profile = {
      id,
      name:$('profileName').value.trim() || `${projectKey || 'DevHub'} 主管旁证`,
      projectKey,
      mode,
      slotName,
      sessionGeneration:$('sessionGeneration').value ? Number($('sessionGeneration').value) : null,
      baseUrl:base
    };
    const idx = cfg.profiles.findIndex(x => x.id === id);
    if (idx >= 0) cfg.profiles[idx] = profile; else cfg.profiles.push(profile);
    cfg.enabled = true;
    cfg.autoProjectMapping = true;
    await saveConfig();
    const token = $('token').value.trim();
    if (token) await chrome.runtime.sendMessage({ type:'SET_DEVHUB_SECRET', profileId:id, token, remember:$('rememberToken').checked });
    clearForm();
    render();
    $('profileStatus').textContent = '配置已保存；DevHub 联动和自动路由已启用。';
    $('globalStatus').textContent = '保存项目配置后已自动启用 DevHub 联动。';
  } catch (e) { $('profileStatus').textContent = friendlyError(e?.message || e); }
});

$('exportConfig').addEventListener('click', async () => {
  try {
    downloadJson(`chatgpt-task-vital-monitor-config-${new Date().toISOString().slice(0,10)}.json`, await buildExport(false));
    $('backupStatus').textContent = '普通配置已导出，不包含任何令牌。';
  } catch (e) { $('backupStatus').textContent = friendlyError(e?.message || e); }
});
$('exportFullConfig').addEventListener('click', async () => {
  if (!confirm('完整配置可能包含已持久保存的 DevHub 访问令牌。只应保存到你自己的安全位置。确定继续吗？')) return;
  try {
    downloadJson(`chatgpt-task-vital-monitor-full-${new Date().toISOString().slice(0,10)}.json`, await buildExport(true));
    $('backupStatus').textContent = '完整配置已导出。请把文件当作敏感凭据保存。';
  } catch (e) { $('backupStatus').textContent = friendlyError(e?.message || e); }
});
$('importConfig').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async e => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    await importPayload(payload);
    $('backupStatus').textContent = '配置导入成功。建议刷新所有 ChatGPT 页面。';
  } catch (err) {
    $('backupStatus').textContent = `配置导入失败：${err?.message || err}`;
  } finally {
    e.target.value = '';
  }
});

$('clearForm').addEventListener('click', clearForm);
Promise.all([loadConfig(), loadProbe()]).catch(e => { $('globalStatus').textContent = friendlyError(e?.message || e); });
