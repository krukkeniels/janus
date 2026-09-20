import type { z } from 'zod';

/** A JSON Schema document, as handed to `codex exec --output-schema` (§18.4). */
export type JsonSchema = Record<string, unknown>;

export class UnsupportedSchemaNodeError extends Error {
  readonly path: string;
  readonly typeName: string;

  constructor(path: string, typeName: string) {
    super(
      `cannot convert ${path === '' ? '<root>' : path}: ${typeName} to a Codex output schema; ` +
        'agent result schemas may use only object, string, number, boolean, array, enum, and nullable nodes, ' +
        'and every property must be required (spec §14: "role schemas list all fields as required and use null ' +
        'for not applicable")',
    );
    this.name = 'UnsupportedSchemaNodeError';
    this.path = path;
    this.typeName = typeName;
  }
}

interface ZodDefLike {
  typeName: string;
  innerType?: z.ZodTypeAny;
  type?: z.ZodTypeAny;
  values?: readonly string[];
}

function defOf(schema: z.ZodTypeAny): ZodDefLike {
  return (schema as unknown as { _def: ZodDefLike })._def;
}

function shapeOf(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> {
  return (schema as unknown as { shape: Record<string, z.ZodTypeAny> }).shape;
}

function child(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

/** Makes the node accept `null` as well, by widening its `type` to a two-entry array. */
function nullable(node: JsonSchema): JsonSchema {
  const current = node['type'];
  if (typeof current !== 'string') {
    throw new UnsupportedSchemaNodeError('<nullable>', 'ZodNullable of a node without a simple type');
  }
  return { ...node, type: [current, 'null'] };
}

function convert(schema: z.ZodTypeAny, path: string): JsonSchema {
  const def = defOf(schema);
  switch (def.typeName) {
    case 'ZodString':
      return { type: 'string' };
    case 'ZodNumber':
      return { type: 'number' };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodEnum': {
      const values = def.values;
      if (values === undefined) throw new UnsupportedSchemaNodeError(path, 'ZodEnum without values');
      return { type: 'string', enum: [...values] };
    }
    case 'ZodArray': {
      const item = def.type;
      if (item === undefined) throw new UnsupportedSchemaNodeError(path, 'ZodArray without an item type');
      return { type: 'array', items: convert(item, child(path, '[]')) };
    }
    case 'ZodNullable': {
      const inner = def.innerType;
      if (inner === undefined) throw new UnsupportedSchemaNodeError(path, 'ZodNullable without an inner type');
      return nullable(convert(inner, path));
    }
    case 'ZodObject': {
      const shape = shapeOf(schema);
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = convert(value, child(path, key));
        required.push(key);
      }
      return { type: 'object', additionalProperties: false, required, properties };
    }
    default:
      throw new UnsupportedSchemaNodeError(path, def.typeName);
  }
}

/**
 * Converts a zod schema into the strict JSON Schema `codex exec --output-schema` accepts (§18.4).
 *
 * There is no hand-written JSON Schema anywhere in Janus: every schema Codex sees is produced here from the same
 * zod object the adapter validates the answer with, so the two cannot disagree. Unsupported nodes throw rather
 * than degrade, so a future field written with `.optional()` or `.default()` fails the suite instead of shipping a
 * schema Codex would reject at runtime.
 */
export function toCodexJsonSchema(schema: z.ZodTypeAny, title: string): JsonSchema {
  const root = convert(schema, '');
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', title, ...root };
}
