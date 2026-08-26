/** CLI/App 的版本化非敏感配置及四层合并。 */
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

import { providerIdSchema } from "../../model/providers/registry/provider-registry.js";

const uniqueNames = (message: string) =>
  z
    .array(z.string().trim().min(1))
    .refine((items) => new Set(items).size === items.length, message);

export const appConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    model: z
      .object({
        provider: providerIdSchema,
        model: z.string().trim().min(1),
        baseUrl: z.string().url().optional(),
        options: z.record(z.string(), z.unknown()).default({}),
        maxOutputTokens: z.number().int().positive().nullable(),
      })
      .strict(),
    runtime: z
      .object({
        tokenBudget: z.number().int().positive(),
        maxModelRequests: z.number().int().positive(),
        maxToolCalls: z.number().int().positive(),
      })
      .strict(),
    tools: z.object({ enabledNames: uniqueNames("工具名称不能重复") }).strict(),
    storage: z.object({ databasePath: z.string().trim().min(1) }).strict(),
    skills: z
      .object({
        resourceRoot: z.string().trim().min(1),
        enabledIds: uniqueNames("Skill ID 不能重复"),
      })
      .strict(),
    memory: z.object({ provider: z.literal("empty") }).strict(),
  })
  .strict();

export type AppConfig = z.infer<typeof appConfigSchema>;
export interface AppConfigOverrides {
  readonly provider?: string;
  readonly model?: string;
  readonly cwd?: string;
  readonly databasePath?: string;
}

function defaults(cwd: string): AppConfig {
  return appConfigSchema.parse({
    schemaVersion: 1,
    model: {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      options: {},
      maxOutputTokens: 1024,
    },
    runtime: { tokenBudget: 32_000, maxModelRequests: 12, maxToolCalls: 24 },
    tools: { enabledNames: ["read", "edit", "shell"] },
    storage: {
      databasePath: path.join(os.homedir(), ".local", "share", "coding-agent", "sessions.sqlite"),
    },
    skills: { resourceRoot: path.join(cwd, "resources", "skills"), enabledIds: [] },
    memory: { provider: "empty" },
  });
}

function merge(base: AppConfig, overlay: unknown): AppConfig {
  if (!overlay || typeof overlay !== "object" || Array.isArray(overlay)) return base;
  const value = overlay as Record<string, unknown>;
  return appConfigSchema.parse({
    ...base,
    ...value,
    model: { ...base.model, ...(value["model"] as object | undefined) },
    runtime: { ...base.runtime, ...(value["runtime"] as object | undefined) },
    tools: { ...base.tools, ...(value["tools"] as object | undefined) },
    storage: { ...base.storage, ...(value["storage"] as object | undefined) },
    skills: { ...base.skills, ...(value["skills"] as object | undefined) },
    memory: { ...base.memory, ...(value["memory"] as object | undefined) },
  });
}

export async function loadAppConfig(input: {
  readonly cwd: string;
  readonly configPath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly overrides?: AppConfigOverrides;
}): Promise<AppConfig> {
  const cwd = path.resolve(input.overrides?.cwd ?? input.cwd);
  let config = defaults(cwd);
  if (input.configPath) {
    const text = await readFile(path.resolve(input.configPath), "utf8");
    config = merge(config, JSON.parse(text) as unknown);
  }
  const environment = input.environment ?? process.env;
  const envOverlay: Record<string, unknown> = {};
  if (environment["CODING_AGENT_PROVIDER"] || environment["CODING_AGENT_MODEL"]) {
    envOverlay["model"] = {
      ...(environment["CODING_AGENT_PROVIDER"]
        ? { provider: environment["CODING_AGENT_PROVIDER"] }
        : {}),
      ...(environment["CODING_AGENT_MODEL"] ? { model: environment["CODING_AGENT_MODEL"] } : {}),
    };
  }
  if (environment["CODING_AGENT_DATABASE_PATH"]) {
    envOverlay["storage"] = { databasePath: environment["CODING_AGENT_DATABASE_PATH"] };
  }
  config = merge(config, envOverlay);
  return merge(config, {
    model: {
      ...(input.overrides?.provider ? { provider: input.overrides.provider } : {}),
      ...(input.overrides?.model ? { model: input.overrides.model } : {}),
    },
    storage: input.overrides?.databasePath
      ? { databasePath: input.overrides.databasePath }
      : config.storage,
  });
}
