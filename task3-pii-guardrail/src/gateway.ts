import { once } from "node:events";
import http from "node:http";
import { text } from "node:stream/consumers";
import { redact, StreamRedactor } from "./redact.js";
import { readSseEvents } from "./sse.js";

interface Chunk {
  choices?: { index: number; delta?: { content?: string | null }; finish_reason?: string | null }[];
}

export function createGateway(upstreamUrl: string, apiKey?: string): http.Server {
  return http.createServer({ noDelay: true }, async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      return sendJson(res, 404, { error: { message: "not found" } });
    }

    let request: { stream?: boolean };
    try {
      request = JSON.parse(await text(req));
    } catch {
      return sendJson(res, 400, { error: { message: "request body must be JSON" } });
    }

    const abort = new AbortController();
    res.on("close", () => abort.abort());
    const auth = apiKey ? `Bearer ${apiKey}` : req.headers.authorization;

    try {
      const upstream = await fetch(`${upstreamUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(auth && { authorization: auth }) },
        body: JSON.stringify(request),
        signal: abort.signal,
      });
      if (!upstream.ok || !upstream.body) {
        return sendJson(res, 502, { error: { message: `upstream returned ${upstream.status}` } });
      }
      if (request.stream) return await streamRedacted(upstream.body, res, abort.signal);

      const completion = (await upstream.json()) as { choices?: { message?: { content?: string } }[] };
      for (const choice of completion.choices ?? []) {
        if (choice.message?.content) choice.message.content = redact(choice.message.content);
      }
      sendJson(res, 200, completion);
    } catch {
      if (!res.headersSent) sendJson(res, 502, { error: { message: "upstream request failed" } });
    }
  });
}

async function streamRedacted(body: ReadableStream<Uint8Array>, res: http.ServerResponse, signal: AbortSignal) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" });
  res.flushHeaders();

  const send = async (data: string) => {
    if (!res.write(`data: ${data}\n\n`)) await once(res, "drain", { signal });
  };

  // one redactor per choice, since n > 1 interleaves choices in the same stream
  const redactors = new Map<number, StreamRedactor>();
  let chunk: Chunk = {};
  try {
    for await (const data of readSseEvents(body)) {
      if (data === "[DONE]") break;
      chunk = JSON.parse(data) as Chunk;
      for (const choice of chunk.choices ?? []) {
        const redactor = redactors.get(choice.index) ?? new StreamRedactor();
        redactors.set(choice.index, redactor);

        let content = redactor.push(choice.delta?.content ?? "");
        if (choice.finish_reason) {
          content += redactor.flush();
          redactors.delete(choice.index);
        }
        choice.delta = { ...choice.delta, content };
      }
      await send(JSON.stringify(chunk));
    }

    // choices that never sent a finish_reason still have text held back
    const rest = [...redactors].map(([index, r]) => ({ index, delta: { content: r.flush() }, finish_reason: null }));
    if (rest.length > 0) await send(JSON.stringify({ ...chunk, choices: rest }));
    await send("[DONE]");
  } catch {
    if (signal.aborted) return;
    // whatever the redactors still hold is dropped, it could be the start of an email
    res.write(`data: ${JSON.stringify({ error: { message: "upstream stream failed" } })}\n\n`);
  }
  res.end();
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
