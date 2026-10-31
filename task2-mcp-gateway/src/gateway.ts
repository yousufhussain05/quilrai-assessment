import http from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { verifyToken } from "./auth.js";

const MAX_BODY = 1024 * 1024;
const FORWARDED = ["content-type", "accept", "mcp-session-id", "mcp-protocol-version"];
const UNAUTHORIZED_TOOL = -32001;

function sendError(res: http.ServerResponse, status: number, id: unknown, code: number, message: string) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
}

async function readBody(req: http.IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString();
}

export function createGateway(downstreamUrl: string, secret: Uint8Array): http.Server {
  return http.createServer((req, res) => {
    handle(req, res, downstreamUrl, secret).catch((err) => {
      console.log("request failed:", err.message);
      if (res.headersSent) res.destroy();
      else sendError(res, 500, null, -32603, "Internal error");
    });
  });
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, downstreamUrl: string, secret: Uint8Array) {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    return sendError(res, 405, null, -32600, "Method not allowed");
  }

  const user = await verifyToken(req.headers.authorization, secret);
  if (!user) {
    console.log("deny: bad or missing token");
    res.setHeader("www-authenticate", 'Bearer error="invalid_token"');
    return sendError(res, 401, null, -32000, "Unauthenticated");
  }

  const raw = await readBody(req);
  if (raw === null) {
    res.setHeader("connection", "close");
    return sendError(res, 413, null, -32600, "Request body too large");
  }

  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return sendError(res, 400, null, -32700, "Parse error");
  }
  // a batch could hide an admin call next to a harmless one, so no batches
  if (Array.isArray(msg)) return sendError(res, 400, null, -32600, "Batch requests are not supported");
  if (msg?.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return sendError(res, 400, null, -32600, "Invalid Request");
  }

  const id = msg.id ?? null;
  if (msg.method === "tools/call") {
    const name = msg.params?.name;
    if (typeof name !== "string") return sendError(res, 200, id, -32602, "Invalid params: tool name must be a string");
    if (name.toLowerCase().startsWith("admin_") && user.role !== "admin") {
      console.log(`deny: ${user.name} (${user.role}) tried ${name}`);
      return sendError(res, 200, id, UNAUTHORIZED_TOOL, "Unauthorized Tool Call");
    }
    console.log(`allow: ${user.name} (${user.role}) called ${name}`);
  } else {
    console.log(`allow: ${user.name} (${user.role}) ${msg.method}`);
  }

  const headers = new Headers({ "x-user": user.name, "x-role": user.role });
  for (const name of FORWARDED) {
    const value = req.headers[name];
    if (typeof value === "string") headers.set(name, value);
  }

  let upstream: Response;
  try {
    upstream = await fetch(downstreamUrl, { method: "POST", headers, body: JSON.stringify(msg) });
  } catch (err) {
    console.log("downstream unreachable:", err);
    return sendError(res, 502, null, -32603, "Internal error");
  }

  const out: Record<string, string> = {};
  for (const name of ["content-type", "mcp-session-id"]) {
    const value = upstream.headers.get(name);
    if (value) out[name] = value;
  }
  res.writeHead(upstream.status, out);
  if (!upstream.body) return void res.end();
  await pipeline(Readable.fromWeb(upstream.body), res).catch(() => {});
}
