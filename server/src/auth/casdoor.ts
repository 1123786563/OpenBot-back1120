import { AsyncLocalStorage } from "node:async_hooks";
import type { GenericOAuthConfig } from "better-auth/plugins/generic-oauth";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import type { AuthConfig } from "../config";

const identitySchema = z.object({
  sub: z.string().min(1),
  email: z.email(),
  email_verified: z.boolean().optional(),
  name: z.string().optional(),
});
export const parseCasdoorIdentity = (raw: unknown) => identitySchema.parse(raw);
export type CasdoorIdentity = z.infer<typeof identitySchema>;
export const casdoorRequest = new AsyncLocalStorage<{
  identity?: CasdoorIdentity;
}>();

export function casdoorProvider(
  config: NonNullable<AuthConfig["casdoor"]>,
): GenericOAuthConfig {
  const keys = createRemoteJWKSet(new URL(`${config.issuer}/.well-known/jwks`));
  return {
    providerId: "casdoor",
    ...config,
    discoveryUrl: `${config.issuer}/.well-known/openid-configuration`,
    requireIdTokenVerification: true,
    pkce: true,
    scopes: ["openid", "email", "profile"],
    overrideUserInfo: true,
    disableProviderLogout: true,
    async getUserInfo(tokens) {
      if (!tokens.idToken || !tokens.accessToken) return null;
      const { payload } = await jwtVerify(tokens.idToken, keys, {
        issuer: config.issuer,
        audience: config.clientId,
        algorithms: ["RS256"],
      });
      const response = await fetch(`${config.issuer}/api/userinfo`, {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
        redirect: "error",
      });
      if (!response.ok) return null;
      const identity = parseCasdoorIdentity(await response.json());
      if (identity.sub !== payload.sub || identity.email !== payload.email)
        return null;
      const request = casdoorRequest.getStore();
      if (!request) return null;
      request.identity = identity;
      return { ...identity, emailVerified: identity.email_verified === true };
    },
  };
}

export function casdoorAuthRequestAllowed(request: Request): boolean {
  const path = new URL(request.url).pathname;
  return (
    (request.method === "GET" &&
      ["/api/auth/get-session", "/api/auth/callback/casdoor"].includes(path)) ||
    (request.method === "POST" &&
      [
        "/api/auth/sign-in/social",
        "/api/auth/sign-out",
        "/api/auth/revoke-session",
        "/api/auth/revoke-sessions",
        "/api/auth/revoke-other-sessions",
      ].includes(path))
  );
}

export async function validateCasdoorDiscovery(issuer: string): Promise<void> {
  const response = await fetch(`${issuer}/.well-known/openid-configuration`, {
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("Casdoor discovery unavailable");
  const document = z
    .object({
      issuer: z.literal(issuer),
      authorization_endpoint: z.url(),
      token_endpoint: z.url(),
      userinfo_endpoint: z.literal(`${issuer}/api/userinfo`),
      jwks_uri: z.literal(`${issuer}/.well-known/jwks`),
    })
    .parse(await response.json());
  for (const endpoint of [
    document.authorization_endpoint,
    document.token_endpoint,
  ]) {
    if (new URL(endpoint).origin !== issuer)
      throw new Error("Casdoor endpoint origin mismatch");
  }
}

const signInSchema = z
  .object({
    provider: z.literal("casdoor"),
    callbackURL: z.string().optional(),
    errorCallbackURL: z.string().optional(),
    newUserCallbackURL: z.string().optional(),
    disableRedirect: z.boolean().optional(),
    requestSignUp: z.boolean().optional(),
  })
  .strict();
export function isCasdoorSignInBody(body: unknown): boolean {
  return signInSchema.safeParse(body).success;
}
