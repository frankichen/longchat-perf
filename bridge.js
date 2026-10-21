(() => {
  'use strict';

  const CHANNEL = 'chatgpt-task-vital-monitor-v4-1';
  const DEFAULTS = {
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
    overlayEnabled: true,
    cacheBustNonce: 0
  };

  let currentSettings = { ...DEFAULTS };
  const manualPending = new Map();
  let manualSeq = 0;

  function post(type, payload = {}) {
    window.postMessage({ channel: CHANNEL, type, ...payload }, location.origin);
  }

  function sendConfig() {
    post('CONFIG', { config: currentSettings });
  }

  async function loadSettings() {
    const stored = await chrome.storage.sync.get(DEFAULTS);
    currentSettings = { ...DEFAULTS, ...stored };
    sendConfig();
  }

  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.channel !== CHANNEL) return;

    if (message.type === 'READY') {
      sendConfig();
      return;
    }

    if (message.type === 'ACQUIRE') {
      chrome.runtime.sendMessage({ type: 'ACQUIRE', key: message.key, url: message.url, kind: message.kind, conversationId: message.conversationId })
        .then(result => post('ACQUIRE_RESULT', { requestId: message.requestId, result }))
        .catch(error => post('ACQUIRE_RESULT', { requestId: message.requestId, result: { action: 'passthrough', error: String(error) } }));
      return;
    }

    if (message.type === 'COMPLETE') {
      chrome.runtime.sendMessage({
        type: 'COMPLETE',
        leaseId: message.leaseId,
        status: message.status,
        snapshot: message.snapshot,
        cacheClass: message.cacheClass,
        retryAfterMs: message.retryAfterMs
      }).then(result => post('COMPLETE_RESULT', { requestId: message.requestId, result }))
        .catch(error => post('COMPLETE_RESULT', { requestId: message.requestId, result: { ok: false, error: String(error) } }));
      return;
    }

    if (message.type === 'NETWORK_ERROR') {
      chrome.runtime.sendMessage({ type: 'NETWORK_ERROR', leaseId: message.leaseId }).catch(() => {});
      return;
    }

    if (message.type === 'INVALIDATE_CONVERSATION' && message.conversationId) {
      chrome.runtime.sendMessage({ type: 'INVALIDATE_CONVERSATION', conversationId: message.conversationId }).catch(() => {});
      return;
    }

    if (message.type === 'HEALTH_EVENT' && message.conversationId) {
      chrome.runtime.sendMessage({ type: 'HEALTH_EVENT', conversationId: message.conversationId, event: message.event }).catch(() => {});
      return;
    }

    if (message.type === 'USAGE_SNAPSHOT' && message.snapshot) {
      chrome.runtime.sendMessage({ type: 'USAGE_SNAPSHOT', snapshot: message.snapshot }).catch(() => {});
      return;
    }

    if (message.type === 'USAGE_HEARTBEAT') {
      chrome.runtime.sendMessage({ type: 'USAGE_HEARTBEAT', at: Number(message.at || Date.now()), source: message.source || '' }).catch(() => {});
      return;
    }

    if (message.type === 'PROJECT_CONTEXT_UPDATE') {
      chrome.runtime.sendMessage({
        type: 'PROJECT_CONTEXT_UPDATE',
        source: message.source || '',
        catalog: Boolean(message.catalog),
        projects: Array.isArray(message.projects) ? message.projects : undefined,
        conversations: Array.isArray(message.conversations) ? message.conversations : undefined,
        conversation: message.conversation || undefined
      }).catch(() => {});
      return;
    }

    if (message.type === 'REQUEST_STREAM_PROBE' && message.conversationId) {
      chrome.runtime.sendMessage({
        type: 'REQUEST_STREAM_PROBE',
        conversationId: message.conversationId,
        cause: message.cause || '',
        force: Boolean(message.force)
      }).then(result => post('STREAM_PROBE_DECISION', { requestId: message.requestId, result }))
        .catch(error => post('STREAM_PROBE_DECISION', { requestId: message.requestId, result: { action: 'skip', error: String(error) } }));
      return;
    }

    if (message.type === 'REQUEST_PERSISTENCE_CHECK' && message.conversationId) {
      chrome.runtime.sendMessage({
        type: 'REQUEST_PERSISTENCE_CHECK',
        conversationId: message.conversationId,
        cause: message.cause || '',
        force: Boolean(message.force)
      }).then(result => post('PERSISTENCE_CHECK_DECISION', { requestId: message.requestId, result }))
        .catch(error => post('PERSISTENCE_CHECK_DECISION', { requestId: message.requestId, result: { action: 'skip', error: String(error) } }));
      return;
    }

    if (message.type === 'MANUAL_DIAGNOSE_RESULT') {
      const pending = manualPending.get(message.requestId);
      if (!pending) return;
      manualPending.delete(message.requestId);
      clearTimeout(pending.timer);
      pending.sendResponse(message.result || { ok: false });
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'RUN_AUTO_STREAM_PROBE' && message.conversationId) {
      post('AUTO_STREAM_PROBE', {
        conversationId: message.conversationId,
        cause: message.cause || 'background-error'
      });
      sendResponse({ ok: true });
      return;
    }
    if (message.type === 'RUN_MANUAL_DIAGNOSE') {
      const requestId = `manual-${Date.now()}-${++manualSeq}`;
      const timer = setTimeout(() => {
        const pending = manualPending.get(requestId);
        if (!pending) return;
        manualPending.delete(requestId);
        pending.sendResponse({ ok: false, error: 'TIMEOUT' });
      }, 30_000);
      manualPending.set(requestId, { sendResponse, timer });
      post('MANUAL_DIAGNOSE', { requestId });
      return true;
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') return;
    let changed = false;
    for (const key of Object.keys(DEFAULTS)) {
      if (changes[key]) {
        currentSettings[key] = changes[key].newValue;
        changed = true;
      }
    }
    if (changed) sendConfig();
  });

  loadSettings().catch(() => sendConfig());
})();
