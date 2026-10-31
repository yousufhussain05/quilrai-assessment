import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ZodError } from "zod";
import { createServer } from "./server.js";

// stdout is the JSON-RPC channel, so anything that would print there goes to stderr instead
console.log = console.info = console.debug = console.error;

function replyWithError(code: number, message: string) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } }) + "\n");
}

const server = createServer();
const transport = new StdioServerTransport();
await server.connect(transport);

// the transport only reports bad input through onerror, it never answers it
const sdkOnError = transport.onerror;
transport.onerror = (error) => {
  sdkOnError?.(error);
  if (error instanceof SyntaxError) replyWithError(-32700, "Parse error");
  else if (error instanceof ZodError) replyWithError(-32600, "Invalid Request");
};

async function shutdown() {
  await server.close();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("end", shutdown);

console.error("customer-support server ready on stdio");
