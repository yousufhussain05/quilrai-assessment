import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { text } from "node:stream/consumers";

export type MockMode = "ok" | "rate_limited" | "slow" | "error" | "bad_request";

// a fake OpenAI-style provider; POST /mode with a mode name in the body to change how it behaves
export async function startMockProvider(name: string, port = 0) {
  const mock = {
    url: "",
    mode: "ok" as MockMode,
    requests: [] as unknown[],
    aborted: 0,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };

  const server = createServer(async (req, res) => {
    const raw = await text(req);

    if (req.url === "/mode") {
      mock.mode = raw.trim() as MockMode;
      res.end(`${name} is now ${mock.mode}\n`);
      return;
    }

    const body = JSON.parse(raw);
    mock.requests.push(body);
    res.on("close", () => {
      if (!res.writableFinished) mock.aborted++;
    });

    const send = (status: number, payload: unknown, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(payload));
    };
    const completion = {
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: `Hello from ${name}.` }, finish_reason: "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    };

    switch (mock.mode) {
      case "ok":
        return send(200, completion);
      case "slow": {
        const timer = setTimeout(() => send(200, completion), 5000);
        res.on("close", () => clearTimeout(timer));
        return;
      }
      case "rate_limited":
        return send(429, { error: { message: "Rate limit reached", type: "rate_limit" } }, { "retry-after": "10" });
      case "bad_request":
        return send(400, { error: { message: "max_tokens is too large for this model", type: "invalid_request_error" } });
      case "error":
        return send(500, {
          error: "Internal Server Error",
          stack: "Error: connect ECONNREFUSED 10.0.3.17:5432\n    at InferenceWorker.run (/srv/inference/worker.py:88:12)",
        });
    }
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  mock.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`;
  return mock;
}
