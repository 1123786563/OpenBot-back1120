import { expect, test } from "bun:test";
import { resumeUrlFor } from "@/lib/auth/resume";

const origin = "https://app.example";

test("resumeUrlFor encodes the handle as a query value on the local verifier", () => {
  expect(resumeUrlFor(origin, "a b&c/../d")).toBe(
    `${origin}/api/plugins/arcade/verify?flow_id=a%20b%26c%2F..%2Fd`,
  );
  const url = new URL(resumeUrlFor(origin, "https://other.example/"));
  expect(url.origin).toBe(origin);
  expect(url.searchParams.get("flow_id")).toBe("https://other.example/");
});

test("resumeUrlFor returns the origin when no usable handle was provided", () => {
  for (const handle of [undefined, "", "x".repeat(5000)]) {
    expect(resumeUrlFor(origin, handle)).toBe(origin);
  }
});
