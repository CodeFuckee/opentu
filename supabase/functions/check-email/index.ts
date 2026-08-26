/**
 * Edge Function: check-email (entry)
 *
 * Determines whether an email is already registered in Supabase Auth.
 * Core logic lives in core.ts (no Deno dependency, unit-testable).
 *
 * Self-hosted instance specifics:
 * - Env var name: SUPABASE_SERVICE_ROLE_KEY (configured on the container)
 * - SUPABASE_URL is the in-container gateway address (http://api-gw:8000)
 */
import { handleCheckEmail } from './core.ts';

Deno.serve(async (request: Request) => {
  return handleCheckEmail(request, {
    SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
    SUPABASE_URL: Deno.env.get('SUPABASE_URL') || '',
  });
});
