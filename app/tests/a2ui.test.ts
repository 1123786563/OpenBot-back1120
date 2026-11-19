import { expect, test } from "bun:test";
import { standardUI } from "@copilotkit/react-core/v2/generative-ui";
import {
  generativeUiProviderOptions,
  OMITTED_STANDARD_COMPONENTS,
  OPENBOT_UI,
  OPENBOT_UI_THEME,
} from "@/lib/copilot/a2ui";

test("disabled and unresolved deployments do not send the catalog", () => {
  expect(generativeUiProviderOptions(false)).toEqual({});
  expect(generativeUiProviderOptions(undefined)).toEqual({});
  expect(generativeUiProviderOptions(true).generativeUI).toEqual({
    ui: OPENBOT_UI,
    theme: OPENBOT_UI_THEME,
  });
});

test("the catalog is the standard one, less the omitted components, plus Breakdown and without the gallery", () => {
  expect(OPENBOT_UI.id).toBe("openbot/ui@1");
  const expected = Object.keys(standardUI.manifestComponents).filter(
    (name) =>
      !(OMITTED_STANDARD_COMPONENTS as readonly string[]).includes(name),
  );
  expect([...OPENBOT_UI.components.keys()].sort()).toEqual(
    [...expected, "Breakdown"].sort(),
  );
  expect(expected).toHaveLength(65);
  // The A2UI 1.0 basic components, under their A2UI names.
  for (const name of [
    "Text",
    "Image",
    "Icon",
    "Video",
    "AudioPlayer",
    "Row",
    "Column",
    "List",
    "Card",
    "Tabs",
    "Divider",
    "Modal",
    "Button",
    "CheckBox",
    "TextField",
    "DateTimeInput",
    "ChoicePicker",
    "Slider",
  ])
    expect(OPENBOT_UI.components.has(name)).toBe(true);
  expect(OPENBOT_UI.components.has("Table")).toBe(true);
  expect(OPENBOT_UI.components.has("Chart")).toBe(true);
  // Map needs maplibre-gl; the other three send linked domains to Google's favicon service.
  for (const name of ["Map", "Favicon", "LinkCard", "Citation"])
    expect(OPENBOT_UI.components.has(name)).toBe(false);
  // The gallery components keep their separate per-Bot tool and grant path.
  expect(OPENBOT_UI.components.has("showTable")).toBe(false);
  expect(OPENBOT_UI.components.has("askForm")).toBe(false);
});
