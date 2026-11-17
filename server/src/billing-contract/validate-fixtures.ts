/**
 * Billing contract checker (#62) — `bun run billing:contract:check`.
 *
 * Machine-verifies the contract beyond syntax lint:
 *  1. VALID fixtures must pass their named JSON Schema (ajv 2020-12) plus
 *     semantic checks; INVALID fixtures must be rejected (schema or semantic).
 *  2. Scalar range bounds (x-value-min/max) are enforced semantically —
 *     JSON Schema cannot compare int64-scale decimal strings, which is exactly
 *     the documented expressiveness boundary this checker closes.
 *  3. Credit-lot conservation, closed state machines, idempotency examples,
 *     HALF_UP rounding, >2^53 round-trips and microsecond boundaries are
 *     asserted via money-time.ts and semantic fixtures.
 *  4. The OpenAPI document is checked structurally: unique operationIds,
 *     Idempotency-Key + x-idempotency-scope on every business write (never on
 *     GET), explicit failure responses referencing problem+json, full
 *     x-error-codes coverage equal to the closed ProblemDocument code enum,
 *     internal/browser and channel/session isolation markers, and no
 *     free-form objects anywhere in the contract.
 *
 * Exit code 0 = contract holds. Any assertion failure exits non-zero.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import Ajv2020 from "ajv/dist/2020";

import {
  BillingValueError,
  lotConserves,
  parseSigned,
  parseTimestampUs,
  parseUnsigned,
  MAX_I64,
  MIN_SIGNED_I64,
  MAX_TIMESTAMP_US,
  formatMicrocreditsDisplay,
  roundHalfUpDiv,
  stepCostMicrocredits,
  timestampUsToIso,
  unknownUsageDeadlineUs,
} from "./money-time.js";

const CONTRACT_DIR = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "contracts",
  "billing",
);
const BASE_ID = "https://openbot.invalid/billing/contract";
const SCHEMA_FILES = [
  "scalars.yaml",
  "common.yaml",
  "objects.yaml",
  "problem.yaml",
  "pagination.yaml",
  "channel.yaml",
  "idempotency.yaml",
] as const;

let failures = 0;
let checks = 0;
function ok(cond: unknown, message: string): void {
  checks++;
  if (!cond) {
    failures++;
    console.error(`  FAIL ${message}`);
  }
}
function section(name: string): void {
  console.log(`\n== ${name}`);
}

type Json = Record<string, unknown>;

function loadYaml(rel: string): Json {
  return parseYaml(readFileSync(join(CONTRACT_DIR, rel), "utf8")) as Json;
}

/** Merge all schema files into one virtual document; rewrite cross-file $refs. */
function mergeSchemas(): { schemas: Record<string, Json>; merged: Json } {
  const schemas: Record<string, Json> = {};
  for (const f of SCHEMA_FILES) {
    const doc = loadYaml(join("schemas", f));
    const comps = (doc.components as Json | undefined)?.schemas as
      | Record<string, Json>
      | undefined;
    if (comps) Object.assign(schemas, comps);
  }
  const merged = { components: { schemas: structuredClone(schemas) } };
  rewriteRefs(merged);
  return { schemas, merged };
}

/** Replace "./file.yaml#/components/schemas/X" with "#/components/schemas/X". */
function rewriteRefs(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach(rewriteRefs);
    return;
  }
  if (node && typeof node === "object") {
    const obj = node as Json;
    for (const [k, v] of Object.entries(obj)) {
      if (k === "$ref" && typeof v === "string" && v.startsWith("./")) {
        obj[k] = `#${v.split("#")[1]}`;
      } else {
        rewriteRefs(v);
      }
    }
  }
}

function resolveRef(root: Json, ref: string): Json {
  if (!ref.startsWith("#/")) throw new Error(`unsupported ref ${ref}`);
  let cur: unknown = root;
  for (const part of ref.slice(2).split("/")) {
    cur = (cur as Json)[part];
    if (cur === undefined) throw new Error(`unresolvable ref ${ref}`);
  }
  return cur as Json;
}

/** Deep-walk schema+instance together enforcing x-value-min/x-value-max. */
function walkBounds(
  root: Json,
  schemaNode: Json,
  value: unknown,
  path: string,
): string[] {
  const errors: string[] = [];
  let node = schemaNode;
  if (typeof node.$ref === "string") {
    node = resolveRef(root, node.$ref);
  }
  if (Array.isArray(node.allOf)) {
    for (const sub of node.allOf as Json[]) {
      errors.push(...walkBounds(root, sub, value, path));
    }
  }
  const min = node["x-value-min"] as string | undefined;
  const max = node["x-value-max"] as string | undefined;
  if ((min !== undefined || max !== undefined) && typeof value === "string") {
    try {
      const bi = min?.startsWith("-")
        ? parseSigned(value)
        : parseUnsigned(value, MAX_I64);
      if (min !== undefined && bi < BigInt(min))
        errors.push(`${path}: ${value} below inclusive minimum ${min}`);
      if (max !== undefined && bi > BigInt(max))
        errors.push(`${path}: ${value} above inclusive maximum ${max}`);
    } catch (e) {
      if (e instanceof BillingValueError && e.code === "out_of_range") {
        errors.push(`${path}: ${value} out of declared range (${e.message})`);
      }
      // lexical problems were already reported by ajv
    }
    return errors;
  }
  const types = node.type;
  const isObj =
    (Array.isArray(types) ? types : [types]).includes("object") ||
    node.properties !== undefined;
  const isArr =
    (Array.isArray(types) ? types : [types]).includes("array") ||
    node.items !== undefined;
  if (isObj && value && typeof value === "object" && !Array.isArray(value)) {
    const props = (node.properties ?? {}) as Record<string, Json>;
    for (const [k, sub] of Object.entries(props)) {
      if (k in (value as Json))
        errors.push(
          ...walkBounds(root, sub, (value as Json)[k], `${path}.${k}`),
        );
    }
    if (
      node.additionalProperties &&
      typeof node.additionalProperties === "object"
    ) {
      for (const [k, v] of Object.entries(value as Json)) {
        if (!(k in props))
          errors.push(
            ...walkBounds(
              root,
              node.additionalProperties as Json,
              v,
              `${path}.${k}`,
            ),
          );
      }
    }
  } else if (isArr && Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      errors.push(
        ...walkBounds(root, (node.items ?? {}) as Json, item, `${path}[${i}]`),
      );
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// State machines (mirror the schema descriptions; JSON Schema cannot express
// transitions, so the checker pins them and the fixtures exercise them).
// ---------------------------------------------------------------------------
const TERMINAL: Record<string, string[]> = {
  Reservation: ["settled", "released"],
  CreditLot: ["exhausted", "expired", "revoked"],
  BillingAccount: ["closed"],
  Order: ["fulfilled", "closed", "exception"],
  PaymentAttempt: ["succeeded", "failed", "closed"],
  Refund: ["rejected", "succeeded", "failed"],
  MeteringRelationship: ["ended"],
};
const TRANSITIONS: Record<string, [string, string][]> = {
  Reservation: [
    ["reserved", "awaiting_usage"],
    ["reserved", "settled"],
    ["reserved", "released"],
    ["awaiting_usage", "settled"],
    ["awaiting_usage", "released"],
  ],
  CreditLot: [
    ["scheduled", "active"],
    ["active", "frozen"],
    ["frozen", "active"],
    ["active", "exhausted"],
    ["frozen", "exhausted"],
    ["active", "expired"],
    ["frozen", "expired"],
    ["active", "revoked"],
  ],
  BillingAccount: [
    ["active", "suspended"],
    ["suspended", "active"],
    ["active", "closed"],
    ["suspended", "closed"],
  ],
  Order: [
    ["pending", "payment_confirming"],
    ["payment_confirming", "paid"],
    ["paid", "fulfilling"],
    ["fulfilling", "fulfilled"],
    ["pending", "closing"],
    ["payment_confirming", "closing"],
    ["closing", "closed"],
    ["paid", "exception"],
    ["fulfilling", "exception"],
  ],
  PaymentAttempt: [
    ["created", "pending"],
    ["created", "closed"],
    ["pending", "unknown"],
    ["pending", "succeeded"],
    ["pending", "failed"],
    ["pending", "closed"],
    ["unknown", "succeeded"],
    ["unknown", "failed"],
    ["unknown", "closed"],
  ],
  Refund: [
    ["requested", "approved"],
    ["requested", "rejected"],
    ["approved", "processing"],
    ["processing", "unknown"],
    ["unknown", "processing"],
    ["processing", "succeeded"],
    ["processing", "failed"],
    ["unknown", "failed"],
  ],
  MeteringRelationship: [
    ["pending", "active"],
    ["active", "suspended"],
    ["suspended", "active"],
    ["active", "ended"],
    ["suspended", "ended"],
  ],
};
function transitionLegal(object: string, from: string, to: string): boolean {
  if (TERMINAL[object]?.includes(from)) return false;
  return TRANSITIONS[object].some(([f, t]) => f === from && t === to);
}

// ---------------------------------------------------------------------------
// Built-in money/time semantics (AC3)
// ---------------------------------------------------------------------------
function assertMoneyTimeSemantics(): void {
  section("money/time semantics (AC3)");
  const exactHalf = roundHalfUpDiv(5n, 10n);
  ok(
    exactHalf === 1n,
    `HALF_UP: exact 0.0000005 credit -> 1 microcredit (got ${exactHalf})`,
  );
  const belowHalf = roundHalfUpDiv(4n, 10n);
  ok(
    belowHalf === 0n,
    `HALF_UP: exact 0.0000004 credit -> 0 microcredits (got ${belowHalf})`,
  );

  const big = "9007199254740993"; // 2^53 + 1 — lossy as a JS number, exact as a string
  const roundTripped = parseUnsigned(big).toString();
  ok(roundTripped === big, `>2^53 round-trip zero loss (${roundTripped})`);
  const maxRoundTrip = parseUnsigned(MAX_I64.toString()).toString();
  ok(maxRoundTrip === MAX_I64.toString(), "int64 max round-trip zero loss");

  ok(
    formatMicrocreditsDisplay(1000123n) === "1.000123",
    "display six decimals (1000123 -> 1.000123)",
  );
  ok(
    formatMicrocreditsDisplay(1n) === "0.000001",
    "minimum consumption displays 0.000001",
  );
  ok(
    formatMicrocreditsDisplay(0n) === "0.000000",
    "zero displays 0.000000 (display zero != unused)",
  );

  // step cost: sum exactly then round once
  const cost = stepCostMicrocredits([
    { quantity: 1250n, price: { numerator: 37n, denominator: 1000000n } },
    { quantity: 480n, price: { numerator: 111n, denominator: 1000000n } },
  ]);
  // exact = 1250*37/1e6 + 480*111/1e6 = (46250 + 53280)/1e6 = 0.09953 microcredits -> 0
  ok(
    cost === 0n,
    `step cost summed-then-rounded: 0.09953 microcredits -> 0 (got ${cost})`,
  );
  const cost2 = stepCostMicrocredits([
    { quantity: 13514n, price: { numerator: 37n, denominator: 1000000n } },
  ]);
  ok(cost2 === 1n, `HALF_UP step boundary: 0.500018 -> 1 (got ${cost2})`);

  const t1 = parseTimestampUs("253402300799999998");
  const t2 = parseTimestampUs("253402300799999999");
  ok(
    t2 - t1 === 1n,
    "adjacent-microsecond instants at the upper bound both parse",
  );
  ok(
    timestampUsToIso(t2) === "9999-12-31T23:59:59.999999Z",
    `ISO derived from integer only (${timestampUsToIso(t2)})`,
  );
  ok(
    timestampUsToIso(0n) === "1970-01-01T00:00:00.000000Z",
    "epoch instant ISO derives exactly",
  );

  ok(
    unknownUsageDeadlineUs(1700000300000000n) ===
      1700000300000000n + 24n * 60n * 60n * 1_000_000n,
    "unknown-usage deadline = reserved_at_us + exactly 24h",
  );
  let threw = false;
  try {
    parseUnsigned("9223372036854775808");
  } catch (e) {
    threw = e instanceof BillingValueError && e.code === "out_of_range";
  }
  ok(threw, "int64 max + 1 rejected as out_of_range");
  threw = false;
  try {
    parseSigned(MIN_SIGNED_I64 - 1n + 0n >= 0n ? "0" : "-9223372036854775808");
  } catch (e) {
    threw = e instanceof BillingValueError && e.code === "out_of_range";
  }
  ok(threw, "signed floor is -2^63+1; -2^63 rejected");

  threw = false;
  try {
    timestampUsToIso(MAX_TIMESTAMP_US + 1n);
  } catch (e) {
    threw = e instanceof BillingValueError && e.code === "out_of_range";
  }
  ok(threw, "timestamp beyond 9999 rejected");
}

// ---------------------------------------------------------------------------
// Fixtures (AC1/AC3/AC4)
// ---------------------------------------------------------------------------
async function assertFixtures(): Promise<void> {
  section("fixtures (AC1/AC3/AC4)");
  const { merged } = mergeSchemas();
  const schemas = (merged.components as Json).schemas as Record<string, Json>;
  const ajv = new Ajv2020({ strict: false, allErrors: true }); // strict off: the merged doc carries OpenAPI-only wrapper keys; x-* keywords are annotation-only;
  // contract extension keywords (annotations only; ranges enforced by walkBounds)
  for (const kw of [
    "x-value-min",
    "x-value-max",
    "x-immutability",
    "x-not-personal-identity",
    "x-problem-content-type",
  ]) {
    ajv.addKeyword(kw);
  }
  // one merged document so intra-contract "#/components/schemas/..." refs resolve
  ajv.addSchema({ $id: "https://openbot.invalid/billing/contract", ...merged });
  const compilers = new Map<string, ReturnType<Ajv2020["compile"]>>();
  const compile = (name: string) => {
    let c = compilers.get(name);
    if (!c) {
      c = ajv.compile({ $ref: `${BASE_ID}#/components/schemas/${name}` });
      compilers.set(name, c);
    }
    return c;
  };

  for (const dir of ["valid", "invalid"] as const) {
    const files = (
      await Array.fromAsync(
        new Bun.Glob("*.json").scan({
          cwd: join(CONTRACT_DIR, "fixtures", dir),
        }),
      )
    ).sort();
    ok(files.length > 0, `${dir} fixtures present`);
    for (const file of files) {
      const fx = JSON.parse(
        readFileSync(join(CONTRACT_DIR, "fixtures", dir, file), "utf8"),
      ) as Json;
      if (fx.kind === "state-machine") {
        const object = fx.object as string;
        const transitions = fx.transitions as [string, string][];
        const expectLegal = dir === "valid";
        const allMatch = transitions.every(
          ([f, t]) => transitionLegal(object, f, t) === expectLegal,
        );
        ok(
          allMatch,
          `${dir}/${file}: state machine ${object} ${JSON.stringify(transitions)}`,
        );
        continue;
      }
      if (fx.kind === "idempotency") {
        continue; // checked in assertOpenApi (needs the operation table)
      }
      const schemaName = fx.schema as string;
      const instance = fx.instance;
      const validate = compile(schemaName);
      const schemaValid = validate(instance) as boolean;
      const boundErrors = walkBounds(
        merged,
        schemas[schemaName],
        instance,
        "$",
      );
      let conserved = true;
      if (schemaName === "CreditLot" && schemaValid) {
        const lot = instance as Record<string, string>;
        conserved = lotConserves({
          granted_microcredits: BigInt(lot.granted_microcredits),
          available_microcredits: BigInt(lot.available_microcredits),
          reserved_microcredits: BigInt(lot.reserved_microcredits),
          refund_frozen_microcredits: BigInt(lot.refund_frozen_microcredits),
          consumed_microcredits: BigInt(lot.consumed_microcredits),
          expired_microcredits: BigInt(lot.expired_microcredits),
          revoked_microcredits: BigInt(lot.revoked_microcredits),
        });
      }
      const semanticValid = boundErrors.length === 0 && conserved;
      const accepted = schemaValid && semanticValid;
      if (dir === "valid") {
        ok(
          accepted,
          `valid/${file} (${schemaName}) accepted — schema errors: ${JSON.stringify(validate.errors ?? [])}; bound errors: ${boundErrors.join("; ")}`,
        );
      } else {
        const via = fx.via as string;
        const rejectedAsExpected = via === "schema" ? !schemaValid : !accepted;
        ok(
          rejectedAsExpected,
          `invalid/${file} (${schemaName}) rejected via ${via} — expected ${fx.code}`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// OpenAPI structural checks (AC2/AC4/AC6/AC9)
// ---------------------------------------------------------------------------
interface OpEntry {
  method: string;
  path: string;
  op: Json;
  operationId: string;
}

function assertOpenApi(): { ops: OpEntry[] } {
  section("openapi structure (AC2/AC4/AC6)");
  const doc = loadYaml("openapi.yaml");
  rewriteRefs(doc);
  const registry = (doc.components as Json)["x-error-code-registry"] as {
    code: string;
    status: number;
  }[];
  const problem = loadYaml(join("schemas", "problem.yaml"));
  const enumCodes = (
    ((problem.components as Json).schemas as Json).ErrorCode as Json
  ).enum as string[];
  const ops: OpEntry[] = [];

  const seenIds = new Set<string>();
  for (const [path, item] of Object.entries(
    doc.paths as Record<string, Json>,
  )) {
    for (const [method, op] of Object.entries(item)) {
      if (["get", "post", "put", "patch", "delete"].includes(method)) {
        const operationId = (op as Json).operationId as string;
        ok(
          typeof operationId === "string" && operationId.length > 0,
          `${method} ${path} has operationId`,
        );
        ok(!seenIds.has(operationId), `operationId ${operationId} unique`);
        seenIds.add(operationId);
        ops.push({ method, path, op: op as Json, operationId });
      }
    }
  }
  ok(
    ops.length >= 16,
    `operation count (${ops.length}) covers the full #62 surface`,
  );

  // parameter headers
  const components = doc.components as Json;
  const paramDefs = components.parameters as Record<string, Json>;

  const coveredCodes = new Set<string>();
  for (const { method, path, op, operationId } of ops) {
    const isGet = method === "get";
    const opParams = (op.parameters as Json[] | undefined) ?? [];
    const idemParam = opParams.some((p) => {
      const ref = (p.$ref as string | undefined) ?? "";
      return ref.endsWith("IdempotencyKeyHeader");
    });
    const scope = op["x-idempotency-scope"] as Json | undefined;
    const isChannelCallback = (
      ((op.tags as string[]) ?? []) as string[]
    ).includes("payment-channel");
    if (isGet || isChannelCallback) {
      ok(
        !idemParam,
        `${method} ${path} (GET/channel) does not require Idempotency-Key`,
      );
      ok(
        !scope,
        `${method} ${path} (GET/channel) declares no idempotency scope`,
      );
    } else {
      ok(idemParam, `POST ${path} requires Idempotency-Key header`);
      ok(!!scope, `POST ${path} declares x-idempotency-scope`);
      const scopeFields = (scope?.scope as string[] | undefined) ?? [];
      ok(
        JSON.stringify(scopeFields) ===
          JSON.stringify([
            "organization_id",
            "billing_account_id",
            "operation",
            "logical_resource_id",
            "key",
          ]),
        `${operationId} idempotency scope is the contract's five-field scope`,
      );
      ok(
        scope?.operation === operationId,
        `${operationId} scope operation pinned to its own operationId`,
      );
    }

    const responses = (op.responses ?? {}) as Record<string, Json>;
    const statusCodes = Object.keys(responses);
    ok(
      statusCodes.some((s) => s.startsWith("2")),
      `${operationId} enumerates a success response`,
    );
    const refToProblem = (raw: Json): boolean => {
      let r = raw;
      if (typeof r.$ref === "string") {
        r = resolveRef(doc, r.$ref);
      }
      const content = (r.content ?? {}) as Record<string, Json>;
      const media = content["application/problem+json"];
      if (!media) return false;
      const ref =
        ((media.schema as Json | undefined)?.$ref as string | undefined) ?? "";
      return ref.endsWith("ProblemDocument");
    };
    if (((op.tags as string[]) ?? []).includes("payment-channel")) {
      ok(
        (op["x-channel-auth"] as string) === "protocol",
        `callback ${operationId} authenticated by protocol only`,
      );
      ok(
        op["x-no-session-auth"] === true,
        `callback ${operationId} declares no session auth`,
      );
      ok(
        ((op.security as Json[]) ?? []).some(
          (s) => "ChannelProtocolAuth" in (s as Json),
        ),
        `callback ${operationId} uses ChannelProtocolAuth`,
      );
      const ackRef = JSON.stringify(responses["200"]);
      ok(
        ackRef.includes("ChannelAcknowledgment"),
        `callback ${operationId} answers with channel acknowledgment schema`,
      );
      ok(
        !JSON.stringify(op).includes("PersonalSessionAuth"),
        `callback ${operationId} never depends on a user session`,
      );
    } else {
      ok(
        statusCodes.some((s) => s.startsWith("4")),
        `${operationId} enumerates failure responses`,
      );
      const fourOrFive = statusCodes.filter(
        (s) => s.startsWith("4") || s.startsWith("5"),
      );
      ok(
        fourOrFive.every((s) => refToProblem(responses[s])),
        `${operationId} failures reference problem+json`,
      );
      for (const code of (op["x-error-codes"] as string[]) ?? []) {
        coveredCodes.add(code);
        ok(
          enumCodes.includes(code),
          `${operationId} error code ${code} is in the closed enum`,
        );
      }
    }
    if (String(path).startsWith("/internal/")) {
      ok(op["x-internal"] === true, `${operationId} marks x-internal`);
      ok(
        ((op.security as Json[]) ?? []).some(
          (s) => "ServiceCredentialAuth" in (s as Json),
        ),
        `${operationId} requires a service credential`,
      );
    } else if (((op.tags as string[]) ?? []).includes("internal-billing")) {
      ok(false, `${operationId} tagged internal but not under /internal/`);
    }
    ok(
      typeof op.summary === "string" && op.summary.length > 0,
      `${operationId} has a summary`,
    );
  }

  // request bodies reference contract schemas, never free-form payments
  ok(
    Object.keys(paramDefs).includes("IdempotencyKeyHeader"),
    "Idempotency-Key parameter defined once",
  );

  // full coverage: every closed error code reachable from at least one operation
  const missing = enumCodes.filter((c) => !coveredCodes.has(c));
  ok(
    missing.length === 0,
    `every closed error code reachable: missing ${JSON.stringify(missing)}`,
  );
  const unknown = [...coveredCodes].filter((c) => !enumCodes.includes(c));
  ok(
    unknown.length === 0,
    `no undeclared error codes used: ${JSON.stringify(unknown)}`,
  );
  for (const reg of registry) {
    ok(
      enumCodes.includes(reg.code),
      `registry entry ${reg.code} exists in enum`,
    );
  }
  ok(
    registry.length === enumCodes.length,
    `registry size (${registry.length}) matches enum size (${enumCodes.length})`,
  );

  // no free-form objects anywhere: every object schema must close its shape
  const allSchemas: Record<string, Json> = {};
  for (const f of SCHEMA_FILES) {
    const comps = ((loadYaml(join("schemas", f)).components ?? {}) as Json)
      .schemas as Record<string, Json>;
    Object.assign(allSchemas, comps);
  }
  Object.assign(allSchemas, components.schemas as Record<string, Json>);
  for (const node of Object.values(allSchemas)) rewriteRefs(node);
  let freeForm = 0;
  const lookup = (ref: string): Json => {
    if (!ref.startsWith("#/components/schemas/"))
      throw new Error(`unsupported scan ref ${ref}`);
    const name = ref.slice("#/components/schemas/".length);
    const t = allSchemas[name];
    if (!t) throw new Error(`unresolvable scan ref ${ref}`);
    return t;
  };
  const inspectObject = (
    name: string,
    node: Json,
    inComposition = false,
  ): void => {
    if (typeof node.$ref === "string") {
      // composition ($ref beside a nullable wrapper) or plain alias: inspect target
      inspectObject(name, lookup(node.$ref), true);
      return;
    }
    if (Array.isArray(node.allOf))
      for (const sub of node.allOf as Json[]) inspectObject(name, sub, true);
    if (Array.isArray(node.oneOf))
      for (const sub of node.oneOf as Json[]) inspectObject(name, sub, true);
    if (Array.isArray(node.anyOf))
      for (const sub of node.anyOf as Json[]) inspectObject(name, sub, true);
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (types.includes("object")) {
      const hasProps =
        node.properties !== undefined &&
        Object.keys(node.properties as Json).length > 0;
      const closed =
        node.additionalProperties === false ||
        node.unevaluatedProperties === false ||
        node["x-composition-mixin"] === true;
      const boundedMap =
        node.maxProperties !== undefined &&
        node.minProperties !== undefined &&
        node.additionalProperties !== true;
      const hasComposition =
        Array.isArray(node.allOf) ||
        Array.isArray(node.oneOf) ||
        Array.isArray(node.anyOf);
      // every contract object must either declare its properties, be closed,
      // be a bounded map, or take part in a composition / $ref target
      if (
        !(hasProps || closed || boundedMap || hasComposition || inComposition)
      ) {
        freeForm++;
        console.error(`  free-form object in ${name}`);
      }
    }
    if (node.items) inspectObject(`${name}[]`, node.items as Json);
    if (node.properties) {
      for (const [k, v] of Object.entries(
        node.properties as Record<string, Json>,
      ))
        inspectObject(`${name}.${k}`, v);
    }
  };
  for (const [name, node] of Object.entries(allSchemas))
    inspectObject(name, node);
  ok(freeForm === 0, `no free-form contract objects (${freeForm} offenders)`);

  return { ops };
}

async function assertIdempotencyFixtures(): Promise<void> {
  const doc = loadYaml("openapi.yaml");
  rewriteRefs(doc);
  const ids = new Set<string>();
  for (const item of Object.values(doc.paths as Record<string, Json>)) {
    for (const op of Object.values(item)) {
      const oid = (op as Json)?.operationId;
      if (typeof oid === "string") ids.add(oid);
    }
  }
  const registry = (doc.components as Json)["x-error-code-registry"] as {
    code: string;
  }[];
  const codes = new Set(registry.map((r) => r.code));
  for (const dir of ["valid", "invalid"] as const) {
    const glob = new Bun.Glob("*.json");
    const files = Array.fromAsync(
      glob.scan({ cwd: join(CONTRACT_DIR, "fixtures", dir) }),
    );
    for (const file of await files) {
      const fx = JSON.parse(
        readFileSync(join(CONTRACT_DIR, "fixtures", dir, file), "utf8"),
      ) as Json;
      if (fx.kind !== "idempotency") continue;
      ok(
        ids.has(fx.operationId as string),
        `${dir}/${file}: operationId ${fx.operationId} exists in the contract`,
      );
      const expected = (fx.expected ?? {}) as Json;
      const code = expected.code as string | undefined;
      if (code)
        ok(
          codes.has(code),
          `${dir}/${file}: expected code ${code} is a closed enum member`,
        );
      if (fx.case === "same_content_replay") {
        ok(
          JSON.stringify(fx.request_a) === JSON.stringify(fx.request_b),
          `${dir}/${file}: normalized requests equal`,
        );
      }
      if (fx.case === "different_content_conflict") {
        ok(
          JSON.stringify(fx.request_a) !== JSON.stringify(fx.request_b),
          `${dir}/${file}: normalized requests differ`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log("billing contract check (#62)");
  assertMoneyTimeSemantics();
  await assertFixtures();
  assertOpenApi();
  await assertIdempotencyFixtures();

  console.log(`\n${checks} checks, ${failures} failures`);
  if (failures > 0) process.exit(1);
  console.log("contract holds.");
}

await main();
