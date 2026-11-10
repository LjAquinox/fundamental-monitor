import { z } from "zod/v4";

const compiled = new WeakMap<z.ZodType, Record<string, any>>();
const checks = new Set([
  "min_length",
  "max_length",
  "length_equals",
  "greater_than",
  "less_than",
  "multiple_of",
  "number_format",
  "string_format",
]);

/** Reject local-only behavior rather than silently weakening the model contract. */
function assertRepresentable(
  schema: z.ZodType,
  path = "$",
  seen = new Set<z.ZodType>(),
) {
  if (seen.has(schema)) return;
  seen.add(schema);
  const d = schema._zod.def as any;
  if (d.coerce)
    throw new Error(`Model schema ${path}: coercion is not supported.`);
  const metadata = schema.meta();
  if (
    metadata &&
    Object.keys(metadata).some((k) => !["description", "title"].includes(k))
  )
    throw new Error(
      `Model schema ${path}: schema overrides are not supported.`,
    );
  for (const check of d.checks || []) {
    const rule = check._zod.def;
    if (!checks.has(rule.check))
      throw new Error(
        `Model schema ${path}: unrepresentable check ${rule.check}; use a separate contextual sanity check.`,
      );
    if (
      rule.check === "string_format" &&
      !["regex", "date", "url", "uuid", "email"].includes(rule.format)
    )
      throw new Error(
        `Model schema ${path}: unsupported string format ${rule.format}.`,
      );
    if (rule.format === "regex" && rule.pattern?.flags)
      throw new Error(
        `Model schema ${path}: regular-expression flags are not representable in JSON Schema.`,
      );
  }
  switch (d.type) {
    case "object":
      if (d.catchall?._zod.def.type !== "never")
        throw new Error(`Model schema ${path}: objects must be strict.`);
      for (const [key, value] of Object.entries(d.shape))
        assertRepresentable(value as z.ZodType, `${path}.${key}`, seen);
      break;
    case "array":
      assertRepresentable(d.element, `${path}[]`, seen);
      break;
    case "nullable":
      assertRepresentable(d.innerType, path, seen);
      break;
    case "union":
      for (const [i, option] of d.options.entries())
        assertRepresentable(option, `${path}|${i}`, seen);
      break;
    case "string":
    case "number":
    case "boolean":
    case "null":
    case "enum":
    case "literal":
      break;
    default:
      throw new Error(
        `Model schema ${path}: unsupported ${d.type}; optional fields, defaults, transforms and custom refinements cannot be hidden from the model.`,
      );
  }
}
function freeze(value: any): any {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** The JSON sent to the provider is generated from the exact parser it uses. */
export function modelJsonSchema(schema: z.ZodType): Record<string, any> {
  const cached = compiled.get(schema);
  if (cached) return cached;
  assertRepresentable(schema);
  const json = z.toJSONSchema(schema, {
    target: "draft-7",
    io: "input",
    unrepresentable: "throw",
    reused: "ref",
    cycles: "throw",
  }) as Record<string, any>;
  delete json.$schema;
  if (json.definitions) {
    json.$defs = json.definitions;
    delete json.definitions;
  }
  const fixRefs = (node: any, expanding = new Set<string>()) => {
    if (!node || typeof node !== "object") return;
    // Zod wraps a described reused primitive in allOf. A single reference
    // plus annotation-only siblings has exactly the reference's validation.
    if (
      node.allOf?.length === 1 &&
      Object.keys(node.allOf[0]).length === 1 &&
      node.allOf[0].$ref &&
      Object.keys(node).every((key) =>
        ["allOf", "description", "title"].includes(key),
      )
    ) {
      node.$ref = node.allOf[0].$ref;
      delete node.allOf;
    }
    if (node.$ref) node.$ref = node.$ref.replace("#/definitions/", "#/$defs/");
    if (node.$ref && Object.keys(node).length > 1) {
      const siblings = Object.keys(node).filter((k) => k !== "$ref");
      if (siblings.some((k) => !["description", "title"].includes(k)))
        throw new Error(
          "Unsupported validation overrides on schema reference.",
        );
      const ref = node.$ref,
        target = ref.startsWith("#/$defs/")
          ? json.$defs?.[ref.slice(8)]
          : undefined;
      if (!target || expanding.has(ref))
        throw new Error("Unknown or cyclic annotated reference.");
      const copy = {
        ...structuredClone(target),
        ...Object.fromEntries(siblings.map((k) => [k, node[k]])),
      };
      fixRefs(copy, new Set([...expanding, ref]));
      for (const key of Object.keys(node)) delete node[key];
      Object.assign(node, copy);
      return;
    }
    for (const value of Object.values(node)) fixRefs(value, expanding);
  };
  fixRefs(json);
  // A single-value enum is equivalent to const and uses the API's enum form.
  const enumLiterals = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (Object.hasOwn(node, "const")) {
      node.enum = [node.const];
      delete node.const;
    }
    for (const child of Object.values(node)) enumLiterals(child);
  };
  enumLiterals(json);
  const allowed = new Set([
    "$ref",
    "$defs",
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "anyOf",
    "enum",
    "description",
    "title",
    "minLength",
    "maxLength",
    "pattern",
    "format",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "minItems",
    "maxItems",
  ]);
  const checkJson = (node: any, path = "$") => {
    if (node.$ref && Object.keys(node).length !== 1)
      throw new Error(
        `Model schema ${path}: $ref cannot have sibling keywords.`,
      );
    for (const key of Object.keys(node))
      if (!allowed.has(key))
        throw new Error(
          `Model schema ${path}: unsupported generated keyword ${key}.`,
        );
    if (
      node.type === "object" &&
      (node.additionalProperties !== false ||
        Object.keys(node.properties || {}).some(
          (key) => !node.required?.includes(key),
        ))
    )
      throw new Error(
        `Model schema ${path}: every property must be required and additional properties forbidden.`,
      );
    if (
      node.$ref &&
      (!node.$ref.startsWith("#/$defs/") ||
        !Object.hasOwn(json.$defs || {}, node.$ref.slice(8)))
    )
      throw new Error(
        `Model schema ${path}: only known local schema references are supported.`,
      );
    for (const [key, value] of Object.entries(node.$defs || {}))
      checkJson(value, `$defs.${key}`);
    for (const [key, value] of Object.entries(node.properties || {}))
      checkJson(value, `${path}.${key}`);
    if (node.items) checkJson(node.items, `${path}[]`);
    for (const [i, value] of (node.anyOf || []).entries())
      checkJson(value, `${path}|${i}`);
  };
  checkJson(json);
  assertModelUnions(json);
  if (json.type !== "object" || json.anyOf)
    throw new Error("A model response schema must have a strict object root.");
  assertModelBudget(json);
  compiled.set(schema, freeze(json));
  return json;
}

/** Enforce documented Structured Outputs budgets before any paid request. */
export function assertModelBudget(json: Record<string, any>) {
  let properties = 0,
    enumValues = 0,
    stringSize = 0;
  const scan = (node: any) => {
    properties += Object.keys(node.properties || {}).length;
    stringSize += Object.keys(node.properties || {}).join("").length;
    enumValues += node.enum?.length || 0;
    stringSize += (node.enum || [])
      .filter((v: any) => typeof v === "string")
      .join("").length;
    for (const [key, value] of Object.entries(node.$defs || {})) {
      stringSize += key.length;
      scan(value);
    }
    for (const value of Object.values(node.properties || {})) scan(value);
    if (node.items) scan(node.items);
    for (const value of node.anyOf || []) scan(value);
  };
  scan(json);
  const depth = (node: any, level = 1): number => {
    if (node.$ref) return depth(json.$defs[node.$ref.slice(8)], level);
    return Math.max(
      level,
      ...Object.values(node.properties || {}).map((v: any) =>
        depth(v, level + 1),
      ),
      ...(node.items ? [depth(node.items, level + 1)] : []),
      ...(node.anyOf || []).map((v: any) => depth(v, level)),
    );
  };
  const maxDepth = depth(json);
  if (
    properties > 5000 ||
    enumValues > 1000 ||
    stringSize > 120000 ||
    maxDepth > 10
  )
    throw new Error(
      `Model schema exceeds Structured Outputs budgets: ${properties} properties, ${enumValues} enum values, ${stringSize} string characters, ${maxDepth} levels.`,
    );
  return { properties, enumValues, stringSize, maxDepth };
}

/** Static provider compatibility policy, independent of response validation. */
export function assertModelUnions(json: Record<string, any>) {
  const resolve = (node: any): any =>
    node.$ref ? resolve(json.$defs[node.$ref.slice(8)]) : node;
  const flatten = (node: any): any[] => {
    node = resolve(node);
    return node.anyOf ? node.anyOf.flatMap(flatten) : [node];
  };
  const seen = new Set<any>();
  function walk(node: any, path: string) {
    node = resolve(node);
    if (seen.has(node)) return;
    seen.add(node);
    if (node.anyOf) {
      const firstKeys = new Map<string, Set<string> | null>();
      for (const alternative of node.anyOf.flatMap(flatten)) {
        if (alternative.type !== "object") continue;
        const first = Object.keys(alternative.properties || {})[0];
        if (!first)
          throw new Error(
            `Model schema ${path}: empty object union alternative is unsupported.`,
          );
        const field = resolve(alternative.properties[first]);
        const values = field.enum
          ? new Set<string>(field.enum.map((v: unknown) => JSON.stringify(v)))
          : null;
        if (firstKeys.has(first)) {
          const previous = firstKeys.get(first);
          if (!previous || !values || [...values].some((v) => previous.has(v)))
            throw new Error(
              `Model schema ${path}: ambiguous first key '${first}' in object union. Put a unique literal/enum discriminator first in each canonical variant, and nest independent discriminators instead of repeating one.`,
            );
          for (const value of values) previous.add(value);
        } else firstKeys.set(first, values);
      }
      node.anyOf.forEach((v: any, i: number) => walk(v, `${path}|${i}`));
    }
    for (const [key, value] of Object.entries(node.properties || {}))
      walk(value, `${path}.${key}`);
    if (node.items) walk(node.items, `${path}[]`);
  }
  walk(json, "$");
}
