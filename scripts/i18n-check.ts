import ts from "typescript";
import { resolve } from "node:path";
import { z } from "zod";
import { inventory } from "./i18n-inventory";

const catalog = z.record(z.string(), z.string().min(1));
const en = catalog.parse(
  await Bun.file("app/src/lib/i18n/locales/en.json").json(),
);
const zh = catalog.parse(
  await Bun.file("app/src/lib/i18n/locales/zh-CN.json").json(),
);
const failures: string[] = [];
const config = ts.readConfigFile("app/tsconfig.json", ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, "app");
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();
function messageOf(
  node: ts.Expression | undefined,
  depth = 0,
): string | undefined {
  if (!node || depth > 8) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text;
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node))
    return messageOf(node.expression, depth + 1);
  if (!ts.isIdentifier(node)) return undefined;
  let symbol = checker.getSymbolAtLocation(node);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias)
    symbol = checker.getAliasedSymbol(symbol);
  const declaration = symbol?.valueDeclaration;
  return declaration && ts.isVariableDeclaration(declaration)
    ? messageOf(declaration.initializer, depth + 1)
    : undefined;
}
function messageChoices(node: ts.Expression): string[] {
  if (ts.isConditionalExpression(node))
    return [
      ...messageChoices(node.whenTrue),
      ...messageChoices(node.whenFalse),
    ];
  const message = messageOf(node);
  return message === undefined ? [] : [message];
}
const placeholders = (message: string) =>
  [...message.matchAll(/\{\{([^}]+)\}\}/g)]
    .map((match) => match[1])
    .sort()
    .join(",");
for (const key of new Set([...Object.keys(en), ...Object.keys(zh)])) {
  if (!(key in en) || !(key in zh)) failures.push(`Missing language: ${key}`);
  else if (placeholders(en[key]) !== placeholders(zh[key]))
    failures.push(`Interpolation mismatch: ${key}`);
}
const sourcePaths = [];
for await (const path of new Bun.Glob("app/src/**/*.{ts,tsx}").scan("."))
  sourcePaths.push(path);
sourcePaths.push("shared/audit-words.ts");
sourcePaths.push("shared/system-display.ts");
sourcePaths.push("shared/tool-name.ts");
sourcePaths.push("shared/audit-filters.ts");
sourcePaths.push("shared/research.ts");
for (const path of sourcePaths) {
  if (/\.test\.|routeTree\.gen|\/generated\//.test(path)) continue;
  const source =
    program.getSourceFile(resolve(path)) ??
    program.getSourceFile(path) ??
    ts.createSourceFile(
      path,
      await Bun.file(path).text(),
      ts.ScriptTarget.Latest,
      true,
    );
  if (path.startsWith("app/") && !path.includes("/i18n/"))
    for (const item of inventory(source))
      failures.push(`${path}: untranslated ${item.text.slice(0, 100)}`);
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      /^(ui|uiNodes|translate)$/.test(node.expression.getText(source)) &&
      node.arguments[0]
    ) {
      for (const key of messageChoices(node.arguments[0])) {
        if (!(key in en) || !(key in zh))
          failures.push(`${path}: missing ${key}`);
        const parameters = [...key.matchAll(/\{\{([^}]+)\}\}/g)].map(
          (match) => match[1],
        );
        const values = node.arguments[1];
        if (
          node.expression.getText(source) === "uiNodes" &&
          values &&
          ts.isArrayLiteralExpression(values)
        ) {
          if (
            parameters.some(
              (parameter) =>
                !/^slot\d+$/.test(parameter) ||
                Number(parameter.slice(4)) >= values.elements.length,
            )
          )
            failures.push(`${path}: missing content slot for ${key}`);
        } else if (
          parameters.length &&
          (!values || ts.isObjectLiteralExpression(values))
        ) {
          const supplied = new Set(
            values && ts.isObjectLiteralExpression(values)
              ? values.properties.flatMap((property) =>
                  property.name
                    ? [
                        ts.isIdentifier(property.name) ||
                        ts.isStringLiteral(property.name)
                          ? property.name.text
                          : property.name.getText(source),
                      ]
                    : [],
                )
              : [],
          );
          if (parameters.some((parameter) => !supplied.has(parameter)))
            failures.push(`${path}: missing interpolation argument for ${key}`);
        }
      }
    }
    if (
      path === "shared/audit-words.ts" &&
      ts.isPropertyAssignment(node) &&
      ts.isStringLiteral(node.initializer) &&
      (!(node.initializer.text in en) || !(node.initializer.text in zh))
    )
      failures.push(`${path}: missing ${node.initializer.text}`);
    if (
      path === "shared/system-display.ts" &&
      ts.isLiteralTypeNode(node) &&
      ts.isStringLiteral(node.literal) &&
      (!(node.literal.text in en) || !(node.literal.text in zh))
    )
      failures.push(`${path}: missing ${node.literal.text}`);
    if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.initializer)) {
      let ancestor: ts.Node | undefined = node.parent;
      while (ancestor && !ts.isVariableDeclaration(ancestor))
        ancestor = ancestor.parent;
      const table =
        ancestor && ts.isVariableDeclaration(ancestor)
          ? ancestor.name.getText(source)
          : "";
      const ownToolCopy =
        path === "shared/tool-name.ts" &&
        (["running", "done", "attempted"].includes(node.name.getText(source)) ||
          ["BROWSER_ACTIONS", "CONTROL_WORDS"].includes(table));
      const sharedCopy = [
        "AUDIT_INTENT_WORDS",
        "AUDIT_EFFECT_WORDS",
        "RESEARCH_ROLE_LABELS",
      ].includes(table);
      if (
        (ownToolCopy || sharedCopy) &&
        (!(node.initializer.text in en) || !(node.initializer.text in zh))
      )
        failures.push(`${path}: missing ${node.initializer.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(
  `Both catalogs contain ${Object.keys(en).length} messages with matching interpolation parameters; source copy checks passed.`,
);
