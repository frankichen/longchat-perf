import {
  DEFAULT_SETTINGS,
  EMPTY_STATS,
  normalizeSettings,
  cacheState,
  backoffMsForStrike,
  createInitialSessionState,
  createHealthState,
  deriveHealth
} from './coordinator-core.js';
import { DEFAULT_AUTO_PROJECT_RULES, matchAutoRule, resolveProfileRoute, normalizeAutoRules } from './project-routing.js';

const SESSION_KEY = 'coordinatorStateV4';
const HEALTH_KEY = 'taskHealthV4';
const TAB_MAP_KEY = 'taskHealthTabMapV4';
const DEVHUB_CONFIG_KEY = 'devhubConfigV4';
const DEVHUB_LOCAL_SECRETS_KEY = 'devhubSecretsV4';
const DEVHUB_SESSION_SECRETS_KEY = 'devhubSecretsSessionV4';
const STREAM_PROBE_COORD_KEY = 'streamProbeCoordV4';
const PERSISTENCE_CHECK_COORD_KEY = 'persistenceCheckCoordV4_3';
const PROJECT_CONTEXT_KEY = 'projectContextV4_1';
const USAGE_STATUS_KEY = 'usageStatusV4_3';
const DEFAULT_DEVHUB_CONFIG = Object.freeze({ enabled: false, baseUrl: 'https://devhub.sgk.555044.xyz', submitOnOpen: true, submitOnStateChange: true, minSubmitGapMs: 60000, profiles: [], bindings: {}, autoProjectMapping: true, autoRules: DEFAULT_AUTO_PROJECT_RULES });
let settings = normalizeSettings();
let updateQueue = Promise.resolve();
let healthQueue = Promise.resolve();
let probeQueue = Promise.resolve();
let persistenceQueue = Promise.resolve();


function sanitizeUsageWindow(value) {
  if (!value || typeof value !== 'object') return null;
  const numberOrNull = v => Number.isFinite(Number(v)) ? Number(v) : null;
  return {
    usedPercent: numberOrNull(value.usedPercent ?? value.used_percent),
    limitWindowSeconds: numberOrNull(value.limitWindowSeconds ?? value.limit_window_seconds),
    resetAfterSeconds: numberOrNull(value.resetAfterSeconds ?? value.reset_after_seconds),
    resetAt: numberOrNull(value.resetAt ?? value.reset_at)
  };
}

function sanitizeUsageSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const models = {};
  const sourceModels = raw.models && typeof raw.models === 'object' ? raw.models : {};
  for (const [name, value] of Object.entries(sourceModels)) {
    if (!name || !value || typeof value !== 'object') continue;
    models[String(name).slice(0, 120)] = {
      available: value.available === true,
      availableAt: Number.isFinite(Number(value.availableAt)) ? Number(value.availableAt) : null,
      creditsWouldEnable: value.creditsWouldEnable === true
    };
  }
  return {
    version: Number.isFinite(Number(raw.version)) ? Number(raw.version) : 1,
    sequence: Number.isFinite(Number(raw.sequence)) ? Number(raw.sequence) : null,
    generatedAtMs: Number.isFinite(Number(raw.generatedAtMs)) ? Number(raw.generatedAtMs) : Date.now(),
    observedAt: Date.now(),
    source: String(raw.source || '').slice(0, 80),
    planType: String(raw.planType || '').slice(0, 60),
    allowed: raw.allowed !== false,
    limitReached: raw.limitReached === true,
    rateLimitReachedType: String(raw.rateLimitReachedType || '').slice(0, 120),
    primaryWindow: sanitizeUsageWindow(raw.primaryWindow),
    secondaryWindow: sanitizeUsageWindow(raw.secondaryWindow),
    spendControlReached: raw.spendControlReached === true,
    resetCreditsAvailable: Number.isFinite(Number(raw.resetCreditsAvailable)) ? Number(raw.resetCreditsAvailable) : null,
    resetCreditsApplicable: Number.isFinite(Number(raw.resetCreditsApplicable)) ? Number(raw.resetCreditsApplicable) : null,
    models
  };
}

async function getUsageStatus() {
  const stored = await chrome.storage.session.get(USAGE_STATUS_KEY);
  const raw = stored[USAGE_STATUS_KEY] || {};
  return {
    snapshot: raw.snapshot || null,
    lastSnapshotAt: Number(raw.lastSnapshotAt || 0),
    lastHeartbeatAt: Number(raw.lastHeartbeatAt || 0),
    heartbeatSource: String(raw.heartbeatSource || '')
  };
}

async function broadcastUsageUpdate(usage) {
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
  await Promise.allSettled(tabs.map(tab => tab.id ? chrome.tabs.sendMessage(tab.id, { type:'USAGE_UPDATE', usage }).catch(() => {}) : Promise.resolve()));
}

async function recordUsageSnapshot(message) {
  const snapshot = sanitizeUsageSnapshot(message?.snapshot);
  if (!snapshot) return { ok:false, error:'USAGE_SNAPSHOT_INVALID' };
  const now = Date.now();
  const stored = await chrome.storage.session.get(USAGE_STATUS_KEY);
  const current = stored[USAGE_STATUS_KEY] || {};
  const next = {
    ...current,
    snapshot,
    lastSnapshotAt: now,
    lastHeartbeatAt: Math.max(Number(current.lastHeartbeatAt || 0), now)
  };
  await chrome.storage.session.set({ [USAGE_STATUS_KEY]: next });
  addStats({ usageSnapshots:1, lastUsageSnapshotAt:now });
  await broadcastUsageUpdate(next);
  return { ok:true };
}

async function recordUsageHeartbeat(message) {
  const now = Number(message?.at || Date.now());
  const stored = await chrome.storage.session.get(USAGE_STATUS_KEY);
  const current = stored[USAGE_STATUS_KEY] || {};
  const next = { ...current, lastHeartbeatAt: now, heartbeatSource:String(message?.source || '').slice(0,80) };
  await chrome.storage.session.set({ [USAGE_STATUS_KEY]: next });
  addStats({ usageHeartbeats:1, lastUsageHeartbeatAt:now });
  await broadcastUsageUpdate(next);
  return { ok:true };
}

async function loadSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  settings = normalizeSettings(stored);
}

async function getState() {
  const result = await chrome.storage.session.get(SESSION_KEY);
  const raw = result[SESSION_KEY] || {};
  return {
    ...createInitialSessionState(),
    ...raw,
    cache: { ...(raw.cache || {}) },
    conversationGenerations: { ...(raw.conversationGenerations || {}) }
  };
}

async function setState(state) {
  pruneCache(state);
  await chrome.storage.session.set({ [SESSION_KEY]: state });
}

function mergeStats(current, delta) {
  const next = { ...EMPTY_STATS, ...current };
  for (const [key, value] of Object.entries(delta || {})) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (key.startsWith('last') || key.endsWith('At') || key === 'lastOtherHttpStatus') {
        next[key] = value;
      } else {
        next[key] = (Number(next[key]) || 0) + value;
      }
    } else if (typeof value === 'string' && key.startsWith('last')) {
      next[key] = value;
    }
  }
  return next;
}

function addStats(delta) {
  updateQueue = updateQueue.then(async () => {
    const current = await chrome.storage.local.get(null);
    await chrome.storage.local.set(mergeStats(current, delta));
  }).catch(() => {});
}

function makeLeaseId() {
  return `${Date.now()}-${crypto.randomUUID()}`;
}

function approxSnapshotBytes(snapshot) {
  if (!snapshot) return 0;
  const body = typeof snapshot.body === 'string' ? snapshot.body.length * 2 : 0;
  let meta = 0;
  try { meta = JSON.stringify(snapshot.headers || []).length * 2 + 512; } catch { meta = 1024; }
  return body + meta;
}

function pruneCache(state) {
  const entries = Object.entries(state.cache || {});
  if (!entries.length) return;

  entries.sort((a, b) => Number(b[1]?.savedAt || 0) - Number(a[1]?.savedAt || 0));
  const kept = {};
  let totalBytes = 0;
  let count = 0;
  let pruned = 0;

  for (const [key, entry] of entries) {
    const bytes = Number(entry?.approxBytes || approxSnapshotBytes(entry?.snapshot));
    const fitsCount = count < settings.cacheMaxEntries;
    const fitsBytes = totalBytes + bytes <= settings.cacheMaxApproxBytes;
    if (fitsCount && fitsBytes) {
      kept[key] = { ...entry, approxBytes: bytes };
      totalBytes += bytes;
      count += 1;
    } else {
      pruned += 1;
    }
  }

  if (pruned > 0) {
    state.cache = kept;
    addStats({ cachePrunes: pruned, lastCachePruneAt: Date.now() });
  }
}

function kindStat(kind, suffix) {
  if (kind === 'detail') return `detail${suffix}`;
  if (kind === 'list') return `list${suffix}`;
  return null;
}

function cacheHitStats(entry, now, stale = false) {
  const delta = { savedRequests: 1 };
  if (entry?.kind === 'detail') delta.detailCacheHits = 1;
  if (entry?.kind === 'list') delta.listCacheHits = 1;
  if (stale) delta.staleCooldownHits = 1;
  delta.lastCacheHitAt = now;
  return delta;
}

async function acquire(message, sender) {
  if (!settings.enabled) return { action: 'passthrough' };

  const now = Date.now();
  const key = String(message.key || '');
  const url = String(message.url || '');
  const kind = message.kind === 'detail' ? 'detail' : (message.kind === 'list' ? 'list' : 'other');
  const conversationId = message.conversationId ? String(message.conversationId) : null;
  if (!key || !url || kind === 'other') return { action: 'passthrough' };

  const state = await getState();
  const entry = state.cache[key];
  const cstate = cacheState(entry, url, settings, now);

  if (!state.forceNextRequest && cstate === 'fresh') {
    addStats(cacheHitStats(entry, now, false));
    return { action: 'cache', snapshot: entry.snapshot, ageMs: now - entry.savedAt, cacheState: 'fresh' };
  }

  const existingLease = state.activeLease;
  if (existingLease && now - Number(existingLease.startedAt || 0) > 120_000) {
    state.activeLease = null;
    await setState(state);
  }

  if (state.activeLease) {
    if (settings.serveStaleDuringCooldown && (cstate === 'fresh' || cstate === 'stale')) {
      addStats(cacheHitStats(entry, now, true));
      return { action: 'cache', snapshot: entry.snapshot, ageMs: now - entry.savedAt, cacheState: 'stale-active-lease' };
    }
    addStats({ crossTabWaits: 1, savedRequests: 1, lastCrossTabWaitAt: now });
    return { action: 'wait', retryAfterMs: 500 };
  }

  const is429Backoff = state.backoffReason === '429' && now < Number(state.nextAllowedAt || 0);
  if (!state.forceNextRequest && is429Backoff) {
    if (settings.serveStaleDuringCooldown && (cstate === 'fresh' || cstate === 'stale')) {
      addStats({ ...cacheHitStats(entry, now, true), stale429Served: 1, lastStale429At: now });
      return { action: 'cache', snapshot: entry.snapshot, ageMs: now - entry.savedAt, cacheState: 'stale-429-backoff' };
    }
    if (settings.local429DuringBackoff) {
      addStats({ local429Blocks: 1, savedRequests: 1, lastLocal429At: now });
      return { action: 'synthetic429', retryAfterMs: Math.max(1_000, Number(state.nextAllowedAt || 0) - now) };
    }
  }

  if (!state.forceNextRequest && now < Number(state.nextAllowedAt || 0)) {
    if (settings.serveStaleDuringCooldown && (cstate === 'fresh' || cstate === 'stale')) {
      addStats({ ...cacheHitStats(entry, now, true), globalGapBlocks: 1, lastGlobalGapBlockAt: now });
      return { action: 'cache', snapshot: entry.snapshot, ageMs: now - entry.savedAt, cacheState: 'stale-global-gap' };
    }
    addStats({ globalGapBlocks: 1, lastGlobalGapBlockAt: now });
    return { action: 'wait', retryAfterMs: Math.min(5_000, Math.max(250, Number(state.nextAllowedAt || 0) - now)) };
  }

  const leaseId = makeLeaseId();
  const generation = conversationId ? Number(state.conversationGenerations[conversationId] || 0) : 0;
  state.activeLease = {
    leaseId,
    key,
    url,
    kind,
    conversationId,
    generation,
    tabId: sender?.tab?.id ?? null,
    startedAt: now
  };

  state.forceNextRequest = false;
  state.lastNetworkAt = now;
  state.nextAllowedAt = Math.max(Number(state.nextAllowedAt || 0), now + settings.globalMinGapMs);
  if (state.backoffReason !== '429') state.backoffReason = '';
  await setState(state);

  const delta = { actualRequests: 1, lastActualRequestAt: now };
  const ks = kindStat(kind, 'ActualRequests');
  if (ks) delta[ks] = 1;
  addStats(delta);
  return { action: 'network', leaseId };
}

async function complete(message) {
  const now = Date.now();
  const leaseId = String(message.leaseId || '');
  const state = await getState();
  if (!state.activeLease || state.activeLease.leaseId !== leaseId) {
    return { ok: false, reason: 'LEASE_MISMATCH' };
  }

  const lease = state.activeLease;
  state.activeLease = null;
  const status = Number(message.status || 0);
  let fallback = null;

  if (status === 200 && message.snapshot && typeof message.snapshot.body === 'string') {
    const currentGeneration = lease.conversationId ? Number(state.conversationGenerations[lease.conversationId] || 0) : 0;
    const generationStillCurrent = !lease.conversationId || currentGeneration === Number(lease.generation || 0);

    if (generationStillCurrent) {
      const approxBytes = approxSnapshotBytes(message.snapshot);
      if (approxBytes <= settings.cacheMaxApproxBytes) {
        state.cache[lease.key] = {
          snapshot: message.snapshot,
          savedAt: now,
          url: lease.url,
          kind: lease.kind,
          conversationId: lease.conversationId,
          cacheClass: String(message.cacheClass || (lease.kind === 'list' ? 'list' : 'detail-uncertain')),
          approxBytes
        };
      }
    } else {
      addStats({ staleGenerationDrops: 1, lastStaleGenerationDropAt: now });
    }

    state.rate429Strikes = 0;
    state.backoffReason = '';
    state.nextAllowedAt = Math.max(now + settings.globalMinGapMs, Number(state.nextAllowedAt || 0));
    addStats({ successfulRequests: 1, lastSuccessAt: now });
  } else if (status === 429) {
    state.rate429Strikes = Math.min(100, Number(state.rate429Strikes || 0) + 1);
    const configuredPenalty = backoffMsForStrike(state.rate429Strikes);
    const serverPenalty = Math.max(0, Number(message.retryAfterMs || 0));
    const penalty = Math.max(configuredPenalty, serverPenalty);
    state.nextAllowedAt = Math.max(Number(state.nextAllowedAt || 0), now + penalty);
    state.backoffReason = '429';
    addStats({ server429: 1, last429At: now, lastBackoffUntilAt: state.nextAllowedAt });

    const entry = state.cache[lease.key];
    const cstate = cacheState(entry, lease.url, settings, now);
    if (settings.staleIf429 && (cstate === 'fresh' || cstate === 'stale')) {
      fallback = entry.snapshot;
      addStats({ stale429Served: 1, savedRequests: 1, lastStale429At: now });
    }
  } else if (status > 0) {
    state.nextAllowedAt = Math.max(Number(state.nextAllowedAt || 0), now + settings.globalMinGapMs);
    addStats({ otherHttpErrors: 1, lastOtherHttpErrorAt: now, lastOtherHttpStatus: status });
  } else {
    state.nextAllowedAt = Math.max(Number(state.nextAllowedAt || 0), now + settings.globalMinGapMs);
    addStats({ networkErrors: 1, lastNetworkErrorAt: now });
  }

  await setState(state);
  return { ok: true, fallback, nextAllowedAt: state.nextAllowedAt, rate429Strikes: state.rate429Strikes };
}

async function invalidateConversation(conversationId) {
  const id = String(conversationId || '').trim();
  if (!id) return;
  const state = await getState();
  state.conversationGenerations[id] = Number(state.conversationGenerations[id] || 0) + 1;
  let removed = 0;
  for (const [key, entry] of Object.entries(state.cache || {})) {
    if (entry?.kind === 'detail' && entry?.conversationId === id) {
      delete state.cache[key];
      removed += 1;
    }
  }
  await setState(state);
  addStats({ invalidations: 1, lastInvalidationAt: Date.now(), ...(removed ? { invalidatedEntries: removed } : {}) });
}

async function clearSharedCache(forceNext = false) {
  const state = await getState();
  state.cache = {};
  if (forceNext) {
    state.forceNextRequest = true;
    state.nextAllowedAt = 0;
    state.backoffReason = '';
    state.rate429Strikes = 0;
  }
  await setState(state);
  addStats({ cacheClears: 1, ...(forceNext ? { manualRefreshes: 1 } : {}), lastCacheClearAt: Date.now() });
}

async function statusSnapshot() {
  const state = await getState();
  const now = Date.now();
  const entries = Object.values(state.cache || {});
  return {
    settings,
    cacheEntries: entries.length,
    listCacheEntries: entries.filter(x => x?.kind === 'list').length,
    detailCacheEntries: entries.filter(x => x?.kind === 'detail').length,
    activeLease: Boolean(state.activeLease),
    activeLeaseKind: state.activeLease?.kind || '',
    nextAllowedAt: Number(state.nextAllowedAt || 0),
    waitMs: Math.max(0, Number(state.nextAllowedAt || 0) - now),
    rate429Strikes: Number(state.rate429Strikes || 0),
    backoffReason: state.backoffReason || ''
  };
}



async function getHealthStore() {
  const result = await chrome.storage.session.get([HEALTH_KEY, TAB_MAP_KEY]);
  return {
    health: { ...(result[HEALTH_KEY] || {}) },
    tabMap: { ...(result[TAB_MAP_KEY] || {}) }
  };
}

async function setHealthStore(store) {
  await chrome.storage.session.set({
    [HEALTH_KEY]: store.health || {},
    [TAB_MAP_KEY]: store.tabMap || {}
  });
}

function normalizeConversationId(value) {
  const id = String(value || '').trim();
  return id || '';
}

function compactTimelineEvent(event, at) {
  const out = { at, kind: String(event.kind || 'UNKNOWN') };
  for (const key of ['status','value','error','source','terminal','cacheClass','aborted','cause','eventType']) {
    if (event[key] !== undefined && event[key] !== null && event[key] !== '') out[key] = event[key];
  }
  return out;
}

function applyHealthEvent(state, event, now) {
  const next = { ...createHealthState(state.conversationId), ...state };
  const kind = String(event.kind || '');
  if (kind === 'PAGE_OPEN' || kind === 'ROUTE_SEEN') next.lastPageSeenAt = now;
  if (kind === 'PAGE_FOCUS') next.lastPageFocusAt = now;

  if (kind === 'TURN_MUTATION') {
    next.startedAt = now;
    next.lastMutationAt = now;
    next.lastPersistedAt = 0;
    next.lastStreamStatusValue = '';
    next.lastStreamStatusOkAt = 0;
    next.lastStreamStatusFailureAt = 0;
    next.streamStatusConsecutiveFailures = 0;
    next.lastStreamStatusAbortAt = 0;
    next.streamStatusAbortCount = 0;
    next.lastStreamProbeAt = 0;
    next.lastStreamProbeOkAt = 0;
    next.lastStreamProbeValue = '';
    next.lastStreamProbeHttpStatus = 0;
    next.lastStreamProbeFailureAt = 0;
    next.streamProbeConsecutiveFailures = 0;
    next.lastStreamProbeSource = '';
    next.lastResumeAt = 0;
    next.lastResumeStatus = 0;
    next.lastResumeFailureAt = 0;
    next.lastBackendTerminalAt = 0;
    next.lastBackendTerminalValue = '';
    next.lastBackendTerminalSource = '';
    next.lastConversationCheckAt = 0;
    next.lastConversationTurnOpen = null;
    next.lastConversationTurnClosed = null;
    next.lastConversationCurrentNodeRole = '';
    next.lastConversationCurrentNodeId = '';
    next.lastConversationWorkingTurnId = '';
    next.lastConversationAsyncStatus = null;
    next.lastPersistenceCheckAt = 0;
    next.lastPersistenceFinalFound = null;
    next.lastPersistenceHttpStatus = 0;
    next.lastPersistenceCheckError = '';
  }

  if (kind === 'STREAM_STATUS') {
    next.lastStreamStatusAt = now;
    next.lastStreamStatusHttpStatus = Number(event.status || 0);
    if (Number(event.status || 0) >= 200 && Number(event.status || 0) < 300 && event.ok !== false) {
      next.lastStreamStatusOkAt = now;
      next.lastStreamStatusValue = String(event.value || 'UNKNOWN');
      next.streamStatusConsecutiveFailures = 0;
      if (String(event.value || '').toUpperCase().includes('COMPLETE') || String(event.value || '').toUpperCase().includes('FINISHED') || String(event.value || '').toUpperCase().includes('DONE') || String(event.value || '').toUpperCase().includes('NOT_STREAMING')) {
        next.lastBackendTerminalAt = now;
        next.lastBackendTerminalValue = String(event.value || '');
        next.lastBackendTerminalSource = 'page-status';
      }
      next.lastGeneralBackendOkAt = now;
      next.recentBackendErrorCount = Math.max(0, Number(next.recentBackendErrorCount || 0) - 1);
      addStats({ streamStatusSuccess: 1, lastStreamStatusSuccessAt: now });
    } else {
      next.lastStreamStatusFailureAt = now;
      next.streamStatusConsecutiveFailures = Number(next.streamStatusConsecutiveFailures || 0) + 1;
      next.lastError = String(event.error || `HTTP_${Number(event.status || 0)}`);
      if (event.aborted === true) {
        next.lastStreamStatusAbortAt = now;
        next.streamStatusAbortCount = Number(next.streamStatusAbortCount || 0) + 1;
        addStats({ streamStatusAborts: 1, lastStreamStatusAbortAt: now });
      }
      if (Number(event.status || 0) === 429) next.last429At = now;
      addStats({ streamStatusFailures: 1, lastStreamStatusFailureAt: now });
    }
  }

  if (kind === 'STREAM_PROBE') {
    next.lastStreamProbeAt = now;
    next.lastStreamProbeHttpStatus = Number(event.status || 0);
    next.lastStreamProbeSource = String(event.source || 'independent-probe');
    if (Number(event.status || 0) >= 200 && Number(event.status || 0) < 300 && event.ok !== false) {
      next.lastStreamProbeOkAt = now;
      next.lastStreamProbeValue = String(event.value || 'UNKNOWN');
      next.streamProbeConsecutiveFailures = 0;
      if (event.terminal === true) {
        next.lastBackendTerminalAt = now;
        next.lastBackendTerminalValue = String(event.value || '');
        next.lastBackendTerminalSource = 'independent-probe';
      }
      next.lastGeneralBackendOkAt = now;
      next.recentBackendErrorCount = Math.max(0, Number(next.recentBackendErrorCount || 0) - 2);
      addStats({ streamProbeSuccess: 1, lastStreamProbeSuccessAt: now });
      if (event.terminal === true) addStats({ streamProbeComplete: 1, lastStreamProbeCompleteAt: now });
    } else {
      next.lastStreamProbeFailureAt = now;
      next.streamProbeConsecutiveFailures = Number(next.streamProbeConsecutiveFailures || 0) + 1;
      next.lastError = String(event.error || `PROBE_HTTP_${Number(event.status || 0)}`);
      if (Number(event.status || 0) === 429) next.last429At = now;
      addStats({ streamProbeFailures: 1, lastStreamProbeFailureAt: now });
    }
  }

  if (kind === 'RESUME') {
    next.lastResumeAt = now;
    next.lastResumeStatus = Number(event.status || 0);
    if (!(next.lastResumeStatus >= 200 && next.lastResumeStatus < 300)) {
      next.lastResumeFailureAt = now;
      next.lastError = String(event.error || `RESUME_HTTP_${next.lastResumeStatus}`);
      if (next.lastResumeStatus === 429) next.last429At = now;
      addStats({ resumeFailures: 1, lastResumeFailureAt: now });
    }
  }

  if (kind === 'DETAIL_SIGNAL' || kind === 'PERSISTENCE_CHECK' || kind === 'MANUAL_DIAGNOSE') {
    const status = Number(event.status || 0);
    if (status >= 200 && status < 300) {
      next.lastDetailNetworkAt = now;
      next.lastGeneralBackendOkAt = now;
      next.lastConversationCheckAt = now;
      next.lastConversationTurnOpen = typeof event.turnOpen === 'boolean' ? event.turnOpen : next.lastConversationTurnOpen;
      next.lastConversationTurnClosed = typeof event.turnClosed === 'boolean' ? event.turnClosed : next.lastConversationTurnClosed;
      next.lastConversationCurrentNodeRole = String(event.currentNodeRole || next.lastConversationCurrentNodeRole || '');
      next.lastConversationCurrentNodeId = String(event.currentNodeId || next.lastConversationCurrentNodeId || '');
      next.lastConversationWorkingTurnId = String(event.workingTurnId || next.lastConversationWorkingTurnId || '');
      next.lastConversationAsyncStatus = event.asyncStatus ?? next.lastConversationAsyncStatus ?? null;
      next.lastPersistenceCheckAt = now;
      next.lastPersistenceHttpStatus = status;
      next.lastPersistenceCheckError = '';
      const found = event.finalFound === true;
      next.lastPersistenceFinalFound = found;
      if (found) next.lastPersistedAt = now;
      if (kind === 'PERSISTENCE_CHECK') {
        addStats({ persistenceChecks: 1, ...(found ? { persistenceFinalFound: 1 } : { persistenceFinalMissing: 1 }), lastPersistenceCheckAt: now });
      }
    } else if (kind === 'PERSISTENCE_CHECK') {
      next.lastPersistenceCheckAt = now;
      next.lastPersistenceHttpStatus = status;
      next.lastPersistenceCheckError = String(event.error || (status ? `HTTP_${status}` : 'NETWORK_ERROR'));
      addStats({ persistenceChecks: 1, persistenceCheckFailures: 1, lastPersistenceCheckAt: now });
    }
    if (status === 429) next.last429At = now;
  }

  if (kind === 'BACKEND_OK') {
    next.lastGeneralBackendOkAt = now;
    next.recentBackendErrorCount = Math.max(0, Number(next.recentBackendErrorCount || 0) - 1);
  }

  if (kind === 'BACKEND_ERROR') {
    next.lastGeneralBackendErrorAt = now;
    const status = Number(event.status || 0);
    const transportFailure = status === 0 || Boolean(String(event.error || '').trim());
    if (transportFailure) next.recentBackendErrorCount = Math.min(20, Number(next.recentBackendErrorCount || 0) + 1);
    next.lastError = String(event.error || (status ? `HTTP_${status}` : 'NETWORK_ERROR'));
    if (status === 429) next.last429At = now;
  }

  if (kind === 'DEVHUB_LIVENESS') {
    next.lastDevHubAt = now;
    next.devhubState = String(event.state || '');
    next.devhubConfidence = String(event.confidence || '');
    next.devhubHeartbeatAgeSeconds = event.heartbeatAgeSeconds === null || event.heartbeatAgeSeconds === undefined ? null : Number(event.heartbeatAgeSeconds);
    next.devhubHeartbeatRequired = event.heartbeatRequired === null || event.heartbeatRequired === undefined ? null : Boolean(event.heartbeatRequired);
    next.devhubActiveTaskId = event.activeTaskId === null || event.activeTaskId === undefined ? null : Number(event.activeTaskId);
    next.devhubLatestActivitySource = String(event.latestActivitySource || '');
    next.devhubBindingSource = String(event.bindingSource || next.devhubBindingSource || '');
    next.devhubProject = String(event.devhubProject || next.devhubProject || '');
    next.devhubTargetSlot = String(event.targetSlot || next.devhubTargetSlot || '');
  }

  if (!['BACKEND_OK'].includes(kind)) {
    const timeline = Array.isArray(next.timeline) ? next.timeline.slice() : [];
    timeline.push(compactTimelineEvent(event, now));
    next.timeline = timeline.slice(-settings.timelineMax);
  }
  return next;
}

async function updateProbeCoordinator(conversationId, updater) {
  const id = normalizeConversationId(conversationId);
  if (!id) return null;
  const stored = await chrome.storage.session.get(STREAM_PROBE_COORD_KEY);
  const map = { ...(stored[STREAM_PROBE_COORD_KEY] || {}) };
  const current = { lastGrantAt: 0, inFlightUntil: 0, terminalAt: 0, ...(map[id] || {}) };
  const next = updater(current, map) || current;
  map[id] = next;
  await chrome.storage.session.set({ [STREAM_PROBE_COORD_KEY]: map });
  return next;
}

async function requestPersistenceCheck(message) {
  const conversationId = normalizeConversationId(message.conversationId);
  if (!conversationId || !settings.autoPersistenceCheckEnabled) return { action:'skip', reason:'disabled_or_missing' };
  const force = Boolean(message.force);
  let result = { action:'skip', reason:'unknown' };
  persistenceQueue = persistenceQueue.then(async () => {
    const now = Date.now();
    const store = await getHealthStore();
    const health = { ...createHealthState(conversationId), ...(store.health[conversationId] || {}) };
    if (health.last429At && now - Number(health.last429At) < settings.healthNetworkWindowMs) {
      result = { action:'skip', reason:'rate-limited', retryAfterMs: settings.healthNetworkWindowMs - (now - Number(health.last429At)) };
      return;
    }
    if (!force && health.lastPersistenceFinalFound === true) {
      result = { action:'skip', reason:'final-confirmed' };
      return;
    }
    const stored = await chrome.storage.session.get(PERSISTENCE_CHECK_COORD_KEY);
    const map = { ...(stored[PERSISTENCE_CHECK_COORD_KEY] || {}) };
    const coord = { lastGrantAt:0, inFlightUntil:0, ...(map[conversationId] || {}) };
    if (!force && now < Number(coord.inFlightUntil || 0)) {
      result = { action:'skip', reason:'in-flight', retryAfterMs:Number(coord.inFlightUntil)-now };
      return;
    }
    const minGap = Math.max(15_000, Number(settings.autoPersistenceCheckMinGapMs || 60_000));
    if (!force && now - Number(coord.lastGrantAt || 0) < minGap) {
      result = { action:'skip', reason:'minimum-gap', retryAfterMs:minGap-(now-Number(coord.lastGrantAt||0)) };
      return;
    }
    map[conversationId] = { lastGrantAt:now, inFlightUntil:now+30_000 };
    await chrome.storage.session.set({ [PERSISTENCE_CHECK_COORD_KEY]: map });
    result = { action:'check' };
  }).catch(error => { result = { action:'skip', reason:'error', error:String(error) }; });
  await persistenceQueue;
  return result;
}

async function requestStreamProbe(message) {
  const conversationId = normalizeConversationId(message.conversationId);
  if (!conversationId || !settings.streamProbeEnabled) return { action: 'skip', reason: 'disabled_or_missing' };
  const force = Boolean(message.force);
  addStats({ streamProbeRequests: 1, lastStreamProbeRequestAt: Date.now() });

  let result = { action: 'skip', reason: 'unknown' };
  probeQueue = probeQueue.then(async () => {
    const now = Date.now();
    const healthStore = await getHealthStore();
    const health = { ...createHealthState(conversationId), ...(healthStore.health[conversationId] || {}) };
    if (health.last429At && now - Number(health.last429At) < settings.healthNetworkWindowMs) {
      result = { action: 'skip', reason: 'rate-limited', retryAfterMs: settings.healthNetworkWindowMs - (now - Number(health.last429At)) };
      addStats({ streamProbeSuppressions: 1 });
      return;
    }
    const staleStreamingWatchdog = String(message.cause || '') === 'stale-streaming-watchdog';
    if (!force && !staleStreamingWatchdog && Number(health.streamStatusConsecutiveFailures || 0) < Number(settings.streamProbeFailureThreshold || 2)) {
      result = { action: 'skip', reason: 'passive-heartbeat-not-degraded' };
      addStats({ streamProbeSuppressions: 1 });
      return;
    }
    const stored = await chrome.storage.session.get(STREAM_PROBE_COORD_KEY);
    const map = { ...(stored[STREAM_PROBE_COORD_KEY] || {}) };
    const coord = { lastGrantAt: 0, inFlightUntil: 0, terminalAt: 0, ...(map[conversationId] || {}) };

    const probeValue = String(health.lastStreamProbeValue || '').toUpperCase();
    const terminal = probeValue.includes('COMPLETE') || probeValue.includes('FINISHED') || probeValue.includes('DONE') || probeValue.includes('NOT_STREAMING');
    if (!force && terminal && now - Number(health.lastStreamProbeOkAt || 0) < settings.streamProbeTerminalHoldMs) {
      result = { action: 'skip', reason: 'terminal-confirmed', retryAfterMs: settings.streamProbeTerminalHoldMs - (now - Number(health.lastStreamProbeOkAt || 0)) };
      addStats({ streamProbeSuppressions: 1 });
      return;
    }

    if (Number(coord.inFlightUntil || 0) > now) {
      result = { action: 'skip', reason: 'probe-in-flight', retryAfterMs: Number(coord.inFlightUntil) - now };
      addStats({ streamProbeSuppressions: 1 });
      return;
    }

    const failures = Math.max(0, Number(health.streamProbeConsecutiveFailures || 0));
    const failureGap = failures > 0
      ? Math.min(settings.streamProbeMaxBackoffMs, settings.streamProbeFailureBackoffMs * (2 ** Math.min(5, failures - 1)))
      : 0;
    const requiredGap = staleStreamingWatchdog
      ? Math.max(settings.streamProbeMinGapMs, settings.streamProbeStaleStreamingGapMs, failureGap)
      : Math.max(settings.streamProbeMinGapMs, failureGap);
    const elapsed = now - Number(coord.lastGrantAt || 0);
    if (!force && coord.lastGrantAt && elapsed < requiredGap) {
      result = { action: 'skip', reason: 'probe-throttled', retryAfterMs: requiredGap - elapsed };
      addStats({ streamProbeSuppressions: 1 });
      return;
    }

    coord.lastGrantAt = now;
    coord.inFlightUntil = now + 15_000;
    map[conversationId] = coord;
    await chrome.storage.session.set({ [STREAM_PROBE_COORD_KEY]: map });
    addStats({ streamProbeGrants: 1, lastStreamProbeGrantAt: now });
    result = { action: 'probe', leaseUntil: coord.inFlightUntil, cause: String(message.cause || '') };
  }).catch(error => {
    result = { action: 'skip', reason: 'coordinator-error', error: String(error) };
  });
  await probeQueue;
  return result;
}

async function broadcastHealth(conversationId, store, summary) {
  const sends = [];
  const decorated = await decorateHealthSummary(conversationId, summary);
  for (const [tabIdRaw, mappedId] of Object.entries(store.tabMap || {})) {
    if (String(mappedId) !== String(conversationId)) continue;
    const tabId = Number(tabIdRaw);
    if (!Number.isInteger(tabId)) continue;
    sends.push(chrome.tabs.sendMessage(tabId, { type: 'HEALTH_UPDATE', conversationId, summary: decorated }).catch(() => {}));
  }
  await Promise.allSettled(sends);
}


function normalizeProjectId(value) {
  const id = String(value || '').trim();
  const canonical = id.match(/^(g-p-[0-9a-f]{32})(?:$|[-_/])/i);
  if (canonical) return canonical[1];
  return id.startsWith('g-p-') ? id : '';
}

function emptyProjectContextStore() {
  return {
    projects: {},
    conversations: {},
    catalogLastFetchedAt: 0,
    catalogInFlightUntil: 0,
    projectDetailFetch: {}
  };
}

async function getProjectContextStore() {
  const stored = await chrome.storage.session.get(PROJECT_CONTEXT_KEY);
  const raw = stored[PROJECT_CONTEXT_KEY] || {};
  return {
    ...emptyProjectContextStore(),
    ...raw,
    projects: { ...(raw.projects || {}) },
    conversations: { ...(raw.conversations || {}) },
    projectDetailFetch: { ...(raw.projectDetailFetch || {}) }
  };
}

async function setProjectContextStore(store) {
  await chrome.storage.session.set({ [PROJECT_CONTEXT_KEY]: store });
}

function mergeProjectRecord(store, project, source, now) {
  const id = normalizeProjectId(project?.id || project?.projectId || project?.gizmo_id || project?.project_id);
  if (!id) return false;
  const current = store.projects[id] || {};
  const name = String(project?.name || project?.display?.name || current.name || '').trim();
  const nextSource = String(source || current.source || '');
  const changed = String(current.id || '') !== id || String(current.name || '') !== name || String(current.source || '') !== nextSource;
  store.projects[id] = changed ? { ...current, id, name, source: nextSource, updatedAt: now } : current;
  return changed;
}

function mergeConversationRecord(store, record, source, now) {
  const conversationId = normalizeConversationId(record?.conversationId || record?.id);
  if (!conversationId) return false;
  const current = store.conversations[conversationId] || {};
  const projectId = normalizeProjectId(record?.projectId || record?.gizmo_id || record?.project_id || current.projectId);
  const projectName = String(record?.projectName || (projectId ? store.projects[projectId]?.name : '') || current.projectName || '').trim();
  const conversationTitle = String(record?.conversationTitle || record?.title || current.conversationTitle || '').trim();
  const nextSource = String(source || current.source || '');
  const changed = String(current.conversationId || '') !== conversationId ||
    String(current.projectId || '') !== projectId ||
    String(current.projectName || '') !== projectName ||
    String(current.conversationTitle || '') !== conversationTitle ||
    String(current.source || '') !== nextSource;
  store.conversations[conversationId] = changed ? {
    ...current,
    conversationId,
    projectId,
    projectName,
    conversationTitle,
    source: nextSource,
    updatedAt: now
  } : current;
  return changed;
}

async function projectContextForConversation(conversationId) {
  const id = normalizeConversationId(conversationId);
  if (!id) return { conversationId: '', projectId: '', projectName: '', conversationTitle: '' };
  const store = await getProjectContextStore();
  const record = { conversationId: id, ...(store.conversations[id] || {}) };
  if (record.projectId && !record.projectName) record.projectName = String(store.projects[record.projectId]?.name || '');
  return record;
}

async function updateProjectContext(message, sender) {
  const now = Date.now();
  const store = await getProjectContextStore();
  const source = String(message.source || 'page');
  let changed = false;
  const touchedConversations = new Set();

  if (Array.isArray(message.projects)) {
    for (const project of message.projects) {
      const projectId = normalizeProjectId(project?.id || project?.projectId || project?.gizmo_id || project?.project_id);
      changed = mergeProjectRecord(store, project, source, now) || changed;
      if (projectId) {
        const currentFetch = { lastRequestedAt: 0, inFlightUntil: 0, ...(store.projectDetailFetch[projectId] || {}) };
        store.projectDetailFetch[projectId] = { ...currentFetch, inFlightUntil: 0, lastRequestedAt: Math.max(Number(currentFetch.lastRequestedAt || 0), now) };
      }
    }
    if (message.catalog === true) {
      store.catalogLastFetchedAt = now;
      store.catalogInFlightUntil = 0;
    }
  }

  if (Array.isArray(message.conversations)) {
    for (const record of message.conversations) {
      const id = normalizeConversationId(record?.conversationId || record?.id);
      const recordChanged = mergeConversationRecord(store, record, source, now);
      if (id && recordChanged) touchedConversations.add(id);
      changed = recordChanged || changed;
    }
  }

  if (message.conversation) {
    const id = normalizeConversationId(message.conversation?.conversationId || message.conversation?.id);
    const recordChanged = mergeConversationRecord(store, message.conversation, source, now);
    if (id && recordChanged) touchedConversations.add(id);
    changed = recordChanged || changed;
  }

  // Fill names for conversations after a catalog update.
  if (Array.isArray(message.projects) && message.projects.length) {
    for (const [id, record] of Object.entries(store.conversations)) {
      if (record.projectId && store.projects[record.projectId]?.name && record.projectName !== store.projects[record.projectId].name) {
        store.conversations[id] = { ...record, projectName: store.projects[record.projectId].name, updatedAt: now };
        touchedConversations.add(id);
        changed = true;
      }
    }
  }

  if (sender?.tab?.id !== undefined && message.conversation?.conversationId) {
    const health = await getHealthStore();
    health.tabMap[String(sender.tab.id)] = normalizeConversationId(message.conversation.conversationId);
    await setHealthStore(health);
  }

  if (changed || message.catalog === true) await setProjectContextStore(store);

  // Re-render overlays when a project name/title becomes known.
  if (touchedConversations.size || (Array.isArray(message.projects) && message.projects.length)) {
    const healthStore = await getHealthStore();
    for (const conversationId of touchedConversations) {
      const state = { ...createHealthState(conversationId), ...(healthStore.health[conversationId] || {}) };
      const summary = { ...deriveHealth(state, Date.now(), settings), ...state, timeline: Array.isArray(state.timeline) ? state.timeline.slice(-12) : [] };
      await broadcastHealth(conversationId, healthStore, summary);
      const isOpen = Object.values(healthStore.tabMap || {}).some(mappedId => String(mappedId) === String(conversationId));
      if (isOpen) {
        const cfg = await getDevHubConfig();
        if (cfg.enabled && cfg.autoProjectMapping && cfg.submitOnOpen) {
          setTimeout(() => {
            (async () => {
              await maybeSubmitDevHub(conversationId, 'PROJECT_CONTEXT_RESOLVED', summary, false);
              await refreshDevHubLiveness(conversationId, false);
            })().catch(() => {});
          }, 0);
        }
      }
    }
  }
  return { ok: true, changed };
}

function ruleSummary(context, cfg) {
  if (!cfg.autoProjectMapping) return null;
  return matchAutoRule(context, cfg.autoRules);
}

async function resolveDevHubTarget(conversationId, cfg = null) {
  const config = cfg || await getDevHubConfig();
  const context = await projectContextForConversation(conversationId);
  const rule = ruleSummary(context, config);
  const resolved = resolveProfileRoute(config.profiles, config.bindings[conversationId], rule);
  return { ...resolved, context };
}

async function decorateHealthSummary(conversationId, summary) {
  const cfg = await getDevHubConfig();
  const resolved = await resolveDevHubTarget(conversationId, cfg);
  const ctx = resolved.context || {};
  const autoTokenReady = resolved.source === 'auto' && resolved.profileId ? Boolean(await getDevHubToken(resolved.profileId)) : false;
  const usageStatus = await getUsageStatus();
  return {
    ...summary,
    conversationTitle: String(ctx.conversationTitle || ''),
    chatgptProjectId: String(ctx.projectId || ''),
    chatgptProjectName: String(ctx.projectName || ''),
    devhubBindingSource: resolved.source,
    devhubProfileSelection: String(resolved.profileSelection || ''),
    autoDevHubProject: resolved.source === 'auto' ? resolved.devhubProject : '',
    autoDevHubSlot: resolved.source === 'auto' ? resolved.targetSlot : '',
    autoMappingMatchedOn: resolved.rule?.matchedOn || '',
    autoProfileId: resolved.source === 'auto' ? resolved.profileId : '',
    autoProfileConfigured: resolved.source === 'auto' ? Boolean(resolved.profile) : false,
    autoTokenReady,
    autoProfileReady: resolved.source === 'auto' ? Boolean(resolved.profile && autoTokenReady) : false,
    usageStatus
  };
}

async function getDevHubConfig() {
  const stored = await chrome.storage.local.get(DEVHUB_CONFIG_KEY);
  const raw = stored[DEVHUB_CONFIG_KEY] || {};
  return {
    ...DEFAULT_DEVHUB_CONFIG,
    ...raw,
    profiles: Array.isArray(raw.profiles) ? raw.profiles : [],
    bindings: { ...(raw.bindings || {}) },
    autoProjectMapping: raw.autoProjectMapping !== false,
    autoRules: normalizeAutoRules(raw.autoRules)
  };
}

async function getDevHubToken(profileId) {
  const session = await chrome.storage.session.get(DEVHUB_SESSION_SECRETS_KEY);
  const sessionSecrets = session[DEVHUB_SESSION_SECRETS_KEY] || {};
  if (sessionSecrets[profileId]) return String(sessionSecrets[profileId]);
  const local = await chrome.storage.local.get(DEVHUB_LOCAL_SECRETS_KEY);
  const localSecrets = local[DEVHUB_LOCAL_SECRETS_KEY] || {};
  return localSecrets[profileId] ? String(localSecrets[profileId]) : '';
}

function devHubOriginPattern(baseUrl) {
  try {
    return `${new URL(baseUrl).origin}/*`;
  } catch {
    return '';
  }
}

async function devHubPermissionGranted(baseUrl) {
  const pattern = devHubOriginPattern(baseUrl);
  if (!pattern) return false;
  try { return await chrome.permissions.contains({ origins: [pattern] }); } catch { return false; }
}

async function maybeSubmitDevHub(conversationId, eventKind, healthState, force = false) {
  const cfg = await getDevHubConfig();
  if (!cfg.enabled) return { ok: false, skipped: 'disabled' };
  const resolved = await resolveDevHubTarget(conversationId, cfg);
  const profile = resolved.profile;
  if (!profile) return { ok: false, skipped: resolved.source === 'auto' ? 'auto_profile_missing' : 'unbound', auto: resolved };
  const profileId = String(profile.id || resolved.profileId || '');
  const targetSlot = String(resolved.targetSlot || profile.slotName || '').trim();
  const token = await getDevHubToken(profileId);
  if (!token) return { ok: false, skipped: 'token_missing', auto: resolved };
  const baseUrl = String(profile.baseUrl || cfg.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl || !(await devHubPermissionGranted(baseUrl))) return { ok: false, skipped: 'permission_missing', auto: resolved };

  const submitStateKey = 'devhubSubmitStateV4';
  const session = await chrome.storage.session.get(submitStateKey);
  const submitState = { ...(session[submitStateKey] || {}) };
  const submitKey = `${profileId}:${targetSlot}:${conversationId}`;
  const previous = submitState[submitKey] || {};
  const now = Date.now();
  const minGap = Math.max(15000, Number(cfg.minSubmitGapMs || 60000));
  const stateCode = String(healthState?.code || 'UNKNOWN');
  const sameState = previous.stateCode === stateCode;
  if (!force && sameState && now - Number(previous.at || 0) < minGap) return { ok: false, skipped: 'throttled', auto: resolved };

  let url = '';
  let body = null;
  if (profile.mode === 'manager_evidence') {
    if (!targetSlot) return { ok: false, skipped: 'slot_missing', auto: resolved };
    url = `${baseUrl}/api/session-activity-evidence`;
    const useGeneration = resolved.source === 'manual' || String(profile.slotName || '').trim() === targetSlot;
    body = {
      slot_name: targetSlot,
      session_generation: useGeneration && profile.sessionGeneration ? Number(profile.sessionGeneration) : null,
      source_kind: 'OTHER',
      observed_at: new Date(now).toISOString(),
      source_ref: `chatgpt-web:${conversationId}:${eventKind}`,
      summary: `ChatGPT Web ${eventKind}; health=${stateCode}; route=${resolved.devhubProject || '-'}:${targetSlot}`,
      details: {
        conversation_id: conversationId,
        conversation_title: String(resolved.context?.conversationTitle || ''),
        chatgpt_project_id: String(resolved.context?.projectId || ''),
        chatgpt_project_name: String(resolved.context?.projectName || ''),
        binding_source: resolved.source,
        profile_selection: String(resolved.profileSelection || ''),
        auto_matched_on: String(resolved.rule?.matchedOn || ''),
        devhub_project: String(resolved.devhubProject || profile.projectKey || ''),
        target_slot: targetSlot,
        event_kind: eventKind,
        health_code: stateCode,
        health_label: String(healthState?.label || ''),
        last_stream_status: String(healthState?.lastStreamStatusValue || ''),
        last_stream_probe: String(healthState?.lastStreamProbeValue || ''),
        last_stream_probe_at: Number(healthState?.lastStreamProbeOkAt || 0) || null,
        extension_version: '0.4.2'
      }
    };
  } else {
    // Direct heartbeat is intentionally never retargeted by auto rules: the token itself is slot-bound.
    if (resolved.source === 'auto' && targetSlot !== String(profile.slotName || '').trim()) {
      return { ok: false, skipped: 'auto_heartbeat_retarget_forbidden', auto: resolved };
    }
    url = `${baseUrl}/api/heartbeat`;
    body = { session_generation: profile.sessionGeneration ? Number(profile.sessionGeneration) : null };
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store'
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    submitState[submitKey] = { at: now, stateCode, eventKind };
    await chrome.storage.session.set({ [submitStateKey]: submitState });
    addStats({ devhubSubmits: 1, lastDevHubSubmitAt: now });
    return { ok: true, status: response.status, binding: { source: resolved.source, project: resolved.devhubProject, slot: targetSlot, profileId } };
  } catch (error) {
    addStats({ devhubSubmitFailures: 1, lastDevHubSubmitFailureAt: now, lastDevHubSubmitError: String(error?.message || error) });
    return { ok: false, error: String(error?.message || error), binding: { source: resolved.source, project: resolved.devhubProject, slot: targetSlot, profileId } };
  }
}

async function refreshDevHubLiveness(conversationId, force = false) {
  const cfg = await getDevHubConfig();
  if (!cfg.enabled) return { ok: false, skipped: 'disabled' };
  const resolved = await resolveDevHubTarget(conversationId, cfg);
  const profile = resolved.profile;
  if (!profile) return { ok: false, skipped: resolved.source === 'auto' ? 'auto_profile_missing' : 'unbound', auto: resolved };
  const profileId = String(profile.id || resolved.profileId || '');
  const targetSlot = String(resolved.targetSlot || profile.slotName || '').trim();
  if (profile.mode !== 'manager_evidence') return { ok: false, skipped: 'manager_token_required', auto: resolved };
  if (!targetSlot) return { ok: false, skipped: 'slot_missing', auto: resolved };
  const token = await getDevHubToken(profileId);
  if (!token) return { ok: false, skipped: 'token_missing', auto: resolved };
  const baseUrl = String(profile.baseUrl || cfg.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl || !(await devHubPermissionGranted(baseUrl))) return { ok: false, skipped: 'permission_missing', auto: resolved };

  const stateKey = 'devhubLivenessFetchStateV4';
  const session = await chrome.storage.session.get(stateKey);
  const state = { ...(session[stateKey] || {}) };
  const key = `${profileId}:${targetSlot}:${conversationId}`;
  const now = Date.now();
  const minGap = Math.max(30_000, Number(cfg.minSubmitGapMs || 60_000));
  if (!force && now - Number(state[key]?.at || 0) < minGap) {
    return { ok: false, skipped: 'throttled', cached: state[key]?.item || null };
  }

  try {
    const url = `${baseUrl}/api/session-liveness?heartbeat_stale_seconds=900`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'authorization': `Bearer ${token}`, 'accept': 'application/json' },
      cache: 'no-store'
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    const payload = await response.json();
    const items = Array.isArray(payload?.data?.items) ? payload.data.items : (Array.isArray(payload?.items) ? payload.items : []);
    const item = items.find(x => String(x?.slot_name || '') === targetSlot) || null;
    if (!item) throw new Error('SLOT_NOT_FOUND');

    const compact = {
      slotName: String(item.slot_name || targetSlot),
      state: String(item.state || ''),
      confidence: String(item.confidence || ''),
      heartbeatAgeSeconds: item.heartbeat_age_seconds === null || item.heartbeat_age_seconds === undefined ? null : Number(item.heartbeat_age_seconds),
      heartbeatRequired: item.heartbeat_required === null || item.heartbeat_required === undefined ? null : Boolean(item.heartbeat_required),
      activeTaskId: item.active_task_id === null || item.active_task_id === undefined ? null : Number(item.active_task_id),
      latestActivitySource: String(item.latest_activity?.source || ''),
      bindingSource: resolved.source,
      devhubProject: String(resolved.devhubProject || profile.projectKey || ''),
      chatgptProjectName: String(resolved.context?.projectName || ''),
      at: now
    };
    state[key] = { at: now, item: compact };
    await chrome.storage.session.set({ [stateKey]: state });
    await healthEvent({
      conversationId,
      event: {
        kind: 'DEVHUB_LIVENESS',
        at: now,
        state: compact.state,
        confidence: compact.confidence,
        heartbeatAgeSeconds: compact.heartbeatAgeSeconds,
        heartbeatRequired: compact.heartbeatRequired,
        activeTaskId: compact.activeTaskId,
        latestActivitySource: compact.latestActivitySource,
        bindingSource: compact.bindingSource,
        devhubProject: compact.devhubProject,
        targetSlot: compact.slotName,
        source: 'devhub'
      }
    }, {});
    addStats({ devhubLivenessReads: 1, lastDevHubLivenessReadAt: now });
    return { ok: true, item: compact };
  } catch (error) {
    addStats({ devhubLivenessFailures: 1, lastDevHubLivenessFailureAt: now, lastDevHubLivenessError: String(error?.message || error) });
    return { ok: false, error: String(error?.message || error), binding: { source: resolved.source, project: resolved.devhubProject, slot: targetSlot, profileId } };
  }
}

async function healthEvent(message, sender) {
  const event = { ...(message.event || {}) };
  const tabId = sender?.tab?.id ?? message.tabId ?? null;
  const eventConversationId = normalizeConversationId(message.conversationId || event.conversationId);

  let result = null;
  healthQueue = healthQueue.then(async () => {
    const store = await getHealthStore();
    let conversationId = eventConversationId;
    if (!conversationId && tabId !== null && tabId !== undefined) conversationId = normalizeConversationId(store.tabMap[String(tabId)]);
    if (!conversationId) {
      result = { ok: false, reason: 'NO_CONVERSATION' };
      return;
    }
    if (tabId !== null && tabId !== undefined) store.tabMap[String(tabId)] = conversationId;

    const now = Number(event.at || Date.now());
    const previous = { ...createHealthState(conversationId), ...(store.health[conversationId] || {}) };
    const kind = String(event.kind || '');
    const next = applyHealthEvent(previous, event, now);
    const derived = deriveHealth(next, Date.now(), settings);
    const stateChanged = previous.lastStateCode !== derived.code;
    next.lastStateCode = derived.code;
    if (stateChanged) {
      next.lastStateChangedAt = Date.now();
      addStats({ healthTransitions: 1, lastHealthTransitionAt: Date.now() });
    }
    store.health[conversationId] = next;
    await setHealthStore(store);

    if (kind === 'TURN_MUTATION') {
      await updateProbeCoordinator(conversationId, coord => ({ ...coord, lastGrantAt: 0, inFlightUntil: 0, terminalAt: 0 }));
      const storedPersistence = await chrome.storage.session.get(PERSISTENCE_CHECK_COORD_KEY);
      const persistenceMap = { ...(storedPersistence[PERSISTENCE_CHECK_COORD_KEY] || {}) };
      delete persistenceMap[conversationId];
      await chrome.storage.session.set({ [PERSISTENCE_CHECK_COORD_KEY]: persistenceMap });
    } else if (kind === 'PERSISTENCE_CHECK') {
      const storedPersistence = await chrome.storage.session.get(PERSISTENCE_CHECK_COORD_KEY);
      const persistenceMap = { ...(storedPersistence[PERSISTENCE_CHECK_COORD_KEY] || {}) };
      const existing = { lastGrantAt:0, inFlightUntil:0, ...(persistenceMap[conversationId] || {}) };
      persistenceMap[conversationId] = { ...existing, inFlightUntil:0 };
      await chrome.storage.session.set({ [PERSISTENCE_CHECK_COORD_KEY]: persistenceMap });
    } else if (kind === 'STREAM_PROBE') {
      await updateProbeCoordinator(conversationId, coord => ({
        ...coord,
        inFlightUntil: 0,
        terminalAt: event.terminal === true ? now : Number(coord.terminalAt || 0)
      }));
    }

    const summary = { ...derived, ...next, timeline: Array.isArray(next.timeline) ? next.timeline.slice(-12) : [] };
    result = { ok: true, conversationId, summary, stateChanged };
    await broadcastHealth(conversationId, store, summary);

    const devHubCfg = await getDevHubConfig();
    const shouldOpen = kind !== 'DEVHUB_LIVENESS' && (kind === 'PAGE_OPEN' || kind === 'PAGE_FOCUS') && devHubCfg.submitOnOpen;
    const shouldState = kind !== 'DEVHUB_LIVENESS' && stateChanged && devHubCfg.submitOnStateChange;
    if (shouldOpen || shouldState) {
      setTimeout(() => {
        (async () => {
          await maybeSubmitDevHub(conversationId, shouldState ? 'HEALTH_STATE_CHANGE' : kind, summary, false);
          await refreshDevHubLiveness(conversationId, false);
        })().catch(() => {});
      }, 0);
    }
  }).catch(error => { result = { ok: false, error: String(error) }; });
  await healthQueue;
  return result;
}

async function getHealthForTab(tabId) {
  const store = await getHealthStore();
  const conversationId = normalizeConversationId(store.tabMap[String(tabId)]);
  if (!conversationId) return { conversationId: '', summary: { ...deriveHealth(createHealthState(''), Date.now(), settings), usageStatus: await getUsageStatus() } };
  const state = { ...createHealthState(conversationId), ...(store.health[conversationId] || {}) };
  const summary = { ...deriveHealth(state, Date.now(), settings), ...state, timeline: Array.isArray(state.timeline) ? state.timeline.slice(-12) : [] };
  return { conversationId, summary: await decorateHealthSummary(conversationId, summary) };
}

function conversationIdFromBackendUrl(urlString) {
  try {
    const path = new URL(urlString).pathname;
    let m = path.match(/^\/backend-api\/conversation\/([^/]+)\/stream_status$/);
    if (m) return decodeURIComponent(m[1]);
    m = path.match(/^\/backend-api\/conversations\/([^/]+)$/);
    if (m) return decodeURIComponent(m[1]);
  } catch {}
  return '';
}

async function recordWebRequestTransport(details, ok) {
  const tabId = Number(details.tabId);
  if (!Number.isInteger(tabId) || tabId < 0) return;
  const store = await getHealthStore();
  const streamStatusConversationId = (() => {
    try {
      const m = new URL(details.url).pathname.match(/^\/backend-api\/conversation\/([^/]+)\/stream_status$/);
      return m ? decodeURIComponent(m[1]) : '';
    } catch { return ''; }
  })();
  let conversationId = streamStatusConversationId || conversationIdFromBackendUrl(details.url) || normalizeConversationId(store.tabMap[String(tabId)]);
  if (!conversationId) return;
  await healthEvent({ conversationId, tabId, event: { kind: ok ? 'BACKEND_OK' : 'BACKEND_ERROR', status: Number(details.statusCode || 0), error: details.error || '', source: 'webRequest' } }, { tab: { id: tabId } });
  if (!ok && streamStatusConversationId && Number(details.statusCode || 0) === 0 && details.type !== 'main_frame') {
    chrome.tabs.sendMessage(tabId, {
      type: 'RUN_AUTO_STREAM_PROBE',
      conversationId: streamStatusConversationId,
      cause: 'webrequest-stream-status-error'
    }).catch(() => {});
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  await chrome.storage.sync.set(normalizeSettings(existing));

  const stats = await chrome.storage.local.get(EMPTY_STATS);
  await chrome.storage.local.set({ ...EMPTY_STATS, ...stats });
  const devhubStored = await chrome.storage.local.get(DEVHUB_CONFIG_KEY);
  if (!devhubStored[DEVHUB_CONFIG_KEY]) await chrome.storage.local.set({ [DEVHUB_CONFIG_KEY]: { ...DEFAULT_DEVHUB_CONFIG } });
  await loadSettings();
});

chrome.runtime.onStartup.addListener(() => {
  loadSettings().catch(() => {});
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') return;
  if (Object.keys(changes).some(key => key in DEFAULT_SETTINGS)) {
    loadSettings().catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return;

  if (message.type === 'ACQUIRE') {
    acquire(message, sender).then(sendResponse).catch(error => sendResponse({ action: 'passthrough', error: String(error) }));
    return true;
  }

  if (message.type === 'COMPLETE') {
    complete(message).then(sendResponse).catch(error => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === 'NETWORK_ERROR') {
    complete({ ...message, status: 0 }).then(sendResponse).catch(error => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === 'INVALIDATE_CONVERSATION') {
    invalidateConversation(message.conversationId).then(() => sendResponse({ ok: true })).catch(error => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === 'CLEAR_SHARED_CACHE') {
    clearSharedCache(Boolean(message.forceNext)).then(() => sendResponse({ ok: true })).catch(error => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === 'RESET_STATS') {
    updateQueue = updateQueue.then(async () => {
      await chrome.storage.local.set({ ...EMPTY_STATS });
      sendResponse({ ok: true });
    }).catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === 'USAGE_SNAPSHOT') {
    recordUsageSnapshot(message).then(sendResponse).catch(error => sendResponse({ ok:false, error:String(error) }));
    return true;
  }

  if (message.type === 'USAGE_HEARTBEAT') {
    recordUsageHeartbeat(message).then(sendResponse).catch(error => sendResponse({ ok:false, error:String(error) }));
    return true;
  }

  if (message.type === 'GET_USAGE_STATUS') {
    getUsageStatus().then(sendResponse).catch(error => sendResponse({ error:String(error) }));
    return true;
  }

  if (message.type === 'PROJECT_CONTEXT_UPDATE') {
    updateProjectContext(message, sender).then(sendResponse).catch(error => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === 'HEALTH_EVENT') {
    healthEvent(message, sender).then(sendResponse).catch(error => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === 'REQUEST_STREAM_PROBE') {
    requestStreamProbe(message).then(sendResponse).catch(error => sendResponse({ action: 'skip', reason: 'error', error: String(error) }));
    return true;
  }

  if (message.type === 'REQUEST_PERSISTENCE_CHECK') {
    requestPersistenceCheck(message).then(sendResponse).catch(error => sendResponse({ action: 'skip', reason: 'error', error: String(error) }));
    return true;
  }

  if (message.type === 'GET_TAB_HEALTH') {
    const tabId = Number(message.tabId ?? sender?.tab?.id);
    getHealthForTab(tabId).then(sendResponse).catch(error => sendResponse({ error: String(error) }));
    return true;
  }

  if (message.type === 'SET_DEVHUB_SECRET') {
    (async () => {
      const profileId = String(message.profileId || '').trim();
      const token = String(message.token || '').trim();
      if (!profileId || !token) return sendResponse({ ok: false, error: 'PROFILE_OR_TOKEN_MISSING' });
      const key = message.remember ? DEVHUB_LOCAL_SECRETS_KEY : DEVHUB_SESSION_SECRETS_KEY;
      const area = message.remember ? chrome.storage.local : chrome.storage.session;
      const stored = await area.get(key);
      const secrets = { ...(stored[key] || {}) };
      secrets[profileId] = token;
      await area.set({ [key]: secrets });
      if (!message.remember) {
        const local = await chrome.storage.local.get(DEVHUB_LOCAL_SECRETS_KEY);
        const localSecrets = { ...(local[DEVHUB_LOCAL_SECRETS_KEY] || {}) };
        if (localSecrets[profileId]) {
          delete localSecrets[profileId];
          await chrome.storage.local.set({ [DEVHUB_LOCAL_SECRETS_KEY]: localSecrets });
        }
      } else {
        const session = await chrome.storage.session.get(DEVHUB_SESSION_SECRETS_KEY);
        const sessionSecrets = { ...(session[DEVHUB_SESSION_SECRETS_KEY] || {}) };
        if (sessionSecrets[profileId]) {
          delete sessionSecrets[profileId];
          await chrome.storage.session.set({ [DEVHUB_SESSION_SECRETS_KEY]: sessionSecrets });
        }
      }
      sendResponse({ ok: true });
    })().catch(error => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === 'DELETE_DEVHUB_SECRET') {
    (async () => {
      const profileId = String(message.profileId || '').trim();
      for (const [area, key] of [[chrome.storage.session, DEVHUB_SESSION_SECRETS_KEY], [chrome.storage.local, DEVHUB_LOCAL_SECRETS_KEY]]) {
        const stored = await area.get(key);
        const secrets = { ...(stored[key] || {}) };
        delete secrets[profileId];
        await area.set({ [key]: secrets });
      }
      sendResponse({ ok: true });
    })().catch(error => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === 'DEVHUB_SEND_NOW') {
    (async () => {
      const tabId = Number(message.tabId ?? sender?.tab?.id);
      const health = await getHealthForTab(tabId);
      if (!health.conversationId) return sendResponse({ ok: false, error: 'NO_CONVERSATION' });
      const submit = await maybeSubmitDevHub(health.conversationId, 'MANUAL_SUBMIT', health.summary, true);
      const liveness = await refreshDevHubLiveness(health.conversationId, true);
      sendResponse({ ok: Boolean(submit?.ok || liveness?.ok), submit, liveness });
    })().catch(error => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === 'DEVHUB_REFRESH_LIVENESS') {
    (async () => {
      const tabId = Number(message.tabId ?? sender?.tab?.id);
      const health = await getHealthForTab(tabId);
      if (!health.conversationId) return sendResponse({ ok: false, error: 'NO_CONVERSATION' });
      sendResponse(await refreshDevHubLiveness(health.conversationId, true));
    })().catch(error => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === 'GET_STATUS') {
    statusSnapshot().then(sendResponse).catch(error => sendResponse({ error: String(error) }));
    return true;
  }
});

chrome.webRequest.onCompleted.addListener(
  details => { recordWebRequestTransport(details, Number(details.statusCode || 0) < 400).catch(() => {}); },
  { urls: ['https://chatgpt.com/backend-api/*'] }
);

chrome.webRequest.onErrorOccurred.addListener(
  details => { recordWebRequestTransport(details, false).catch(() => {}); },
  { urls: ['https://chatgpt.com/backend-api/*'] }
);

chrome.tabs.onRemoved.addListener(tabId => {
  healthQueue = healthQueue.then(async () => {
    const store = await getHealthStore();
    delete store.tabMap[String(tabId)];
    await setHealthStore(store);
  }).catch(() => {});
});

loadSettings().catch(() => {});
