import { describe, expect, it } from "vitest";
import { redact, StreamRedactor } from "../src/redact.js";

function streamed(chunks: string[]): string {
  const redactor = new StreamRedactor();
  return chunks.map((c) => redactor.push(c)).join("") + redactor.flush();
}

const PIECES = ["jane.doe@example.com", "4111 1111 1111 1111", "3782-822463-10005", "123-45-6789", "123456789",
  "4111 1111 1111 1112", "555-867-5309", "2024-06-15", "user@localhost", "hello", "world", "42"];

const pick = <T>(list: T[]) => list[Math.floor(Math.random() * list.length)];

function randomText(pieceCount: number, separators: string[]): string {
  let text = "";
  for (let i = 0; i < pieceCount; i++) text += pick(PIECES) + pick(separators);
  return text;
}

function randomChunks(text: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; ) {
    const size = 1 + Math.floor(Math.random() * 15);
    chunks.push(text.slice(i, i + size));
    i += size;
  }
  return chunks;
}

describe("redact", () => {
  it("redacts emails", () => {
    expect(redact("mail jane.doe@example.com or j+tag@mail.example.co.uk.")).toBe("mail [REDACTED] or [REDACTED].");
    expect(redact("(A_B%C@Sub-Domain.Example.ORG)")).toBe("([REDACTED])");
  });

  it("redacts cards only when the Luhn check passes", () => {
    for (const card of ["4111 1111 1111 1111", "4111-1111-1111-1111", "4111111111111111", "3782 822463 10005"]) {
      expect(redact(`card ${card}, thanks`)).toBe("card [REDACTED], thanks");
    }
    for (const notCard of ["4111 1111 1111 1112", "4111111111111112", "4111-1111 1111-1111", "41111111111111111111"]) {
      expect(redact(`ref ${notCard}`)).toBe(`ref ${notCard}`);
    }
    expect(redact("ref 1234-4111-1111-1111-1111")).toBe("ref 1234-[REDACTED]");
  });

  it("redacts SSNs in all three formats and skips invalid ones", () => {
    expect(redact("SSN 123-45-6789, 123 45 6789 or 123456789")).toBe("SSN [REDACTED], [REDACTED] or [REDACTED]");
    for (const notSsn of ["000-12-3456", "666-12-3456", "912-34-5678", "123-00-4567", "123-45-0000", "123-45 6789"]) {
      expect(redact(`id ${notSsn}`)).toBe(`id ${notSsn}`);
    }
  });

  it("leaves near-misses alone", () => {
    const text = "call 555-867-5309 or (555) 867-5309, pay $1,299.99 by 2024-06-15 at 10:30, user@localhost";
    expect(redact(text)).toBe(text);
  });
});

describe("StreamRedactor", () => {
  it("redacts PII split across chunks", () => {
    const redactor = new StreamRedactor();
    expect(redactor.push("Email: jane.d")).toBe("Email: ");
    expect(redactor.push("oe@exam")).toBe("");
    expect(redactor.push("ple.com, card 4111 ")).toBe("[REDACTED], card ");
    expect(redactor.push("1111 1111 1111 ok")).toBe("[REDACTED] ");
    expect(redactor.flush()).toBe("ok");
  });

  it("sends prose as soon as it ends in whitespace", () => {
    const redactor = new StreamRedactor();
    expect(redactor.push("Hello world, how are ")).toBe("Hello world, how are ");
    expect(redactor.push("you")).toBe("");
    expect(redactor.push(" today")).toBe("you ");
    expect(redactor.flush()).toBe("today");
  });

  it("matches redact() on the full text for random chunkings", () => {
    for (let run = 0; run < 500; run++) {
      const text = randomText(12, [" ", " ", ", ", ". ", "\n", "-", "@", ""]);
      const chunks = randomChunks(text);
      expect(streamed(chunks), JSON.stringify(chunks)).toBe(redact(text));
    }
  });

  it("still matches redact() when one long token goes past the 512 char cap", () => {
    for (let run = 0; run < 200; run++) {
      const text = randomText(80, ["", "-", ".", "@"]);
      const chunks = randomChunks(text);
      expect(streamed(chunks), JSON.stringify(chunks)).toBe(redact(text));
    }
  });

  it("holds at most 512 chars of a long token with no whitespace", () => {
    const token = "abc.def-gh_".repeat(10_000);
    const redactor = new StreamRedactor();
    let out = "";
    for (let i = 0; i < token.length; i += 100) {
      out += redactor.push(token.slice(i, i + 100));
      expect(Math.min(i + 100, token.length) - out.length).toBeLessThanOrEqual(512);
    }
    expect(out + redactor.flush()).toBe(token);
  });
});
