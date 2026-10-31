# QuilrAI take-home

My solutions to the four tasks in the AI Field Developer assessment. Each task has its own folder and README with the details. Everything runs locally against mock servers, so you don't need any API keys.

- [task1-mcp-server](task1-mcp-server): MCP server over stdio with `get_customer_record` and `trigger_refund`, strict zod validation and JSON-RPC error codes.
- [task2-mcp-gateway](task2-mcp-gateway): HTTP proxy in front of an MCP server that reads the role from a JWT and blocks `admin_` tool calls for non-admins.
- [task3-pii-guardrail](task3-pii-guardrail): LLM proxy that redacts emails, SSNs and card numbers from a streamed response as it streams.
- [task4-model-router](task4-model-router): LLM gateway with a per-key token rate limit stored in SQLite, and fallback to a second provider on 429 or timeout.

## Setup

You need Node 22.13 or newer. Task 4 uses the built-in `node:sqlite`, which prints an ExperimentalWarning on Node 22. That's expected.

```sh
npm install
npm test
```

## Running the tasks

```sh
npm run build && node dist/task1-mcp-server/src/main.js   # task 1 talks JSON-RPC on stdin/stdout
npm run task2:demo
npm run task3:demo
npm run task4:demo
```

The demos start their mock servers and either print curl commands to try or, for task 3, stream a sample answer and show what the client receives.

Stack: TypeScript on Node 22, the official MCP SDK, zod and jose. The HTTP servers use plain `node:http` and `fetch`.
