import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { hostedConfiguration } from './hosted-config';

const createClient = vi.hoisted(() => vi.fn(() => ({ auth: {} })));
vi.mock('@supabase/supabase-js', () => ({ createClient }));
beforeEach(() => {
  vi.resetModules(); createClient.mockClear();
  vi.stubEnv('VITE_HOSTED_ENABLED', 'false');
  vi.stubEnv('VITE_SUPABASE_URL', '');
  vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', '');
  vi.stubEnv('VITE_HOSTED_ORIGIN', '');
});
afterEach(() => vi.unstubAllEnvs());
function validSettings() {
  vi.stubEnv('VITE_HOSTED_ENABLED', 'true');
  vi.stubEnv('VITE_SUPABASE_URL', 'https://backend.example.com');
  vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_synthetic_fixture');
  vi.stubEnv('VITE_HOSTED_ORIGIN', 'https://portal.example.com');
}
it('does not construct a client or use a production portal when unconfigured', async () => {
  const { getClient, HOSTED_ORIGIN } = await import('./competition');
  expect(HOSTED_ORIGIN).toBe('');
  await expect(getClient()).rejects.toThrow('not configured');
  expect(createClient).not.toHaveBeenCalled();
});
it('requires deliberate enablement even when all public settings exist', () => {
  validSettings(); vi.stubEnv('VITE_HOSTED_ENABLED', 'false');
  expect(hostedConfiguration().configured).toBe(false);
  expect(createClient).not.toHaveBeenCalled();
});
it.each([
  ['VITE_SUPABASE_URL', 'http://backend.example.com'],
  ['VITE_SUPABASE_URL', 'https://secret@backend.example.com'],
  ['VITE_SUPABASE_URL', 'https://backend.example.com/path'],
  ['VITE_SUPABASE_URL', 'https://backend.example.com:444'],
  ['VITE_SUPABASE_URL', 'not a URL'],
  ['VITE_HOSTED_ORIGIN', 'javascript:alert(1)'],
  ['VITE_HOSTED_ORIGIN', 'https://portal.example.com?secret=example'],
  ['VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_secret_synthetic_fixture'],
  ['VITE_SUPABASE_PUBLISHABLE_KEY', 'eyJ.synthetic.jwt'],
])('rejects invalid public configuration %s', (key, value) => {
  validSettings(); vi.stubEnv(key, value);
  expect(hostedConfiguration().configured).toBe(false);
  expect(createClient).not.toHaveBeenCalled();
});
it('constructs the SDK once only when an explicitly configured client is requested', async () => {
  validSettings();
  const { getClient, HOSTED_ORIGIN } = await import('./competition');
  expect(createClient).not.toHaveBeenCalled();
  expect(HOSTED_ORIGIN).toBe('https://portal.example.com');
  await getClient(); await getClient();
  expect(createClient).toHaveBeenCalledTimes(1);
  expect(createClient).toHaveBeenCalledWith('https://backend.example.com', 'sb_publishable_synthetic_fixture', expect.any(Object));
});
