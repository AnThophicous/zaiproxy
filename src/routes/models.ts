import { Hono } from "hono";
import type { ZaiClient } from "../services/zai-client.js";
import { openAIError } from "../lib/openai-error.js";
import type { OpenAIModel } from "../types/openai.js";
import { canonicalModelId, findModel } from "../constants/models.js";

export function modelRoutes(zai: ZaiClient): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const verbose = isVerbose(c.req.query("verbose"));
    const models = await zai.listModels();
    return c.json({
      object: "list",
      data: verbose ? models : models.map(strictModel)
    });
  });

  app.get("/:id", async (c) => {
    const id = canonicalModelId(c.req.param("id"));
    const verbose = isVerbose(c.req.query("verbose"));
    const models = await zai.listModels();
    const model = findModel(models, id);
    if (!model) {
      const error = openAIError(`Model '${id}' not found`, 404, "model_not_found", "invalid_request_error");
      return c.json(error.body, error.status);
    }
    return c.json(verbose ? model : strictModel(model));
  });

  return app;
}

function strictModel(model: OpenAIModel) {
  return {
    id: model.id,
    object: model.object,
    created: model.created,
    owned_by: model.owned_by
  };
}

function isVerbose(value: string | undefined): boolean {
  return value === "1" || value === "true";
}
