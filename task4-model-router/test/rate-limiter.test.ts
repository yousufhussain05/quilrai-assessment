import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, test } from "vitest";
import { RateLimiter } from "../src/rate-limiter.js";

const T0 = 1_700_000_000_000;
let dir: string;
let dbPath: string;
let now: number;
let limiter: RateLimiter;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "limiter-test-"));
  dbPath = join(dir, "limiter.sqlite");
  now = T0;
  limiter = new RateLimiter(dbPath, () => now);
});

afterEach(() => {
  limiter.close();
  rmSync(dir, { recursive: true, force: true });
});

function rowCount() {
  const db = new DatabaseSync(dbPath);
  const row = db.prepare("SELECT COUNT(*) AS n FROM token_usage").get() as { n: number };
  db.close();
  return row.n;
}

test("a reservation counts until exactly one window later", () => {
  expect(limiter.reserve("a", 50_000)).toMatchObject({ status: "ok", remaining: 0 });

  now = T0 + 59_999;
  expect(limiter.remaining("a")).toBe(0);
  expect(limiter.reserve("a", 1)).toEqual({ status: "rate_limited", retryAfterMs: 1 });

  now = T0 + 60_000;
  expect(limiter.remaining("a")).toBe(50_000);
  expect(limiter.reserve("a", 50_000)).toMatchObject({ status: "ok", remaining: 0 });
});

test("retry-after is the exact wait until enough old reservations expire", () => {
  limiter.reserve("a", 20_000);
  now = T0 + 10_000;
  limiter.reserve("a", 20_000);
  now = T0 + 20_000;
  limiter.reserve("a", 10_000);

  now = T0 + 30_000;
  expect(limiter.reserve("a", 20_000)).toEqual({ status: "rate_limited", retryAfterMs: 30_000 });
  expect(limiter.reserve("a", 25_000)).toEqual({ status: "rate_limited", retryAfterMs: 40_000 });

  now = T0 + 70_000;
  expect(limiter.reserve("a", 25_000)).toMatchObject({ status: "ok", remaining: 15_000 });
});

test("expired rows are deleted from the file", () => {
  limiter.reserve("a", 100);
  limiter.reserve("b", 100);
  expect(rowCount()).toBe(2);

  now = T0 + 60_000;
  limiter.reserve("c", 100);
  expect(rowCount()).toBe(1);
});

test("reconcile swaps the estimate for real usage", () => {
  const reservation = limiter.reserve("a", 40_000);
  assert(reservation.status === "ok");

  limiter.reconcile(reservation.id, 1_000);
  expect(limiter.remaining("a")).toBe(49_000);

  limiter.reconcile(reservation.id, 0);
  expect(limiter.reserve("a", 50_000)).toMatchObject({ status: "ok" });
});

test("a request bigger than the whole budget is too large, not rate limited", () => {
  expect(limiter.reserve("a", 50_001)).toEqual({ status: "too_large" });
  expect(rowCount()).toBe(0);
});

test("usage survives reopening the database file", () => {
  limiter.reserve("a", 40_000);
  limiter.close();

  limiter = new RateLimiter(dbPath, () => now);
  expect(limiter.remaining("a")).toBe(10_000);
  expect(limiter.reserve("a", 20_000)).toMatchObject({ status: "rate_limited" });
});

test("tenants have separate budgets", () => {
  limiter.reserve("a", 50_000);
  expect(limiter.reserve("a", 1)).toMatchObject({ status: "rate_limited" });
  expect(limiter.reserve("b", 50_000)).toMatchObject({ status: "ok" });
});
