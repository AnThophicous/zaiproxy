import { Hono } from "hono";
import type { AppContainer } from "./bootstrap/container.js";
import { ZaiClient } from "./services/zai-client.js";
import { chatRoutes } from "./routes/chat.js";
import { healthRoutes } from "./routes/health.js";
import { modelRoutes } from "./routes/models.js";
import { responsesRoutes } from "./routes/responses.js";
import { proxyToolRoutes } from "./routes/proxy-tools.js";
import { requestLogger, requireProxyAuth } from "./routes/middleware.js";

export function createApp(container: AppContainer): Hono {
  const app = new Hono();
  const zai = new ZaiClient(container.accounts, container.conversations);

  app.use("*", async (c, next) => {
    const url = new URL(c.req.url);
    const normalizedPath = url.pathname.replace(/\/{2,}/g, "/");
    if (normalizedPath !== url.pathname) {
      url.pathname = normalizedPath;
      return app.fetch(new Request(url, c.req.raw));
    }
    await next();
  });

  app.use("*", requestLogger);
  app.get("/", (c) =>
    c.json({
      service: `ZAI Proxy ${container.config.version}`,
      openai_compatible: true,
      routes: [
        "/health",
        "/v1/models",
        "/v1/chat/completions",
        "/v1/chat/completions/stop",
        "/v1/completions",
        "/v1/responses",
        "/v1/responses/stop",
        "/v1/responses/:id/cancel",
        "/v1/chat/responses",
        "/v1/proxy/tools"
      ]
    })
  );

  app.route("/health", healthRoutes(zai));
  app.route("/v1/health", healthRoutes(zai));

  app.use("/v1/*", requireProxyAuth);
  app.route("/v1/models", modelRoutes(zai));
  app.route("/v1", proxyToolRoutes());
  app.route("/v1", chatRoutes(zai));
  app.route("/v1", responsesRoutes(zai, container.responses));

  return app;
}
