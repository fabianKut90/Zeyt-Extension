import posthog from 'posthog-js/dist/module.no-external';

const POSTHOG_KEY = process.env.POSTHOG_KEY || '';
const POSTHOG_HOST = process.env.POSTHOG_HOST || 'https://eu.i.posthog.com';

let initialized = false;

function initAnalytics(): boolean {
  if (!POSTHOG_KEY) return false;
  if (initialized) return true;

  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    autocapture: false,
    capture_pageview: false,
    disable_session_recording: true,
    disable_external_dependency_loading: true,
    persistence: 'localStorage',
    person_profiles: 'identified_only',
  });

  posthog.register({
    extension_surface: 'chrome_extension',
  });

  initialized = true;
  return true;
}

export async function trackEvent(
  event: string,
  properties: Record<string, unknown> = {},
): Promise<void> {
  if (!initAnalytics()) return;

  try {
    posthog.capture(event, properties);
  } catch (error) {
    console.warn('[analytics] track failed:', error);
  }
}
