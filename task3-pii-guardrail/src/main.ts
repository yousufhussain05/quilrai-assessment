import { createGateway } from "./gateway.js";

const upstream = process.env.UPSTREAM_URL;
if (!upstream) throw new Error("set UPSTREAM_URL, e.g. https://api.openai.com");

const port = Number(process.env.PORT ?? 8787);
createGateway(upstream, process.env.UPSTREAM_API_KEY).listen(port, () => {
  console.log(`gateway on http://localhost:${port}, forwarding to ${upstream}`);
});
