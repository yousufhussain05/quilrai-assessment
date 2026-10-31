import { expect, it } from "vitest";
import { readSseEvents } from "../src/sse.js";

async function parse(...chunks: Uint8Array[]): Promise<string[]> {
  async function* body() {
    yield* chunks;
  }
  const events: string[] = [];
  for await (const data of readSseEvents(body())) events.push(data);
  return events;
}

it("parses events split at any byte, with CRLF and multi-line data", async () => {
  const raw = new TextEncoder().encode(
    ': ping\r\ndata: {"a":1}\r\n\r\ndata: two\r\ndata: lines\r\n\r\nevent: x\nid: 7\ndata:no space\n\ndata: [DONE]',
  );
  for (let i = 0; i <= raw.length; i++) {
    expect(await parse(raw.slice(0, i), raw.slice(i)), `split at ${i}`).toEqual([
      '{"a":1}',
      "two\nlines",
      "no space",
      "[DONE]",
    ]);
  }
});

it("decodes a UTF-8 character split across chunks", async () => {
  const raw = new TextEncoder().encode("data: héllo 😀 世界\n\n");
  for (let i = 0; i <= raw.length; i++) {
    expect(await parse(raw.slice(0, i), raw.slice(i)), `split at ${i}`).toEqual(["héllo 😀 世界"]);
  }
});
