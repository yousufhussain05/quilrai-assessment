import { once } from "node:events";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { createGateway } from "./gateway.js";
import { CHUNKS, createMockLlm } from "./mock-llm.js";
import { readSseEvents } from "./sse.js";

async function listen(server: http.Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const mock = createMockLlm({ delayMs: 60 });
const gatewayUrl = await listen(createGateway(await listen(mock)));

console.log(`mock LLM sends ${CHUNKS.length} chunks, 60ms apart:`);
console.log(CHUNKS.map((c) => JSON.stringify(c)).join(" | "));
console.log("\nclient receives (ms since request):");

const start = performance.now();
const res = await fetch(`${gatewayUrl}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "mock", stream: true, messages: [{ role: "user", content: "show me the record" }] }),
});

let answer = "";
for await (const data of readSseEvents(res.body!)) {
  const ms = String(Math.round(performance.now() - start)).padStart(5);
  if (data === "[DONE]") {
    console.log(`${ms}  [DONE]`);
    break;
  }
  const chunk = JSON.parse(data) as { choices: { delta: { content?: string } }[] };
  const content = chunk.choices.map((c) => c.delta.content ?? "").join("");
  answer += content;
  console.log(`${ms}  ${JSON.stringify(content)}`);
}

console.log(`\nfull answer:\n${answer}`);
process.exit(0);
