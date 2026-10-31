import type http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeToken } from "../src/auth.js";
import { createGateway } from "../src/gateway.js";
import { startMockServer, type MockServer } from "../src/mock-server.js";

const secret = new TextEncoder().encode("s".repeat(32));
let downstream: MockServer;
let gateway: http.Server;
let url: string;
let admin: string;
let viewer: string;

beforeAll(async () => {
  downstream = await startMockServer();
  gateway = createGateway(downstream.url, secret);
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/mcp`;
  admin = await makeToken(secret, "alice", "admin");
  viewer = await makeToken(secret, "bob", "viewer");
});

afterAll(() => {
  gateway.closeAllConnections();
  gateway.close();
  downstream.close();
});

async function connect(token: string) {
  const client = new Client({ name: "test", version: "1.0.0" });
  const headers = { Authorization: `Bearer ${token}` };
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  return client;
}

function post(token: string | null, body: unknown) {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const toolCall = (name: string) => ({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: {} } });

describe("with the MCP client", () => {
  it("viewer can list tools and call list_users", async () => {
    const client = await connect(viewer);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(4);
    const result = await client.callTool({ name: "list_users", arguments: {} });
    expect(JSON.stringify(result)).toContain("alice");
    await client.close();
  });

  it("viewer is denied admin_reset_key and downstream never runs it", async () => {
    const client = await connect(viewer);
    const err = await client.callTool({ name: "admin_reset_key", arguments: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(-32001);
    expect(downstream.toolsRun).not.toContain("admin_reset_key");
    await client.close();
  });

  it("admin can run admin_reset_key", async () => {
    const client = await connect(admin);
    await client.callTool({ name: "admin_reset_key", arguments: {} });
    expect(downstream.toolsRun).toContain("admin_reset_key");
    await client.close();
  });

  it("never sends the Authorization header downstream", async () => {
    const client = await connect(viewer);
    await client.listTools();
    await client.close();
    for (const headers of downstream.requestHeaders) {
      expect(headers.authorization).toBeUndefined();
      expect(headers["x-role"]).toBeTruthy();
    }
  });
});

describe("raw requests", () => {
  it("denies ADMIN_ tool names too", async () => {
    const before = downstream.requestHeaders.length;
    const res = await post(viewer, toolCall("ADMIN_delete_user"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: 7, error: { code: -32001 } });
    expect(downstream.requestHeaders.length).toBe(before);
  });

  it("rejects a batch without reaching downstream", async () => {
    const before = downstream.requestHeaders.length;
    const res = await post(viewer, [{ jsonrpc: "2.0", id: 1, method: "tools/list" }, toolCall("admin_delete_user")]);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: -32600 } });
    expect(downstream.requestHeaders.length).toBe(before);
  });

  it("returns -32700 for bad JSON", async () => {
    const res = await post(viewer, "{nope");
    expect(await res.json()).toMatchObject({ id: null, error: { code: -32700 } });
  });

  it("returns -32602 when the tool name is not a string", async () => {
    const res = await post(viewer, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: 5 } });
    expect(await res.json()).toMatchObject({ error: { code: -32602 } });
  });

  it("rejects a body over 1 MB with 413", async () => {
    const res = await post(viewer, "x".repeat(1024 * 1024 + 1));
    expect(res.status).toBe(413);
  });

  it("returns 502 when downstream is down", async () => {
    const g = createGateway("http://127.0.0.1:1/mcp", secret);
    await new Promise<void>((resolve) => g.listen(0, "127.0.0.1", resolve));
    const res = await fetch(`http://127.0.0.1:${(g.address() as AddressInfo).port}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${viewer}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { code: -32603 } });
    g.close();
  });
});

describe("tokens", () => {
  it("returns 401 with WWW-Authenticate when there is no token", async () => {
    const res = await post(null, toolCall("list_users"));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    expect(await res.json()).toMatchObject({ error: { code: expect.any(Number) } });
  });

  it("rejects bad signatures, alg none and unknown roles", async () => {
    const other = new TextEncoder().encode("o".repeat(32));
    const badSig = await makeToken(other, "mallory", "admin");
    const badRole = await new SignJWT({ role: "root" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("x")
      .setExpirationTime("1h")
      .sign(secret);
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const algNone = `${b64({ alg: "none" })}.${b64({ sub: "x", role: "admin", exp: 9999999999 })}.`;
    for (const token of [badSig, badRole, algNone]) {
      expect((await post(token, toolCall("list_users"))).status).toBe(401);
    }
  });
});
