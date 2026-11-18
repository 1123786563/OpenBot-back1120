import ts from "typescript";

// Source-aware inventory: never treat API values, CSS classes or user data as copy.
const attributes = new Set([
  "attempted",
  "detail",
  "title",
  "description",
  "label",
  "placeholder",
  "aria-label",
  "alt",
  "tooltip",
  "emptyText",
  "loadingText",
  "submitLabel",
  "cancelLabel",
  "confirmLabel",
  "actionLabel",
  "pendingLabel",
  "emptyTitle",
  "emptyDescription",
  "caption",
  "summary",
  "heading",
  "hint",
  "errorMessage",
  "successMessage",
  "statusLabel",
  "loadingLabel",
  "pendingText",
]);
const properties = new Set([
  "title",
  "description",
  "label",
  "placeholder",
  "fallback",
  "emptyText",
  "loadingText",
  "submitLabel",
  "cancelLabel",
  "confirmLabel",
  "actionLabel",
  "pendingLabel",
  "emptyTitle",
  "emptyDescription",
  "caption",
  "summary",
  "heading",
  "hint",
  "errorMessage",
  "successMessage",
  "statusLabel",
  "loadingLabel",
  "pendingText",
]);
export type Copy = {
  start: number;
  end: number;
  text: string;
  kind: "text" | "attribute" | "expression" | "property";
  node: ts.Node;
};
export function inventory(source: ts.SourceFile): Copy[] {
  const found: Copy[] = [];
  const add = (node: ts.Node, text: string, kind: Copy["kind"]) => {
    if (
      text === "OpenBot" ||
      text === "English" ||
      text === "v{{value}}" ||
      /^(?:text-|#[0-9a-f]{3,8}$)/i.test(text)
    )
      return;
    let parent: ts.Node | undefined = node;
    while (parent && !ts.isSourceFile(parent)) {
      if (
        ts.isJsxElement(parent) &&
        ["style", "script", "code", "pre"].includes(
          parent.openingElement.tagName.getText(source),
        )
      )
        return;
      if (
        (ts.isPropertyAssignment(parent) ||
          ts.isGetAccessorDeclaration(parent)) &&
        ["parameters", "description"].includes(parent.name.getText(source)) &&
        ts.isObjectLiteralExpression(parent.parent) &&
        parent.parent.properties.some(
          (property) => property.name?.getText(source) === "parameters",
        )
      )
        return;
      if (
        ts.isCallExpression(parent) &&
        /^(useCopilotReadable|host\.addContext)$/.test(
          parent.expression.getText(source),
        )
      )
        return;
      parent = parent.parent;
    }
    if (
      /[A-Za-z]/.test(text.replace(/\{\{value\}\}/g, "")) &&
      !/^(https?:|\/|#[0-9a-f]|[\w.+-]+@)/i.test(text)
    )
      found.push({
        start: node.getStart(source),
        end: node.getEnd(),
        text,
        kind,
        node,
      });
  };
  const expression = (node: ts.Expression) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      add(node, node.text, "expression");
    else if (ts.isTemplateExpression(node))
      add(
        node,
        node.head.text +
          node.templateSpans
            .map((span) => `{{value}}${span.literal.text}`)
            .join(""),
        "expression",
      );
    else if (ts.isConditionalExpression(node)) {
      expression(node.whenTrue);
      expression(node.whenFalse);
    } else if (
      ts.isBinaryExpression(node) &&
      [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(
        node.operatorToken.kind,
      )
    )
      expression(node.right);
    else if (ts.isParenthesizedExpression(node)) expression(node.expression);
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      const text = node.text.replace(/\s+/g, " ").trim();
      if (text) add(node, text, "text");
    } else if (
      ts.isJsxAttribute(node) &&
      attributes.has(node.name.getText(source)) &&
      node.initializer
    ) {
      if (ts.isStringLiteral(node.initializer))
        add(node.initializer, node.initializer.text, "attribute");
      else if (
        ts.isJsxExpression(node.initializer) &&
        node.initializer.expression
      )
        expression(node.initializer.expression);
    } else if (
      ts.isJsxExpression(node) &&
      !ts.isJsxAttribute(node.parent) &&
      node.expression
    )
      expression(node.expression);
    else if (
      ts.isPropertyAssignment(node) &&
      properties.has(node.name.getText(source))
    )
      expression(node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

if (import.meta.main) {
  const rows = [];
  for await (const path of new Bun.Glob("app/src/**/*.{ts,tsx}").scan(".")) {
    if (/\.test\.|routeTree\.gen|\/i18n\/|\/generated\//.test(path)) continue;
    const source = ts.createSourceFile(
      path,
      await Bun.file(path).text(),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const item of inventory(source))
      rows.push({
        path,
        line: source.getLineAndCharacterOfPosition(item.start).line + 1,
        kind: item.kind,
        text: item.text,
      });
  }
  await Bun.write(
    "/tmp/openbot-i18n-inventory.json",
    JSON.stringify(rows, null, 2),
  );
  console.log(
    JSON.stringify({
      occurrences: rows.length,
      unique: new Set(rows.map((row) => row.text)).size,
      files: new Set(rows.map((row) => row.path)).size,
    }),
  );
}
