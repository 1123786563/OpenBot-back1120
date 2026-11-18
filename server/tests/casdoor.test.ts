import { expect, test } from "bun:test";
import {
  casdoorAuthRequestAllowed,
  isCasdoorSignInBody,
  parseCasdoorIdentity,
} from "../src/auth/casdoor";
import { configuredAuthProviders, loadConfig } from "../src/config";
import { createRequestActor } from "../src/request-actor";

const environment = {
  AUTH_MODE: "casdoor",
  OPENBOT_SINGLE_USER: "false",
  DATABASE_URL: "postgres://test:test@localhost:56432/openbot_t02_unit",
  KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  BETTER_AUTH_URL: "http://localhost:14001",
  BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long",
  CASDOOR_OAUTH_ISSUER: "http://localhost:19000",
  CASDOOR_OAUTH_CLIENT_ID: "test-client",
  CASDOOR_OAUTH_CLIENT_SECRET: "test-secret",
  TRUSTED_ORIGINS: "http://localhost:14001",
  INTELLIGENCE_API_URL: "http://localhost:7100",
  INTELLIGENCE_GATEWAY_WS_URL: "ws://localhost:7103",
  INTELLIGENCE_API_KEY: "test-key",
};
test("public Casdoor configuration has no admin floor or email allowlist", () => {
  const config = loadConfig(environment);
  expect(config.singleUser).toBe(false);
  expect(configuredAuthProviders(config.auth)).toEqual(["casdoor"]);
  expect(config.auth?.initialAdminEmails).toEqual([]);
  expect(config.auth?.allowedEmailDomains).toEqual([]);
});
test.each([
  ["OPENBOT_SINGLE_USER", "true"],
  ["OPENBOT_ORGANIZATION_AUTH_URL", "https://authority.test"],
  ["GOOGLE_OAUTH_CLIENT_ID", "other"],
  ["MICROSOFT_OAUTH_CLIENT_ID", "other"],
  ["OKTA_OAUTH_CLIENT_ID", "other"],
  ["INITIAL_ADMIN_EMAILS", "admin@gmail.com"],
  ["SIGNIN_ALLOWED_EMAIL_DOMAINS", "gmail.com"],
  ["SCIM_BEARER_TOKEN", "other"],
])("Casdoor conflicts fail closed: %s", (key, value) => {
  expect(() => loadConfig({ ...environment, [key]: value })).toThrow();
});
test.each([false, undefined, null, "true", 1])(
  "only boolean true is a verified claim: %s",
  (value) => {
    const parsed = () =>
      parseCasdoorIdentity({
        sub: "immutable-subject",
        email: "test@gmail.com",
        email_verified: value,
      });
    if (value === false || value === undefined)
      expect(parsed().email_verified === true).toBe(false);
    else expect(parsed).toThrow();
  },
);
test("accepts a verified profile without deriving privilege from IdP admin", () => {
  expect(
    parseCasdoorIdentity({
      sub: "subject",
      email: "test@outlook.com",
      email_verified: true,
      isAdmin: true,
    }),
  ).toEqual({
    sub: "subject",
    email: "test@outlook.com",
    email_verified: true,
  });
});
test.each([
  "/sign-in/email",
  "/sign-in/sso",
  "/sign-in/anonymous",
  "/organization/session",
  "/organization/set-active",
  "/update-user",
  "/link-social",
  "/desktop/token",
  "/scim/v2/Users/x",
  "/callback/okta",
])("auth route rejects %s", (path) => {
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"])
    expect(
      casdoorAuthRequestAllowed(
        new Request(`http://localhost/api/auth${path}`, { method }),
      ),
    ).toBe(false);
});
test("Copilot uses the same business eligibility verdict", async () => {
  const actors = createRequestActor({
    singleUser: false,
    resolveBusinessAccess: async () => ({
      kind: "denied",
      code: "EMAIL_VERIFICATION_REQUIRED",
    }),
    getSession: async () => {
      throw Error("must not bypass resolver");
    },
    rolesForUser: async () => ["admin"],
  });
  await expect(
    actors.identifyUser(new Request("http://localhost/copilotkit")),
  ).rejects.toThrow("EMAIL_VERIFICATION_REQUIRED");
  expect(
    await actors.identifyActor(new Request("http://localhost/copilotkit")),
  ).toEqual({ id: "", role: "user" });
});

test("sign-in accepts only the code-flow request fields", () => {
  expect(
    isCasdoorSignInBody({
      provider: "casdoor",
      callbackURL: "http://localhost:14001",
    }),
  ).toBe(true);
  for (const body of [
    { provider: "google" },
    { provider: "casdoor", idToken: {} },
    { provider: "casdoor", additionalData: { emailVerified: true } },
    { provider: "casdoor", activeOrganizationId: "default" },
  ])
    expect(isCasdoorSignInBody(body)).toBe(false);
});

test("explicit listener IP is parsed, invalid hosts are refused and legacy default remains unset", () => {
  expect(
    loadConfig({ ...environment, OPENBOT_LISTEN_HOSTNAME: "127.0.0.1" })
      .listenHostname,
  ).toBe("127.0.0.1");
  expect(loadConfig(environment).listenHostname).toBeUndefined();
  expect(() =>
    loadConfig({ ...environment, OPENBOT_LISTEN_HOSTNAME: "http://127.0.0.1" }),
  ).toThrow("OPENBOT_LISTEN_HOSTNAME");
});
