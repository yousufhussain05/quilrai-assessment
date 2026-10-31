import http from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

export type MockServer = {
  url: string;
  toolsRun: string[];
  requestHeaders: http.IncomingHttpHeaders[];
  close: () => void;
};

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

export async function startMockServer(port = 0): Promise<MockServer> {
  const toolsRun: string[] = [];
  const requestHeaders: http.IncomingHttpHeaders[] = [];

  function buildServer() {
    const server = new McpServer({ name: "mock-downstream", version: "1.0.0" });
    const run = (name: string, result: string) => () => {
      toolsRun.push(name);
      return text(result);
    };
    server.registerTool("list_users", { description: "List users" }, run("list_users", '["alice","bob"]'));
    server.registerTool("get_weather", { description: "Get weather", inputSchema: { city: z.string() } }, ({ city }) => {
      toolsRun.push("get_weather");
      return text(`Sunny in ${city}`);
    });
    server.registerTool("admin_reset_key", { description: "Reset the API key" }, run("admin_reset_key", "key reset"));
    server.registerTool("admin_delete_user", { description: "Delete a user", inputSchema: { user: z.string() } }, ({ user }) => {
      toolsRun.push("admin_delete_user");
      return text(`deleted ${user}`);
    });
    return server;
  }

  const httpServer = http.createServer(async (req, res) => {
    requestHeaders.push(req.headers);
    // stateless: fresh server + transport per request
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => httpServer.listen(port, "127.0.0.1", resolve));

  return {
    url: `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`,
    toolsRun,
    requestHeaders,
    close: () => {
      httpServer.closeAllConnections();
      httpServer.close();
    },
  };
}
