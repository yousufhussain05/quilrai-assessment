async function* lines(body: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true });
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) yield part.replace(/\r$/, "");
  }
  buffer += decoder.decode();
  if (buffer !== "") yield buffer.replace(/\r$/, "");
  yield ""; // so a last event with no blank line after it still comes out
}

export async function* readSseEvents(body: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  let data: string[] = [];
  for await (const line of lines(body)) {
    if (line === "") {
      if (data.length > 0) yield data.join("\n");
      data = [];
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).replace(/^ /, ""));
    }
  }
}
