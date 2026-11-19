import { afterEach, expect, test } from "bun:test";
import { auditActionWords, dataWords } from "@openbot/shared/audit-words";
import {
  approvalDisplay,
  approvalPhrase,
  readToolName,
  ruleTitle,
} from "@openbot/shared/tool-name";
import { client } from "@/lib/client";
import { i18n, resolveLocale, ui, uiNodes } from "@/lib/i18n";
import { ApiError } from "@/lib/i18n/errors";
import { replyNotice } from "@/lib/notifications/reply-notice";
import { browserCallFailed, toolResultFailed } from "@/lib/plugins/tool-result";
import { relativeTime, relativeTimeShort } from "@/lib/relative-time";

const originalFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = originalFetch;
  await i18n.changeLanguage("en");
});

test("reply notifications localize the title and preserve the Bot name and response", async () => {
  await i18n.changeLanguage("zh-CN");
  const notice = replyNotice(
    {
      channelId: "channel",
      lastMessageAgentId: "bot",
      lastMessage: "Original response in English",
      lastMessageAt: "2026-11-18T00:00:00Z",
    },
    "all",
    [],
    [{ id: "bot", name: "Custom Bot" }],
  );
  expect(notice?.title).toBe("Custom Bot 已回复");
  expect(notice?.body).toBe("Original response in English");
});

test("runtime failure markers remain recognizable in either interface language", async () => {
  for (const locale of ["en", "zh-CN"]) {
    await i18n.changeLanguage(locale);
    expect(browserCallFailed("Error: invalid arguments")).toBe(true);
    expect(
      toolResultFailed("The vendor reported an error: original reason"),
    ).toBe(true);
    expect(
      toolResultFailed("That tool could not be called: original reason"),
    ).toBe(true);
    expect(toolResultFailed("A vendor's original answer")).toBe(false);
  }
});

test("approval titles translate their structure and expose only existing display fields", async () => {
  const display = approvalDisplay({
    toolRef: "computer_click",
    scope: "example.com",
    target: {
      element: { role: "button", name: "Save draft", credentials: "private" },
      args: { password: "private" },
      secret: "private",
    },
  });
  expect(display).toEqual({
    toolRef: "computer_click",
    scope: "example.com",
    target: { element: { role: "button", name: "Save draft" } },
  });
  expect(approvalPhrase(display)).toBe(
    "click the button “Save draft” on example.com",
  );
  await i18n.changeLanguage("zh-CN");
  expect(approvalPhrase(display, ui)).toContain("Save draft");
  expect(approvalPhrase(display, ui)).toContain("点击");
  expect(approvalPhrase(display, ui)).toContain("example.com");
  expect(readToolName("host_write_file", false, ui).label).not.toBe(
    "Saved a file",
  );
  expect(readToolName("host_write_file").label).toBe("Saved a file");
  expect(ruleTitle({ toolRef: "*", scope: "*" }, ui).title).toBe("任意动作");
});

test("audit labels translate while server defaults and third-party action names stay intact", async () => {
  await i18n.changeLanguage("zh-CN");
  expect(auditActionWords("computer_click", ui)).toBe("点击页面");
  expect(auditActionWords("computer_click")).toBe("Click on a page");
  expect(dataWords(["botActivity", "recentRefusals"], ui)).toBe(
    "AI 同事的活动 和 被拒绝的操作",
  );
  expect(auditActionWords("custom/My_Customer_Record", ui)).toBe(
    auditActionWords("custom/My_Customer_Record"),
  );
});

test("unknown future error codes retain structured vendor details", async () => {
  const original = "Vendor original English error";
  expect(new ApiError("unavailable", original).message).toBe(original);
  const raw = { reason: "vendor original", reference: "abc" };
  globalThis.fetch = Object.assign(
    async () =>
      Response.json(
        { error: raw, code: "future_vendor_code" },
        { status: 403 },
      ),
    { preconnect: originalFetch.preconnect },
  );
  try {
    await client("/api/future-error");
    throw new Error("Expected the request to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    if (!(error instanceof ApiError)) throw error;
    expect(error.code).toBe("permission_denied");
    expect(error.details).toBe(JSON.stringify(raw));
  }
});

test("browser language mapping and explicit preference", () => {
  expect(resolveLocale("system", "zh-TW")).toBe("zh-CN");
  expect(resolveLocale("system", "fr-FR")).toBe("en");
  expect(resolveLocale("en", "zh-CN")).toBe("en");
});

test("formatters refresh immediately, preserve invalid dates and never translate content slots", async () => {
  await i18n.changeLanguage("zh-CN");
  const now = new Date("2026-11-18T00:00:00Z");
  expect(relativeTimeShort("2026-11-17T23:00:00Z", now)).toBe("1小时");
  expect(relativeTime("invalid-date")).toBe("invalid-date");
  const name = "My custom English Bot";
  const nodes = uiNodes("Sign in to {{slot0}}", [name]);
  expect(JSON.stringify(nodes)).toContain(name);
  expect(ui("missing-key-for-fallback")).toBe("missing-key-for-fallback");
  await i18n.changeLanguage("en");
  expect(relativeTimeShort("2026-11-17T23:00:00Z", now)).toBe("1h");
});
