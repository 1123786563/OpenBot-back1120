import type { InterfaceErrorCode } from "@openbot/shared/interface-errors";
import { useState } from "react";
import { i18n, ui, useLocale } from ".";

const messages = {
  invalid_request: "Please check your input and try again.",
  sign_in_required: "Please sign in to continue.",
  permission_denied: "You do not have permission to do this.",
  not_found: "This item is no longer available.",
  conflict: "This item changed. Refresh and try again.",
  rate_limited: "Too many requests. Please try again later.",
  unavailable: "The service is temporarily unavailable. Please try again.",
  request_failed: "Something went wrong. Please try again.",
} satisfies Record<InterfaceErrorCode, string>;
export class ApiError extends Error {
  constructor(
    readonly code: InterfaceErrorCode,
    readonly details: string,
    message = details,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
export function errorText(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : null;
  return error instanceof ApiError
    ? ui(messages[error.code])
    : message && i18n.exists(message)
      ? ui(message)
      : ui(messages.request_failed);
}
export function ErrorDetails({ error }: { error: unknown }) {
  useLocale();
  const [expanded, setExpanded] = useState(false);
  const raw =
    error instanceof ApiError
      ? error.details
      : error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : null;
  return (
    <span>
      {errorText(error)}
      {raw && (
        <>
          <span> </span>
          <button
            type="button"
            className="underline"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {ui("Details")}
          </button>
          <span
            data-error-detail
            hidden={!expanded}
            className="block whitespace-pre-wrap break-words text-xs"
          >
            {raw}
          </span>
        </>
      )}
    </span>
  );
}
