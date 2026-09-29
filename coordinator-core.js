export const BACKOFF_STEPS_MS = Object.freeze([
  10 * 60_000,
  30 * 60_000,
  60 * 60_000,
  120 * 60_000
]);

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  overlayEnabled: true,
  listFirstPageTtlMs: 30 * 60_000,
  listOtherPageTtlMs: 4 * 60 * 60_000,
  detailStableTtlMs: 24 * 60 * 60_000,
  detailUncertainTtlMs: 60_000,
  globalMinGapMs: 30_000,
  staleMaxMs: 7 * 24 * 60 * 60_000,
  serveStaleDuringCooldown: true,
  staleIf429: true,
  local429DuringBackoff: true,
  cacheMaxEntries: 24,
  cacheMaxApproxBytes: 7_000_000,
  healthAliveFreshMs: 30_000,
  healthDegradedMs: 120_000,
  healthSuspectedDeadMs: 180_000,
  healthNetworkWindowMs: 45_000,
  streamProbeEnabled: true,
  streamProbeFailureThreshold: 2,
  streamProbeMinGapMs: 15_000,
  streamProbeStaleStreamingEnabled: true,
  streamProbeStaleStreamingAfterMs: 90_000,
  streamProbeStaleStreamingGapMs: 60_000,
  streamProbeFailureBackoffMs: 10_000,
  streamProbeMaxBackoffMs: 30_000,
  streamProbeTerminalHoldMs: 5 * 60_000,
  terminalPersistenceGraceMs: 30_000,
  autoPersistenceCheckEnabled: true,
  autoPersistenceCheckDelayMs: 5_000,
  autoPersistenceCheckMinGapMs: 60_000,
  timelineMax: 50,
  cacheBustNonce: 0
});

export const EMPTY_STATS = Object.freeze({
  actualRequests: 0,
  listActualRequests: 0,
  detailActualRequests: 0,
  successfulRequests: 0,
  savedRequests: 0,
  listCacheHits: 0,
  detailCacheHits: 0,
  staleCooldownHits: 0,
  crossTabWaits: 0,
  globalGapBlocks: 0,
  server429: 0,
  local429Blocks: 0,
  stale429Served: 0,
  otherHttpErrors: 0,
  networkErrors: 0,
  invalidations: 0,
  staleGenerationDrops: 0,
  cachePrunes: 0,
  cacheClears: 0,
  manualRefreshes: 0,
  streamStatusSuccess: 0,
  streamStatusFailures: 0,
  streamStatusAborts: 0,
  streamProbeRequests: 0,
  streamProbeGrants: 0,
  streamProbeSuppressions: 0,
  streamProbeSuccess: 0,
  streamProbeFailures: 0,
  streamProbeComplete: 0,
  persistenceChecks: 0,
  persistenceFinalFound: 0,
  persistenceFinalMissing: 0,
  persistenceCheckFailures: 0,
  resumeFailures: 0,
  healthTransitions: 0,
  devhubSubmits: 0,
  devhubSubmitFailures: 0,
  devhubLivenessReads: 0,
  devhubLivenessFailures: 0,
  usageSnapshots: 0,
  usageHeartbeats: 0
});

export function normalizeSettings(raw = {}) {
  const out = { ...DEFAULT_SETTINGS, ...raw };
  const clamp = (v, min, max, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };

  out.listFirstPageTtlMs = clamp(out.listFirstPageTtlMs, 60_000, 24 * 60 * 60_000, DEFAULT_SETTINGS.listFirstPageTtlMs);
  out.listOtherPageTtlMs = clamp(out.listOtherPageTtlMs, out.listFirstPageTtlMs, 7 * 24 * 60 * 60_000, DEFAULT_SETTINGS.listOtherPageTtlMs);
  out.detailStableTtlMs = clamp(out.detailStableTtlMs, 5 * 60_000, 7 * 24 * 60 * 60_000, DEFAULT_SETTINGS.detailStableTtlMs);
  out.detailUncertainTtlMs = clamp(out.detailUncertainTtlMs, 5_000, 30 * 60_000, DEFAULT_SETTINGS.detailUncertainTtlMs);
  out.globalMinGapMs = clamp(out.globalMinGapMs, 5_000, 30 * 60_000, DEFAULT_SETTINGS.globalMinGapMs);
  out.staleMaxMs = clamp(out.staleMaxMs, Math.max(out.listOtherPageTtlMs, out.detailStableTtlMs), 30 * 24 * 60 * 60_000, DEFAULT_SETTINGS.staleMaxMs);
  out.cacheMaxEntries = clamp(out.cacheMaxEntries, 4, 64, DEFAULT_SETTINGS.cacheMaxEntries);
  out.cacheMaxApproxBytes = clamp(out.cacheMaxApproxBytes, 1_000_000, 8_000_000, DEFAULT_SETTINGS.cacheMaxApproxBytes);
  out.healthAliveFreshMs = clamp(out.healthAliveFreshMs, 5_000, 120_000, DEFAULT_SETTINGS.healthAliveFreshMs);
  out.healthDegradedMs = clamp(out.healthDegradedMs, out.healthAliveFreshMs, 10 * 60_000, DEFAULT_SETTINGS.healthDegradedMs);
  out.healthSuspectedDeadMs = clamp(out.healthSuspectedDeadMs, out.healthDegradedMs, 30 * 60_000, DEFAULT_SETTINGS.healthSuspectedDeadMs);
  out.healthNetworkWindowMs = clamp(out.healthNetworkWindowMs, 10_000, 5 * 60_000, DEFAULT_SETTINGS.healthNetworkWindowMs);
  out.streamProbeFailureThreshold = clamp(out.streamProbeFailureThreshold, 1, 8, DEFAULT_SETTINGS.streamProbeFailureThreshold);
  out.streamProbeMinGapMs = clamp(out.streamProbeMinGapMs, 5_000, 5 * 60_000, DEFAULT_SETTINGS.streamProbeMinGapMs);
  out.streamProbeStaleStreamingEnabled = Boolean(out.streamProbeStaleStreamingEnabled);
  out.streamProbeStaleStreamingAfterMs = clamp(out.streamProbeStaleStreamingAfterMs, 30_000, 10 * 60_000, DEFAULT_SETTINGS.streamProbeStaleStreamingAfterMs);
  out.streamProbeStaleStreamingGapMs = clamp(out.streamProbeStaleStreamingGapMs, 30_000, 10 * 60_000, DEFAULT_SETTINGS.streamProbeStaleStreamingGapMs);
  out.streamProbeFailureBackoffMs = clamp(out.streamProbeFailureBackoffMs, 5_000, 5 * 60_000, DEFAULT_SETTINGS.streamProbeFailureBackoffMs);
  out.streamProbeMaxBackoffMs = clamp(out.streamProbeMaxBackoffMs, out.streamProbeFailureBackoffMs, 10 * 60_000, DEFAULT_SETTINGS.streamProbeMaxBackoffMs);
  out.streamProbeTerminalHoldMs = clamp(out.streamProbeTerminalHoldMs, 30_000, 24 * 60 * 60_000, DEFAULT_SETTINGS.streamProbeTerminalHoldMs);
  out.terminalPersistenceGraceMs = clamp(out.terminalPersistenceGraceMs, 5_000, 5 * 60_000, DEFAULT_SETTINGS.terminalPersistenceGraceMs);
  out.autoPersistenceCheckDelayMs = clamp(out.autoPersistenceCheckDelayMs, 1_000, 60_000, DEFAULT_SETTINGS.autoPersistenceCheckDelayMs);
  out.autoPersistenceCheckMinGapMs = clamp(out.autoPersistenceCheckMinGapMs, 15_000, 30 * 60_000, DEFAULT_SETTINGS.autoPersistenceCheckMinGapMs);
  out.autoPersistenceCheckEnabled = Boolean(out.autoPersistenceCheckEnabled);
  out.timelineMax = clamp(out.timelineMax, 10, 100, DEFAULT_SETTINGS.timelineMax);
  out.enabled = Boolean(out.enabled);
  out.overlayEnabled = Boolean(out.overlayEnabled);
  out.serveStaleDuringCooldown = Boolean(out.serveStaleDuringCooldown);
  out.staleIf429 = Boolean(out.staleIf429);
  out.local429DuringBackoff = Boolean(out.local429DuringBackoff);
  out.streamProbeEnabled = Boolean(out.streamProbeEnabled);
  out.cacheBustNonce = Number(out.cacheBustNonce) || 0;
  return out;
}

export function classifyConversationUrl(urlString) {
  try {
    const url = new URL(urlString);
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
    if (path === '/backend-api/conversations') {
      return { kind: 'list', conversationId: null };
    }
    const match = path.match(/^\/backend-api\/conversations\/([^/]+)$/);
    if (match) {
      return { kind: 'detail', conversationId: decodeURIComponent(match[1]) };
    }
  } catch {}
  return { kind: 'other', conversationId: null };
}

export function ttlMsForEntry(entry, url, settings) {
  if (entry?.cacheClass === 'detail-stable') return settings.detailStableTtlMs;
  if (entry?.cacheClass === 'detail-uncertain') return settings.detailUncertainTtlMs;

  const classified = classifyConversationUrl(url);
  if (classified.kind === 'detail') return settings.detailUncertainTtlMs;
  if (classified.kind === 'list') {
    try {
      const u = new URL(url);
      const offset = Number(u.searchParams.get('offset') || 0);
      return offset > 0 ? settings.listOtherPageTtlMs : settings.listFirstPageTtlMs;
    } catch {
      return settings.listFirstPageTtlMs;
    }
  }
  return 0;
}

export function cacheState(entry, url, settings, now = Date.now()) {
  if (!entry || !entry.savedAt || !entry.snapshot) return 'missing';
  const age = now - Number(entry.savedAt);
  const ttl = ttlMsForEntry(entry, url, settings);
  if (ttl > 0 && age <= ttl) return 'fresh';
  if (age <= settings.staleMaxMs) return 'stale';
  return 'expired';
}

export function backoffMsForStrike(strike) {
  const i = Math.max(0, Math.min(BACKOFF_STEPS_MS.length - 1, Number(strike || 1) - 1));
  return BACKOFF_STEPS_MS[i];
}

export function createInitialSessionState() {
  return {
    cache: {},
    conversationGenerations: {},
    lastNetworkAt: 0,
    nextAllowedAt: 0,
    rate429Strikes: 0,
    backoffReason: '',
    forceNextRequest: false,
    activeLease: null
  };
}

export function createHealthState(conversationId = '') {
  return {
    conversationId,
    startedAt: 0,
    lastMutationAt: 0,
    lastPageSeenAt: 0,
    lastPageFocusAt: 0,
    lastStreamStatusAt: 0,
    lastStreamStatusOkAt: 0,
    lastStreamStatusValue: '',
    lastStreamStatusHttpStatus: 0,
    streamStatusConsecutiveFailures: 0,
    lastStreamStatusFailureAt: 0,
    lastStreamStatusAbortAt: 0,
    streamStatusAbortCount: 0,
    lastStreamProbeAt: 0,
    lastStreamProbeOkAt: 0,
    lastStreamProbeValue: '',
    lastStreamProbeHttpStatus: 0,
    lastStreamProbeFailureAt: 0,
    streamProbeConsecutiveFailures: 0,
    lastStreamProbeSource: '',
    lastResumeAt: 0,
    lastResumeStatus: 0,
    lastResumeFailureAt: 0,
    lastDetailNetworkAt: 0,
    lastPersistedAt: 0,
    lastBackendTerminalAt: 0,
    lastBackendTerminalValue: '',
    lastBackendTerminalSource: '',
    lastConversationCheckAt: 0,
    lastConversationTurnOpen: null,
    lastConversationTurnClosed: null,
    lastConversationCurrentNodeRole: '',
    lastConversationCurrentNodeId: '',
    lastConversationWorkingTurnId: '',
    lastConversationAsyncStatus: null,
    lastPersistenceCheckAt: 0,
    lastPersistenceFinalFound: null,
    lastPersistenceHttpStatus: 0,
    lastPersistenceCheckError: '',
    lastGeneralBackendOkAt: 0,
    lastGeneralBackendErrorAt: 0,
    recentBackendErrorCount: 0,
    last429At: 0,
    lastError: '',
    lastDevHubAt: 0,
    devhubState: '',
    devhubConfidence: '',
    devhubHeartbeatAgeSeconds: null,
    devhubHeartbeatRequired: null,
    devhubActiveTaskId: null,
    devhubLatestActivitySource: '',
    devhubBindingSource: '',
    devhubProject: '',
    devhubTargetSlot: '',
    lastStateCode: 'UNKNOWN',
    lastStateChangedAt: 0,
    timeline: []
  };
}

function isStreamingValue(value) {
  const v = String(value || '').trim().toUpperCase();
  if (!v || v.includes('NOT_STREAMING')) return false;
  return v === 'IS_STREAMING' || v === 'STREAMING' || /(^|_)IS_STREAMING$/.test(v);
}

function isTerminalValue(value) {
  const v = String(value || '').toUpperCase();
  return v.includes('NOT_STREAMING') || v.includes('COMPLETE') || v.includes('FINISHED') || v.includes('DONE');
}

function effectiveStreamEvidence(state) {
  const passiveAt = Number(state.lastStreamStatusOkAt || 0);
  const probeAt = Number(state.lastStreamProbeOkAt || 0);
  if (probeAt > passiveAt) {
    return {
      at: probeAt,
      value: String(state.lastStreamProbeValue || ''),
      source: 'independent-probe',
      httpStatus: Number(state.lastStreamProbeHttpStatus || 0)
    };
  }
  return {
    at: passiveAt,
    value: String(state.lastStreamStatusValue || ''),
    source: passiveAt ? 'page-heartbeat' : '',
    httpStatus: Number(state.lastStreamStatusHttpStatus || 0)
  };
}

export function deriveHealth(state, now = Date.now(), settings = DEFAULT_SETTINGS) {
  const s = { ...createHealthState(state?.conversationId || ''), ...(state || {}) };
  const sinceMutation = s.lastMutationAt ? now - s.lastMutationAt : Infinity;
  const evidence = effectiveStreamEvidence(s);
  const streamAge = evidence.at ? now - evidence.at : Infinity;
  const resumeFailed = (s.lastResumeStatus === 404 || s.lastResumeStatus === 410 || s.lastResumeStatus >= 500) && s.lastResumeFailureAt > 0;
  const persistedAfterMutation = s.lastPersistedAt > 0 && (!s.lastMutationAt || s.lastPersistedAt >= s.lastMutationAt);
  const generalNetworkRecent = s.lastGeneralBackendOkAt > 0 && now - s.lastGeneralBackendOkAt <= settings.healthNetworkWindowMs;
  const generalErrorsRecent = s.lastGeneralBackendErrorAt > 0 && now - s.lastGeneralBackendErrorAt <= settings.healthNetworkWindowMs;
  const recent429 = s.last429At > 0 && now - s.last429At <= settings.healthNetworkWindowMs;
  const streaming = isStreamingValue(evidence.value);
  const terminalStatus = isTerminalValue(evidence.value) || Number(s.lastBackendTerminalAt || 0) > 0;
  const terminalAt = Math.max(Number(s.lastBackendTerminalAt || 0), terminalStatus ? Number(evidence.at || 0) : 0);
  const terminalAge = terminalAt ? now - terminalAt : Infinity;
  const probeIsNewest = evidence.source === 'independent-probe';
  const passiveCurrentlyFailing = Number(s.streamStatusConsecutiveFailures || 0) > 0 && Number(s.lastStreamStatusFailureAt || 0) >= Number(s.lastStreamStatusOkAt || 0);
  const persistenceCheckedAfterTerminal = Number(s.lastPersistenceCheckAt || 0) > 0 && (!terminalAt || Number(s.lastPersistenceCheckAt) >= terminalAt);

  if (persistedAfterMutation || s.lastPersistenceFinalFound === true) {
    return { code: 'COMPLETED_PERSISTED', level: 'blue', confidence: 'HIGH', label: '已完成并落盘', action: '已确认当前任务的最终助手回复已经写入会话；可以刷新页面，不要重复执行任务。' };
  }

  if (terminalStatus && persistenceCheckedAfterTerminal && s.lastPersistenceFinalFound === false) {
    if (terminalAge < settings.terminalPersistenceGraceMs) {
      return { code: 'COMPLETE_WAITING_FINAL', level: 'orange', confidence: 'HIGH', label: '后台已结束，等待最终回复落盘', action: `已确认后端状态为结束，但当前会话尚未找到最终助手回复；先等约 ${Math.ceil((settings.terminalPersistenceGraceMs-terminalAge)/1000)} 秒，不要重跑。` };
    }
    const devhubHint = s.devhubActiveTaskId ? ` DevHub 仍记录 Task #${s.devhubActiveTaskId}；建议先查 DevHub/Checkpoint，避免重复执行。` : '';
    return { code: 'COMPLETE_WITHOUT_FINAL', level: 'red', confidence: 'HIGH', label: '执行已结束，但最终回复未落盘', action: `后端已经进入结束状态，而且重新读取会话后仍没有当前任务的最终助手回复。不要把它当成仍在运行；先核对 DevHub/Checkpoint/实际产物，再决定是否补跑最后阶段。${devhubHint}` };
  }

  const passiveStillStreaming = isStreamingValue(s.lastStreamStatusValue);
  const independentProbeTerminal = isTerminalValue(s.lastStreamProbeValue) && Number(s.lastStreamProbeOkAt || 0) > 0;
  if (terminalStatus && independentProbeTerminal && passiveStillStreaming && !persistenceCheckedAfterTerminal) {
    return {
      code: 'STREAM_STATUS_CONFLICT',
      level: 'orange',
      confidence: 'HIGH',
      label: '页面仍报运行中，但独立探针已确认结束',
      action: '页面自己的 stream_status 可能是滞后/假活状态。独立无缓存探针已经返回结束；插件会继续核验最终回复是否真正落盘，在此之前不要重复执行任务。'
    };
  }

  if (terminalStatus && terminalAge <= Math.max(settings.healthDegradedMs, 5 * 60_000)) {
    return {
      code: probeIsNewest ? 'BACKEND_COMPLETE_PROBE' : 'BACKEND_COMPLETE',
      level: 'orange',
      confidence: probeIsNewest ? 'HIGH' : 'MEDIUM',
      label: probeIsNewest ? '后台已结束（独立探针确认），尚未确认最终回复' : '后台已结束，尚未确认最终回复',
      action: '后端状态“结束”不等于最终回复已经落盘。插件会做一次低频落盘核验；在结果确认前不要重复执行同一任务。'
    };
  }

  if (streaming && streamAge <= settings.healthAliveFreshMs) {
    if (probeIsNewest && passiveCurrentlyFailing) {
      return { code: 'ALIVE_PROBE_CONFIRMED', level: 'green', confidence: 'HIGH', label: '后台仍有存活证据（独立探针确认）', action: '页面自己的状态查询正在失败/被取消，但独立探针成功返回“正在运行”；先不要点重试。' };
    }
    if (resumeFailed && s.lastResumeFailureAt >= evidence.at - 15_000) {
      return { code: 'STREAM_LOST_BACKEND_ALIVE', level: 'yellow', confidence: 'MEDIUM', label: '前端断流，但后台状态仍报运行中', action: '这是服务端状态账本的存活证据，不保证工作进程一定仍在持续计算；不要点重试，继续观察真实活动和最终落盘。' };
    }
    return { code: 'ALIVE', level: 'green', confidence: 'MEDIUM', label: '有近期运行中证据', action: '最近一次状态查询成功并报告“正在运行”。继续等待，但不要把它当成唯一的存活证明。' };
  }

  if (recent429) {
    return { code: 'RATE_LIMITED', level: 'purple', confidence: 'HIGH', label: '429 限流中', action: '不要手动连续重试，让降频和退避机制生效；任务生命体征会继续尽量使用低频探针和已有证据判断。' };
  }

  if (generalErrorsRecent && !generalNetworkRecent && s.recentBackendErrorCount >= 2) {
    return { code: 'NETWORK_PATH_UNSTABLE', level: 'black', confidence: 'HIGH', label: '网络/代理链路异常', action: '多个后端请求同时出现传输失败，而且近期没有成功请求；优先恢复网络/代理链路，不要重新执行任务。' };
  }

  if (streaming && streamAge <= settings.healthDegradedMs) {
    return { code: 'HEARTBEAT_DEGRADED', level: 'yellow', confidence: 'LOW', label: '心跳波动；曾报告运行中', action: '最近的“正在运行”证据已经变旧。插件会在连续失败时低频发起独立探针；不要仅凭页面卡住就重跑。' };
  }

  if (resumeFailed && sinceMutation >= settings.healthSuspectedDeadMs && streamAge >= settings.healthSuspectedDeadMs && generalNetworkRecent) {
    return { code: 'SUSPECTED_TERMINATED', level: 'red', confidence: 'MEDIUM', label: '疑似真正终止且未落盘', action: '网络仍然可达，但恢复请求失败、心跳长期没有新证据且没有最终结果；点“诊断当前任务”确认后再决定是否重试。' };
  }

  if (s.lastMutationAt && sinceMutation < 15 * 60_000) {
    return { code: 'UNKNOWN_RUNNING', level: 'gray', confidence: 'LOW', label: '执行状态未确认', action: '继续观察状态查询、网络链路、DevHub 活动和最终落盘；不要只根据页面错误提示判断任务失败。' };
  }

  return { code: 'IDLE_OR_UNKNOWN', level: 'gray', confidence: 'LOW', label: '无法确认/当前无活动', action: '需要时可以点击“诊断当前任务”。' };
}

