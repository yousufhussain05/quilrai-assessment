# Task 3: PII redaction on streamed responses

A small OpenAI-compatible proxy for `POST /v1/chat/completions`. It forwards the request to an upstream provider and replaces emails, credit card numbers and US SSNs in the answer with `[REDACTED]`. Streaming responses stay streaming. Each delta is redacted and passed on as soon as it's safe to send.

`src/redact.ts` has the regex and `StreamRedactor`, `src/sse.ts` parses the upstream event stream, `src/gateway.ts` is the HTTP server, and `src/mock-llm.ts` is a fake provider for the demo and the tests.

## Run

From the repo root:

```sh
# mock LLM + gateway + one streaming request, prints each delta with its arrival time
npx tsx task3-pii-guardrail/src/demo.ts

# tests
npx vitest run task3-pii-guardrail

# gateway in front of a real provider (PORT defaults to 8787)
UPSTREAM_URL=https://api.openai.com UPSTREAM_API_KEY=sk-... npx tsx task3-pii-guardrail/src/main.ts
curl -N localhost:8787/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"gpt-4o-mini","stream":true,"messages":[{"role":"user","content":"Make up a customer with an email and the test card 4111 1111 1111 1111"}]}'
```

In the demo the mock sends 20 chunks 60ms apart, with the email, card and SSN each split across chunks. An empty `""` line means the gateway got a chunk but is still holding its text back.

## How the redaction works

There's one global regex that combines the three patterns. Emails are the usual `local@domain.tld` shape. SSNs are `123-45-6789`, `123 45 6789` or `123456789`, skipping area 000, 666 and 9xx, group 00 and serial 0000. Cards are 13 to 19 digits, either in one run or grouped 4-4-4-4 or 4-6-5 with the same space or dash between groups, and they only get redacted if the Luhn check passes.

The streaming part is the interesting bit. An email can show up as `jane.d`, `oe@exam`, `ple.com` in three chunks, and none of those match on their own. So every choice in the stream gets a `StreamRedactor` that holds back the end of the text that could still turn into a match. That's the trailing run of characters from `[A-Za-z0-9._%+@-]`, plus a space that comes right after a digit, since `4111 ` can still continue as a card. Everything before that run gets redacted and sent.

```
push("Email: jane.d")   -> "Email: "             holding "jane.d"
push("oe@exam")         -> ""                    holding "jane.doe@exam"
push("ple.com, card ")  -> "[REDACTED], card "   holding ""
```

The character right before the held text can't be part of a match that continues into later text, so redacting the front part alone gives the same result as redacting the whole answer at the end. The tests check this by streaming random chunkings of random text and comparing against `redact(fullText)`.

The cost is latency. Prose that ends in whitespace goes out right away, but a trailing word or digit group waits for the next chunk, so the client sees each token one token later than it would without the gateway. On my laptop one `StreamRedactor` gets through about 40 MB/s of text in small chunks, so the regex isn't the slow part.

One long token with no break (a base64 blob, say) would otherwise be held forever. Once the held text passes 512 characters the redactor cuts it anyway, moving the cut back to the start of any match that crosses it. It also keeps the last character it sent so the regex lookbehinds still see it after a cut like that.

In the gateway, the redactors live in a `Map` keyed by choice index, since `n > 1` interleaves choices in one stream. Held text is flushed into the chunk that carries `finish_reason`, and again before `[DONE]` for any choice that never sent one. SSE headers are flushed before the first chunk, writes wait for `drain` when the socket buffer is full, and a client disconnect aborts the upstream fetch. If the upstream fails before streaming starts, the client gets a 502 with a generic message. If it dies mid-stream, the client gets one error event and the held text is dropped, because it might be the first half of an email.

## Limitations

- Only emails, cards and SSNs, matched by regex. No names, addresses, phone numbers or API keys.
- Emails are ASCII only. Cards have to start with 2 to 6, and other layouts like 4-4-4-4-3 or dot separators are missed.
- Roughly 1 in 10 random 16-digit numbers passes Luhn, and any 9-digit number that fits the SSN rules gets redacted, so some order numbers will get caught.
- Only `content` is redacted. Tool call arguments and logprobs pass through as is, and the prompt sent upstream isn't touched.
- The 512 cap only works because no match can be longer than about 470 characters (the email pattern has length limits). If the email pattern gets looser, the cap has to go up too.
- The gateway has no auth, rate limiting or body size limit. Without `UPSTREAM_API_KEY` it forwards the client's `Authorization` header.
