export type Provider = { url: string; model: string; apiKey?: string; timeoutMs: number };

export type Completion = { usage?: { total_tokens?: number } };

type Attempt =
  | { kind: "ok"; body: Completion }
  | { kind: "failover"; error: "upstream_unavailable" | "upstream_timeout" }
  | { kind: "stop"; error: "invalid_request" | "client_closed" };

export async function route(
  primary: Provider,
  secondary: Provider,
  body: object,
  signal: AbortSignal,
): Promise<Attempt & { route: "primary" | "fallback" }> {
  const first = await callProvider(primary, body, signal);
  if (first.kind !== "failover") return { ...first, route: "primary" };
  return { ...(await callProvider(secondary, body, signal)), route: "fallback" };
}

async function callProvider(provider: Provider, body: object, signal: AbortSignal): Promise<Attempt> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), provider.timeoutMs);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;

  try {
    const res = await fetch(provider.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, model: provider.model }),
      signal: AbortSignal.any([signal, timeout.signal]),
    });
    if (res.ok) return { kind: "ok", body: (await res.json()) as Completion };

    await res.body?.cancel();
    // the request itself is bad, so the other provider would reject it too
    if ([400, 413, 422].includes(res.status)) return { kind: "stop", error: "invalid_request" };
    return { kind: "failover", error: "upstream_unavailable" };
  } catch {
    if (signal.aborted) return { kind: "stop", error: "client_closed" };
    return { kind: "failover", error: timeout.signal.aborted ? "upstream_timeout" : "upstream_unavailable" };
  } finally {
    clearTimeout(timer);
  }
}
