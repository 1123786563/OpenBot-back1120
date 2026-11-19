import { expect, test } from "bun:test";
import {
  earlierFrom,
  openingFrom,
  shouldDrawEarlier,
} from "@/components/channels/transcript-pages";

test("page arithmetic", () => {
  expect(openingFrom(50)).toBe(30);
  expect(openingFrom(12)).toBe(0);
  expect(earlierFrom(30)).toBe(10);
  expect(earlierFrom(10)).toBe(0);
});

test("an older page is drawn only near the top of a measured view", () => {
  expect(
    shouldDrawEarlier({ from: 30, scrollTop: 100, scrollHeight: 5000 }),
  ).toBe(true);
  expect(
    shouldDrawEarlier({ from: 0, scrollTop: 100, scrollHeight: 5000 }),
  ).toBe(false);
  expect(
    shouldDrawEarlier({ from: 30, scrollTop: 900, scrollHeight: 5000 }),
  ).toBe(false);
  expect(shouldDrawEarlier({ from: 30, scrollTop: 0, scrollHeight: 0 })).toBe(
    false,
  );
});
