INSERT INTO llm_providers (name, api_format, base_url, enabled)
VALUES ('xAI', 'openai', 'https://api.x.ai/v1', FALSE)
ON CONFLICT (name) DO UPDATE SET
  api_format = EXCLUDED.api_format,
  base_url   = EXCLUDED.base_url,
  updated_at = now();
