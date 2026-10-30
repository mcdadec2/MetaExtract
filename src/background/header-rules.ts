import { browser } from 'wxt/browser';
import { isHttpUrl } from '../lib/classify';

/**
 * Many CDNs only serve media to requests that look like they come from the
 * page (Referer, Origin). Our own fetches come from the extension, so these
 * session rules add the page's headers, only for extension-initiated
 * requests to the given hosts.
 */
export const ENGINE_RULE_ID = 1;
let nextInspectRuleId = 100;

export async function setPageHeaders(ruleId: number, pageUrl: string | undefined, hosts: string[]): Promise<void> {
  if (!pageUrl || !isHttpUrl(pageUrl) || hosts.length === 0) {
    await clearPageHeaders(ruleId);
    return;
  }
  await browser.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId],
    addRules: [
      {
        id: ruleId,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'referer', operation: 'set', value: pageUrl },
            { header: 'origin', operation: 'set', value: new URL(pageUrl).origin },
          ],
        },
        condition: {
          initiatorDomains: [browser.runtime.id],
          requestDomains: hosts,
          resourceTypes: ['xmlhttprequest', 'other'],
        },
      },
    ],
  });
}

export async function clearPageHeaders(ruleId: number): Promise<void> {
  await browser.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
}

/** Runs `fn` with the page's headers on requests to `url`'s host. */
export async function withPageHeaders<T>(pageUrl: string | undefined, url: string, fn: () => Promise<T>): Promise<T> {
  const ruleId = nextInspectRuleId;
  nextInspectRuleId = nextInspectRuleId >= 4000 ? 100 : nextInspectRuleId + 1;
  await setPageHeaders(ruleId, pageUrl, [new URL(url).hostname]);
  try {
    return await fn();
  } finally {
    await clearPageHeaders(ruleId).catch(() => {});
  }
}
