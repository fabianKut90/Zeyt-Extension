// The original URL is passed as ?url= by the declarativeNetRequest redirect rule
const params = new URLSearchParams(location.search);
const originalUrl = params.get('url') || '';

function matchesBlockedDomain(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function isUrlStillBlockedByList(url, blockedDomains) {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return blockedDomains.some((domain) => matchesBlockedDomain(host, domain));
  } catch {
    return false;
  }
}

async function getStoredBlockedDomains() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return null;
  try {
    const result = await chrome.storage.local.get('config');
    return Array.isArray(result?.config?.lastBlockList) ? result.config.lastBlockList : [];
  } catch {
    return null;
  }
}

function formatHostForTitle(host) {
  if (!host) return 'Zeyt';
  const trimmedHost = host.replace(/^www\./, '');
  return `Zeyt - ${trimmedHost.charAt(0).toUpperCase()}${trimmedHost.slice(1)}`;
}

try {
  const host = originalUrl ? new URL(originalUrl).hostname : location.hostname;
  document.getElementById('domain').textContent = host;
  document.title = formatHostForTitle(host);
} catch {}

// Show session end time from chrome.storage if available
if (typeof chrome !== 'undefined' && chrome.storage) {
  chrome.storage.local.get('config', ({ config }) => {
    const endsAt = config?.lastFocusState?.endsAt;
    const el = document.getElementById('until-text');
    if (endsAt && el) {
      el.textContent = `Session ends at ${new Date(endsAt).toLocaleTimeString()}`;
    } else if (el) {
      el.textContent = 'Session ends when you tap your NFC tag.';
    }
  });
}

// Send a message to the SW, retrying once if the SW isn't awake yet
async function sendToSW(msg, retries = 2, delayMs = 800) {
  for (let i = 0; i < retries; i++) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (e) {
      const isConnectionError = e?.message?.includes('Receiving end does not exist');
      if (i < retries - 1 && isConnectionError) {
        await new Promise(r => setTimeout(r, delayMs));
      } else {
        throw e;
      }
    }
  }
}

async function shouldReloadToOriginalUrl() {
  const blockedDomains = await getStoredBlockedDomains();
  if (!blockedDomains) return false;
  return !isUrlStillBlockedByList(originalUrl, blockedDomains);
}

// Poll helper — sends POLL_NOW to SW, reloads if unblocked
async function checkState(auto) {
  const btn = document.getElementById('btn-refresh');
  const msg = document.getElementById('refresh-msg');
  btn.disabled = true;
  if (!auto) msg.textContent = 'Checking…';

  if (await shouldReloadToOriginalUrl()) {
    msg.textContent = 'This site is no longer blocked. Redirecting…';
    setTimeout(() => { location.href = originalUrl || 'about:blank'; }, 300);
    return;
  }

  try {
    const result = await sendToSW({
      type: 'POLL_NOW',
      force: !auto,
      source: auto ? 'extension:blocked.auto' : 'extension:blocked.manual',
    });
    if (result?.type === 'STATUS' && result.isBlocking === false) {
      msg.textContent = 'Unblocked! Redirecting…';
      setTimeout(() => { location.href = originalUrl || 'about:blank'; }, 600);
    } else {
      if (!auto) msg.textContent = 'Still blocked. Try again after unlocking your phone.';
      btn.disabled = false;
    }
  } catch {
    if (!auto) msg.textContent = 'Could not reach extension. Try reopening the tab.';
    btn.disabled = false;
  }
}

const btn = document.getElementById('btn-refresh');
if (btn && typeof chrome !== 'undefined' && chrome.runtime) {
  // Auto-check on load — clears stale rules silently if already unblocked
  checkState(true);
  // Manual retry button
  btn.addEventListener('click', () => checkState(false));
}
