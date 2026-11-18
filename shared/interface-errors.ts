import { z } from "zod";
export const interfaceErrorCode = z.enum([
  "invalid_request",
  "sign_in_required",
  "permission_denied",
  "not_found",
  "conflict",
  "rate_limited",
  "unavailable",
  "request_failed",
]);
export type InterfaceErrorCode = z.infer<typeof interfaceErrorCode>;
export const errorResponse = z.object({
  error: z.unknown().optional(),
  code: z.unknown().optional(),
});
export function errorCodeForStatus(status: number): InterfaceErrorCode {
  switch (status) {
    case 400:
    case 422:
      return "invalid_request";
    case 401:
      return "sign_in_required";
    case 403:
      return "permission_denied";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 429:
      return "rate_limited";
    case 502:
    case 503:
    case 504:
      return "unavailable";
    default:
      return "request_failed";
  }
}
