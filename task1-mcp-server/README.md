# Task 1: MCP server

A small MCP server over stdio with two tools, `get_customer_record` and `trigger_refund`. The customers are an in-memory seed list, so refunds reset when the process restarts.

## Running it

From the repo root, after `npm install`:

```sh
npx tsx task1-mcp-server/src/main.ts
```

or build and run the compiled version:

```sh
npm run build
node dist/task1-mcp-server/src/main.js
```

Claude Desktop config:

```json
{
  "mcpServers": {
    "customer-support": {
      "command": "node",
      "args": ["/absolute/path/to/repo/dist/task1-mcp-server/src/main.js"]
    }
  }
}
```

`npm run` prints a banner to stdout, which breaks the JSON-RPC stream. Launch with node directly, or use `npm run -s`.

Tests: `npx vitest run task1-mcp-server`. Seed ids are CUST-10001, CUST-10002, CUST-20003 (closed) and CUST-30004.

## How it works

I used the low-level `Server` instead of `McpServer`. In SDK 1.32 `McpServer` turns invalid-argument errors into `isError` tool results, and I wanted them to come back as real JSON-RPC -32602 errors.

The zod schemas in `src/server.ts` do the validation and also produce the JSON Schema shown in `tools/list`. They are strict, so unknown keys fail. `customer_id` has to match `CUST-` plus five digits exactly. `amount` is a real number (no string coercion) above 0, up to 1,000,000, with at most 2 decimals. `reason` is trimmed and needs at least 10 characters.

Bad arguments and unknown tools give -32602 with the zod issues in `error.data`. Things like a missing customer, a closed account or a refund over the balance are normal tool results with `isError: true`. If something unexpected throws, the details go to stderr and the client only sees -32603 "Internal error". The `tools/call` request schema is deliberately loose so a malformed `name` also ends up as -32602.

stdout only carries JSON-RPC. `console.log`, `info` and `debug` are pointed at stderr when the server starts, and logs use stderr. The SDK transport doesn't answer lines it can't decode, so `main.ts` hooks its error callback and replies with -32700 for invalid JSON and -32600 for JSON that isn't a JSON-RPC message. The server closes on stdin end, SIGINT and SIGTERM.

## Things I'd add next

- An idempotency key on `trigger_refund`. Right now two identical calls make two refunds.
- A real data store, and storing money as integer cents instead of rounded floats.
- Auth and an audit log for refunds.
