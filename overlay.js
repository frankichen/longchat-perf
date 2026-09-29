(() => {
  'use strict';

  const rootHost = document.createElement('div');
  rootHost.id = 'chatgpt-task-vital-monitor-host';
  rootHost.style.position = 'fixed';
  rootHost.style.right = '14px';
  rootHost.style.bottom = '14px';
  rootHost.style.zIndex = '2147483647';
  rootHost.style.pointerEvents = 'none';
  const shadow = rootHost.attachShadow({ mode:'closed' });

  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .wrap { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; pointer-events:auto; color:#f5f5f5; }
    .pill { border:1px solid rgba(255,255,255,.18); border-radius:999px; padding:7px 11px; box-shadow:0 6px 24px rgba(0,0,0,.28); cursor:pointer; display:flex; align-items:center; gap:7px; font-size:12px; line-height:1; backdrop-filter:blur(10px); background:rgba(24,24,27,.90); user-select:none; }
    .dot { width:9px; height:9px; border-radius:50%; flex:0 0 auto; }
    .green .dot { background:#22c55e; box-shadow:0 0 0 3px rgba(34,197,94,.15); }
    .blue .dot { background:#3b82f6; box-shadow:0 0 0 3px rgba(59,130,246,.15); }
    .yellow .dot { background:#eab308; box-shadow:0 0 0 3px rgba(234,179,8,.15); }
    .orange .dot { background:#f97316; box-shadow:0 0 0 3px rgba(249,115,22,.15); }
    .purple .dot { background:#a855f7; box-shadow:0 0 0 3px rgba(168,85,247,.15); }
    .red .dot { background:#ef4444; box-shadow:0 0 0 3px rgba(239,68,68,.15); }
    .black .dot { background:#71717a; box-shadow:0 0 0 3px rgba(113,113,122,.18); }
    .gray .dot { background:#a1a1aa; }
    .panel { display:none; width:380px; max-height:460px; overflow:auto; margin-top:8px; border:1px solid rgba(255,255,255,.15); border-radius:14px; background:rgba(24,24,27,.96); box-shadow:0 12px 40px rgba(0,0,0,.36); padding:13px; font-size:12px; line-height:1.45; }
    .panel.open { display:block; }
    .title { font-size:14px; font-weight:700; margin-bottom:4px; }
    .action { color:#d4d4d8; margin-bottom:10px; }
    .grid { display:grid; grid-template-columns:118px 1fr; gap:5px 8px; color:#d4d4d8; }
    .k { color:#a1a1aa; }
    .timeline { margin-top:11px; border-top:1px solid rgba(255,255,255,.1); padding-top:8px; }
    .row { display:flex; gap:7px; padding:3px 0; color:#d4d4d8; }
    .time { color:#71717a; min-width:68px; }
    .muted { color:#71717a; }
  `;
  shadow.appendChild(style);

  const wrap = document.createElement('div');
  wrap.className = 'wrap';
  wrap.innerHTML = `
    <div class="pill gray" id="pill"><span class="dot"></span><span id="label">任务状态：未知</span></div>
    <div class="panel" id="panel">
      <div class="title" id="title"></div>
      <div class="action" id="action"></div>
      <div class="grid">
        <div class="k">判断置信度</div><div id="confidence"></div>
        <div class="k">页面状态查询</div><div id="stream"></div>
        <div class="k">独立生命探针</div><div id="probe"></div>
        <div class="k">最后成功心跳</div><div id="heartbeat"></div>
        <div class="k">后端结束状态</div><div id="terminal"></div>
        <div class="k">恢复请求</div><div id="resume"></div>
        <div class="k">网络链路</div><div id="network"></div>
        <div class="k">最终回复落盘</div><div id="persisted"></div>
        <div class="k">ChatGPT 项目</div><div id="project"></div>
        <div class="k">自动路由</div><div id="autoroute"></div>
        <div class="k">DevHub</div><div id="devhub"></div>
        <div class="k">额度状态</div><div id="usageState"></div>
        <div class="k">主限额窗口</div><div id="usagePrimary"></div>
        <div class="k">次限额窗口</div><div id="usageSecondary"></div>
        <div class="k">最后错误</div><div id="error"></div>
      </div>
      <div class="timeline"><div class="muted">最近证据</div><div id="timeline"></div></div>
    </div>`;
  shadow.appendChild(wrap);

  const $ = id => shadow.getElementById(id);
  let latest = null;
  let enabled = true;

  function ensureAttached() {
    if (!enabled) return;
    if (document.documentElement) {
      if (!document.documentElement.contains(rootHost)) document.documentElement.appendChild(rootHost);
      return;
    }
    setTimeout(ensureAttached, 10);
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

  function friendlyError(value) {
    const v = String(value || '').trim();
    const lower = v.toLowerCase();
    if (!v) return '-';
    if (/^http[_ ]?\d+$/i.test(v)) return `服务器返回状态码 ${v.match(/\d+/)?.[0] || ''}`;
    if (lower.includes('429') || lower.includes('too many requests')) return '请求过多，已触发限流';
    if (lower.includes('network')) return '网络请求失败';
    if (lower.includes('timeout')) return '请求超时';
    if (lower.includes('abort')) return '请求被取消';
    if (lower.includes('resume')) return '恢复请求失败';
    return '未分类异常';
  }

  function eventName(kind) {
    return ({
      PAGE_OPEN:'页面打开', PAGE_FOCUS:'页面聚焦', ROUTE_SEEN:'路由识别', TURN_MUTATION:'新任务/会话变更',
      STREAM_STATUS:'页面状态查询', STREAM_PROBE:'独立生命探针', RESUME:'恢复请求', DETAIL_SIGNAL:'会话详情读取',
      PERSISTENCE_CHECK:'最终回复核验', BACKEND_OK:'后端请求成功', BACKEND_ERROR:'后端请求失败', DEVHUB_LIVENESS:'DevHub 存活证据'
    })[kind] || String(kind || '未知事件');
  }

  function eventText(e) {
    const parts = [eventName(e.kind)];
    if (e.status !== undefined) parts.push(`状态码 ${e.status}`);
    if (e.value) parts.push(statusText(e.value));
    if (e.finalFound === true) parts.push('已找到最终回复');
    if (e.finalFound === false) parts.push('未找到最终回复');
    if (e.error) parts.push(friendlyError(e.error));
    return parts.join(' / ');
  }

  function confidenceText(v) {
    return ({ HIGH:'高', MEDIUM:'中', LOW:'低' })[String(v || '').toUpperCase()] || (v ? '未知' : '-');
  }


  function devHubStateText(v) {
    const x = String(v || '').toUpperCase();
    return ({ ACTIVE:'活跃', ACTIVE_CORROBORATED:'有旁证活跃', NOT_REQUIRED:'当前无需心跳', SUSPECTED_DEAD:'疑似失联' })[x] || (v ? '未知状态' : '-');
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
    return parts.slice(0,2).join(' ');
  }

  function usageWindowText(win, snapshotAt = 0) {
    if (!win) return '-';
    const pct = Number.isFinite(Number(win.usedPercent)) ? `${Number(win.usedPercent)}%` : '未知';
    let remaining = null;
    if (Number.isFinite(Number(win.resetAt)) && Number(win.resetAt) > 0) remaining = Math.max(0, Math.round(Number(win.resetAt) - Date.now()/1000));
    else if (Number.isFinite(Number(win.resetAfterSeconds))) {
      const elapsed = snapshotAt ? Math.max(0, (Date.now() - Number(snapshotAt))/1000) : 0;
      remaining = Math.max(0, Math.round(Number(win.resetAfterSeconds) - elapsed));
    }
    const reset = remaining === null ? '未知' : countdownText(remaining);
    return `${durationText(win.limitWindowSeconds)} / 已用 ${pct} / ${reset} 后重置`;
  }

  function render(summary) {
    latest = summary || null;
    if (!enabled) { rootHost.style.display = 'none'; return; }
    rootHost.style.display = '';
    const s = summary || { level:'gray', label:'任务状态：未知', action:'' };
    const level = ['green','blue','yellow','orange','purple','red','black','gray'].includes(s.level) ? s.level : 'gray';
    $('pill').className = `pill ${level}`;
    $('label').textContent = s.label || '任务状态：未知';
    $('title').textContent = s.label || '状态未知';
    $('action').textContent = s.action || '';
    $('confidence').textContent = confidenceText(s.confidence);
    const passiveStatus = s.lastStreamStatusValue ? statusText(s.lastStreamStatusValue) : (s.lastStreamStatusFailureAt ? `连续失败 ${Number(s.streamStatusConsecutiveFailures || 0)} 次` : '-');
    $('stream').textContent = `${passiveStatus}${s.lastStreamStatusAt ? `（${ago(s.lastStreamStatusAt)}）` : ''}`;
    const probeStatus = s.lastStreamProbeValue ? statusText(s.lastStreamProbeValue) : (s.lastStreamProbeFailureAt ? `连续失败 ${Number(s.streamProbeConsecutiveFailures || 0)} 次` : '-');
    $('probe').textContent = `${probeStatus}${s.lastStreamProbeAt ? `（${ago(s.lastStreamProbeAt)}）` : ''}`;
    const newestHeartbeat = Math.max(Number(s.lastStreamStatusOkAt || 0), Number(s.lastStreamProbeOkAt || 0));
    $('heartbeat').textContent = ago(newestHeartbeat);
    $('terminal').textContent = s.lastBackendTerminalAt ? `${statusText(s.lastBackendTerminalValue || 'COMPLETE')} / ${ago(s.lastBackendTerminalAt)}` : '-';
    $('resume').textContent = s.lastResumeStatus ? `状态码 ${s.lastResumeStatus}（${ago(s.lastResumeAt)}）` : '-';
    if (s.lastGeneralBackendOkAt && (!s.lastGeneralBackendErrorAt || s.lastGeneralBackendOkAt >= s.lastGeneralBackendErrorAt)) $('network').textContent = `正常（${ago(s.lastGeneralBackendOkAt)}）`;
    else if (s.lastGeneralBackendErrorAt) $('network').textContent = `异常（${ago(s.lastGeneralBackendErrorAt)}）`;
    else $('network').textContent = '-';
    if (s.lastPersistenceFinalFound === true || s.lastPersistedAt) $('persisted').textContent = `已确认（${ago(s.lastPersistenceCheckAt || s.lastPersistedAt)}）`;
    else if (s.lastPersistenceFinalFound === false && s.lastPersistenceCheckAt) $('persisted').textContent = `未找到最终回复（${ago(s.lastPersistenceCheckAt)}）`;
    else $('persisted').textContent = '尚未确认';
    $('project').textContent = s.chatgptProjectName ? `${s.chatgptProjectName}${s.chatgptProjectId ? ` / ${String(s.chatgptProjectId).slice(0,18)}…` : ''}` : (s.conversationTitle ? `会话：${s.conversationTitle}` : '-');
    if (s.autoDevHubProject && s.autoDevHubSlot) {
      const readiness = s.autoProfileReady ? ' ✓' : (s.autoProfileConfigured ? ' / 缺少令牌' : ' / 缺少配置');
      $('autoroute').textContent = `${s.autoDevHubProject} / ${s.autoDevHubSlot}${readiness}`;
    } else if (s.devhubBindingSource === 'manual') $('autoroute').textContent = '手工绑定';
    else $('autoroute').textContent = '-';
    $('devhub').textContent = s.devhubState ? `${devHubStateText(s.devhubState)}${s.devhubConfidence ? ` / 置信度${confidenceText(s.devhubConfidence)}` : ''}${s.devhubActiveTaskId ? ` / 任务 #${s.devhubActiveTaskId}` : ''}（${ago(s.lastDevHubAt)}）` : '-';
    const usage = s.usageStatus?.snapshot || null;
    const plan = usage ? planText(usage.planType) : '';
    $('usageState').textContent = usage
      ? (usage.spendControlReached
        ? `已触发消费控制${plan ? ` / ${plan}` : ''}`
        : ((usage.limitReached || usage.allowed === false) ? `已触发限流${plan ? ` / ${plan}` : ''}` : `允许使用${plan ? ` / ${plan}` : ''}`))
      : '尚未捕获';
    const snapAt = s.usageStatus?.lastSnapshotAt || usage?.observedAt || usage?.generatedAtMs || 0;
    $('usagePrimary').textContent = usageWindowText(usage?.primaryWindow, snapAt);
    $('usageSecondary').textContent = usageWindowText(usage?.secondaryWindow, snapAt);
    $('error').textContent = friendlyError(s.lastError);
    const events = Array.isArray(s.timeline) ? s.timeline.slice(-8).reverse() : [];
    $('timeline').innerHTML = '';
    for (const e of events) {
      const row = document.createElement('div');
      row.className = 'row';
      const t = document.createElement('span');
      t.className = 'time';
      t.textContent = ago(e.at);
      const text = document.createElement('span');
      text.textContent = eventText(e);
      row.append(t, text);
      $('timeline').appendChild(row);
    }
  }

  async function refresh() {
    try {
      const result = await chrome.runtime.sendMessage({ type:'GET_TAB_HEALTH' });
      if (result?.summary) render(result.summary);
    } catch {}
  }

  $('pill').addEventListener('click', () => $('panel').classList.toggle('open'));
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === 'HEALTH_UPDATE' && message.summary) render(message.summary);
    if (message?.type === 'USAGE_UPDATE') {
      latest = { ...(latest || {}), usageStatus: message.usage || null };
      render(latest);
    }
  });
  chrome.storage.sync.get({ overlayEnabled:true }).then(v => { enabled = Boolean(v.overlayEnabled); ensureAttached(); refresh(); }).catch(ensureAttached);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.overlayEnabled) {
      enabled = Boolean(changes.overlayEnabled.newValue);
      ensureAttached();
      render(latest);
    }
  });
  setInterval(refresh, 3000);
  setInterval(() => latest && render(latest), 1000);
})();
