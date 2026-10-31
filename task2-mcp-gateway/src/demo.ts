import { randomBytes } from "node:crypto";
import { makeToken } from "./auth.js";
import { createGateway } from "./gateway.js";
import { startMockServer } from "./mock-server.js";

const secret = randomBytes(32);
const downstream = await startMockServer(8788);
createGateway(downstream.url, secret).listen(8787);

const admin = await makeToken(secret, "alice", "admin");
const viewer = await makeToken(secret, "bob", "viewer");

const curl = (token: string, body: object) =>
  `curl -s http://localhost:8787/mcp -H 'Authorization: Bearer ${token}' ` +
  `-H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' ` +
  `-d '${JSON.stringify(body)}'`;
const call = (name: string) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } });

console.log("gateway on :8787, mock downstream on :8788\n");
console.log("# viewer lists tools\n" + curl(viewer, { jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
console.log("# viewer calls list_users\n" + curl(viewer, call("list_users")) + "\n");
console.log("# viewer calls admin_reset_key (denied)\n" + curl(viewer, call("admin_reset_key")) + "\n");
console.log("# admin calls admin_reset_key\n" + curl(admin, call("admin_reset_key")) + "\n");
console.log("# no token (401)\ncurl -i http://localhost:8787/mcp -d '{}'");
