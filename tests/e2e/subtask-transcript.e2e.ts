import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { answered, handedBack } from "../../app/tests/subagent.fixture";
import { subagentThreadId } from "../../shared/subagent";

for (const state of [
  "finished",
  "working",
  "handed-back",
  "stopped",
  "refused",
  "parallel",
]) {
  test(`the transcript shows a ${state} subtask`, async ({
    app,
    browser,
    screen,
  }) => {
    const task = state === "handed-back" ? handedBack : answered;
    const threadId = await subagentThreadId(task.parentThreadId, task.call.id);
    const requests: string[] = [];
    await browser.route(
      new RegExp(
        `/api/copilotkit/threads/${RegExp.escape(threadId)}/messages(?:\\?|$)`,
      ),
      (route) => {
        requests.push(route.request.method);
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            messages:
              state === "working" ? task.subagent.slice(0, 2) : task.subagent,
          }),
        });
      },
    );
    await app.open(`/tests/browser/subtask-transcript.html?state=${state}`);
    const transcript = screen.getByRole("region", "Messages", { exact: true });
    await expect(transcript).toBeVisible();
    await expect(browser.locator("figure")).toHaveCount(0);
    const label =
      state === "parallel"
        ? "Working on 2 subtasks…"
        : state === "working"
          ? "Working on a subtask…"
          : "Ran a subtask";
    const summary = transcript.getByText(label, { exact: true });
    if (state === "parallel" || state === "working" || state === "finished")
      await expect(summary).toBeVisible();
    const steps = transcript.getByText("Subtask", { exact: true });
    if (state === "parallel") {
      await summary.click();
      await expect(steps).toHaveCount(2);
      await expect(
        transcript.getByText("Working", { exact: true }),
      ).toHaveCount(2);
      await expect(
        transcript.getByText("Not completed", { exact: true }),
      ).toHaveCount(0);
      return;
    }
    if (state === "stopped" || state === "refused") {
      await expect(
        transcript.getByText(
          state === "stopped" ? "Not completed" : "Blocked",
          { exact: true },
        ),
      ).toHaveCount(1);
      await expect(
        transcript.getByText("Working", { exact: true }),
      ).toHaveCount(0);
      return;
    }
    await summary.click();
    expect(requests).toEqual([]);
    await steps.click();
    if (state === "handed-back") {
      const notice = transcript.getByRole("region", "Handed back", {
        exact: true,
      });
      await expect(
        notice.getByText(/the Bot asks you in this conversation/),
      ).toBeVisible();
      await expect(
        notice.getByText("List open tickets on accounts", { exact: true }),
      ).toBeVisible();
      await expect(
        notice.getByText("Acme Robotics", { exact: true }),
      ).toBeVisible();
      await expect(
        transcript.getByText("Needs your approval", { exact: true }),
      ).toHaveCount(0);
    } else {
      await expect(
        transcript.getByText("Get account", { exact: true }),
      ).toBeVisible();
      await expect(
        transcript.getByText("List open tickets", { exact: true }),
      ).toBeVisible();
      await expect(
        transcript.getByText("In progress", { exact: true }),
      ).toHaveCount(state === "working" ? 2 : 0);
      if (state === "finished") {
        await expect(
          transcript.getByText(/For customer account Birch Labs/).first(),
        ).toBeVisible();
        await expect(
          transcript.getByText("2 steps", { exact: true }),
        ).toBeVisible();
        await expect(transcript.getByText(/Marco Diaz/).first()).toBeVisible();
      }
    }
    await expect.poll(() => requests).toEqual(["GET"]);
  });
}
