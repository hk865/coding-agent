/**
 * 模块职责：注册工具定义，生成不可变快照，并根据并行安全属性提供工具分组策略。
 *
 * 设计边界：注册表不执行工具、不做权限判断，也不修改模型生成的调用。
 * 关键流程：注册时校验名称和元数据；冻结后提供模型规格、handler 查询及稳定执行分组。
 */
import type { ModelToolSpec } from "../../core/ports/model_client/model-client-port.js";
import type {
  ToolBatchPolicy,
  ToolExecutionGroup,
} from "../../core/ports/tool_batch_policy/tool-batch-policy-port.js";
import type { ToolCall } from "../../core/ports/tool_executor/tool-executor-port.js";
import type { ToolDefinition } from "../schemas/tool-schemas.js";
import { validateToolDefinition } from "../schemas/tool-schemas.js";

const OMITTED_MODEL_SCHEMA_KEYS = new Set(["$schema", "minLength", "maxLength"]);

function compatibleModelSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => compatibleModelSchema(item));
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (OMITTED_MODEL_SCHEMA_KEYS.has(key)) continue;
    if (key === "oneOf") {
      result["anyOf"] = compatibleModelSchema(child);
    } else if (key === "const") {
      result["enum"] = [compatibleModelSchema(child)];
    } else {
      result[key] = compatibleModelSchema(child);
    }
  }
  return result;
}

function schemaForModel(definition: ToolDefinition): ModelToolSpec["inputSchema"] {
  const candidate = definition.inputSchema as unknown as { toJSONSchema?: () => unknown };
  if (typeof candidate.toJSONSchema === "function") {
    const generated = candidate.toJSONSchema();
    if (generated && typeof generated === "object" && !Array.isArray(generated)) {
      return compatibleModelSchema(generated) as ModelToolSpec["inputSchema"];
    }
  }
  return { type: "object", additionalProperties: false };
}

export class ToolRegistrySnapshot {
  readonly #definitions: ReadonlyMap<string, ToolDefinition>;

  constructor(definitions: readonly ToolDefinition[]) {
    this.#definitions = new Map(definitions.map((definition) => [definition.name, definition]));
  }

  resolve(name: string): ToolDefinition | undefined {
    return this.#definitions.get(name);
  }

  list(): readonly ToolDefinition[] {
    return [...this.#definitions.values()];
  }

  modelToolSpecs(): readonly ModelToolSpec[] {
    return this.list()
      .map((definition) => ({
        name: definition.name,
        description: definition.description,
        inputSchema: schemaForModel(definition),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }
}

export class ToolRegistry {
  readonly #definitions = new Map<string, ToolDefinition>();
  #frozen = false;

  register(definition: ToolDefinition): void {
    if (this.#frozen) throw new Error("ToolRegistry 冻结后不能继续注册");
    validateToolDefinition(definition);
    if (this.#definitions.has(definition.name)) throw new Error(`工具 ${definition.name} 重复注册`);
    this.#definitions.set(definition.name, definition);
  }

  freeze(enabledNames: readonly string[]): ToolRegistrySnapshot {
    if (this.#frozen) throw new Error("ToolRegistry 只能冻结一次");
    this.#frozen = true;
    const names = new Set(enabledNames);
    if (names.size !== enabledNames.length) throw new Error("enabled tool name 不能重复");
    const definitions = enabledNames.map((name) => {
      const definition = this.#definitions.get(name);
      if (!definition) throw new Error(`无法启用未注册工具 ${name}`);
      return definition;
    });
    return new ToolRegistrySnapshot(definitions);
  }
}

export class RegistryToolBatchPolicy implements ToolBatchPolicy {
  constructor(private readonly snapshot: ToolRegistrySnapshot) {}

  plan(calls: readonly Readonly<ToolCall>[]): readonly ToolExecutionGroup[] {
    const allIndependentReadOnly = calls.every((call) => {
      const definition = this.snapshot.resolve(call.name);
      return definition?.effectClass === "read_only" && definition.independentReadOnly;
    });
    if (allIndependentReadOnly && calls.length > 1) {
      return [{ mode: "parallel_read_only", callIds: calls.map((call) => call.callId) }];
    }
    return calls.map((call) => ({ mode: "serial", callIds: [call.callId] }));
  }
}
