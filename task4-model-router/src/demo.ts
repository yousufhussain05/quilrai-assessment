import { startMockProvider } from "./mock-provider.js";
import { createGateway } from "./server.js";

const primary = await startMockProvider("primary", 9101);
const secondary = await startMockProvider("secondary", 9102);

const gateway = createGateway({
  apiKeys: ["demo-key"],
  dbPath: "gateway.sqlite",
  primary: { url: primary.url, model: "primary-model", timeoutMs: 3000 },
  secondary: { url: secondary.url, model: "secondary-model", timeoutMs: 10_000 },
});

const call = (maxTokens: number) =>
  `curl -i localhost:8080/v1/chat/completions -H 'authorization: Bearer demo-key' ` +
  `-H 'content-type: application/json' -d '{"messages":[{"role":"user","content":"hello"}],"max_tokens":${maxTokens}}'`;

gateway.listen(8080, () => {
  console.log(`gateway on :8080, primary mock on :9101, secondary mock on :9102

normal request, served by the primary:
  ${call(100)}

make the primary slow (or rate_limited / error / bad_request), then send the request again:
  curl -X POST localhost:9101/mode -d slow

with the primary slow, three 20k-token requests don't fit in the 50k budget, so one gets a 429:
  for i in 1 2 3; do ${call(20_000)} & done; wait
`);
});
