import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { sessions } from "../db/schema";

/**
 * Whether one session may still be sent anything, asked BEFORE EVERY SEND.
 *
 * A subscription that outlives its request — a channel WebSocket, a CopilotKit response stream —
 * was authenticated once, at its beginning. Sign-out ends the session row, and nothing about the
 * open socket or the open stream notices by itself: whatever writes to it next speaks for a
 * session that no longer exists, on this replica or any other.
 *
 * The SHARED state is the `sessions` table itself. Sign-out deletes the row, on whichever replica
 * handled the POST; every replica that asks the database before sending sees the same answer, so
 * no announcement, no propagation delay and no lost notification can leave a window: a frame is
 * sent only after a read that ran after the delete. The LOCAL set is an accelerator, not the
 * truth — it makes a session this replica has already seen revoked free to refuse, and remembers
 * a read that answered "gone" so the same session is not looked up again.
 *
 * Per-send database reads are the price of that ordering, and they are paid gladly: the writes
 * gated here are an event fan-out per message and a stream chunk per model event, not per byte of
 * a hot loop, and one indexed primary-key read per send is noise beside the vendor round trips
 * the same streams already wait on. A cached "alive" verdict would buy those reads back at the
 * cost of exactly the window this gate exists to close.
 *
 * `maySend(undefined)` is TRUE, deliberately. No session id means the deployment has no sessions
 * to revoke — single-user mode has no sign-out — and there is nothing to refuse against.
 */
export type SessionGate = {
  /** Record that this session has ended, on this replica, before any read can say so. */
  revoke(sessionId: string): void;
  /** Whether the named session still exists and may receive business data. */
  maySend(sessionId: string | undefined): Promise<boolean>;
};

export function createSessionGate(database: Database): SessionGate {
  const revoked = new Set<string>();
  return {
    revoke(sessionId) {
      revoked.add(sessionId);
    },
    async maySend(sessionId) {
      if (!sessionId) return true;
      if (revoked.has(sessionId)) return false;
      const [row] = await database
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      if (!row) {
        // The read is the authority, and it has spoken: remember it so the same session costs
        // no further reads, here or in any later frame.
        revoked.add(sessionId);
        return false;
      }
      return true;
    },
  };
}

/**
 * A response whose streaming body stops rather than outlive the session it was started under.
 *
 * A streaming response was authorized once, at its first byte. The chunks after it — a model
 * turn's tokens, most of what a signed-in person streams — belong to the session, and a session
 * that ends mid-stream must not go on receiving them: the gate is consulted before EVERY chunk is
 * enqueued, and a refused one ends the stream, so the browser sees the response close rather than
 * a body that quietly stays open doing nothing.
 *
 * Finite bodies need no wrapper — they are answered in one write, inside the request that was
 * authorized. Only a body that trickles over time can outlive the session, so only one is
 * wrapped; a response without a body, or with no session on the request that asked for it
 * (single-user mode), passes through untouched.
 */
export function gateStreamingResponse(
  response: Response,
  gate: SessionGate,
  sessionId: string | undefined,
): Response {
  if (!sessionId || !response.body) return response;
  const source = response.body;
  const gated = source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      async transform(chunk, controller) {
        if (!(await gate.maySend(sessionId))) {
          // Ending the stream, not pausing it: there is nothing to resume with, because the
          // session the response was answering no longer exists.
          controller.error(new Error("SESSION_REVOKED"));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(gated, response);
}
