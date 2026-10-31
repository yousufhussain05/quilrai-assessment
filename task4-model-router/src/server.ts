import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { json } from "node:stream/consumers";
import { z } from "zod";
import { RateLimiter } from "./rate-limiter.js";
import { route, type Provider } from "./router.js";

const ERRORS = {
  invalid_request: { status: 400, message: "The request is invalid." },
  authentication_error: { status: 401, message: "Missing or unknown API key." },
  not_found: { status: 404, message: "Not found." },
  request_too_large: { status: 413, message: "The request needs more tokens than the per-minute budget." },
  rate_limit_exceeded: { status: 429, message: "Token rate limit exceeded for this API key." },
  internal_error: { status: 500, message: "Something went wrong in the gateway." },
  upstream_unavailable: { status: 502, message: "No model provider could handle the request." },
  upstream_timeout: { status: 504, message: "The model provider took too long to respond." },
};
type ErrorType = keyof typeof ERRORS;

const ChatRequest = z.looseObject({
  model: z.string().optional(),
  messages: z.array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string() })).min(1),
  max_tokens: z.number().int().positive().default(512),
  temperature: z.number().min(0).max(2).optional(),
  stream: z.literal(false).optional(),
});

export type GatewayConfig = {
  apiKeys: string[];
  dbPath: string;
  primary: Provider;
  secondary: Provider;
};

const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

export function createGateway(config: GatewayConfig) {
  const tenants = new Set(config.apiKeys.map(hashKey));
  const limiter = new RateLimiter(config.dbPath);

  const server = createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader("x-request-id", requestId);

    const fail = (type: ErrorType, extra: { message?: string; retry_after_ms?: number } = {}) => {
      res.writeHead(ERRORS[type].status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type, message: ERRORS[type].message, request_id: requestId, ...extra } }));
    };

    try {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") return fail("not_found");

      const key = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
      const tenant = key ? hashKey(key) : "";
      if (!tenants.has(tenant)) return fail("authentication_error");

      const parsed = ChatRequest.safeParse(await json(req).catch(() => undefined));
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return fail("invalid_request", { message: `${issue.path.join(".") || "body"}: ${issue.message}` });
      }
      const body = parsed.data;

      // rough guess: ~4 chars per token, plus everything the model is allowed to generate
      const chars = body.messages.reduce((sum, m) => sum + m.content.length, 0);
      const estimate = Math.ceil(chars / 4) + body.max_tokens;

      const reservation = limiter.reserve(tenant, estimate);
      if (reservation.status === "too_large") return fail("request_too_large");
      if (reservation.status === "rate_limited") {
        res.setHeader("retry-after", Math.ceil(reservation.retryAfterMs / 1000));
        return fail("rate_limit_exceeded", { retry_after_ms: reservation.retryAfterMs });
      }

      const clientGone = new AbortController();
      res.on("close", () => {
        if (!res.writableFinished) clientGone.abort();
      });

      const result = await route(config.primary, config.secondary, body, clientGone.signal);
      // no usage in the response means we keep the estimate rather than undercount
      const used = result.kind === "ok" ? (result.body.usage?.total_tokens ?? estimate) : 0;
      limiter.reconcile(reservation.id, used);
      console.log(`${requestId} ${result.route} ${result.kind === "ok" ? "ok" : result.error} (${used} tokens)`);

      if (result.kind !== "ok") {
        if (result.error !== "client_closed") fail(result.error);
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "x-gateway-route": result.route,
        "x-ratelimit-remaining-tokens": limiter.remaining(tenant),
      });
      res.end(JSON.stringify(result.body));
    } catch (err) {
      console.error(`${requestId} unexpected error`, err);
      if (!res.headersSent) fail("internal_error");
    }
  });

  server.on("close", () => limiter.close());
  return server;
}
