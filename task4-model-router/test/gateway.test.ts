import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { startMockProvider } from "../src/mock-provider.js";
import { createGateway } from "../src/server.js";

type Mock = Awaited<ReturnType<typeof startMockProvider>>;

const hello = { messages: [{ role: "user", content: "hello" }] };
let dir: string;
let primary: Mock;
let secondary: Mock;
let gateway: Server;
let url: string;

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  dir = mkdtempSync(join(tmpdir(), "gateway-test-"));
  primary = await startMockProvider("primary");
  secondary = await startMockProvider("secondary");
  gateway = createGateway({
    apiKeys: ["test-key"],
    dbPath: join(dir, "gateway.sqlite"),
    primary: { url: primary.url, model: "primary-model", timeoutMs: 500 },
    secondary: { url: secondary.url, model: "secondary-model", timeoutMs: 1000 },
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1/chat/completions`;
});

afterEach(async () => {
  gateway.closeAllConnections();
  await new Promise((resolve) => gateway.close(resolve));
  await primary.close();
  await secondary.close();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function chat(body: object = hello, init: RequestInit = {}) {
  return fetch(url, {
    method: "POST",
    headers: { authorization: "Bearer test-key", "content-type": "application/json" },
    body: JSON.stringify(body),
    ...init,
  });
}

async function errorOf(res: Response) {
  return ((await res.json()) as { error: Record<string, unknown> }).error;
}

test("serves from the primary and reports the remaining budget", async () => {
  const res = await chat();

  expect(res.status).toBe(200);
  expect(res.headers.get("x-gateway-route")).toBe("primary");
  expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  expect(res.headers.get("x-ratelimit-remaining-tokens")).toBe("49970");
  expect(await res.json()).toMatchObject({ choices: [{ message: { content: "Hello from primary." } }] });
  expect(primary.requests[0]).toMatchObject({ model: "primary-model", max_tokens: 512 });
});

test("falls back when the primary returns 429", async () => {
  primary.mode = "rate_limited";
  const res = await chat();

  expect(res.status).toBe(200);
  expect(res.headers.get("x-gateway-route")).toBe("fallback");
  expect(secondary.requests[0]).toMatchObject({ model: "secondary-model" });
});

test("falls back at the primary timeout and aborts the slow primary request", async () => {
  primary.mode = "slow";
  const start = Date.now();
  const res = await chat();
  const elapsed = Date.now() - start;

  expect(res.headers.get("x-gateway-route")).toBe("fallback");
  expect(elapsed).toBeGreaterThanOrEqual(490);
  expect(elapsed).toBeLessThan(1500);
  await vi.waitFor(() => expect(primary.aborted).toBe(1));
});

test("does not fall back when the primary rejects the request as bad", async () => {
  primary.mode = "bad_request";
  const res = await chat();

  expect(res.status).toBe(400);
  expect((await errorOf(res)).type).toBe("invalid_request");
  expect(secondary.requests).toHaveLength(0);
});

test("returns 502 without upstream details when both providers fail, and charges nothing", async () => {
  primary.mode = "error";
  secondary.mode = "error";
  const res = await chat();
  const text = await res.text();

  expect(res.status).toBe(502);
  expect(JSON.parse(text).error.type).toBe("upstream_unavailable");
  for (const leak of ["ECONNREFUSED", "10.0.3.17", "worker.py", "Error:", "127.0.0.1"]) {
    expect(text).not.toContain(leak);
  }

  primary.mode = "ok";
  expect((await chat()).headers.get("x-ratelimit-remaining-tokens")).toBe("49970");
});

test("rejects a missing or unknown API key with 401", async () => {
  const unknown = await chat(hello, { headers: { authorization: "Bearer nope" } });
  const missing = await chat(hello, { headers: {} });

  expect(unknown.status).toBe(401);
  expect(missing.status).toBe(401);
  expect((await errorOf(unknown)).type).toBe("authentication_error");
  expect(primary.requests).toHaveLength(0);
});

test("rejects an invalid body with 400", async () => {
  expect((await chat({ messages: [] })).status).toBe(400);
  expect((await chat({ ...hello, stream: true })).status).toBe(400);
  expect((await chat({ ...hello, max_tokens: -1 })).status).toBe(400);
  expect(primary.requests).toHaveLength(0);
});

test("100 parallel 1,000-token requests: 50 get through, the rest get 429 with Retry-After", async () => {
  primary.mode = "slow";
  // "hello" is 2 tokens by the estimate, so each request reserves exactly 1,000
  const responses = await Promise.all(Array.from({ length: 100 }, () => chat({ ...hello, max_tokens: 998 })));

  const ok = responses.filter((r) => r.status === 200);
  const limited = responses.filter((r) => r.status === 429);
  expect(ok).toHaveLength(50);
  expect(limited).toHaveLength(50);

  const res = limited[0];
  const error = await errorOf(res);
  expect(Object.keys(error).sort()).toEqual(["message", "request_id", "retry_after_ms", "type"]);
  expect(error.type).toBe("rate_limit_exceeded");
  expect(error.request_id).toBe(res.headers.get("x-request-id"));
  expect(error.retry_after_ms).toBeGreaterThan(55_000);
  expect(res.headers.get("retry-after")).toBe("60");
});

test("a request bigger than the whole budget gets 413 and no Retry-After", async () => {
  const res = await chat({ ...hello, max_tokens: 60_000 });

  expect(res.status).toBe(413);
  expect(res.headers.get("retry-after")).toBeNull();
  expect((await errorOf(res)).type).toBe("request_too_large");
});

test("a client disconnect aborts the upstream call and skips the fallback", async () => {
  primary.mode = "slow";
  const client = new AbortController();
  const pending = chat(hello, { signal: client.signal });
  await vi.waitFor(() => expect(primary.requests).toHaveLength(1));
  client.abort();

  await expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(primary.aborted).toBe(1));
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(secondary.requests).toHaveLength(0);
});
