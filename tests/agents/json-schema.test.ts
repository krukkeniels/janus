import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toCodexJsonSchema, UnsupportedSchemaNodeError } from '../../src/agents/json-schema.js';

describe('toCodexJsonSchema', () => {
  it('marks every property required and forbids extras, as Codex strict schemas demand (§14)', () => {
    const schema = z
      .object({
        status: z.enum(['completed', 'failed']),
        summary: z.string(),
        count: z.number(),
        done: z.boolean(),
        items: z.array(z.string()),
        maybe: z.array(z.string()).nullable(),
        nested: z.object({ a: z.string() }).strict(),
      })
      .strict();

    expect(toCodexJsonSchema(schema, 'janus-test-result')).toEqual({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      title: 'janus-test-result',
      type: 'object',
      additionalProperties: false,
      required: ['status', 'summary', 'count', 'done', 'items', 'maybe', 'nested'],
      properties: {
        status: { type: 'string', enum: ['completed', 'failed'] },
        summary: { type: 'string' },
        count: { type: 'number' },
        done: { type: 'boolean' },
        items: { type: 'array', items: { type: 'string' } },
        maybe: { type: ['array', 'null'], items: { type: 'string' } },
        nested: {
          type: 'object',
          additionalProperties: false,
          required: ['a'],
          properties: { a: { type: 'string' } },
        },
      },
    });
  });

  it('refuses an optional property, because Codex requires every property to be present', () => {
    const schema = z.object({ a: z.string().optional() }).strict();
    expect(() => toCodexJsonSchema(schema, 't')).toThrow(UnsupportedSchemaNodeError);
    expect(() => toCodexJsonSchema(schema, 't')).toThrow('a: ZodOptional');
  });

  it('refuses a default, which would hide a missing property instead of rejecting it', () => {
    const schema = z.object({ a: z.string().default('x') }).strict();
    expect(() => toCodexJsonSchema(schema, 't')).toThrow('a: ZodDefault');
  });

  it('names the path of an unsupported node', () => {
    const schema = z.object({ a: z.object({ b: z.record(z.string(), z.string()) }).strict() }).strict();
    expect(() => toCodexJsonSchema(schema, 't')).toThrow('a.b: ZodRecord');
  });

  it('widens a nullable enum so the schema does not reject null (JSON Schema applies enum regardless of type)', () => {
    const schema = z.object({ suspect_repo: z.enum(['ui-kit', 'shell']).nullable() }).strict();
    const json = toCodexJsonSchema(schema, 't');
    const properties = json['properties'] as Record<string, Record<string, unknown>>;
    expect(properties['suspect_repo']).toEqual({
      type: ['string', 'null'],
      enum: ['ui-kit', 'shell', null],
    });
  });

  it('names the real path, not a placeholder, when a nullable node has no simple type', () => {
    // Double-nullable: the inner convert() already returns a widened (array) `type`, so the outer nullable()
    // hits its "not a simple type" guard. The path in the error must be the field's real path, not '<nullable>'.
    const schema = z.object({ a: z.string().nullable().nullable() }).strict();
    expect(() => toCodexJsonSchema(schema, 't')).toThrow('a: ZodNullable of a node without a simple type');
  });

  it('refuses a passthrough object, because it would accept extras the model is told are forbidden', () => {
    const schema = z.object({ a: z.object({ b: z.string() }).passthrough() }).strict();
    expect(() => toCodexJsonSchema(schema, 't')).toThrow('a: ZodObject (passthrough)');
  });

  it('refuses a strip-mode (plain) object, for the same reason', () => {
    const schema = z.object({ a: z.object({ b: z.string() }) }).strict();
    expect(() => toCodexJsonSchema(schema, 't')).toThrow('a: ZodObject (strip)');
  });
});
