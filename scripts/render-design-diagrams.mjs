// Install the isolated rendering tools as described in docs/design/rendered/README.md.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const toolRoot = process.env.OPENBOT_DIAGRAM_TOOLS || path.join(os.tmpdir(), "openbot-diagram-render");
const require = createRequire(path.join(toolRoot, "package.json"));
const { chromium } = require("playwright-core");
const mermaidRoot = path.dirname(require.resolve("mermaid/package.json"));
const mermaidVersion = require("mermaid/package.json").version;
const output = path.join(root, "docs/design/rendered");
await mkdir(output, { recursive: true });
const documents = ["system-architecture", "data-flows"];
const diagrams = [];
for (const document of documents) {
  const markdown = await readFile(path.join(root, `docs/design/${document}.md`), "utf8");
  let heading = "";
  let code = null;
  let index = 0;
  for (const line of markdown.split("\n")) {
    if (code !== null) {
      if (line === "```") {
        diagrams.push({ id: `${document}-${++index}`, title: heading, source: document, code: code.join("\n") });
        code = null;
      } else code.push(line);
    } else if (line === "```mermaid") code = [];
    else if (line.startsWith("## ")) heading = line.slice(3);
  }
  if (code !== null) throw new Error(`Unclosed Mermaid block in ${document}`);
}

// Serve only the rendering library, on loopback; no workspace files are exposed.
const dist = path.join(mermaidRoot, "dist");
const server = createServer(async (request, response) => {
  try {
    if (request.url === "/") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end('<!doctype html><meta charset="utf-8"><style>body{margin:24px;background:white}svg{display:block;max-width:none!important}</style><main id="diagram"></main>');
      return;
    }
    const target = path.resolve(dist, `.${decodeURIComponent(new URL(request.url, "http://localhost").pathname)}`);
    if (!target.startsWith(`${dist}${path.sep}`)) throw new Error("Invalid asset path");
    response.setHeader("Content-Type", "text/javascript; charset=utf-8");
    response.end(await readFile(target));
  } catch {
    response.statusCode = 404;
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
const report = { mermaidVersion, browserVersion: null, diagrams: [] };
try {
  browser = await chromium.launch({ executablePath: process.env.OPENBOT_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  report.browserVersion = browser.version();
  const page = await browser.newPage({ viewport: { width: 1800, height: 1200 }, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async () => {
    window.mermaid = (await import("/mermaid.esm.min.mjs")).default;
    window.mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "default",
      fontFamily: '"PingFang SC", "Microsoft YaHei", Arial, sans-serif',
      fontSize: 16,
      flowchart: { htmlLabels: false, useMaxWidth: false, wrappingWidth: 280, padding: 18, nodeSpacing: 40, rankSpacing: 65 },
      sequence: { useMaxWidth: false, wrap: true, width: 180, diagramMarginX: 30, diagramMarginY: 20, actorMargin: 45 },
    });
  });
  for (const diagram of diagrams) {
    const result = await page.evaluate(async ({ id, code }) => {
      await window.mermaid.parse(code);
      const { svg } = await window.mermaid.render(id, code);
      document.querySelector("#diagram").innerHTML = svg;
      await document.fonts.ready;
      const element = document.querySelector("#diagram svg");
      const view = element.getBoundingClientRect();
      const outside = [...element.querySelectorAll("text")].filter((text) => {
        const box = text.getBoundingClientRect();
        return box.width && box.height && (box.left < view.left - 2 || box.right > view.right + 2 || box.top < view.top - 2 || box.bottom > view.bottom + 2);
      }).map((text) => text.textContent);
      return { svg, width: Math.ceil(view.width), height: Math.ceil(view.height), textOutsideCanvas: outside };
    }, diagram);
    await writeFile(path.join(output, `${diagram.id}.svg`), result.svg);
    await page.locator("#diagram svg").screenshot({ path: path.join(output, `${diagram.id}.png`) });
    const { svg, ...checks } = result;
    report.diagrams.push({ id: diagram.id, title: diagram.title, source: `${diagram.source}.md`, ...checks });
    console.log(`${diagram.id}: ${checks.width} x ${checks.height}, text outside canvas: ${checks.textOutsideCanvas.length}`);
  }
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
const escape = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
await writeFile(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(path.join(output, "index.html"), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>OpenBot 架构图与数据流程图</title><style>body{font:16px/1.6 system-ui,sans-serif;margin:32px;color:#242333;background:#f7f7fb}main{max-width:1500px;margin:auto}section{background:white;padding:24px;margin:28px 0;border:1px solid #ddd;border-radius:12px}img{width:100%;height:auto}a{color:#5551aa}h1{font-size:28px}h2{font-size:22px}</style><main><h1>OpenBot 架构图与数据流程图</h1><p>共 ${diagrams.length} 张；SVG 可缩放，PNG 可直接分享。点击图像打开原尺寸。Mermaid ${escape(mermaidVersion)}。</p>${diagrams.map((item) => `<section><h2>${escape(item.title)}</h2><p><a href="${item.id}.svg">SVG</a> · <a href="${item.id}.png">PNG</a></p><a href="${item.id}.svg"><img src="${item.id}.svg" alt="${escape(item.title)}"></a></section>`).join("\n")}</main></html>\n`);
if (report.diagrams.some((item) => item.textOutsideCanvas.length)) process.exitCode = 1;
