const DEFAULTS = { enabled:true, overlayEnabled:true, cv:true, noblur:true, collapse:true, stream:true, cmMount:true, keepMessages:60 };
const DEVHUB_CONFIG_KEY = 'devhubConfigV4';
const DEFAULT_DEVHUB = { enabled:false, baseUrl:'https://devhub.sgk.555044.xyz', profiles:[], bindings:{}, autoProjectMapping:true, autoRules:[] };
const STAT_KEYS = [
  'actualRequests','savedRequests','server429','streamStatusSuccess','streamStatusFailures','streamStatusAborts',
  'streamProbeSuccess','streamProbeFailures','streamProbeComplete','persistenceChecks','persistenceFinalFound','persistenceFinalMissing',
  'devhubSubmits','devhubLivenessReads','usageSnapshots','usageHeartbeats'
];
const $ = id => document.getElementById(id);
let activeTab = null;
let currentConversationId = '';
let healthSummary = null;


function sendToActivePage(msg) {
  return new Promise(resolve => {
    chrome.tabs.query({ active:true, currentWindow:true }, tabs => {
      const tab = tabs && tabs[0];
      if (!tab?.id) return resolve(null);
      chrome.tabs.sendMessage(tab.id, msg, res => {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(res || null);
      });
    });
  });
}

const fmtMs = ms => ms == null ? '—' : (ms >= 1000 ? `${(ms/1000).toFixed(1)} 秒` : `${Math.round(ms)} 毫秒`);

function renderCmStatus(cm) {
  const el = $('cmStatus');
  el.classList.remove('warn');
  if (!cm?.present) { el.textContent = '代码块批量挂载：未检测到补丁，请刷新 ChatGPT 页面。'; return; }
  if (cm.external) { el.textContent = '代码块批量挂载：检测到其他同类补丁，当前补丁已自动让位。'; return; }
  if (cm.stale) { el.textContent = '⚠ 代码块补丁疑似失效：ChatGPT 页面结构可能已变化。'; el.classList.add('warn'); return; }
  const s = cm.stats;
  if (s?.intercepted > 0) el.textContent = `代码块批量挂载：拦截 ${s.intercepted} · 挂载 ${s.mounted} · ${s.batches} 批 · 上批 ${s.lastBatchSize} 个 / ${fmtMs(s.lastBatchInsertTimeMs)}`;
  else el.textContent = '代码块批量挂载：待命，打开或切换长会话时生效。';
}

function renderLongTaskStatus(cm) {
  const el = $('ltStatus');
  const s = cm?.stats;
  if (!s?.ltSupported) { el.textContent = ''; return; }
  el.textContent = `主线程长任务：累计 ${fmtMs(s.ltTotalMs)} · 最长 ${fmtMs(s.ltWorstMs)} · 本批后 ${fmtMs(s.lastBatchBusyMs)}`;
}

async function refreshPerformanceStatus() {
  const res = await sendToActivePage({ type:'lcp-status' });
  if (!res) {
    $('perfStatus').textContent = '未检测到 ChatGPT 会话页。';
    $('cmStatus').textContent = '';
    $('ltStatus').textContent = '';
    return;
  }
  $('perfStatus').textContent = `消息 ${res.messages} · 已折叠 ${res.folded} · ${res.streaming ? '正在流式输出' : '页面空闲'}`;
  renderCmStatus(res.cm);
  renderLongTaskStatus(res.cm);
}

function setPerformanceEnabledState(on) {
  for (const id of ['cv','noblur','collapse','stream','cmMount']) $(id).disabled = !on;
  $('keep').disabled = !on;
  $('foldNow').disabled = !on;
  $('expandAll').disabled = !on;
}

async function savePerformanceSettings() {
  const keep = Math.max(10, Math.min(500, parseInt($('keep').value,10) || 60));
  await chrome.storage.sync.set({
    cv:$('cv').checked,
    noblur:$('noblur').checked,
    collapse:$('collapse').checked,
    stream:$('stream').checked,
    cmMount:$('cmMount').checked,
    keepMessages:keep
  });
  $('keep').value = String(keep);
  setTimeout(() => refreshPerformanceStatus().catch(()=>{}), 300);
}

function ago(ts) {
  if (!ts) return '-';
  const s = Math.max(0, Math.round((Date.now() - Number(ts)) / 1000));
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  return `${Math.floor(m / 60)} 小时前`;
}

function statusText(value) {
  const v = String(value || '').trim().toUpperCase();
  if (!v) return '-';
  if (v === 'IS_STREAMING' || v === 'STREAMING') return '正在运行';
  if (v.includes('COMPLETE') || v.includes('FINISHED') || v.includes('DONE') || v.includes('NOT_STREAMING')) return '已结束';
  return '未知状态';
}

function friendlyReason(value) {
  const v = String(value || '').trim();
  const lower = v.toLowerCase();
  const map = {
    no_conversation:'未识别到当前会话', probe_busy:'独立探针正在协调中',
    disabled_or_missing:'功能未启用或缺少会话信息', 'rate-limited':'当前处于限流退避期',
    'already-checked-after-terminal':'结束状态之后已经核验过最终回复',
    'in-flight':'已有同类核验正在进行', 'minimum-gap':'距离上一次核验时间太短',
    'passive-heartbeat-not-degraded':'页面状态查询仍可用，无需额外探针',
    disabled:'DevHub 全局联动未启用', auto_profile_missing:'已识别项目和槽位，但缺少对应主管配置',
    token_missing:'已找到配置，但缺少访问令牌', permission_missing:'缺少 DevHub 域名访问权限，请到配置页重新保存配置',
    slot_missing:'未识别目标槽位', unbound:'当前会话未命中自动路由，也没有手工绑定',
    manager_token_required:'读取 DevHub 存活状态需要主管旁证配置', throttled:'同步间隔尚未到'
  };
  if (map[lower]) return map[lower];
  if (/^http[_ ]?\d+$/i.test(v)) return `服务器返回状态码 ${v.match(/\d+/)?.[0] || ''}`;
  if (lower.includes('network')) return '网络请求失败';
  if (lower.includes('timeout')) return '请求超时';
  if (lower.includes('permission')) return '浏览器权限不足';
  return v ? '发生未分类异常' : '未知原因';
}

function displayProfileName(p) {
  const raw = String(p?.name || p?.slotName || p?.id || '未命名配置');
  const m = raw.match(/^(.+?)\s+Manager\s+evidence$/i);
  if (m) return `${m[1]} 主管旁证`;
  return raw.replace(/Manager/ig, '主管').replace(/evidence/ig, '旁证');
}

function confidenceText(v) {
  const x = String(v || '').toUpperCase();
  return ({ HIGH:'高', MEDIUM:'中', LOW:'低' })[x] || (v ? '未知' : '-');
}

function devHubStateText(v) {
  const x = String(v || '').toUpperCase();
  return ({ ACTIVE:'活跃', ACTIVE_CORROBORATED:'有旁证活跃', NOT_REQUIRED:'当前无需心跳', SUSPECTED_DEAD:'疑似失联' })[x] || (v ? '未知状态' : '-');
}

function modeText(mode) {
  return mode === 'manager_evidence' ? '主管旁证模式' : (mode === 'heartbeat' ? '槽位心跳模式' : '未知模式');
}


function planText(value) {
  const v = String(value || '').toLowerCase();
  return ({ team:'团队版', plus:'Plus 版', pro:'Pro 版', free:'免费版', go:'Go 版', enterprise:'企业版', edu:'教育版', business:'商业版' })[v] || (value ? '未知套餐' : '');
}

function durationText(seconds) {
  const s = Math.max(0, Number(seconds || 0));
  if (!s) return '未知窗口';
  if (s % 604800 === 0) return `${Math.round(s/604800)} 周`;
  if (s % 86400 === 0) return `${Math.round(s/86400)} 天`;
  if (s % 3600 === 0) return `${Math.round(s/3600)} 小时`;
  if (s % 60 === 0) return `${Math.round(s/60)} 分钟`;
  return `${Math.round(s)} 秒`;
}

function countdownText(seconds) {
  let s = Math.max(0, Math.round(Number(seconds || 0)));
  if (!s) return '即将重置';
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60);
  const parts = [];
  if (d) parts.push(`${d} 天`);
  if (h) parts.push(`${h} 小时`);
  if (m || !parts.length) parts.push(`${m} 分钟`);
  return parts.slice(0, 2).join(' ');
}

function usageWindowText(windowInfo, snapshotAt = 0) {
  if (!windowInfo) return '-';
  const pct = Number.isFinite(Number(windowInfo.usedPercent)) ? `${Number(windowInfo.usedPercent)}%` : '未知';
  const duration = durationText(windowInfo.limitWindowSeconds);
  let remaining = null;
  if (Number.isFinite(Number(windowInfo.resetAt)) && Number(windowInfo.resetAt) > 0) {
    remaining = Math.max(0, Math.round(Number(windowInfo.resetAt) - Date.now()/1000));
  } else if (Number.isFinite(Number(windowInfo.resetAfterSeconds))) {
    const elapsed = snapshotAt ? Math.max(0, (Date.now() - Number(snapshotAt))/1000) : 0;
    remaining = Math.max(0, Math.round(Number(windowInfo.resetAfterSeconds) - elapsed));
  }
  const reset = remaining === null ? '未知' : countdownText(remaining);
  return `${duration} / 已用 ${pct} / ${reset} 后重置`;
}

function renderUsage(usageStatus) {
  const usage = usageStatus?.snapshot || null;
  if (!usage) {
    $('usageAllowed').textContent = '尚未捕获额度快照';
    $('usagePrimary').textContent = '-';
    $('usageSecondary').textContent = '-';
    $('usageCredits').textContent = '-';
    $('usageModels').textContent = '-';
    $('usageUpdated').textContent = usageStatus?.lastHeartbeatAt ? `只有额度心跳 / ${ago(usageStatus.lastHeartbeatAt)}` : '-';
    return;
  }
  const plan = planText(usage.planType);
  $('usageAllowed').textContent = usage.spendControlReached
    ? `已触发消费控制${plan ? ` / ${plan}` : ''}`
    : (usage.limitReached || usage.allowed === false
      ? `已触发限流${plan ? ` / ${plan}` : ''}`
      : `允许使用${plan ? ` / ${plan}` : ''}`);
  const snapAt = usageStatus.lastSnapshotAt || usage.observedAt || usage.generatedAtMs || 0;
  $('usagePrimary').textContent = usageWindowText(usage.primaryWindow, snapAt);
  $('usageSecondary').textContent = usageWindowText(usage.secondaryWindow, snapAt);
  if (Number.isFinite(Number(usage.resetCreditsAvailable))) {
    const applicable = Number.isFinite(Number(usage.resetCreditsApplicable)) ? `（当前可用 ${Number(usage.resetCreditsApplicable)}）` : '';
    $('usageCredits').textContent = `${Number(usage.resetCreditsAvailable)} 次${applicable}`;
  } else {
    $('usageCredits').textContent = '-';
  }
  const modelEntries = Object.entries(usage.models || {});
  $('usageModels').textContent = modelEntries.length
    ? modelEntries.map(([name, v]) => `${name}：${v?.available ? '可用' : '不可用'}`).join('；')
    : '-';
  $('usageUpdated').textContent = ago(usageStatus.lastSnapshotAt || usage.observedAt || usage.generatedAtMs);
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active:true, currentWindow:true });
  return tabs[0] || null;
}

function renderHealth(summary) {
  healthSummary = summary || {};
  const level = ['green','blue','yellow','orange','purple','red','black','gray'].includes(summary?.level) ? summary.level : 'gray';
  $('healthCard').className = `card health ${level}`;
  $('healthLabel').textContent = summary?.label || '无法确认';
  $('healthAction').textContent = summary?.action || '';
  $('confidenceValue').textContent = confidenceText(summary?.confidence);
  $('streamValue').textContent = summary?.lastStreamStatusValue
    ? statusText(summary.lastStreamStatusValue)
    : ((summary?.streamStatusConsecutiveFailures || 0) > 0 ? `连续失败 ${summary.streamStatusConsecutiveFailures} 次` : '-');
  $('probeValue').textContent = summary?.lastStreamProbeValue
    ? `${statusText(summary.lastStreamProbeValue)} / ${ago(summary.lastStreamProbeOkAt)}`
    : ((summary?.streamProbeConsecutiveFailures || 0) > 0 ? `连续失败 ${summary.streamProbeConsecutiveFailures} 次` : '-');
  $('chainStateValue').textContent = summary?.lastConversationTurnOpen === true
    ? '当前任务链未闭合'
    : (summary?.lastConversationTurnClosed === true
      ? (summary?.lastPersistenceFinalFound === true ? '任务链已闭合，最终回复已确认' : '任务链已闭合，最终回复未确认')
      : (summary?.lastConversationCheckAt ? '已读取，但任务链闭合状态不明确' : '尚未读取'));
  $('chainNodeValue').textContent = summary?.lastConversationCurrentNodeRole || '-';
  $('workingTurnValue').textContent = summary?.lastConversationWorkingTurnId
    ? String(summary.lastConversationWorkingTurnId).slice(0, 18) + (String(summary.lastConversationWorkingTurnId).length > 18 ? '…' : '')
    : '-';
  $('asyncStatusValue').textContent = summary?.lastConversationAsyncStatus === null || summary?.lastConversationAsyncStatus === undefined
    ? '-'
    : `${summary.lastConversationAsyncStatus}（仅记录原值）`;
  $('heartbeatAge').textContent = ago(Math.max(Number(summary?.lastStreamStatusOkAt || 0), Number(summary?.lastStreamProbeOkAt || 0)));
  $('terminalValue').textContent = summary?.lastBackendTerminalAt
    ? `${statusText(summary.lastBackendTerminalValue || 'COMPLETE')} / ${ago(summary.lastBackendTerminalAt)}`
    : '-';
  $('resumeValue').textContent = summary?.lastResumeStatus ? `状态码 ${summary.lastResumeStatus} / ${ago(summary.lastResumeAt)}` : '-';
  if (summary?.lastGeneralBackendOkAt && (!summary?.lastGeneralBackendErrorAt || summary.lastGeneralBackendOkAt >= summary.lastGeneralBackendErrorAt)) {
    $('networkValue').textContent = `正常 / ${ago(summary.lastGeneralBackendOkAt)}`;
  } else if (summary?.lastGeneralBackendErrorAt) {
    $('networkValue').textContent = `异常 / ${ago(summary.lastGeneralBackendErrorAt)}`;
  } else {
    $('networkValue').textContent = '-';
  }
  if (summary?.lastPersistenceFinalFound === true || summary?.lastPersistedAt) {
    $('persistedValue').textContent = `已确认 / ${ago(summary.lastPersistenceCheckAt || summary.lastPersistedAt)}`;
  } else if (summary?.lastPersistenceFinalFound === false && summary?.lastPersistenceCheckAt) {
    $('persistedValue').textContent = `未找到最终回复 / ${ago(summary.lastPersistenceCheckAt)}`;
  } else {
    $('persistedValue').textContent = '尚未确认';
  }
  $('chatgptProjectValue').textContent = summary?.chatgptProjectName || summary?.conversationTitle || '-';
  if (summary?.autoDevHubProject && summary?.autoDevHubSlot) {
    const readiness = summary.autoProfileReady ? ' ✓' : (summary.autoProfileConfigured ? ' / 缺少令牌' : ' / 缺少配置');
    $('autoRouteValue').textContent = `${summary.autoDevHubProject} / ${summary.autoDevHubSlot}${readiness}`;
  } else if (summary?.devhubBindingSource === 'manual') {
    $('autoRouteValue').textContent = '手工绑定';
  } else {
    $('autoRouteValue').textContent = '-';
  }
  $('devhubLivenessValue').textContent = summary?.devhubState
    ? `${devHubStateText(summary.devhubState)}${summary.devhubConfidence ? ' / 置信度'+confidenceText(summary.devhubConfidence) : ''}${summary.devhubActiveTaskId ? ' / 任务 #'+summary.devhubActiveTaskId : ''} / ${ago(summary.lastDevHubAt)}`
    : '-';
  renderUsage(summary?.usageStatus || null);
}

async function refreshHealth() {
  activeTab = activeTab || await getActiveTab();
  if (!activeTab?.id) return;
  const result = await chrome.runtime.sendMessage({ type:'GET_TAB_HEALTH', tabId:activeTab.id });
  currentConversationId = result?.conversationId || '';
  $('conversationId').textContent = currentConversationId || '当前页面未识别到会话标识';
  renderHealth(result?.summary || {});
}

async function refreshProfiles() {
  const stored = await chrome.storage.local.get(DEVHUB_CONFIG_KEY);
  const cfg = { ...DEFAULT_DEVHUB, ...(stored[DEVHUB_CONFIG_KEY] || {}) };
  cfg.profiles = Array.isArray(cfg.profiles) ? cfg.profiles : [];
  cfg.bindings = { ...(cfg.bindings || {}) };
  const select = $('profileSelect');
  select.innerHTML = '<option value="">未绑定 DevHub</option>';
  for (const p of cfg.profiles) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = `${displayProfileName(p)}【${modeText(p.mode)}】`;
    select.appendChild(o);
  }
  if (currentConversationId && cfg.bindings[currentConversationId]) select.value = cfg.bindings[currentConversationId];
  else if (healthSummary?.autoProfileId) select.value = healthSummary.autoProfileId;

  if (!cfg.enabled) {
    $('devhubStatus').textContent = 'DevHub 联动未启用；在配置页保存任一主管配置即可自动启用。';
  } else if (healthSummary?.devhubBindingSource === 'auto' && healthSummary?.autoDevHubProject && healthSummary?.autoDevHubSlot) {
    const issue = healthSummary.autoProfileReady ? '' : (healthSummary.autoProfileConfigured ? '；主管令牌尚未配置' : '；缺少对应主管配置');
    $('devhubStatus').textContent = `自动识别：${healthSummary.autoDevHubProject} / ${healthSummary.autoDevHubSlot}${issue}`;
  } else if (currentConversationId && cfg.bindings[currentConversationId]) {
    $('devhubStatus').textContent = '当前会话使用手工 DevHub 绑定。';
  } else {
    $('devhubStatus').textContent = 'DevHub 已启用，但当前项目/标题尚未命中自动规则。';
  }
  return cfg;
}

async function refreshStats() {
  const stats = await chrome.storage.local.get(STAT_KEYS);
  for (const key of STAT_KEYS) $(key).textContent = Number(stats[key] || 0).toLocaleString('zh-CN');
}

async function refreshRuntime() {
  const r = await chrome.runtime.sendMessage({ type:'GET_STATUS' });
  $('runtime').textContent = `缓存 ${r.cacheEntries || 0} 项；真实读取闸门：${r.waitMs > 0 ? `等待 ${Math.ceil(r.waitMs/1000)} 秒` : '已开放'}`;
}

async function load() {
  const settings = await chrome.storage.sync.get(DEFAULTS);
  $('enabled').checked = Boolean(settings.enabled);
  $('overlayEnabled').checked = Boolean(settings.overlayEnabled);
  $('cv').checked = Boolean(settings.cv);
  $('noblur').checked = Boolean(settings.noblur);
  $('collapse').checked = Boolean(settings.collapse);
  $('stream').checked = Boolean(settings.stream);
  $('cmMount').checked = Boolean(settings.cmMount);
  $('keep').value = String(Number(settings.keepMessages || 60));
  setPerformanceEnabledState(Boolean(settings.enabled));
  activeTab = await getActiveTab();
  await refreshHealth();
  await refreshProfiles();
  await refreshStats();
  await refreshRuntime();
  await refreshPerformanceStatus();
}

$('enabled').addEventListener('change', async e => { await chrome.storage.sync.set({ enabled:e.target.checked }); setPerformanceEnabledState(e.target.checked); });
$('overlayEnabled').addEventListener('change', e => chrome.storage.sync.set({ overlayEnabled:e.target.checked }));


for (const id of ['cv','noblur','collapse','stream','cmMount']) $(id).addEventListener('change', () => savePerformanceSettings().catch(()=>{}));
$('keep').addEventListener('change', () => savePerformanceSettings().catch(()=>{}));
$('foldNow').addEventListener('click', async () => { await sendToActivePage({ type:'lcp-fold-now' }); setTimeout(() => refreshPerformanceStatus().catch(()=>{}), 300); });
$('expandAll').addEventListener('click', async () => { await sendToActivePage({ type:'lcp-expand-all' }); setTimeout(() => refreshPerformanceStatus().catch(()=>{}), 300); });

$('diagnose').addEventListener('click', async () => {
  if (!activeTab?.id) return;
  $('status').textContent = '正在读取状态服务；如果它返回结束，再读取一次会话链，核对 current_node、working turn、end_turn 和最终回复…';
  try {
    const result = await chrome.tabs.sendMessage(activeTab.id, { type:'RUN_MANUAL_DIAGNOSE' });
    const value = result?.streamValue || result?.probe?.value || '';
    const count = Number(result?.requestCount || 0);
    if (result?.ok && result?.finalFound) {
      $('status').textContent = `会话链已确认最终助手回复真正落盘。本次 ${count || 2} 个有界请求；可以刷新，不要重复执行。`;
    } else if (result?.ok && result?.turnOpen) {
      const node = result?.currentNodeRole || '未知节点';
      $('status').textContent = `状态服务可能返回“${statusText(value || 'UNKNOWN')}”，但会话链仍未闭合（当前节点：${node}）。因此不能判定完成，继续观察真实进展。`;
    } else if (result?.ok && result?.backendTerminal) {
      $('status').textContent = `状态服务返回：${statusText(value || 'COMPLETE')}，但会话链尚未给出足够强的最终完成证据。状态服务只作辅助，不要直接重跑整个任务。`;
    } else if (result?.ok) {
      $('status').textContent = `状态服务探针：${statusText(value || 'UNKNOWN')}；这里只是辅助状态信号。本次用了 ${count || 1} 个请求。`;
    } else if (result?.skipped) {
      $('status').textContent = `本次没有额外发请求：${result?.error || '探针正在协调/退避中'}。`;
    } else {
      $('status').textContent = `状态服务探针失败：状态码 ${result?.status ?? 0}${result?.error ? ' / '+friendlyReason(result.error) : ''}。更像网络链路或服务暂时不可达。`;
    }
    setTimeout(refreshHealth, 500);
  } catch (e) {
    $('status').textContent = `诊断失败：${friendlyReason(e?.message || e)}`;
  }
});

$('bindProfile').addEventListener('click', async () => {
  if (!currentConversationId) { $('status').textContent = '当前页面没有识别到会话标识。'; return; }
  const stored = await chrome.storage.local.get(DEVHUB_CONFIG_KEY);
  const cfg = { ...DEFAULT_DEVHUB, ...(stored[DEVHUB_CONFIG_KEY] || {}) };
  cfg.bindings = { ...(cfg.bindings || {}) };
  const id = $('profileSelect').value;
  if (id) cfg.bindings[currentConversationId] = id;
  else delete cfg.bindings[currentConversationId];
  await chrome.storage.local.set({ [DEVHUB_CONFIG_KEY]:cfg });
  $('status').textContent = id ? '已绑定当前会话。自动规则仍会优先提供正确的目标槽位。' : '已取消当前会话的手工绑定。';
  await refreshProfiles();
});

$('submitDevHub').addEventListener('click', async () => {
  if (!activeTab?.id) return;
  $('devhubStatus').textContent = '正在同步 DevHub…';
  const r = await chrome.runtime.sendMessage({ type:'DEVHUB_SEND_NOW', tabId:activeTab.id });
  const live = r?.liveness?.item;
  const reason = r?.error || r?.submit?.error || r?.submit?.skipped || r?.liveness?.error || r?.liveness?.skipped || '未知失败';
  const reasonText = {
    disabled:'DevHub 全局联动未启用',
    auto_profile_missing:'已识别项目/槽位，但缺少对应主管配置',
    token_missing:'已找到配置，但缺少访问令牌',
    permission_missing:'缺少 DevHub 域名访问权限，请到配置页重新保存配置',
    slot_missing:'未识别目标槽位',
    unbound:'当前会话未命中自动路由，也没有手工绑定',
    manager_token_required:'读取 DevHub 存活状态需要主管旁证配置',
    throttled:'同步间隔尚未到'
  }[reason] || friendlyReason(reason);
  $('devhubStatus').textContent = r?.ok
    ? `DevHub 同步成功${live ? ` / ${devHubStateText(live.state)} / 置信度${confidenceText(live.confidence)}` : ''}`
    : `DevHub 同步失败：${reasonText}`;
  refreshStats();
  setTimeout(refreshHealth, 300);
});

$('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('forceRefresh').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type:'CLEAR_SHARED_CACHE', forceNext:true });
  $('status').textContent = '已清缓存，下一次真实会话读取将被放行。';
  refreshRuntime();
});
$('resetStats').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type:'RESET_STATS' });
  refreshStats();
  $('status').textContent = '统计已清零，DevHub 配置不会被删除。';
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' || area === 'session') refreshStats().catch(() => {});
});

load().catch(e => { $('status').textContent = `加载失败：${friendlyReason(e?.message || e)}`; });
setInterval(() => { refreshHealth().catch(() => {}); refreshRuntime().catch(() => {}); refreshPerformanceStatus().catch(() => {}); }, 2000);
