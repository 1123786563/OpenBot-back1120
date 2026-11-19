import { expect, test } from "bun:test";
import { cronFrom, scheduleSentence } from "@/lib/routines/form";

test("the schedule picker writes the cron it reads back in words", () => {
  const at = { time: "09:00", weekday: "1", monthDay: "1" };
  const cases = [
    [{ ...at, repeat: "weekdays" }, "0 9 * * 1-5", "Every weekday at 9:00 AM"],
    [
      { ...at, repeat: "daily", time: "18:30" },
      "30 18 * * *",
      "Every day at 6:30 PM",
    ],
    [
      { ...at, repeat: "weekly", weekday: "5", time: "00:15" },
      "15 0 * * 5",
      "Every Friday at 12:15 AM",
    ],
    [
      { ...at, repeat: "monthly", monthDay: "22", time: "12:00" },
      "0 12 22 * *",
      "On the 22nd of every month at 12:00 PM",
    ],
    [{ ...at, repeat: "hourly" }, "0 * * * *", "Every hour, on the hour"],
  ] as const;
  for (const [schedule, cron, words] of cases) {
    expect(cronFrom(schedule)).toBe(cron);
    expect(scheduleSentence(schedule)).toBe(words);
  }
});
