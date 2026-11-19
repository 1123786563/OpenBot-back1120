/**
 * #64 isolated-entry authentication.
 *
 * Service credentials are generated per isolated run and injected through the
 * process environment; the SERVER holds the trusted subject → organization /
 * account-scope / capability / namespace mapping. A request header can never
 * choose any of these. There is no user-self-service grant path anywhere.
 *
 * The production mount (#67) replaces this resolver with the real identity
 * adapter; the ledger SERVICE does not know or care which resolver produced
 * the credential.
 */
import type { ServiceCredential } from "./service.js";
import { LedgerError } from "./service.js";

export function parseCredentials(raw: string | undefined): ServiceCredential[] {
  if (!raw) throw new Error("BILLING_LEDGER_CREDENTIALS must be configured");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("BILLING_LEDGER_CREDENTIALS must be a JSON array");
  return parsed.map((c) => {
    const r = c as Record<string, unknown>;
    return {
      token: String(r.token),
      subject: String(r.subject),
      organizationId: String(r.organization_id),
      accountScope: (r.account_scope as string[]) ?? [],
      capabilities: (r.capabilities as string[]) ?? [],
      namespace: String(r.namespace),
    };
  });
}

export class CredentialResolver {
  private readonly byToken = new Map<string, ServiceCredential>();
  constructor(credentials: ServiceCredential[]) {
    for (const c of credentials) this.byToken.set(c.token, c);
  }

  /** Bearer token → credential, else 401 BEFORE anything else is inspected. */
  authenticate(authorizationHeader: string | undefined): ServiceCredential {
    const m = /^Bearer\s+(.+)$/i.exec(authorizationHeader ?? "");
    const token = m?.[1] ?? "";
    const cred = this.byToken.get(token);
    if (!cred) throw new LedgerError("unauthenticated", "no or unknown service credential");
    return cred;
  }

  requireCapability(cred: ServiceCredential, capability: string): void {
    if (!cred.capabilities.includes(capability))
      throw new LedgerError("forbidden", `credential lacks the ${capability} capability`);
  }

  /**
   * Object lookup outside the credential's account scope answers 404 —
   * deliberately indistinguishable from "does not exist" — while a missing
   * capability on a KNOWN operation answers 403.
   */
  requireAccountScope(cred: ServiceCredential, organizationId: string, accountId: string): void {
    if (cred.organizationId !== organizationId)
      throw new LedgerError("resource_not_found", "billing account not found in this organization scope");
    if (!cred.accountScope.includes("*") && !cred.accountScope.includes(accountId))
      throw new LedgerError("resource_not_found", "billing account not found in this organization scope");
  }
}
