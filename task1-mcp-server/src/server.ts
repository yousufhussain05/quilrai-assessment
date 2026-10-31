import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getCustomer, refund } from "./store.js";

const customerId = z.string().regex(/^CUST-\d{5}$/, "customer_id must look like CUST-12345");

const getCustomerArgs = z.strictObject({ customer_id: customerId });

const refundArgs = z.strictObject({
  customer_id: customerId,
  amount: z
    .number()
    .positive()
    .max(1_000_000)
    .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, "amount can have at most 2 decimal places"),
  reason: z.string().trim().min(10, "reason must be at least 10 characters").max(500),
});

const tools = [
  {
    name: "get_customer_record",
    description: "Look up a customer by customer_id (format CUST-12345).",
    inputSchema: z.toJSONSchema(getCustomerArgs),
  },
  {
    name: "trigger_refund",
    description: "Queue a refund for a customer. amount is in USD with at most 2 decimals.",
    inputSchema: z.toJSONSchema(refundArgs),
  },
];

// permissive on purpose: if the SDK parsed params with its own schema, bad params would come back as -32603
const callToolRequest = z.object({ method: z.literal("tools/call"), params: z.unknown() });
const callToolParams = z.looseObject({ name: z.string(), arguments: z.unknown() });

function invalidParams(message: string, error: z.ZodError) {
  const issues = error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
  return new McpError(ErrorCode.InvalidParams, message, { issues });
}

function parse<T extends z.ZodType>(schema: T, args: unknown): z.output<T> {
  const result = schema.safeParse(args ?? {});
  if (!result.success) throw invalidParams("Invalid arguments", result.error);
  return result.data;
}

function result(payload: object): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: { ...payload } };
}

function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function callTool(name: string, args: unknown): CallToolResult {
  if (name === "get_customer_record") {
    const { customer_id } = parse(getCustomerArgs, args);
    const customer = getCustomer(customer_id);
    return customer ? result(customer) : toolError("Customer not found");
  }
  if (name === "trigger_refund") {
    const { customer_id, amount, reason } = parse(refundArgs, args);
    const outcome = refund(customer_id, amount, reason);
    return typeof outcome === "string" ? toolError(outcome) : result(outcome);
  }
  throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
}

export function createServer() {
  const server = new Server({ name: "customer-support", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.onerror = (error) => console.error("server error:", error);

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));

  server.setRequestHandler(callToolRequest, (request) => {
    const params = callToolParams.safeParse(request.params);
    if (!params.success) throw invalidParams("Invalid tools/call params", params.error);

    try {
      return callTool(params.data.name, params.data.arguments);
    } catch (error) {
      if (error instanceof McpError) throw error;
      console.error("tool failed:", error);
      throw new McpError(ErrorCode.InternalError, "Internal error");
    }
  });

  return server;
}
