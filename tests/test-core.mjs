import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, deriveHealth, createHealthState, classifyConversationUrl, backoffMsForStrike } from '../coordinator-core.js';

const now = 1_000_000;
let s = createHealthState('c1');
s.lastMutationAt = now - 10_000;
s.lastStreamStatusOkAt = now - 2_000;
s.lastStreamStatusValue = 'IS_STREAMING';
assert.equal(deriveHealth(s, now, DEFAULT_SETTINGS).code, 'ALIVE');

s.lastResumeStatus = 404;
s.lastResumeFailureAt = now - 1_000;
assert.equal(deriveHealth(s, now, DEFAULT_SETTINGS).code, 'STREAM_LOST_BACKEND_ALIVE');

s.lastPersistedAt = now;
assert.equal(deriveHealth(s, now, DEFAULT_SETTINGS).code, 'COMPLETED_PERSISTED');

s = createHealthState('probe-alive');
s.lastMutationAt = now - 15_000;
s.lastStreamStatusFailureAt = now - 3_000;
s.streamStatusConsecutiveFailures = 4;
s.lastStreamProbeOkAt = now - 1_000;
s.lastStreamProbeAt = now - 1_000;
s.lastStreamProbeHttpStatus = 200;
s.lastStreamProbeValue = 'IS_STREAMING';
assert.equal(deriveHealth(s, now, DEFAULT_SETTINGS).code, 'ALIVE_PROBE_CONFIRMED');

s = createHealthState('probe-complete');
s.lastMutationAt = now - 60_000;
s.lastStreamStatusFailureAt = now - 2_000;
s.streamStatusConsecutiveFailures = 5;
s.lastStreamProbeOkAt = now - 500;
s.lastStreamProbeAt = now - 500;
s.lastStreamProbeHttpStatus = 200;
s.lastStreamProbeValue = 'COMPLETE';
assert.equal(deriveHealth(s, now, DEFAULT_SETTINGS).code, 'STATUS_SERVICE_TERMINAL_UNCONFIRMED');

s = createHealthState('c2');
s.lastMutationAt = now - 50_000;
s.lastGeneralBackendErrorAt = now - 1_000;
s.recentBackendErrorCount = 4;
assert.equal(deriveHealth(s, now, DEFAULT_SETTINGS).code, 'NETWORK_PATH_UNSTABLE');

s = createHealthState('c3');
s.lastMutationAt = now - 400_000;
s.lastResumeStatus = 410;
s.lastResumeFailureAt = now - 200_000;
s.lastGeneralBackendOkAt = now - 1_000;
s.lastStreamStatusOkAt = now - 400_000;
s.lastStreamStatusValue = 'IS_STREAMING';
assert.equal(deriveHealth(s, now, DEFAULT_SETTINGS).code, 'SUSPECTED_TERMINATED');

s = createHealthState('c4');
s.lastMutationAt = now - 40_000;
s.lastStreamStatusOkAt = now - 1_000;
s.lastStreamStatusValue = 'NOT_STREAMING';
s.lastResumeStatus = 410;
s.lastResumeFailureAt = now - 2_000;
assert.equal(deriveHealth(s, now, DEFAULT_SETTINGS).code, 'BACKEND_COMPLETE');



s = createHealthState('conflict');
s.lastMutationAt = now - 120_000;
s.lastStreamStatusOkAt = now - 1_000;
s.lastStreamStatusValue = 'IS_STREAMING';
s.lastStreamProbeOkAt = now - 500;
s.lastStreamProbeValue = 'COMPLETE';
s.lastBackendTerminalAt = now - 500;
s.lastBackendTerminalValue = 'COMPLETE';
s.lastBackendTerminalSource = 'independent-probe';
assert.equal(deriveHealth(s, now, DEFAULT_SETTINGS).code, 'STREAM_STATUS_CONFLICT');

s = createHealthState('c4b');
s.lastMutationAt = now - 120_000;
s.lastBackendTerminalAt = now - 45_000;
s.lastBackendTerminalValue = 'COMPLETE';
s.lastPersistenceCheckAt = now - 10_000;
s.lastPersistenceFinalFound = false;
s.lastGeneralBackendOkAt = now - 9_000;
assert.equal(deriveHealth(s, now, DEFAULT_SETTINGS).code, 'COMPLETE_WITHOUT_FINAL');

s = createHealthState('c5');
s.lastMutationAt = now - 40_000;
s.last429At = now - 500;
s.lastGeneralBackendErrorAt = now - 500;
s.recentBackendErrorCount = 0;
assert.equal(deriveHealth(s, now, DEFAULT_SETTINGS).code, 'RATE_LIMITED');

assert.deepEqual(classifyConversationUrl('https://chatgpt.com/backend-api/conversations/abc?num_turns=10'), {kind:'detail', conversationId:'abc'});
assert.equal(backoffMsForStrike(1), 10 * 60_000);
assert.equal(backoffMsForStrike(4), 120 * 60_000);
console.log('core tests: PASS');
