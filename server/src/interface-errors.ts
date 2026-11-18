import { errorCodeForStatus } from "@openbot/shared/interface-errors";
import type { MiddlewareHandler } from "hono";

// Keep the original envelope for clients that still consume `error`.
export const interfaceErrors: MiddlewareHandler = async (context, next) => {
  await next();
  if (
    context.res.status < 400 ||
    !context.res.headers.get("content-type")?.includes("application/json")
  )
    return;
  const body: unknown = await context.res
    .clone()
    .json()
    .catch(() => null);
  if (!body || typeof body !== "object" || !("error" in body) || "code" in body)
    return;
  const headers = new Headers(context.res.headers);
  headers.delete("content-length");
  context.res = new Response(
    JSON.stringify({ ...body, code: errorCodeForStatus(context.res.status) }),
    { status: context.res.status, headers },
  );
};
