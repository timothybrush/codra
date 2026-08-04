-- Google Vertex AI is a distinct api_format from 'gemini': Vertex rejects plain API keys and
-- requires an OAuth2 Bearer token minted from a service-account JSON key, so it needs its own
-- adapter and its own row in the enum. Widen the CHECK constraint to allow it.
ALTER TABLE llm_providers DROP CONSTRAINT IF EXISTS llm_providers_api_format_check;
ALTER TABLE llm_providers ADD CONSTRAINT llm_providers_api_format_check
  CHECK (api_format IN ('openai', 'anthropic', 'gemini', 'cloudflare-workers-ai', 'vertex'));
