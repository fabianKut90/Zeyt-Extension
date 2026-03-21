// All block rules are managed as dynamic declarativeNetRequest rules.
// Static rules.json is empty; we only ever use dynamic rules at runtime.

const BASE_RULE_ID = 1000; // Avoid collisions with any future static rules

export async function updateBlockRules(domains: string[]): Promise<void> {
  if (domains.length === 0) {
    await clearBlockRules();
    return;
  }

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);

  const addRules: chrome.declarativeNetRequest.Rule[] = domains.map((domain, i) => ({
    id: BASE_RULE_ID + i,
    priority: 1,
    action: {
      type: chrome.declarativeNetRequest.RuleActionType.REDIRECT,
      redirect: { extensionPath: '/blocked.html' },
    },
    condition: {
      // ||domain^ matches domain and all subdomains, with or without www
      urlFilter: `||${domain}^`,
      resourceTypes: [chrome.declarativeNetRequest.ResourceType.MAIN_FRAME],
    },
  }));

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules,
  });
}

export async function clearBlockRules(): Promise<void> {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);
  if (removeRuleIds.length > 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
  }
}

export async function getActiveRuleCount(): Promise<number> {
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  return rules.length;
}
