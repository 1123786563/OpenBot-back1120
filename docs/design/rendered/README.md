# 架构与数据流程图渲染

打开 [图集](index.html) 查看全部 8 张图，每张均提供 SVG 和 PNG。SVG 适合放大阅读，PNG 适合直接分享；图集随窗口缩放，点击图像可打开原始 SVG。

来源：[系统架构](../system-architecture.md)、[数据流程](../data-flows.md)。Mermaid 代码保留在源 Markdown 中，本目录是生成产物。

## 检查结果

- 使用 Mermaid 12.3.0 和本机 Chrome 完成 8/8 解析与渲染。
- 检查每张图的 SVG 文字包围盒，未发现文字超出画布；尺寸和浏览器版本见 [report.json](report.json)。
- 逐张查看 PNG，检查中文显示、节点与边标签、箭头、子图标题、时序参与者和注释框。
- 将流程图换行宽度提高到 280，修正节点过窄导致的中文拆词，并减小容器图高度；最终图未发现明显裁切或遮挡。
- 复杂图仍有跨区域回路线；图集提供完整 SVG 以便放大，不以缩略图字号判断原图可读性。

此结论针对本目录的渲染产物，不保证所有 Markdown 平台、字体和 Mermaid 版本的布局一致。自动包围盒检查不能代替人工视觉检查。

## 重新生成

依赖安装到临时目录，不修改项目依赖或 lockfile。在仓库根目录运行：

```sh
export OPENBOT_DIAGRAM_TOOLS="$(mktemp -d)"
npm install --prefix "$OPENBOT_DIAGRAM_TOOLS" --no-audit --no-fund mermaid@12.3.0 playwright-core@1.65.1
node scripts/render-design-diagrams.mjs
```

默认浏览器是 macOS 的 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`。其他环境通过 `OPENBOT_CHROME` 指定已安装的 Chromium/Chrome 可执行文件。渲染器只在 loopback 临时提供 Mermaid 资源，结束后关闭浏览器和本地服务。

修改源图后重新运行，并复查 PNG；脚本自动检测解析错误和画布外文字，人工检查结论需要随实际检查更新。
