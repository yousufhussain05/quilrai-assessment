# Task 4: rate limiter and model fallback

A small gateway in front of two OpenAI-compatible providers. It exposes `POST /v1/chat/completions` (non-streaming). Each API key gets 50,000 tokens per sliding minute, tracked in a SQLite file. Requests go to the primary provider first and fall back to the secondary if the primary is rate limited, slow or down.

The code is in `src/`. `rate-limiter.ts` is the SQLite limiter, `router.ts` does the primary/secondary calls, `server.ts` is the HTTP handler, and `mock-provider.ts` is a fake provider used by the tests and the demo.

## Running

From the repo root:

```sh
npx tsx task4-model-router/src/demo.ts
npx vitest run task4-model-router
```

The demo starts a mock primary on :9101, a mock secondary on :9102 and the gateway on :8080, with one API key, `demo-key`. It writes `gateway.sqlite` in the current directory.

A normal request goes to the primary. The response has `x-gateway-route: primary`, `x-request-id` and `x-ratelimit-remaining-tokens`.

```sh
curl -i localhost:8080/v1/chat/completions \
  -H 'authorization: Bearer demo-key' -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"hello"}],"max_tokens":100}'
```

To see the fallback, switch the primary to `slow` and send the same request again. The mock waits 5 seconds, so after 3 seconds the gateway gives up on it and you get `x-gateway-route: fallback` with the secondary's answer. The `rate_limited` and `error` modes fall back right away, and `bad_request` shows that a 400 does not fall back.

```sh
curl -X POST localhost:9101/mode -d slow
```

To get a 429, leave the primary slow and send three 20,000-token requests at once. Only two fit in the budget while they're in flight, so the third gets a 429 with `Retry-After: 60` and `retry_after_ms` in the body.

```sh
for i in 1 2 3; do curl -s -i localhost:8080/v1/chat/completions \
  -H 'authorization: Bearer demo-key' -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"hello"}],"max_tokens":20000}' & done; wait
```

## How it works

The rate limiter is a sliding log. Every admitted request is a row in `token_usage (tenant, ts_ms, tokens)` in a WAL-mode SQLite file, indexed on `(tenant, ts_ms)`. The tenant is the sha256 of the API key, so raw keys never get written to disk. `reserve()` runs in one `BEGIN IMMEDIATE` transaction. It deletes rows older than the window, sums the tenant's tokens, and then either inserts a row or rejects. On a reject it walks the tenant's oldest rows until enough tokens would have expired, which gives the exact retry-after. The reservation is an estimate, about chars/4 of the messages plus `max_tokens`. If the client leaves out `max_tokens` the gateway uses 512, and it always sends `max_tokens` upstream so the provider can't generate more than was reserved. After the call, `reconcile()` replaces the estimate with the provider's `usage.total_tokens`, or 0 if the call failed. Reserving before the call means concurrent requests can't all slip past the check. A single request bigger than the whole 50,000 budget gets a 413, since retrying it will never work.

For the fallback, the primary gets 3 seconds. The timeout aborts the fetch through an AbortController, so the slow request is cancelled and the timer is cleared either way. The gateway tries the secondary (10 second timeout) on a 429, a timeout, a 5xx or a network error. It also falls back on 401, 403 and 404, because those mean our key or model name for that provider is wrong, and the other provider might be fine. It does not fall back on 400, 413 or 422. Those mean the request itself is bad, and the secondary would reject it too. If the client disconnects, the upstream call is aborted and nothing falls back.

Every error looks like `{"error": {"type", "message", "request_id"}}`, plus `retry_after_ms` and a `Retry-After` header on a 429. The types are `invalid_request` (400), `authentication_error` (401), `not_found` (404), `request_too_large` (413), `rate_limit_exceeded` (429), `internal_error` (500), `upstream_unavailable` (502) and `upstream_timeout` (504). The gateway writes every message itself and discards provider error bodies, so a provider's stack trace or internal hostname never reaches the client. Anything unexpected turns into `internal_error`, and the real error goes to the server log with the request id.

## What I'd change for production

- Move the limiter to Redis (a sorted set per tenant and a Lua script for the reserve) so it works across hosts. One SQLite file only works for replicas on the same machine.
- Use the model's real tokenizer instead of chars/4. Text like code or CJK can undercount until reconcile catches up.
- Support streaming. Right now `stream: true` gets a 400.
- Read the keys, provider URLs and timeouts from env or a config file instead of hard-coding them in `demo.ts`, and cap the request body size.
- Skip the primary for a while after it returns 429 with `Retry-After`, instead of trying it on every request.
