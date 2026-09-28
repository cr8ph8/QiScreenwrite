/** Public build settings only. Reading them never constructs a network client. */
export function hostedConfiguration() {
  const unavailable = { configured: false as const, message: 'Online services are not configured in this build. Local writing remains available.' };
  if (import.meta.env.VITE_HOSTED_ENABLED !== 'true') return unavailable;
  const endpoint = import.meta.env.VITE_SUPABASE_URL?.trim();
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
  const portal = import.meta.env.VITE_HOSTED_ORIGIN?.trim();
  if (!endpoint || !publishableKey || !portal) return unavailable;
  try {
    const origins = [endpoint, portal].map(value => new URL(value));
    if (origins.some(url => url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.port)) return unavailable;
    if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey)) return unavailable;
    return { configured: true as const, endpoint: origins[0].origin, portal: origins[1].origin, publishableKey, message: '' };
  } catch { return unavailable; }
}
