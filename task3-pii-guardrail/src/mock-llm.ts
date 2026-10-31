import http from "node:http";
import { text } from "node:stream/consumers";
import { setTimeout as sleep } from "node:timers/promises";

// PII is split across chunks on purpose. The "Order" sentence is near-misses that should pass through.
export const CHUNKS = [
  "Sure", ", here is the", " customer record",
  ". Email: jane.d", "oe@exam", "ple.com", ", card ", "4111 1111 ", "1111 1111", ", SSN 123-4", "5-6789",
  ". Order 4111", " 1111 1111 1112", " ships in 2024", " for $1,299", ".99; call 555-867", "-5309 by 2024", "-06-15",
  ". Anything else? Write to ", "help@acme.io",
];

export function createMockLlm({ delayMs = 30, failAfter = Infinity } = {}): http.Server {
  return http.createServer(async (req, res) => {
    const { stream } = JSON.parse(await text(req)) as { stream?: boolean };

    if (!stream) {
      const message = { role: "assistant", content: CHUNKS.join("") };
      const choices = [{ index: 0, message, finish_reason: "stop" }];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "mock", object: "chat.completion", choices }));
      return;
    }

    const send = (delta: object, finish_reason: string | null = null) => {
      const chunk = { id: "mock", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    };

    res.writeHead(200, { "content-type": "text/event-stream" });
    send({ role: "assistant", content: "" });
    for (const [i, content] of CHUNKS.entries()) {
      await sleep(delayMs);
      if (res.destroyed) return;
      if (i === failAfter) {
        res.destroy();
        return;
      }
      send({ content });
    }
    send({}, "stop");
    res.end("data: [DONE]\n\n");
  });
}
