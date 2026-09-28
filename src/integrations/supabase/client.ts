// Imported only after the writer explicitly enables a hosted connection.
// VITE_ values are public build-time configuration, never server secrets.
import { createClient } from '@supabase/supabase-js';
import { hostedConfiguration } from '@/local/connectors/hosted-config';

const config = hostedConfiguration();
if (!config.configured) throw new Error(config.message);
export const supabase = createClient(config.endpoint, config.publishableKey, {
  auth: { storage: localStorage, persistSession: true, autoRefreshToken: true },
});
