(() => {
  'use strict';

  const CHANNEL = 'chatgpt-task-vital-monitor-v4-1';
  const originalFetch = window.fetch.bind(window);
  const nativeXHROpen = XMLHttpRequest.prototype.open;
  const nativeXHRSend = XMLHttpRequest.prototype.send;
  const NativeEventSource = window.EventSource;
  const xhrInfo = new WeakMap();
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
    cacheBustNonce: 0
  };

  let config = { ...DEFAULTS };
  const pending = new Map();
  const passiveStreamFailures = new Map();
  const probeInFlight = new Set();
  const persistenceTimers = new Map();
  const streamingVerificationTimers = new Map();
  let seq = 0;
  let lastRouteConversationId = '';
  let lastObservedDocumentTitle = '';

  function post(type, payload = {}) {
    window.postMessage({ channel: CHANNEL, type, ...payload }, location.origin);
  }

  function health(kind, payload = {}, conversationId = '') {
    const id = conversationId || currentConversationId();
    if (!id) return;
    post('HEALTH_EVENT', { conversationId: id, event: { kind, at: Date.now(), ...payload } });
  }


  function sanitizeUsageWindow(value) {
    if (!value || typeof value !== 'object') return null;
    const numberOrNull = v => Number.isFinite(Number(v)) ? Number(v) : null;
    return {
      usedPercent: numberOrNull(value.used_percent),
      limitWindowSeconds: numberOrNull(value.limit_window_seconds),
      resetAfterSeconds: numberOrNull(value.reset_after_seconds),
      resetAt: numberOrNull(value.reset_at)
    };
  }

  function sanitizeUsagePayload(data, source = 'page') {
    const root = data?.usage && typeof data.usage === 'object' ? data.usage : data;
    if (!root || typeof root !== 'object') return null;
    const rate = root.rate_limit && typeof root.rate_limit === 'object' ? root.rate_limit : null;
    if (!rate) return null;
    const models = {};
    if (root.model_usage && typeof root.model_usage === 'object') {
      for (const [name, value] of Object.entries(root.model_usage)) {
        if (!name || !value || typeof value !== 'object') continue;
        models[String(name).slice(0, 120)] = {
          available: value.available === true,
          availableAt: Number.isFinite(Number(value.available_at)) ? Number(value.available_at) : null,
          creditsWouldEnable: value.credits_would_enable === true
        };
      }
    }
    return {
      version: Number.isFinite(Number(data?.version)) ? Number(data.version) : 1,
      sequence: Number.isFinite(Number(data?.sequence)) ? Number(data.sequence) : null,
      generatedAtMs: Number.isFinite(Number(data?.generated_at_ms)) ? Number(data.generated_at_ms) : Date.now(),
      source,
      planType: String(root.plan_type || '').slice(0, 60),
      allowed: rate.allowed !== false,
      limitReached: rate.limit_reached === true,
      rateLimitReachedType: typeof root.rate_limit_reached_type === 'string' ? root.rate_limit_reached_type.slice(0, 120) : (root.rate_limit_reached_type?.type ? String(root.rate_limit_reached_type.type).slice(0, 120) : ''),
      primaryWindow: sanitizeUsageWindow(rate.primary_window),
      secondaryWindow: sanitizeUsageWindow(rate.secondary_window),
      spendControlReached: root.spend_control?.reached === true,
      resetCreditsAvailable: Number.isFinite(Number(root.rate_limit_reset_credits?.available_count)) ? Number(root.rate_limit_reset_credits.available_count) : null,
      resetCreditsApplicable: Number.isFinite(Number(root.rate_limit_reset_credits?.applicable_available_count)) ? Number(root.rate_limit_reset_credits.applicable_available_count) : null,
      models
    };
  }

  function publishUsageSnapshot(data, source = 'page') {
    if (!config.enabled) return;
    const snapshot = sanitizeUsagePayload(data, source);
    if (snapshot) post('USAGE_SNAPSHOT', { snapshot });
  }

  function publishUsageHeartbeat(source = 'page') {
    if (!config.enabled) return;
    post('USAGE_HEARTBEAT', { at: Date.now(), source });
  }

  function parseUsageSseBlock(block, source = 'fetch-sse') {
    if (!block) return;
    let eventType = '';
    const dataLines = [];
    for (const rawLine of String(block).split(/\r?\n/)) {
      const line = rawLine.trimEnd();
      if (line.startsWith('event:')) eventType = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (eventType === 'usage.heartbeat') {
      publishUsageHeartbeat(source);
      return;
    }
    if (eventType !== 'usage.snapshot' || !dataLines.length) return;
    try { publishUsageSnapshot(JSON.parse(dataLines.join('\n')), source); } catch {}
  }

  async function observeUsageStreamResponse(info, response) {
    try {
      if (!info?.url || info.url.origin !== location.origin || !response?.ok) return;
      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      const path = String(info.url.pathname || '').toLowerCase();
      if (!contentType.includes('text/event-stream') || !path.includes('usage')) return;
      const clone = response.clone();
      if (!clone.body?.getReader) return;
      const reader = clone.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 262144) buffer = buffer.slice(-131072);
        for (;;) {
          const m = buffer.match(/\r?\n\r?\n/);
          if (!m || m.index === undefined) break;
          const idx = m.index;
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + m[0].length);
          parseUsageSseBlock(block, 'fetch-sse');
        }
      }
      if (buffer.trim()) parseUsageSseBlock(buffer, 'fetch-sse');
    } catch {}
  }

  async function observeUsageJsonResponse(info, response) {
    try {
      if (!info?.url || info.url.origin !== location.origin || !response?.ok) return;
      const path = String(info.url.pathname || '').toLowerCase();
      if (!(path === '/backend-api/wham/usage' || path === '/backend-api/codex/usage' || path.endsWith('/usage'))) return;
      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('text/event-stream')) {
        observeUsageStreamResponse(info, response).catch(() => {});
        return;
      }
      if (!contentType.includes('json')) return;
      const data = await response.clone().json();
      publishUsageSnapshot(data, 'usage-json');
    } catch {}
  }

  function installEventSourceUsageObserver() {
    if (typeof NativeEventSource !== 'function') return;
    try {
      class ObservedEventSource extends NativeEventSource {
        constructor(url, eventSourceInitDict) {
          super(url, eventSourceInitDict);
          try {
            this.addEventListener('usage.snapshot', event => {
              try { publishUsageSnapshot(JSON.parse(String(event?.data || '{}')), 'eventsource'); } catch {}
            });
            this.addEventListener('usage.heartbeat', () => publishUsageHeartbeat('eventsource'));
          } catch {}
        }
      }
      Object.defineProperty(window, 'EventSource', { configurable: true, enumerable: true, writable: true, value: ObservedEventSource });
    } catch {}
  }

  function normalizePath(pathname) {
    return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  }

  function requestInfo(input, init) {
    const rawUrl = input instanceof Request ? input.url : String(input);
    let url;
    try { url = new URL(rawUrl, location.href); } catch { return null; }
    const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const signal = init?.signal || (input instanceof Request ? input.signal : null);
    const credentials = String(init?.credentials || (input instanceof Request ? input.credentials : 'same-origin'));
    return { url, method, signal, credentials };
  }

  function classifyTarget(info) {
    if (!info || info.method !== 'GET' || info.url.origin !== location.origin) return null;
    const path = normalizePath(info.url.pathname);
    if (path === '/backend-api/conversations') return { kind: 'list', conversationId: null };
    const match = path.match(/^\/backend-api\/conversations\/([^/]+)$/);
    if (match) return { kind: 'detail', conversationId: decodeURIComponent(match[1]) };
    return null;
  }

  function classifyHealthTarget(info) {
    if (!info || info.url.origin !== location.origin) return null;
    const path = normalizePath(info.url.pathname);
    const stream = path.match(/^\/backend-api\/conversation\/([^/]+)\/stream_status$/);
    if (stream) return { kind: 'stream_status', conversationId: decodeURIComponent(stream[1]) };
    if (/\/conversation(?:\/[^/]+)?\/resume$/.test(path) || /\/f\/conversation\/resume$/.test(path)) {
      return { kind: 'resume', conversationId: currentConversationId() };
    }
    return null;
  }

  function currentConversationId() {
    const match = location.pathname.match(/(?:^|\/)c\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  function projectIdFromLocation() {
    try {
      const parts = location.pathname.split('/').map(part => decodeURIComponent(part));
      const found = parts.find(part => String(part || '').startsWith('g-p-')) || '';
      return normalizeProjectId(found);
    } catch {
      return '';
    }
  }

  function inferredConversationTitle() {
    let title = String(document.title || '').trim();
    title = title.replace(/\s*[|\-–—]\s*ChatGPT\s*$/i, '').trim();
    if (/^chatgpt$/i.test(title)) return '';
    return title;
  }

  function projectNameFromDom(projectId) {
    const id = normalizeProjectId(projectId);
    if (!id || !document.querySelectorAll) return '';
    try {
      const candidates = [];
      for (const anchor of document.querySelectorAll('a[href]')) {
        const href = String(anchor.getAttribute('href') || '');
        if (!href.includes(id)) continue;
        const text = String(anchor.textContent || '').replace(/\s+/g, ' ').trim();
        if (text && text.length <= 160) candidates.push(text);
      }
      candidates.sort((a,b) => a.length - b.length);
      return candidates[0] || '';
    } catch {
      return '';
    }
  }

  function normalizeProjectId(value) {
    const id = String(value || '').trim();
    const canonical = id.match(/^(g-p-[0-9a-f]{32})(?:$|[-_/])/i);
    if (canonical) return canonical[1];
    return id.startsWith('g-p-') ? id : '';
  }

  function collectProjectRecords(data) {
    const out = new Map();
    const seen = new WeakSet();
    const queue = [{ value: data, depth: 0 }];
    let visited = 0;
    while (queue.length && visited < 5000) {
      const { value, depth } = queue.shift();
      if (!value || typeof value !== 'object') continue;
      if (seen.has(value)) continue;
      seen.add(value);
      visited += 1;
      if (!Array.isArray(value)) {
        const id = normalizeProjectId(value.id || value.project_id || value.projectId || value.gizmo_id);
        const name = String(value.display?.name || value.name || '').trim();
        if (id && name) out.set(id, { id, name });
      }
      if (depth >= 7) continue;
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child === 'object') queue.push({ value: child, depth: depth + 1 });
      } else {
        for (const child of Object.values(value)) if (child && typeof child === 'object') queue.push({ value: child, depth: depth + 1 });
      }
    }
    return Array.from(out.values());
  }

  function conversationContextFromData(data, conversationIdHint = '') {
    const hint = String(conversationIdHint || '');
    const seen = new WeakSet();
    const queue = [{ value: data, depth: 0 }];
    let best = null;
    let visited = 0;
    while (queue.length && visited < 4000) {
      const { value, depth } = queue.shift();
      if (!value || typeof value !== 'object') continue;
      if (seen.has(value)) continue;
      seen.add(value);
      visited += 1;
      if (!Array.isArray(value)) {
        const id = String(value.id || value.conversation_id || value.conversationId || '').trim();
        const projectId = normalizeProjectId(value.gizmo_id || value.project_id || value.projectId || value.conversation_template_id);
        const title = String(value.title || value.name || '').trim();
        const matchesHint = hint && id === hint;
        const looksConversation = Boolean(matchesHint || projectId || (id && title && depth <= 3));
        if (looksConversation) {
          const score = (matchesHint ? 100 : 0) + (projectId ? 30 : 0) + (title ? 10 : 0) - depth;
          if (!best || score > best.score) best = { score, conversationId: hint || id, projectId, conversationTitle: title };
        }
      }
      if (depth >= 6) continue;
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child === 'object') queue.push({ value: child, depth: depth + 1 });
      } else {
        for (const child of Object.values(value)) if (child && typeof child === 'object') queue.push({ value: child, depth: depth + 1 });
      }
    }
    if (!best) return null;
    delete best.score;
    if (!best.conversationId) best.conversationId = hint;
    return best;
  }

  function projectObservationTarget(info) {
    if (!info || info.method !== 'GET' || info.url.origin !== location.origin) return null;
    const path = normalizePath(info.url.pathname);
    if (path === '/backend-api/pins' && info.url.searchParams.get('item_type') === 'project') return { kind: 'catalog', source: 'pins' };
    if (path === '/backend-api/gizmos/snorlax/sidebar') return { kind: 'catalog', source: 'sidebar' };
    let m = path.match(/^\/backend-api\/gizmos\/(g-p-[^/]+)\/conversations$/);
    if (m) return { kind: 'project_conversations', source: 'project_conversations', projectId: decodeURIComponent(m[1]) };
    m = path.match(/^\/backend-api\/gizmos\/(g-p-[^/]+)$/);
    if (m) return { kind: 'project_detail', source: 'project_detail', projectId: decodeURIComponent(m[1]) };
    m = path.match(/^\/backend-api\/conversations?\/([^/]+)$/);
    if (m) return { kind: 'conversation_detail', source: 'conversation_detail', conversationId: decodeURIComponent(m[1]) };
    return null;
  }

  async function observeProjectPayload(target, body) {
    if (!target || !body) return;
    let data;
    try { data = JSON.parse(body); } catch { return; }
    if (target.kind === 'catalog' || target.kind === 'project_detail') {
      const projects = collectProjectRecords(data);
      if (projects.length) post('PROJECT_CONTEXT_UPDATE', { source: target.source, catalog: target.kind === 'catalog', projects });
      else if (target.kind === 'catalog') post('PROJECT_CONTEXT_UPDATE', { source: target.source, catalog: true, projects: [] });
      return;
    }
    if (target.kind === 'project_conversations') {
      const items = Array.isArray(data?.items) ? data.items : (Array.isArray(data?.conversations?.items) ? data.conversations.items : []);
      const conversations = items.map(item => ({
        conversationId: String(item?.id || item?.conversation_id || ''),
        projectId: normalizeProjectId(item?.gizmo_id || target.projectId),
        conversationTitle: String(item?.title || '').trim()
      })).filter(item => item.conversationId);
      if (conversations.length) post('PROJECT_CONTEXT_UPDATE', { source: target.source, conversations });
      return;
    }
    if (target.kind === 'conversation_detail') {
      const context = conversationContextFromData(data, target.conversationId);
      if (context) {
        if (context.projectId) context.projectName = projectNameFromDom(context.projectId);
        post('PROJECT_CONTEXT_UPDATE', { source: target.source, conversation: context });
      }
    }
  }

  async function observeProjectResponse(info, response) {
    const target = projectObservationTarget(info);
    if (!target || !response?.ok) return;
    try { await observeProjectPayload(target, await response.clone().text()); } catch {}
  }

  function mutationConversationId(info) {
    if (!info || info.method === 'GET' || info.url.origin !== location.origin) return null;
    const path = normalizePath(info.url.pathname);
    if (!path.includes('conversation')) return null;
    if (/\/conversation(?:\/[^/]+)?\/resume$/.test(path) || /\/f\/conversation\/resume$/.test(path)) return null;
    const match = path.match(/^\/backend-api\/conversations?\/([^/]+)$/);
    if (match && match[1] !== 'resume') return decodeURIComponent(match[1]);
    return currentConversationId();
  }

  function stableKey(info) {
    const url = new URL(info.url.href);
    url.hash = '';
    const entries = Array.from(url.searchParams.entries()).sort(([ak, av], [bk, bv]) => {
      const kc = ak.localeCompare(bk);
      return kc || av.localeCompare(bv);
    });
    url.search = '';
    for (const [k, v] of entries) url.searchParams.append(k, v);
    return `v043 ${info.credentials} ${url.href}`;
  }

  function requestBridge(type, payload, responseType, signal) {
    if (signal?.aborted) return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
    const requestId = `${Date.now()}-${++seq}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`Task Vital Monitor bridge timeout: ${type}`));
      }, 10_000);
      const onAbort = () => {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      pending.set(requestId, {
        responseType,
        resolve: value => {
          clearTimeout(timer);
          if (signal) signal.removeEventListener('abort', onAbort);
          resolve(value);
        }
      });
      post(type, { requestId, ...payload });
    });
  }

  function sleep(ms, signal) {
    if (signal?.aborted) return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      if (signal) {
        const onAbort = () => {
          clearTimeout(timer);
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  async function snapshotResponse(response) {
    const clone = response.clone();
    return {
      body: await clone.text(),
      status: clone.status,
      statusText: clone.statusText,
      headers: Array.from(clone.headers.entries()),
      url: clone.url,
      redirected: clone.redirected,
      type: clone.type
    };
  }

  function restoreResponse(snapshot) {
    const response = new Response(snapshot.body, { status: snapshot.status, statusText: snapshot.statusText, headers: snapshot.headers });
    try { Object.defineProperty(response, 'url', { value: snapshot.url || '', configurable: true }); } catch {}
    try { Object.defineProperty(response, 'redirected', { value: Boolean(snapshot.redirected), configurable: true }); } catch {}
    try { Object.defineProperty(response, 'type', { value: snapshot.type || 'basic', configurable: true }); } catch {}
    return response;
  }

  function synthetic429(retryAfterMs) {
    const seconds = Math.max(1, Math.ceil((Number(retryAfterMs) || 60_000) / 1000));
    return new Response(JSON.stringify({ detail: 'Too many requests (blocked locally during guard cooldown)' }), {
      status: 429,
      statusText: 'Too Many Requests',
      headers: { 'content-type': 'application/json', 'retry-after': String(seconds), 'x-chatgpt-request-guard': 'local-backoff' }
    });
  }

  function retryAfterMs(snapshot) {
    if (!snapshot?.headers) return 0;
    const pair = snapshot.headers.find(([name]) => String(name).toLowerCase() === 'retry-after');
    if (!pair) return 0;
    const raw = String(pair[1] || '').trim();
    if (!raw) return 0;
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const at = Date.parse(raw);
    return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
  }

  function messageSignal(message) {
    const metadata = message?.metadata || {};
    const role = String(message?.author?.role || message?.role || '').toLowerCase();
    const status = String(message?.status || metadata?.status || '').toLowerCase();
    const content = message?.content;
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    const text = parts.map(part => typeof part === 'string' ? part : (part?.text || '')).join('').trim();
    const hasVisibleContent = Boolean(text || String(content?.text || '').trim());
    const recipient = String(message?.recipient || '').trim();
    const hidden = metadata?.is_visually_hidden_from_conversation === true;
    const thinkingPreamble = metadata?.is_thinking_preamble_message === true;
    const endTurn = message?.end_turn === true ? true : (message?.end_turn === false ? false : null);
    const workingTurnId = String(metadata?.working_turn_id || metadata?.turn_exchange_id || '');
    const strongFinal = role === 'assistant'
      && endTurn === true
      && !hidden
      && !thinkingPreamble
      && (!recipient || recipient === 'all')
      && hasVisibleContent;
    return {
      role,
      status,
      terminal: strongFinal,
      hasVisibleContent,
      finalFound: strongFinal,
      endTurn,
      recipient,
      hidden,
      workingTurnId,
      messageId: String(message?.id || '')
    };
  }

  function summarizeTurn(messages, currentMessage, source) {
    let lastUser = -1;
    for (let i = 0; i < messages.length; i++) {
      if (messageSignal(messages[i]).role === 'user') lastUser = i;
    }
    const turnMessages = messages.slice(Math.max(0, lastUser + 1));
    let assistant = null;
    for (const message of turnMessages) {
      const sig = messageSignal(message);
      if (sig.role === 'assistant') assistant = sig;
    }
    const current = messageSignal(currentMessage || turnMessages[turnMessages.length - 1] || null);
    const finalFound = Boolean(assistant?.finalFound && current.messageId === assistant.messageId);
    const turnOpen = Boolean(
      !finalFound &&
      (
        current.role === 'tool' ||
        (current.role === 'assistant' && current.endTurn !== true) ||
        assistant?.endTurn === false ||
        (current.recipient && current.recipient !== 'all')
      )
    );
    return {
      ...(assistant || { role:'', status:'', terminal:false, finalFound:false, endTurn:null, recipient:'', hidden:false, workingTurnId:'', messageId:'' }),
      finalFound,
      terminal: finalFound,
      turnOpen,
      turnClosed: finalFound,
      currentNodeRole: current.role || '',
      currentNodeMessageId: current.messageId || '',
      workingTurnId: current.workingTurnId || assistant?.workingTurnId || '',
      source
    };
  }

  function latestMessageSignal(data) {
    const roots = [data, data?.conversation].filter(Boolean);
    for (const root of roots) {
      const mapping = root?.mapping;
      const currentNode = String(root?.current_node || '');
      if (mapping && currentNode && mapping[currentNode]) {
        const branch = [];
        const seen = new Set();
        let nodeId = currentNode;
        while (nodeId && mapping[nodeId] && !seen.has(nodeId) && branch.length < 500) {
          seen.add(nodeId);
          const node = mapping[nodeId];
          if (node?.message) branch.push(node.message);
          nodeId = String(node?.parent || '');
        }
        branch.reverse();
        return {
          ...summarizeTurn(branch, mapping[currentNode]?.message || null, 'mapping-current-branch'),
          currentNodeId: currentNode,
          asyncStatus: root?.async_status ?? null
        };
      }
    }

    for (const root of roots) {
      for (const arr of [root?.messages, root?.items]) {
        if (!Array.isArray(arr) || !arr.length) continue;
        const list = arr.map(x => x?.message || x).filter(Boolean);
        const current = list[list.length - 1] || null;
        return {
          ...summarizeTurn(list, current, 'flat-list'),
          currentNodeId: String(root?.current_node || current?.id || ''),
          asyncStatus: root?.async_status ?? null
        };
      }
    }
    return { role:'', status:'', terminal:false, finalFound:false, turnOpen:false, turnClosed:false, messageId:'', currentNodeRole:'', currentNodeId:'', workingTurnId:'', asyncStatus:null, source:'none' };
  }

  function signalFromBody(body) {
    try { return latestMessageSignal(JSON.parse(body)); }
    catch { return { role:'', status:'', terminal:false, finalFound:false, turnOpen:false, turnClosed:false, messageId:'', currentNodeRole:'', currentNodeId:'', workingTurnId:'', asyncStatus:null, source:'parse-error' }; }
  }

  function cacheClassForSnapshot(snapshot, target) {
    if (target?.kind !== 'detail' || snapshot?.status !== 200 || !snapshot?.body) return target?.kind === 'list' ? 'list' : 'detail-uncertain';
    return signalFromBody(snapshot.body).terminal ? 'detail-stable' : 'detail-uncertain';
  }

  function streamStatusValue(body) {
    try {
      const data = JSON.parse(body);
      return String(data?.status || data?.data?.status || 'UNKNOWN');
    } catch {
      return 'UNKNOWN';
    }
  }

  function isTerminalStreamValue(value) {
    const v = String(value || '').trim().toUpperCase();
    return v.includes('COMPLETE') || v.includes('FINISHED') || v.includes('DONE') || v.includes('NOT_STREAMING');
  }

  function isStreamingStreamValue(value) {
    const v = String(value || '').trim().toUpperCase();
    return v === 'IS_STREAMING' || v === 'STREAMING' || /(^|_)IS_STREAMING$/.test(v);
  }

  function isAbortError(error) {
    return String(error?.name || '') === 'AbortError';
  }


  async function performPersistenceCheck(conversationId, source = 'conversation-chain-check') {
    const id = String(conversationId || '');
    if (!id) return { ok:false, status:0, finalFound:false, turnOpen:false, turnClosed:false, error:'NO_CONVERSATION' };
    const url = `${location.origin}/backend-api/conversations/${encodeURIComponent(id)}?num_turns=10&include_has_versions=true`;
    try {
      const response = await originalFetch(url, {
        method:'GET',
        credentials:'include',
        cache:'no-store',
        headers:{ accept:'application/json' }
      });
      let body = '';
      try { body = await response.clone().text(); } catch {}
      const signal = response.ok ? signalFromBody(body) : { terminal:false, finalFound:false, turnOpen:false, turnClosed:false, role:'', status:'', currentNodeRole:'', currentNodeId:'', workingTurnId:'', asyncStatus:null, source:'http-error' };
      health('PERSISTENCE_CHECK', {
        status:response.status,
        ok:response.ok,
        finalFound:Boolean(signal.finalFound),
        terminal:Boolean(signal.terminal),
        turnOpen:Boolean(signal.turnOpen),
        turnClosed:Boolean(signal.turnClosed),
        currentNodeRole:signal.currentNodeRole || '',
        currentNodeId:signal.currentNodeId || '',
        workingTurnId:signal.workingTurnId || '',
        asyncStatus:signal.asyncStatus ?? null,
        assistantStatus:signal.status || '',
        assistantMessageId:signal.messageId || '',
        parseSource:signal.source || '',
        error:response.ok ? '' : `HTTP_${response.status}`,
        source
      }, id);
      if (response.ok && signal.turnOpen && !signal.finalFound && config.autoPersistenceCheckEnabled) {
        scheduleTerminalPersistenceCheck(id, 'turn-open-follow-up', Math.max(30_000, Number(config.autoPersistenceCheckMinGapMs || 60_000)));
      }
      return {
        ok:response.ok,
        status:response.status,
        finalFound:Boolean(signal.finalFound),
        terminal:Boolean(signal.terminal),
        turnOpen:Boolean(signal.turnOpen),
        turnClosed:Boolean(signal.turnClosed),
        currentNodeRole:signal.currentNodeRole || '',
        currentNodeId:signal.currentNodeId || '',
        workingTurnId:signal.workingTurnId || '',
        asyncStatus:signal.asyncStatus ?? null,
        assistantStatus:signal.status || '',
        assistantMessageId:signal.messageId || '',
        conversationId:id
      };
    } catch (error) {
      const message = String(error?.message || error);
      health('PERSISTENCE_CHECK', { status:0, ok:false, finalFound:false, terminal:false, turnOpen:false, turnClosed:false, error:message, source }, id);
      return { ok:false, status:0, finalFound:false, terminal:false, turnOpen:false, turnClosed:false, error:message, conversationId:id };
    }
  }

  function scheduleTerminalPersistenceCheck(conversationId, cause = 'terminal-status', delayOverrideMs = 0) {
    const id = String(conversationId || '');
    if (!id || !config.autoPersistenceCheckEnabled || persistenceTimers.has(id)) return;
    const delay = Math.max(1000, Number(delayOverrideMs || config.autoPersistenceCheckDelayMs || 5000));
    const timer = setTimeout(async () => {
      persistenceTimers.delete(id);
      let decision;
      try {
        decision = await requestBridge('REQUEST_PERSISTENCE_CHECK', { conversationId:id, cause, force:false }, 'PERSISTENCE_CHECK_DECISION', null);
      } catch { return; }
      if (!decision || decision.action !== 'check') {
        if (decision?.reason === 'minimum-gap' && Number(decision?.retryAfterMs || 0) > 0) {
          scheduleTerminalPersistenceCheck(id, cause, Number(decision.retryAfterMs));
        }
        return;
      }
      await performPersistenceCheck(id, cause === 'turn-open-follow-up' ? 'turn-open-follow-up' : 'auto-terminal-check');
    }, delay);
    persistenceTimers.set(id, timer);
  }


  function clearStreamingVerification(conversationId) {
    const id = String(conversationId || '');
    const timer = streamingVerificationTimers.get(id);
    if (timer) clearTimeout(timer);
    streamingVerificationTimers.delete(id);
  }

  function scheduleStreamingVerification(conversationId, delayOverride = null) {
    const id = String(conversationId || '');
    if (!id || !config.streamProbeEnabled || !config.streamProbeStaleStreamingEnabled || streamingVerificationTimers.has(id)) return;
    const delay = Math.max(30_000, Number(delayOverride ?? config.streamProbeStaleStreamingAfterMs ?? 90_000));
    const timer = setTimeout(async () => {
      streamingVerificationTimers.delete(id);
      let decision;
      try {
        decision = await requestBridge('REQUEST_STREAM_PROBE', { conversationId:id, cause:'stale-streaming-watchdog', force:false }, 'STREAM_PROBE_DECISION', null);
      } catch { return; }
      if (!decision || decision.action !== 'probe') {
        if (decision?.reason !== 'terminal-confirmed' && decision?.reason !== 'rate-limited') {
          scheduleStreamingVerification(id, Math.max(30_000, Number(decision?.retryAfterMs || config.streamProbeStaleStreamingGapMs || 60_000)));
        }
        return;
      }
      const probe = await performStreamProbe(id, 'stale-streaming-watchdog', 'anti-stale-probe');
      if (probe.ok && probe.terminal) {
        clearStreamingVerification(id);
        return;
      }
      if (probe.ok && isStreamingStreamValue(probe.value)) {
        scheduleStreamingVerification(id, Number(config.streamProbeStaleStreamingGapMs || 60_000));
      }
    }, delay);
    streamingVerificationTimers.set(id, timer);
  }

  function notePassiveStreamSuccess(conversationId) {
    if (conversationId) passiveStreamFailures.set(conversationId, 0);
  }

  function notePassiveStreamFailure(conversationId, cause) {
    if (!conversationId) return;
    const count = Number(passiveStreamFailures.get(conversationId) || 0) + 1;
    passiveStreamFailures.set(conversationId, count);
    if (count >= Math.max(1, Number(config.streamProbeFailureThreshold || 2))) {
      maybeAutoProbe(conversationId, cause || 'passive-failure').catch(() => {});
    }
  }

  async function performStreamProbe(conversationId, cause = 'auto', source = 'independent-probe') {
    const id = String(conversationId || '');
    if (!id) return { ok: false, error: 'NO_CONVERSATION' };
    const url = `${location.origin}/backend-api/conversation/${encodeURIComponent(id)}/stream_status`;
    try {
      const response = await originalFetch(url, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers: { accept: 'application/json' }
      });
      let body = '';
      try { body = await response.clone().text(); } catch {}
      const value = response.ok ? streamStatusValue(body) : '';
      health('STREAM_PROBE', {
        status: response.status,
        ok: response.ok,
        value,
        terminal: response.ok && isTerminalStreamValue(value),
        error: response.ok ? '' : `HTTP_${response.status}`,
        source,
        cause
      }, id);
      if (response.ok) notePassiveStreamSuccess(id);
      if (response.ok && isTerminalStreamValue(value)) {
        clearStreamingVerification(id);
        scheduleTerminalPersistenceCheck(id, source);
      } else if (response.ok && isStreamingStreamValue(value) && source === 'anti-stale-probe') {
        scheduleStreamingVerification(id, Number(config.streamProbeStaleStreamingGapMs || 60_000));
      }
      return { ok: response.ok, status: response.status, value, terminal: response.ok && isTerminalStreamValue(value), conversationId: id };
    } catch (error) {
      const aborted = isAbortError(error);
      health('STREAM_PROBE', {
        status: 0,
        ok: false,
        value: '',
        terminal: false,
        aborted,
        errorName: String(error?.name || ''),
        error: String(error?.message || error),
        source,
        cause
      }, id);
      return { ok: false, status: 0, value: '', terminal: false, aborted, error: String(error?.message || error), conversationId: id };
    }
  }

  async function maybeAutoProbe(conversationId, cause) {
    const id = String(conversationId || '');
    if (!id || !config.streamProbeEnabled || probeInFlight.has(id)) return;
    let decision;
    try {
      decision = await requestBridge('REQUEST_STREAM_PROBE', { conversationId: id, cause }, 'STREAM_PROBE_DECISION', null);
    } catch {
      return;
    }
    if (!decision || decision.action !== 'probe') return;
    probeInFlight.add(id);
    try {
      await performStreamProbe(id, cause, 'independent-probe');
    } finally {
      probeInFlight.delete(id);
    }
  }

  async function observeHealthFetch(input, init, info, target) {
    try {
      const response = await originalFetch(input, init);
      if (target.kind === 'stream_status') {
        let body = '';
        try { body = await response.clone().text(); } catch {}
        const value = response.ok ? streamStatusValue(body) : '';
        health('STREAM_STATUS', { status: response.status, ok: response.ok, value, error: response.ok ? '' : `HTTP_${response.status}`, source: 'fetch', aborted: false }, target.conversationId);
        if (response.ok) {
          notePassiveStreamSuccess(target.conversationId);
          if (isTerminalStreamValue(value)) {
            clearStreamingVerification(target.conversationId);
            scheduleTerminalPersistenceCheck(target.conversationId, 'page-stream-status');
          } else if (isStreamingStreamValue(value)) {
            scheduleStreamingVerification(target.conversationId);
          }
        } else if (response.status !== 429) notePassiveStreamFailure(target.conversationId, `fetch-http-${response.status}`);
      } else if (target.kind === 'resume') {
        health('RESUME', { status: response.status, ok: response.ok, error: response.ok ? '' : `HTTP_${response.status}`, source: 'fetch' }, target.conversationId);
      }
      return response;
    } catch (error) {
      if (target.kind === 'stream_status') {
        const aborted = isAbortError(error);
        health('STREAM_STATUS', { status: 0, ok: false, error: String(error?.message || error), errorName: String(error?.name || ''), aborted, source: 'fetch' }, target.conversationId);
        notePassiveStreamFailure(target.conversationId, aborted ? 'fetch-aborted' : 'fetch-transport-error');
      }
      if (target.kind === 'resume') health('RESUME', { status: 0, ok: false, error: String(error?.message || error), source: 'fetch' }, target.conversationId);
      throw error;
    }
  }

  async function guardedFetch(input, init) {
    const info = requestInfo(input, init);
    const mutateId = mutationConversationId(info);
    if (mutateId) {
      post('INVALIDATE_CONVERSATION', { conversationId: mutateId });
      clearStreamingVerification(mutateId);
      health('TURN_MUTATION', { source: 'fetch', path: info?.url?.pathname || '' }, mutateId);
    }

    const healthTarget = classifyHealthTarget(info);
    if (healthTarget) return observeHealthFetch(input, init, info, healthTarget);

    const target = classifyTarget(info);
    if (!config.enabled) return originalFetch(input, init);
    if (!target) {
      const response = await originalFetch(input, init);
      observeProjectResponse(info, response).catch(() => {});
      observeUsageJsonResponse(info, response).catch(() => {});
      return response;
    }
    const key = stableKey(info);

    for (;;) {
      let decision;
      try {
        decision = await requestBridge('ACQUIRE', { key, url: info.url.href, kind: target.kind, conversationId: target.conversationId }, 'ACQUIRE_RESULT', info.signal);
      } catch {
        return originalFetch(input, init);
      }

      if (!decision || decision.action === 'passthrough') {
        const response = await originalFetch(input, init);
        observeProjectResponse(info, response).catch(() => {});
        observeUsageJsonResponse(info, response).catch(() => {});
        return response;
      }
      if (decision.action === 'cache' && decision.snapshot) {
        const obsTarget = projectObservationTarget(info);
        if (obsTarget) observeProjectPayload(obsTarget, decision.snapshot.body).catch(() => {});
        return restoreResponse(decision.snapshot);
      }
      if (decision.action === 'synthetic429') return synthetic429(decision.retryAfterMs);
      if (decision.action === 'wait') {
        await sleep(Math.max(250, Number(decision.retryAfterMs) || 500), info.signal);
        continue;
      }

      if (decision.action === 'network' && decision.leaseId) {
        try {
          const response = await originalFetch(input, init);
          const snapshot = await snapshotResponse(response);
          const obsTarget = projectObservationTarget(info);
          if (obsTarget) observeProjectPayload(obsTarget, snapshot.body).catch(() => {});
          const cacheClass = cacheClassForSnapshot(snapshot, target);
          if (target.kind === 'detail') {
            const signal = signalFromBody(snapshot.body);
            health('DETAIL_SIGNAL', { status: response.status, terminal: signal.terminal, finalFound: Boolean(signal.finalFound), assistantStatus: signal.status || '', parseSource: signal.source || '', cacheClass, source: 'network' }, target.conversationId);
          }
          let completion = null;
          try {
            completion = await requestBridge('COMPLETE', {
              leaseId: decision.leaseId,
              status: response.status,
              snapshot,
              cacheClass,
              retryAfterMs: retryAfterMs(snapshot)
            }, 'COMPLETE_RESULT', null);
          } catch {}
          if (response.status === 429 && completion?.fallback) return restoreResponse(completion.fallback);
          return response;
        } catch (error) {
          post('NETWORK_ERROR', { leaseId: decision.leaseId });
          if (target.kind === 'detail') health('DETAIL_SIGNAL', { status: 0, terminal: false, error: String(error?.message || error), source: 'network' }, target.conversationId);
          throw error;
        }
      }
      return originalFetch(input, init);
    }
  }

  Object.defineProperty(window, 'fetch', { configurable: true, enumerable: true, writable: true, value: guardedFetch });

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    let parsed = null;
    try { parsed = new URL(String(url), location.href); } catch {}
    xhrInfo.set(this, { method: String(method || 'GET').toUpperCase(), url: parsed });
    return nativeXHROpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function(body) {
    const raw = xhrInfo.get(this);
    const info = raw?.url ? { url: raw.url, method: raw.method, signal: null, credentials: 'same-origin' } : null;
    const mutateId = mutationConversationId(info);
    if (mutateId) {
      post('INVALIDATE_CONVERSATION', { conversationId: mutateId });
      clearStreamingVerification(mutateId);
      health('TURN_MUTATION', { source: 'xhr', path: info?.url?.pathname || '' }, mutateId);
    }
    const projectTarget = projectObservationTarget(info);
    if (projectTarget) {
      this.addEventListener('load', () => {
        if (!(Number(this.status || 0) >= 200 && Number(this.status || 0) < 300)) return;
        try {
          let bodyText = '';
          try { bodyText = typeof this.responseText === 'string' ? this.responseText : ''; } catch {}
          if (!bodyText) { try { bodyText = JSON.stringify(this.response || {}); } catch {} }
          if (bodyText) observeProjectPayload(projectTarget, bodyText).catch(() => {});
        } catch {}
      }, { once: true });
    }

    if (info?.url && info.url.origin === location.origin && /\/usage$/i.test(normalizePath(info.url.pathname))) {
      this.addEventListener('load', () => {
        if (!(Number(this.status || 0) >= 200 && Number(this.status || 0) < 300)) return;
        try {
          const text = typeof this.responseText === 'string' ? this.responseText : '';
          if (!text) return;
          const contentType = String(this.getResponseHeader('content-type') || '').toLowerCase();
          if (contentType.includes('text/event-stream')) {
            for (const block of text.split(/\r?\n\r?\n/)) parseUsageSseBlock(block, 'xhr-sse');
          } else {
            publishUsageSnapshot(JSON.parse(text), 'usage-xhr');
          }
        } catch {}
      }, { once: true });
    }

    const target = classifyHealthTarget(info);
    if (target) {
      let reported = false;
      const report = (eventType = 'loadend') => {
        if (reported) return;
        reported = true;
        const status = Number(this.status || 0);
        if (target.kind === 'stream_status') {
          let value = '';
          try { value = status >= 200 && status < 300 ? streamStatusValue(String(this.responseText || '')) : ''; } catch {}
          const aborted = eventType === 'abort';
          const ok = status >= 200 && status < 300;
          const error = ok ? '' : (status ? (status >= 400 ? `HTTP_${status}` : '') : `XHR_${String(eventType).toUpperCase()}`);
          health('STREAM_STATUS', { status, ok, value, error, aborted, source: 'xhr', eventType }, target.conversationId);
          if (ok) {
            notePassiveStreamSuccess(target.conversationId);
            if (isTerminalStreamValue(value)) {
              clearStreamingVerification(target.conversationId);
              scheduleTerminalPersistenceCheck(target.conversationId, 'xhr-stream-status');
            } else if (isStreamingStreamValue(value)) {
              scheduleStreamingVerification(target.conversationId);
            }
          } else if (status !== 429) notePassiveStreamFailure(target.conversationId, aborted ? 'xhr-aborted' : `xhr-${eventType}`);
        } else if (target.kind === 'resume') {
          health('RESUME', { status, ok: status >= 200 && status < 300, error: status ? (status >= 400 ? `HTTP_${status}` : '') : 'XHR_ERROR', source: 'xhr' }, target.conversationId);
        }
      };
      this.addEventListener('load', () => report('load'), { once: true });
      this.addEventListener('abort', () => report('abort'), { once: true });
      this.addEventListener('error', () => report('error'), { once: true });
      this.addEventListener('timeout', () => report('timeout'), { once: true });
      this.addEventListener('loadend', () => report('loadend'), { once: true });
    }
    return nativeXHRSend.call(this, body);
  };

  function announceRoute(kind) {
    const id = currentConversationId();
    if (!id) return;
    lastRouteConversationId = id;
    const projectId = projectIdFromLocation();
    const conversationTitle = inferredConversationTitle();
    post('PROJECT_CONTEXT_UPDATE', {
      source: 'route',
      conversation: { conversationId: id, projectId, projectName: projectNameFromDom(projectId), conversationTitle }
    });
    health(kind, { href: location.pathname }, id);
  }

  const nativePushState = history.pushState.bind(history);
  const nativeReplaceState = history.replaceState.bind(history);
  history.pushState = function(...args) {
    const value = nativePushState(...args);
    queueMicrotask(() => announceRoute('ROUTE_SEEN'));
    return value;
  };
  history.replaceState = function(...args) {
    const value = nativeReplaceState(...args);
    queueMicrotask(() => announceRoute('ROUTE_SEEN'));
    return value;
  };
  window.addEventListener('popstate', () => queueMicrotask(() => announceRoute('ROUTE_SEEN')));
  window.addEventListener('focus', () => announceRoute('PAGE_FOCUS'));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) announceRoute('PAGE_FOCUS'); });
  setInterval(() => {
    const id = currentConversationId() || '';
    if (id && id !== lastRouteConversationId) announceRoute('ROUTE_SEEN');
    const title = inferredConversationTitle();
    if (id && title && title !== lastObservedDocumentTitle) {
      lastObservedDocumentTitle = title;
      const projectId = projectIdFromLocation();
      post('PROJECT_CONTEXT_UPDATE', { source: 'document_title', conversation: { conversationId: id, projectId, projectName: projectNameFromDom(projectId), conversationTitle: title } });
    }
  }, 1500);

  async function manualDiagnose(requestId) {
    const id = currentConversationId();
    if (!id) {
      post('MANUAL_DIAGNOSE_RESULT', { requestId, result: { ok: false, error: 'NO_CONVERSATION' } });
      return;
    }
    try {
      const decision = await requestBridge('REQUEST_STREAM_PROBE', { conversationId: id, cause: 'manual-diagnose', force: true }, 'STREAM_PROBE_DECISION', null);
      if (!decision || decision.action !== 'probe') {
        post('MANUAL_DIAGNOSE_RESULT', { requestId, result: { ok: false, skipped: true, error: decision?.reason || 'PROBE_BUSY', conversationId: id } });
        return;
      }
      const probe = await performStreamProbe(id, 'manual-diagnose', 'manual-probe');
      let persistence = null;
      let requestCount = 1;
      if (probe.ok && probe.terminal) {
        persistence = await performPersistenceCheck(id);
        requestCount += 1;
      }
      post('MANUAL_DIAGNOSE_RESULT', {
        requestId,
        result: {
          ok: Boolean(probe.ok),
          conversationId: id,
          requestCount,
          probe,
          persistence,
          status: probe.status,
          streamValue: probe.value || '',
          backendTerminal: Boolean(probe.terminal),
          terminal: Boolean(persistence?.terminal),
          finalFound: Boolean(persistence?.finalFound)
        }
      });
    } catch (error) {
      post('MANUAL_DIAGNOSE_RESULT', { requestId, result: { ok: false, status: 0, error: String(error?.message || error), conversationId: id } });
    }
  }

  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.channel !== CHANNEL) return;
    if (message.type === 'CONFIG') {
      config = { ...DEFAULTS, ...(message.config || {}) };
      return;
    }
    if (message.type === 'MANUAL_DIAGNOSE') {
      manualDiagnose(message.requestId).catch(() => {});
      return;
    }
    if (message.type === 'AUTO_STREAM_PROBE' && message.conversationId) {
      maybeAutoProbe(message.conversationId, message.cause || 'background-error').catch(() => {});
      return;
    }
    const requestId = message.requestId;
    if (!requestId || !pending.has(requestId)) return;
    const entry = pending.get(requestId);
    if (message.type !== entry.responseType) return;
    pending.delete(requestId);
    entry.resolve(message.result);
  });

  installEventSourceUsageObserver();
  post('READY');
  queueMicrotask(() => announceRoute('PAGE_OPEN'));
})();
