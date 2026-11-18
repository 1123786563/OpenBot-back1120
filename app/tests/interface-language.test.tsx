import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { DEFAULT_USER_PREFERENCES } from "@openbot/shared/user-preferences";
import { LanguagePicker, LanguageProvider } from "@/lib/i18n/provider";
import {
  i18n,
  LANGUAGE_STORAGE_KEY,
  resolveLocale,
  ui,
  uiNodes,
} from "@/lib/i18n";
import { relativeTime, relativeTimeShort } from "@/lib/relative-time";
import {
  currentUserQueryOptions,
  type AuthenticatedUser,
} from "@/lib/auth/queries";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";
import { ApiError, ErrorDetails } from "@/lib/i18n/errors";
import { client } from "@/lib/client";
import { auditActionWords, dataWords } from "@openbot/shared/audit-words";
import {
  approvalDisplay,
  approvalPhrase,
  readToolName,
  ruleTitle,
} from "@openbot/shared/tool-name";
import { browserCallFailed, toolResultFailed } from "@/lib/plugins/tool-result";
import { replyNotice } from "@/lib/notifications/reply-notice";

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

test("errors translate summaries, retain original details and reveal them on request", async () => {
  const original = "Vendor original English error";
  const error = new ApiError("unavailable", original);
  expect(error.message).toBe(original);
  const view = render(<ErrorDetails error={error} />);
  const detail = view.container.querySelector<HTMLElement>(
    "[data-error-detail]",
  );
  expect(detail?.hidden).toBe(true);
  await i18n.changeLanguage("zh-CN");
  await waitFor(() =>
    expect(view.container.textContent).toContain("服务暂时不可用"),
  );
  fireEvent.click(view.getByRole("button", { name: "详情" }));
  expect(detail?.hidden).toBe(false);
  expect(detail?.textContent).toBe(original);
});

const originalFetch = globalThis.fetch;
beforeAll(() => GlobalRegistrator.register());
afterEach(async () => {
  cleanup();
  localStorage.clear();
  globalThis.fetch = originalFetch;
  await i18n.changeLanguage("en");
});
afterAll(() => GlobalRegistrator.unregister());

test("an older preference read cannot overwrite a successful language selection", async () => {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const user = {
    id: "alice",
    email: "alice@example.com",
    role: "user",
    onboarding: null,
  } satisfies AuthenticatedUser;
  cache.setQueryData(currentUserQueryOptions().queryKey, user);
  const initialRead = Promise.withResolvers<Response>();
  let readSignal: AbortSignal | null | undefined;
  globalThis.fetch = Object.assign(
    (
      _url: Parameters<typeof fetch>[0],
      options?: Parameters<typeof fetch>[1],
    ) => {
      if (options?.method === "PATCH")
        return Promise.resolve(
          Response.json({
            preferences: { ...DEFAULT_USER_PREFERENCES, language: "zh-CN" },
          }),
        );
      readSignal = options?.signal;
      return initialRead.promise;
    },
    { preconnect: originalFetch.preconnect },
  );
  const view = render(
    <QueryClientProvider client={cache}>
      <LanguageProvider>
        <LanguagePicker />
      </LanguageProvider>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(readSignal).toBeDefined());
  fireEvent.change(view.getByRole("combobox"), { target: { value: "zh-CN" } });
  await waitFor(() =>
    expect(
      cache.getQueryData(userPreferencesQueryOptions("alice").queryKey),
    ).toMatchObject({ language: "zh-CN" }),
  );
  expect(readSignal?.aborted).toBe(true);
  await act(async () => {
    initialRead.resolve(
      Response.json({
        preferences: { ...DEFAULT_USER_PREFERENCES, language: "en" },
      }),
    );
  });
  expect(i18n.language).toBe("zh-CN");
  expect(
    cache.getQueryData(userPreferencesQueryOptions("alice").queryKey),
  ).toMatchObject({ language: "zh-CN" });
  view.unmount();
  cache.clear();
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

test("account save failure keeps selection and draft; retry syncs; logout restores local choice", async () => {
  localStorage.setItem(LANGUAGE_STORAGE_KEY, "en");
  const cache = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  const user = {
    id: "alice",
    email: "alice@example.com",
    role: "user" as const,
    onboarding: null,
  };
  cache.setQueryData(currentUserQueryOptions().queryKey, user);
  cache.setQueryData(userPreferencesQueryOptions(user.id).queryKey, {
    ...DEFAULT_USER_PREFERENCES,
    language: "en",
  });
  let succeed = false;
  const saved: unknown[] = [];
  globalThis.fetch = Object.assign(
    async (
      _url: Parameters<typeof fetch>[0],
      options?: Parameters<typeof fetch>[1],
    ) => {
      saved.push(JSON.parse(String(options?.body)));
      return Response.json(
        succeed
          ? { preferences: { ...DEFAULT_USER_PREFERENCES, language: "zh-CN" } }
          : { error: "provider original error", code: "unavailable" },
        { status: succeed ? 200 : 503 },
      );
    },
    { preconnect: originalFetch.preconnect },
  );
  const view = render(
    <QueryClientProvider client={cache}>
      <LanguageProvider>
        <input aria-label="draft" defaultValue="Unsaved English text" />
        <LanguagePicker />
      </LanguageProvider>
    </QueryClientProvider>,
  );
  const input = view.getByRole("textbox");
  await waitFor(() => expect(i18n.language).toBe("en"));
  fireEvent.change(view.getByRole("combobox"), { target: { value: "zh-CN" } });
  await waitFor(() =>
    expect(view.getByRole("alert").textContent).toContain("语言尚未同步"),
  );
  expect(i18n.language).toBe("zh-CN");
  expect(view.getByRole("textbox")).toBe(input);
  expect(input.getAttribute("value")).toBe("Unsaved English text");
  succeed = true;
  fireEvent.click(view.getByRole("button", { name: "重试" }));
  await waitFor(() => expect(view.queryByRole("alert")).toBeNull());
  expect(saved).toEqual([{ language: "zh-CN" }, { language: "zh-CN" }]);
  expect(
    cache.getQueryData(userPreferencesQueryOptions(user.id).queryKey),
  ).toMatchObject({ language: "zh-CN" });
  cache.setQueryData(currentUserQueryOptions().queryKey, null);
  await waitFor(() => expect(i18n.language).toBe("en"));
  expect(view.getByRole("textbox")).toBe(input);
  expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("en");
  view.unmount();
  cache.clear();
});
