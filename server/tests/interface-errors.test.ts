import { expect, test } from "bun:test";
import { Hono } from "hono";
import { interfaceErrors } from "../src/interface-errors";
import { describeCron } from "../src/routines/schedule";

test.each([
  { status: 400, code: "invalid_request" },
  { status: 401, code: "sign_in_required" },
  { status: 403, code: "permission_denied" },
  { status: 404, code: "not_found" },
  { status: 409, code: "conflict" },
  { status: 429, code: "rate_limited" },
  { status: 503, code: "unavailable" },
  { status: 500, code: "request_failed" },
])(
  "HTTP $status has stable code $code without replacing the original error",
  async ({ status, code }) => {
    const app = new Hono();
    app.use("*", interfaceErrors);
    app.get("/", () =>
      Response.json({ error: "Original English error" }, { status }),
    );
    const response = await app.request("/");
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({
      error: "Original English error",
      code,
    });
  },
);

test("error codes retain legacy messages and response metadata", async () => {
  const app = new Hono();
  app.use("*", interfaceErrors);
  app.get("/denied", (context) =>
    context.json({ error: "Original vendor message" }, 403, {
      "x-request-id": "test",
    }),
  );
  const response = await app.request("/denied");
  expect(response.status).toBe(403);
  expect(response.headers.get("x-request-id")).toBe("test");
  expect(await response.json()).toEqual({
    error: "Original vendor message",
    code: "permission_denied",
  });
});

test("schedule prose localizes without changing cron or its meaning", () => {
  expect(describeCron("0 9 * * 1-5", "zh-CN")).toBe("工作日 09:00");
  expect(describeCron("0 9 * * 1-5")).toBe("Weekdays at 09:00");
  expect(describeCron("*/20 * * * *", "zh-CN")).toBe("每 20 分钟");
  expect(describeCron("0 9 12 * *", "zh-CN")).toBe("每月 12 日 09:00");
  expect(describeCron("not cron", "zh-CN")).toBe("not cron");
});
