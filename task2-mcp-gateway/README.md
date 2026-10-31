# MCP gateway

A small proxy that sits in front of an MCP server (streamable HTTP). It checks a bearer JWT, reads the caller's role, and blocks `admin_*` tool calls for anyone who isn't an admin. Everything else is passed through to the downstream server, including SSE responses.

## Try it

    npx tsx task2-mcp-gateway/src/demo.ts

That starts a mock MCP server on :8788 and the gateway on :8787 with a random secret, and prints curl commands with an admin token and a viewer token already filled in. The gist:

    # viewer, allowed
    curl localhost:8787/mcp -H "Authorization: Bearer $VIEWER" -H 'Content-Type: application/json' \
      -H 'Accept: application/json, text/event-stream' \
      -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_users","arguments":{}}}'

    # viewer, denied with -32001 (same curl, name admin_reset_key)
    # admin, allowed (same curl with $ADMIN)
    # no token: 401 with a WWW-Authenticate header
    curl -i localhost:8787/mcp -d '{}'

Tests run with `npx vitest run task2-mcp-gateway`.

## Design notes

The token is an HS256 JWT checked with jose. The algorithm is pinned and `exp` is required. The `role` claim has to be `admin` or `viewer`, otherwise it is treated like a bad token and gets a 401.

For `tools/call` the gateway looks at `params.name`. If it starts with `admin_` (any casing) and the role isn't admin, it answers with JSON-RPC error -32001 "Unauthorized Tool Call" and never talks to the downstream. The denial is an HTTP 200 on purpose: the official MCP client turns non-2xx responses into transport errors, so the agent would never see the -32001.

Batches are rejected outright, since a batch could hide an admin call next to a harmless one. Bodies over 1 MB get a 413.

What goes downstream is `JSON.stringify` of the parsed message, not the raw bytes, so what I checked is what gets forwarded. The Authorization header is dropped and replaced with `x-user` and `x-role`. The response is piped straight back so SSE works. If the downstream is down the client gets a generic 502 with -32603.

## Known gaps

- Only POST is supported, so there is no GET stream for server-initiated messages.
- Shared secret only. Real use would want JWKS or asymmetric keys.
- No rate limiting and no timeout on the downstream request.
- Role names and the `admin_` prefix are hardcoded.
