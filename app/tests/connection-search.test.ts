import { expect, test } from "bun:test";
import {
  Route as ConnectedAccountRoute,
  landedActionFrom,
} from "@/routes/_authed/_app/connections.$key";

test("validateSearch omits the key when absent and reads the action as text", () => {
  const validate = ConnectedAccountRoute.options.validateSearch;
  if (typeof validate !== "function")
    throw new Error("Expected a connection search validator");
  expect(validate({})).toEqual({});
  expect("action" in validate({})).toBe(false);
  expect(validate({ action: "Gmail.ListEmails" })).toEqual({
    action: "Gmail.ListEmails",
  });
  /*
   * The router JSON-parses search values, so an action name made of digits arrives as a number and
   * a JSON-shaped one as an object. Both are still what the verifier put in the URL: the key is
   * read as text (`searchText`) rather than dropped for having parsed into something else.
   */
  expect(validate({ action: 5 })).toEqual({ action: "5" });
  expect(validate({ action: { a: 1 } })).toEqual({ action: '{"a":1}' });
});

test("an empty or absurdly long action is not drawn", () => {
  expect(landedActionFrom(undefined)).toBeNull();
  expect(landedActionFrom("   ")).toBeNull();
  expect(landedActionFrom("x".repeat(201))).toBeNull();
  expect(landedActionFrom(" Gmail.ListEmails ")).toBe("Gmail.ListEmails");
});
