export const DEFAULT_AUTO_PROJECT_RULES = Object.freeze([
  { aliases: ['sxt加速A'], devhubProject: 'sxt', targetSlot: 'WORKER-A' },
  { aliases: ['sxt加速B'], devhubProject: 'sxt', targetSlot: 'WORKER-B' },
  { aliases: ['sxt加速C'], devhubProject: 'sxt', targetSlot: 'WORKER-C' },
  { aliases: ['sxt评审'], devhubProject: 'sxt', targetSlot: 'REVIEWER-A' },
  { aliases: ['XYZL-A开发'], devhubProject: 'xyzl', targetSlot: 'WORKER-A' },
  { aliases: ['XYZL-B开发'], devhubProject: 'xyzl', targetSlot: 'WORKER-B' },
  { aliases: ['XYZL-C开发'], devhubProject: 'xyzl', targetSlot: 'WORKER-C' }
]);

export function normalizeRoutingText(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

export function normalizeAutoRules(rules) {
  const source = Array.isArray(rules) && rules.length ? rules : DEFAULT_AUTO_PROJECT_RULES;
  return source.map((rule, index) => ({
    id: String(rule?.id || `rule-${index + 1}`),
    aliases: (Array.isArray(rule?.aliases) ? rule.aliases : [rule?.name]).map(x => String(x || '').trim()).filter(Boolean),
    devhubProject: String(rule?.devhubProject || '').trim().toLocaleLowerCase(),
    targetSlot: String(rule?.targetSlot || '').trim().toUpperCase()
  })).filter(rule => rule.aliases.length && rule.devhubProject && rule.targetSlot);
}

export function matchAutoRule(context, rules) {
  const projectName = normalizeRoutingText(context?.projectName);
  const conversationTitle = normalizeRoutingText(context?.conversationTitle);
  for (const rule of normalizeAutoRules(rules)) {
    for (const aliasRaw of rule.aliases) {
      const alias = normalizeRoutingText(aliasRaw);
      if (!alias) continue;
      if (projectName === alias) return { ...rule, matchedOn: 'project_name', matchedValue: context?.projectName || '' };
      if (conversationTitle === alias) return { ...rule, matchedOn: 'conversation_title', matchedValue: context?.conversationTitle || '' };
    }
  }
  return null;
}

export function selectAutoProfile(profiles, rule) {
  if (!rule) return null;
  const list = (Array.isArray(profiles) ? profiles : []).filter(Boolean);
  const projectKey = normalizeRoutingText(rule.devhubProject);
  const targetSlot = String(rule.targetSlot || '').trim().toUpperCase();

  const scored = [];
  for (const profile of list) {
    if (String(profile.mode || '') !== 'manager_evidence') continue;
    const pProject = normalizeRoutingText(profile.projectKey);
    const pSlot = String(profile.slotName || '').trim().toUpperCase();
    const pName = normalizeRoutingText(profile.name);
    let score = 0;
    if (pProject && pProject === projectKey) score += 100;
    else if (!pProject && projectKey && pName.includes(projectKey)) score += 20;
    else continue;
    if (pSlot && pSlot === targetSlot) score += 15;
    if (!pSlot || pSlot === 'MANAGER') score += 5;
    scored.push({ profile, score });
  }
  scored.sort((a, b) => b.score - a.score || String(a.profile.id).localeCompare(String(b.profile.id)));
  return scored[0]?.profile || null;
}


export function resolveProfileRoute(profiles, manualProfileId, rule) {
  const list = (Array.isArray(profiles) ? profiles : []).filter(Boolean);
  const manualId = String(manualProfileId || '').trim();
  const manualProfile = manualId ? (list.find(p => String(p?.id || '') === manualId) || null) : null;

  if (manualProfile) {
    const profileProject = normalizeRoutingText(manualProfile.projectKey);
    const ruleProject = normalizeRoutingText(rule?.devhubProject);
    if (
      rule &&
      String(manualProfile.mode || '') === 'manager_evidence' &&
      profileProject &&
      profileProject === ruleProject
    ) {
      return {
        source: 'auto',
        profileSelection: 'manual_binding',
        profileId: manualId,
        profile: manualProfile,
        targetSlot: String(rule.targetSlot || '').trim().toUpperCase(),
        devhubProject: String(rule.devhubProject || '').trim().toLocaleLowerCase(),
        rule
      };
    }
    return {
      source: 'manual',
      profileSelection: 'manual_binding',
      profileId: manualId,
      profile: manualProfile,
      targetSlot: String(manualProfile.slotName || '').trim().toUpperCase(),
      devhubProject: String(manualProfile.projectKey || '').trim().toLocaleLowerCase(),
      rule: null
    };
  }

  if (!rule) {
    return { source: 'none', profileSelection: 'none', profileId: '', profile: null, targetSlot: '', devhubProject: '', rule: null };
  }
  const profile = selectAutoProfile(list, rule);
  return {
    source: 'auto',
    profileSelection: 'auto',
    profileId: String(profile?.id || ''),
    profile: profile || null,
    targetSlot: String(rule.targetSlot || '').trim().toUpperCase(),
    devhubProject: String(rule.devhubProject || '').trim().toLocaleLowerCase(),
    rule
  };
}
