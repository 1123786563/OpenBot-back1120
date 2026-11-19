import type { Browser } from "@e2e-dev/web";
import { expect } from "e2e";

const email = "maya@example.test";
const finishTime = "2026-10-23T00:00:00Z";

export async function serveOnboarding(
  browser: Browser,
  options: {
    name?: string;
    step?: number;
    evaluateLocally?: boolean;
    beforeCapabilities?: () => Promise<"unavailable" | undefined>;
    saveName?: (name: string) => Promise<string | undefined>;
    finish?: () => Promise<string | undefined>;
  } = {},
) {
  let name = options.name ?? email;
  const onboarding = {
    step: options.step ?? 3,
    completedAt: null as string | null,
  };
  const writes: ({ name: string } | { step: number } | { completed: true })[] =
    [];
  await browser.route(/\/api\/me$/, (route) =>
    route.fulfill({
      json: {
        user: {
          id: "maya",
          email,
          name,
          needsName: name === email,
          role: "admin",
          onboarding,
        },
      },
    }),
  );
  await browser.route(/\/api\/capabilities$/, async (route) => {
    if ((await options.beforeCapabilities?.()) === "unavailable") {
      return route.fulfill({
        status: 503,
        json: { error: "Setup unavailable" },
      });
    }
    const original = await (await route.fetch()).json<
      Record<string, unknown>
    >();
    return route.fulfill({
      json: { ...original, localEvaluation: options.evaluateLocally ?? false },
    });
  });
  await browser.route(/\/api\/me\/profile$/, async (route) => {
    expect(route.request.method).toBe("PATCH");
    const body = JSON.parse(route.request.postData ?? "null") as {
      name: string;
    };
    writes.push(body);
    const error = await options.saveName?.(body.name);
    if (error) return route.fulfill({ status: 500, json: { error } });
    name = body.name;
    return route.fulfill({ json: { profile: { name, needsName: false } } });
  });
  await browser.route(/\/api\/me\/onboarding$/, async (route) => {
    expect(route.request.method).toBe("POST");
    const body = JSON.parse(route.request.postData ?? "null") as
      | { step: number }
      | { completed: true };
    writes.push(body);
    if ("step" in body) {
      onboarding.step = body.step;
    } else {
      const error = await options.finish?.();
      if (error) return route.fulfill({ status: 503, json: { error } });
      onboarding.completedAt = finishTime;
    }
    return route.fulfill({ json: { onboarding } });
  });
  const savedSteps = () =>
    writes
      .flatMap((write) => ("step" in write ? [write.step] : []))
      .filter((step, index, steps) => index === 0 || step !== steps[index - 1]);
  return { writes, savedSteps };
}
