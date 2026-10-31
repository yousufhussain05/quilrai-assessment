import { spawn, spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { expect, it } from "vitest";

const root = new URL("../..", import.meta.url).pathname;
const main = new URL("../src/main.ts", import.meta.url).pathname;
const nodeArgs = ["--import", "tsx", main];

// sends every line, closes stdin, and returns what the server wrote to stdout
async function run(lines: string[]) {
  const child = spawn(process.execPath, nodeArgs, { cwd: root });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  const exitCode = new Promise((resolve) => child.on("close", resolve));
  child.stdin.end(lines.join("\n") + "\n");
  const code = await exitCode;
  const raw = out.split("\n").filter(Boolean);
  return { code, raw, replies: raw.map((line) => JSON.parse(line)) };
}

const request = (id: number, method: string, params?: object) => JSON.stringify({ jsonrpc: "2.0", id, method, params });
const call = (name: string, args?: object) => request(2, "tools/call", { name, arguments: args });

async function callOne(name: string, args?: object) {
  const { replies } = await run([call(name, args)]);
  return replies[0];
}

const refund = { customer_id: "CUST-10001", amount: 10, reason: "double charged last month" };

it("only writes json-rpc to stdout", async () => {
  const { raw, replies, code } = await run([
    request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } }),
    request(3, "tools/list"),
    call("get_customer_record", { customer_id: "CUST-10001" }),
    call("get_customer_record", { customer_id: "nope" }),
    "not json",
  ]);
  expect(raw).toHaveLength(5);
  expect(replies.every((r) => r.jsonrpc === "2.0")).toBe(true);
  expect(code).toBe(0);
});

it("lists both tools", async () => {
  const { replies } = await run([request(1, "tools/list")]);
  const names = replies[0].result.tools.map((t: { name: string }) => t.name);
  expect(names).toEqual(["get_customer_record", "trigger_refund"]);
});

it("returns a customer record", async () => {
  const reply = await callOne("get_customer_record", { customer_id: "CUST-10001" });
  expect(reply.result.structuredContent).toMatchObject({ name: "Ada Lovelace", status: "active" });
});

it("rejects a malformed customer id", async () => {
  const reply = await callOne("get_customer_record", { customer_id: "cust-10001" });
  expect(reply.error.code).toBe(-32602);
  expect(reply.error.data.issues[0].path).toBe("customer_id");
});

it("rejects unknown keys", async () => {
  const reply = await callOne("get_customer_record", { customer_id: "CUST-10001", extra: true });
  expect(reply.error.code).toBe(-32602);
});

it("rejects bad refund amounts and reasons", async () => {
  for (const bad of [{ amount: "10" }, { amount: 0 }, { amount: 1.234 }, { amount: 2_000_000 }, { reason: "too short" }]) {
    const reply = await callOne("trigger_refund", { ...refund, ...bad });
    expect(reply.error.code, JSON.stringify(bad)).toBe(-32602);
  }
});

it("rejects an unknown tool", async () => {
  const reply = await callOne("delete_everything", {});
  expect(reply.error.code).toBe(-32602);
});

it("returns -32602 when the call params are malformed", async () => {
  const { replies } = await run([request(2, "tools/call", { name: 5 })]);
  expect(replies[0].error.code).toBe(-32602);
});

it("reports a missing customer as a tool error", async () => {
  const reply = await callOne("get_customer_record", { customer_id: "CUST-99999" });
  expect(reply.error).toBeUndefined();
  expect(reply.result.isError).toBe(true);
});

it("queues a refund and lowers the balance", async () => {
  const { replies } = await run([
    request(1, "tools/call", { name: "trigger_refund", arguments: refund }),
    request(2, "tools/call", { name: "trigger_refund", arguments: { ...refund, amount: 240.01 } }),
    request(3, "tools/call", { name: "trigger_refund", arguments: { ...refund, customer_id: "CUST-20003" } }),
  ]);
  expect(replies[0].result.structuredContent).toMatchObject({ status: "queued", amount: 10, remaining_refundable_balance: 240 });
  expect(replies[1].result.isError).toBe(true);
  expect(replies[2].result.isError).toBe(true);
});

it("answers garbage input with parse and invalid request errors", async () => {
  const { replies } = await run(["{not json", '{"foo":1}']);
  expect(replies[0]).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  expect(replies[1].error.code).toBe(-32600);
});

it("sends console.log to stderr", () => {
  const script = `await import(${JSON.stringify(main)}); console.log("probe")`;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: root,
    input: "",
    encoding: "utf8",
  });
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("probe");
});

it("shows an McpError with code -32602 to the sdk client", async () => {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: nodeArgs, cwd: root, stderr: "ignore" }));
  const error = await client.callTool({ name: "trigger_refund", arguments: { customer_id: "x" } }).catch((e) => e);
  await client.close();
  expect(error).toBeInstanceOf(McpError);
  expect(error.code).toBe(-32602);
});
