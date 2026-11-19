export const ASK =
  "Build an interactive weekend trip budget in this conversation. Start with transport $100, lodging $200 and food $80.";

/** What the Bot draws, as a model writes it for `generateSandboxedUi`. */
export const BUDGET = {
  initialHeight: 320,
  placeholderMessages: ["Building your trip budget"],
  css: ".budget { padding: 16px; }",
  html: `<div class="budget"><h2>Weekend trip budget</h2><label>Transport <input id="transport" value="100"></label><label>Lodging <input id="lodging" value="200"></label><label>Food <input id="food" value="80"></label><p>Total: <strong id="total">$380</strong></p></div>`,
  jsFunctions: "function total() { return 380; }",
};

/**
 * The same budget drawn from the A2UI catalog with `render_ui`, as the runtime offers it: three
 * number fields under a heading, and a total the Bot computes.
 */
const field = (key: string, label: string) => ({
  id: key,
  component: "TextField",
  label,
  variant: "number",
  value: { "@path": `/${key}` },
});
export const RENDERED_BUDGET = {
  target: "chat",
  operations: [
    {
      version: "1.0",
      createSurface: {
        surfaceId: "budget",
        catalogId: "openbot/ui@1",
        dataModel: { transport: 100, lodging: 200, food: 80 },
      },
    },
    {
      version: "1.0",
      updateComponents: {
        surfaceId: "budget",
        components: [
          { id: "root", component: "Card", child: "fields" },
          {
            id: "fields",
            component: "Column",
            children: ["heading", "transport", "lodging", "food", "total"],
          },
          field("transport", "Transport ($)"),
          field("lodging", "Lodging ($)"),
          field("food", "Food ($)"),
          {
            id: "total",
            component: "Text",
            text: {
              "@call": "calc",
              args: {
                expression: "'Total $' + (transport + lodging + food)",
                transport: { "@path": "/transport" },
                lodging: { "@path": "/lodging" },
                food: { "@path": "/food" },
              },
            },
          },
          // Listed last and shown first: the line is read in the order the surface shows it.
          { id: "heading", component: "Text", text: "## Weekend trip budget" },
        ],
      },
    },
  ],
};
