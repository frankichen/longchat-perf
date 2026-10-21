import assert from 'node:assert/strict';
import { DEFAULT_AUTO_PROJECT_RULES, matchAutoRule, selectAutoProfile, resolveProfileRoute } from '../project-routing.js';

assert.equal(matchAutoRule({ projectName: 'sxt加速A' }, DEFAULT_AUTO_PROJECT_RULES)?.targetSlot, 'WORKER-A');
assert.equal(matchAutoRule({ projectName: 'SXT加速c' }, DEFAULT_AUTO_PROJECT_RULES)?.targetSlot, 'WORKER-C');
assert.equal(matchAutoRule({ conversationTitle: 'XYZL-B开发' }, DEFAULT_AUTO_PROJECT_RULES)?.devhubProject, 'xyzl');
assert.equal(matchAutoRule({ projectName: '乱想', conversationTitle: '普通聊天' }, DEFAULT_AUTO_PROJECT_RULES), null);

const profiles = [
  { id: 'x', name: 'SXT Manager', mode: 'manager_evidence', projectKey: 'sxt', slotName: 'MANAGER' },
  { id: 'y', name: 'XYZL Manager', mode: 'manager_evidence', projectKey: 'xyzl', slotName: 'MANAGER' },
  { id: 'z', name: 'SXT WORKER-A evidence', mode: 'manager_evidence', projectKey: 'sxt', slotName: 'WORKER-A' }
];
const sxtA = matchAutoRule({ projectName: 'sxt加速A' }, DEFAULT_AUTO_PROJECT_RULES);
assert.equal(selectAutoProfile(profiles, sxtA)?.id, 'z');
const xyzlC = matchAutoRule({ projectName: 'XYZL-C开发' }, DEFAULT_AUTO_PROJECT_RULES);
assert.equal(selectAutoProfile(profiles, xyzlC)?.id, 'y');


// A manual Manager-profile binding must not suppress the auto-detected worker slot.
const manualXyzlManager = resolveProfileRoute(profiles, 'y', matchAutoRule({ conversationTitle: 'XYZL-B开发' }, DEFAULT_AUTO_PROJECT_RULES));
assert.equal(manualXyzlManager.source, 'auto');
assert.equal(manualXyzlManager.profileSelection, 'manual_binding');
assert.equal(manualXyzlManager.profileId, 'y');
assert.equal(manualXyzlManager.devhubProject, 'xyzl');
assert.equal(manualXyzlManager.targetSlot, 'WORKER-B');

// A manual profile from another project must remain manual rather than being silently retargeted.
const wrongProjectManual = resolveProfileRoute(profiles, 'x', matchAutoRule({ conversationTitle: 'XYZL-B开发' }, DEFAULT_AUTO_PROJECT_RULES));
assert.equal(wrongProjectManual.source, 'manual');
assert.equal(wrongProjectManual.targetSlot, 'MANAGER');

console.log('project-routing PASS');
