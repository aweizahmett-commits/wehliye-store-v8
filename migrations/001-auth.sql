-- Additive only. Does not modify products, store_state, orders, or customer profiles.
CREATE TABLE IF NOT EXISTS public.wehliye_sessions (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash)=64),
  kind TEXT NOT NULL CHECK (kind IN ('customer','admin')),
  profile JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS wehliye_sessions_expiry ON public.wehliye_sessions(expires_at);
CREATE TABLE IF NOT EXISTS public.wehliye_oauth_states (
  state_hash TEXT PRIMARY KEY CHECK (length(state_hash)=64),
  browser_hash TEXT NOT NULL CHECK (length(browser_hash)=64),
  verifier TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS wehliye_oauth_expiry ON public.wehliye_oauth_states(expires_at);
CREATE TABLE IF NOT EXISTS public.wehliye_rate_limits (
  key_hash TEXT PRIMARY KEY CHECK (length(key_hash)=64),
  attempts INTEGER NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS wehliye_rate_expiry ON public.wehliye_rate_limits(expires_at);
