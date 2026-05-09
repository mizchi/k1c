import process from 'node:process';
import { z } from 'zod';
import { schemaFor, listKinds } from '../manifest/schemas.ts';

/**
 * `k1c explain <kind>` walks a manifest's zod schema and pretty-prints the
 * field tree, mirroring `kubectl explain`. Optional fields are tagged
 * `optional`, enums show their members, unions are listed with each
 * member indented under a `<one of>` header.
 *
 * The walk only descends into the kinds it recognises; advanced zod
 * combinators (refinements, transforms, brand) are summarized rather than
 * unfolded so the output stays readable.
 */
export interface ExplainArgs {
  readonly kind: string;
  readonly recursive: boolean;
}

export interface ExplainDeps {
  readonly out?: (msg: string) => void;
  readonly err?: (msg: string) => void;
}

export function runExplain(args: ExplainArgs, deps: ExplainDeps = {}): number {
  const out = deps.out ?? ((m) => process.stdout.write(`${m}\n`));
  const err = deps.err ?? ((m) => process.stderr.write(`${m}\n`));

  if (args.kind === '' || args.kind === 'list') {
    out('Available manifest kinds:');
    for (const k of [...listKinds()].sort()) out(`  ${k}`);
    return 0;
  }

  const schema = schemaFor(args.kind);
  if (schema === undefined) {
    err(`unknown manifest kind: ${args.kind}`);
    err('');
    err(`run "k1c explain list" to see all available kinds`);
    return 2;
  }
  out(`KIND: ${args.kind}`);
  out('');
  out('FIELDS:');
  for (const line of formatSchema(schema, args.recursive ? Infinity : 6, 1)) {
    out(line);
  }
  return 0;
}

function indent(depth: number): string {
  return '  '.repeat(depth);
}

/**
 * Recursively format a zod schema node as a list of lines. `depth` controls
 * the indent; `maxDepth` caps recursion so a refinement loop or deeply
 * nested object does not produce thousands of lines.
 */
function formatSchema(schema: z.ZodTypeAny, maxDepth: number, depth: number): string[] {
  if (depth > maxDepth) return [`${indent(depth)}<...>`];
  const def = schema._def as { typeName?: string };
  switch (def.typeName) {
    case 'ZodObject':
      return formatObject(schema as z.ZodObject<z.ZodRawShape>, maxDepth, depth);
    case 'ZodEffects':
      // .superRefine() / .refine() / .transform() wrap the underlying schema.
      return formatSchema((def as unknown as { schema: z.ZodTypeAny }).schema, maxDepth, depth);
    case 'ZodOptional':
    case 'ZodDefault':
    case 'ZodNullable':
      return formatSchema((def as unknown as { innerType: z.ZodTypeAny }).innerType, maxDepth, depth);
    default:
      return [`${indent(depth)}${describeLeaf(schema)}`];
  }
}

function formatObject(
  schema: z.ZodObject<z.ZodRawShape>,
  maxDepth: number,
  depth: number,
): string[] {
  const out: string[] = [];
  const shape = (schema._def as { shape?: (() => z.ZodRawShape) | z.ZodRawShape }).shape;
  const resolvedShape = typeof shape === 'function' ? (shape as () => z.ZodRawShape)() : shape;
  if (!resolvedShape) return out;
  for (const [key, value] of Object.entries(resolvedShape)) {
    const optional = isOptional(value as z.ZodTypeAny);
    const tag = optional ? ' (optional)' : '';
    const inner = unwrap(value as z.ZodTypeAny);
    const innerDef = inner._def as { typeName?: string };
    const summary = describeLeaf(inner);
    if (innerDef.typeName === 'ZodObject') {
      out.push(`${indent(depth)}${key}${tag}: object`);
      out.push(...formatObject(inner as z.ZodObject<z.ZodRawShape>, maxDepth, depth + 1));
      continue;
    }
    if (innerDef.typeName === 'ZodArray') {
      const elt = (innerDef as { type: z.ZodTypeAny }).type;
      const eltUnwrapped = unwrap(elt);
      if ((eltUnwrapped._def as { typeName?: string }).typeName === 'ZodObject') {
        out.push(`${indent(depth)}${key}${tag}: array of object`);
        out.push(
          ...formatObject(eltUnwrapped as z.ZodObject<z.ZodRawShape>, maxDepth, depth + 1),
        );
      } else {
        out.push(`${indent(depth)}${key}${tag}: array<${describeLeaf(eltUnwrapped)}>`);
      }
      continue;
    }
    if (innerDef.typeName === 'ZodUnion' || innerDef.typeName === 'ZodDiscriminatedUnion') {
      out.push(`${indent(depth)}${key}${tag}: <one of>`);
      for (const opt of getUnionOptions(inner)) {
        out.push(`${indent(depth + 1)}- ${describeLeaf(opt)}`);
        const optInner = unwrap(opt);
        if ((optInner._def as { typeName?: string }).typeName === 'ZodObject') {
          out.push(...formatObject(optInner as z.ZodObject<z.ZodRawShape>, maxDepth, depth + 2));
        }
      }
      continue;
    }
    if (innerDef.typeName === 'ZodRecord') {
      const value = (innerDef as { valueType: z.ZodTypeAny }).valueType;
      out.push(`${indent(depth)}${key}${tag}: map<string, ${describeLeaf(unwrap(value))}>`);
      continue;
    }
    out.push(`${indent(depth)}${key}${tag}: ${summary}`);
  }
  return out;
}

function describeLeaf(schema: z.ZodTypeAny): string {
  const def = schema._def as { typeName?: string };
  switch (def.typeName) {
    case 'ZodString':
      return 'string';
    case 'ZodNumber':
      return 'number';
    case 'ZodBoolean':
      return 'boolean';
    case 'ZodLiteral':
      return `literal(${JSON.stringify((def as { value: unknown }).value)})`;
    case 'ZodEnum': {
      const values = (def as { values: ReadonlyArray<string> }).values;
      return `enum(${values.join(' | ')})`;
    }
    case 'ZodObject':
      return 'object';
    case 'ZodArray':
      return 'array';
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion':
      return 'union';
    case 'ZodRecord':
      return 'map<string, ?>';
    case 'ZodAny':
    case 'ZodUnknown':
      return 'any';
    case 'ZodNever':
      return 'never';
    case 'ZodEffects':
      return describeLeaf((def as unknown as { schema: z.ZodTypeAny }).schema);
    default:
      return def.typeName ?? 'unknown';
  }
}

function isOptional(schema: z.ZodTypeAny): boolean {
  const def = schema._def as { typeName?: string; innerType?: z.ZodTypeAny };
  if (def.typeName === 'ZodOptional' || def.typeName === 'ZodDefault' || def.typeName === 'ZodNullable') {
    return true;
  }
  if (def.typeName === 'ZodEffects' && def.innerType !== undefined) {
    return isOptional(def.innerType);
  }
  return false;
}

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let cur: z.ZodTypeAny = schema;
  for (let i = 0; i < 8; i += 1) {
    const def = cur._def as { typeName?: string; innerType?: z.ZodTypeAny; schema?: z.ZodTypeAny };
    if (
      (def.typeName === 'ZodOptional' || def.typeName === 'ZodDefault' || def.typeName === 'ZodNullable') &&
      def.innerType !== undefined
    ) {
      cur = def.innerType;
      continue;
    }
    if (def.typeName === 'ZodEffects' && def.schema !== undefined) {
      cur = def.schema;
      continue;
    }
    break;
  }
  return cur;
}

function getUnionOptions(schema: z.ZodTypeAny): ReadonlyArray<z.ZodTypeAny> {
  const def = schema._def as {
    typeName?: string;
    options?: ReadonlyArray<z.ZodTypeAny>;
    optionsMap?: Map<unknown, z.ZodTypeAny>;
  };
  if (def.options) return def.options;
  if (def.optionsMap) return [...def.optionsMap.values()];
  return [];
}
