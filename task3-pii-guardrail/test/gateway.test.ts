import { once } from "node:events";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { createGateway } from "../src/gateway.js";
import { createMockLlm } from "../src/mock-llm.js";
import { readSseEvents } from "../src/sse.js";

const REDACTED_ANSWER =
  "Sure, here is the customer record. Email: [REDACTED], card [REDACTED], SSN [REDACTED]. " +
  "Order 4111 1111 1111 1112 ships in 2024 for $1,299.99; call 555-867-5309 by 2024-06-15. " +
  "Anything else? Write to [REDACTED]";

const servers: http.Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

async function listen(server: http.Server): Promise<string> {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function startGateway(mock = createMockLlm({ delayMs: 1 })): Promise<string> {
  return listen(createGateway(await listen(mock)));
}

function post(url: string, body: object, signal?: AbortSignal): Promise<Response> {
  return fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "mock", messages: [{ role: "user", content: "hi" }], ...body }),
    signal,
  });
}

async function readEvents(res: Response) {
  const events: { at: number; data: string; content: string }[] = [];
  for await (const data of readSseEvents(res.body!)) {
    const content = data === "[DONE]" ? "" : (JSON.parse(data).choices?.[0]?.delta?.content ?? "");
    events.push({ at: performance.now(), data, content });
  }
  return events;
}

function textOf(events: { content: string }[]): string {
  return events.map((e) => e.content).join("");
}

it("streams the answer with PII redacted", async () => {
  const res = await post(await startGateway(), { stream: true });
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  const events = await readEvents(res);
  expect(textOf(events)).toBe(REDACTED_ANSWER);
  expect(events.at(-1)?.data).toBe("[DONE]");

  // the trailing email is still held when finish_reason arrives, so it goes out in that chunk
  const finish = events.at(-2)!;
  expect(JSON.parse(finish.data).choices[0].finish_reason).toBe("stop");
  expect(finish.content).toBe("[REDACTED]");
});

it("delivers the first delta long before the stream ends", async () => {
  const url = await startGateway(createMockLlm({ delayMs: 40 }));
  const start = performance.now();
  const events = await readEvents(await post(url, { stream: true }));
  const first = events.find((e) => e.content !== "")!;
  expect(first.at - start).toBeLessThan(200);
  expect(events.at(-1)!.at - start).toBeGreaterThan(700);
});

it("aborts the upstream request when the client disconnects", async () => {
  const mock = createMockLlm({ delayMs: 50 });
  const upstreamFinished = new Promise<boolean>((resolve) => {
    mock.on("request", (_req, res: http.ServerResponse) => res.on("close", () => resolve(res.writableEnded)));
  });
  const client = new AbortController();
  const res = await post(await startGateway(mock), { stream: true }, client.signal);
  for await (const data of readSseEvents(res.body!)) {
    if (data.includes("Sure")) break;
  }
  client.abort();
  expect(await upstreamFinished).toBe(false);
});

it("drops held text and sends an error event when the upstream dies mid-stream", async () => {
  // dies right after "oe@exam", so "jane.doe@exam" is still held
  const url = await startGateway(createMockLlm({ delayMs: 1, failAfter: 5 }));
  const events = await readEvents(await post(url, { stream: true }));
  expect(textOf(events)).toBe("Sure, here is the customer record. Email: ");
  expect(events.at(-1)?.data).toBe(JSON.stringify({ error: { message: "upstream stream failed" } }));
});

it("redacts non-streaming responses", async () => {
  const res = await post(await startGateway(), {});
  const body = (await res.json()) as { choices: { message: { content: string } }[] };
  expect(body.choices[0].message.content).toBe(REDACTED_ANSWER);
});

it("returns a generic 502 when the upstream is down", async () => {
  const url = await listen(createGateway("http://127.0.0.1:1"));
  const res = await post(url, { stream: true });
  expect(res.status).toBe(502);
  expect(await res.json()).toEqual({ error: { message: "upstream request failed" } });
});
