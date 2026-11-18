import postgres from "postgres";
import { sql } from "drizzle-orm";
import type { SessionGate } from "../auth/session-gate";
import type { Database } from "../db/client";
import type { ChannelWorkWire } from "./working";

/**
 * Live channel activity, from whoever ran an agent to everybody else in the channel.
 *
 * The person who ran it already has the reply and reports it over HTTP; this is the other direction,
 * telling the channel's other members that something was said. It is an optimisation and never a
 * source of truth: the roster query stays authoritative, and a client that misses events while
 * disconnected recovers by refetching on reconnect. Nothing may be knowable only through the socket.
 *
 * Delivery goes through Postgres rather than an in-process list, because an in-process list is
 * silently wrong the moment a second server instance exists: the writer is on one and the listener
 * on the other, and the message is never delivered.
 *
 * A NOTIFY is never replayed, so an announcement made while this subscription is down is gone. The
 * client's own "refetch on reconnect" does not cover it: the socket that dropped is this server's,
 * not the browser's. `resyncAll` is the signal that closes that gap.
 */

export const CHANNEL_ACTIVITY_TOPIC = "channel_activity";

export type ChannelActivityEvent = {
  channelId: string;
  /** Who may receive it. Resolved by the writer, which already had to check membership. */
  memberIds: string[];
  lastMessage: string | null;
  lastMessageAt: string | null;
  lastMessageAgentId: string | null;
  /**
   * A Bot's reply, its first line as plain text: what a notification says when the reply lands while
   * OpenBot is out of sight. `lastMessage` runs every line into one. Only on a Bot's message.
   */
  firstLine?: string;
  /**
   * What the conversation is called now, on its own event: the sweep's summary, written seconds after
   * the activity it follows, or a rename. Null when a cleared name leaves it with no summary yet.
   */
  summary?: string | null;
  /** A person's first words, newly written, on its own event: the row's name until `summary`. */
  opening?: string;
  /** The channel is hidden from every member's roster. Absent on an ordinary activity event. */
  deleted?: true;
  /**
   * One member's pin, changed. Absent on an ordinary activity event.
   *
   * A pin lives on one membership row, so the writer names that member alone in `memberIds` and the
   * hub's delivery rule does the rest: nobody else in the channel hears a pin they did not make.
   */
  pinned?: boolean;
  /**
   * A turn started or ended in this channel. Absent on an ordinary activity event.
   *
   * Transient and message-less: it is never written to a table, only announced, so the roster can
   * show a working indicator for a headless turn — a handoff hop, a relay — that no browser
   * streams. A missed one costs at most a stuck-looking dot until the next real event, never data.
   */
  busy?: boolean;
  /**
   * Everything this channel is waiting on right now: a Bot it asked, a routine firing into it.
   * Absent on an ordinary activity event.
   *
   * The WHOLE list, never a change to it, so the newest event is the answer and a missed one is
   * corrected by the next. Read from the queue and the run history at the moment of sending, which
   * is also what the roster and the channel read return. See `working.ts`.
   */
  work?: ChannelWorkWire[];
  /**
   * When `work` was read, by the database's clock: ISO-8601 in UTC to the microsecond, fixed width
   * so two compare as strings. Present whenever `work` is. Events
   * can arrive out of order across replicas, so a browser keeps the list with the latest stamp.
   */
  workAt?: string;
  /**
   * Not a business event: the named SESSIONS have ended, so their connections lose the
   * qualification to receive anything. The hub closes the connections instead of delivering —
   * nothing here is meant to reach a browser, and it carries no payload worth reading. Published
   * by the sign-out path so every instance ends its own socket for that session, not only the
   * one that handled the POST. This is a prompt close, not the authority: every deliver still
   * asks the gate before sending, so a replica that has not heard the announcement yet cannot
   * send into a session that is already gone.
   */
  sessionRevoked?: true;
  /**
   * Which sessions the `sessionRevoked` event is about, when the publisher knew.
   *
   * Sign-out ends ONE session — the one that signed out — and the person's other devices keep
   * theirs, so the close is per session, never per person. An announcement without this field
   * comes from an older replica that named people only; its `memberIds` are then read as user
   * ids, and every connection of that person is closed, which is the only thing that publisher
   * could have meant.
   */
  revokedSessions?: { userId: string; sessionId: string }[];
};

/** "The roster you hold may be wrong." Carries no delta, because what was lost is not recoverable. */
export type ChannelResyncEvent = { resync: true };

const RESYNC_PAYLOAD = JSON.stringify({
  resync: true,
} satisfies ChannelResyncEvent);

type Send = (payload: string) => void;
/** Close one connection, not just silence it. A revoked connection must stop, not pause. */
type Close = () => void;

export type ChannelEventHub = {
  /**
   * Attach a connection for one session of one person. Returns the detach. `close` ends the
   * connection for real; a revoked session's registration is dropped by the hub, not merely
   * muted. The session id is what sign-out knows and what the gate answers for, so the
   * registration carries it from the start — revocation that had to close by person would end
   * that person's other devices' subscriptions along with the signed-out one.
   */
  register(
    userId: string,
    sessionId: string | undefined,
    send: Send,
    close?: Close,
  ): () => void;
  /**
   * Fan one event out to this instance's own connections. Asynchronous because every recipient
   * session is asked of the gate BEFORE its frame is written: a connection whose session has
   * ended — on this replica or another — receives nothing, and the read that answered ran after
   * the sign-out, so no ordering can write a frame into a session that is already gone.
   */
  deliver(event: ChannelActivityEvent): Promise<void>;
  /** Tell every connection to refetch. Everybody, because the lost events named their own members. */
  resyncAll(): void;
  /**
   * End one session's connections on this instance: the session these connections were upgraded
   * under has signed out. Their person's OTHER sessions — their other devices — are untouched:
   * revocation is per session, because that is what sign-out ends.
   */
  revokeSession(userId: string, sessionId: string | undefined): void;
  connectionCount(userId: string): number;
};

type Registration = { sessionId: string | undefined; send: Send; close: Close };

export function createChannelEventHub(
  gate?: SessionGate,
  hooks?: {
    /**
     * A session ended, on this instance or announced from another: anything else this instance
     * keeps for that session — a proxied Intelligence gateway socket, most likely — should end
     * now. Called for each named session, before the hub's own detach work, so a socket ends the
     * moment the announcement lands rather than at its next frame.
     */
    onSessionRevoked?: (userId: string, sessionId: string | undefined) => void;
  },
): ChannelEventHub {
  const connections = new Map<string, Set<Registration>>();
  const onSessionRevoked = hooks?.onSessionRevoked;

  const detachAll = (
    keys: { userId: string; sessionId?: string }[],
    closeEach: boolean,
  ) => {
    for (const { userId, sessionId } of keys) {
      const registrations = connections.get(userId);
      if (!registrations) continue;
      for (const registration of [...registrations]) {
        // A named session ends only its own connections; an unnamed key (an older replica's
        // announcement) ends every connection of that person.
        if (sessionId !== undefined && registration.sessionId !== sessionId)
          continue;
        registrations.delete(registration);
        if (closeEach) {
          try {
            registration.close();
          } catch {
            // A close that fails is a connection already going; its own close handler's detach
            // finds nothing left and does nothing.
          }
        }
        // The send of a closing connection is never called again: the registration is gone, so
        // neither `deliver` nor a revocation can reach it.
        void registration.send;
      }
      if (registrations.size === 0) connections.delete(userId);
    }
  };

  return {
    register(userId, sessionId, send, close) {
      const existing = connections.get(userId) ?? new Set();
      const registration: Registration = {
        sessionId,
        send,
        close: close ?? (() => {}),
      };
      existing.add(registration);
      connections.set(userId, existing);

      return () => {
        const remaining = connections.get(userId);
        if (!remaining) return;
        remaining.delete(registration);
        // Dropped entirely rather than left empty, so a long-lived process does not accumulate a
        // set per person who ever connected.
        if (remaining.size === 0) connections.delete(userId);
      };
    },

    async deliver(event) {
      // A revocation carries no business payload and is not delivered: it ends the named
      // sessions' connections on this instance. Whoever published it already checked the
      // session on the server side; the connection of a signed-out session loses its receiving
      // qualification here rather than at the browser's next close. An announcement without
      // session ids names people — an older replica's shape — and closes that person's every
      // connection, which is all that publisher could have meant.
      if (event.sessionRevoked) {
        const keys: { userId: string; sessionId?: string }[] =
          event.revokedSessions ??
          event.memberIds.map((userId) => ({ userId }));
        for (const { userId, sessionId } of keys)
          onSessionRevoked?.(userId, sessionId);
        detachAll(keys, true);
        return;
      }
      for (const userId of event.memberIds) {
        for (const registration of [...(connections.get(userId) ?? [])]) {
          // THE GATE IS ASKED BEFORE THE WRITE, every time, per recipient. The sessions table is
          // the shared state every replica reads, so the answer is about the session as it is
          // NOW, not as it was when the socket upgraded — a sign-out that landed between the
          // event's publication and this write is caught here, on the replica that never saw
          // the announcement too. A refused session's connection ends rather than lingers:
          // there is nothing it may receive ever again.
          if (gate && !(await gate.maySend(registration.sessionId))) {
            detachAll([{ userId, sessionId: registration.sessionId }], true);
            continue;
          }
          try {
            registration.send(JSON.stringify(event));
          } catch {
            // A connection that cannot be written to is one that is closing. Its own close handler
            // detaches it; failing here would deny the event to everybody after it in the set.
          }
        }
      }
    },

    revokeSession(userId, sessionId) {
      onSessionRevoked?.(userId, sessionId);
      detachAll([{ userId, sessionId }], true);
    },

    resyncAll() {
      for (const registrations of connections.values()) {
        for (const registration of registrations) {
          try {
            registration.send(RESYNC_PAYLOAD);
          } catch {
            // Closing, and detached by its own close handler. See `deliver`.
          }
        }
      }
    },

    connectionCount(userId) {
      return connections.get(userId)?.size ?? 0;
    },
  };
}

export type ChannelActivityListener = { stop: () => Promise<void> };

/**
 * Announce that these sessions have ended, on the same topic every instance listens to.
 *
 * The instance that handled the sign-out closes its own socket directly; this carries the same
 * fact to the others, so a socket upgraded on a replica that never saw the POST loses its
 * receiving qualification too, rather than living on until the browser happens to close it. The
 * event carries the session ids and nothing else — there is no payload, because a signed-out
 * session is owed no content, not even a reason. The close is the prompt part of revocation, not
 * the authority: a replica that misses the announcement still refuses the session at its next
 * send, because the gate reads the same table the sign-out deleted from.
 */
export async function announceSessionRevoked(
  database: Database,
  ended: { userId: string; sessionId?: string }[],
): Promise<void> {
  if (ended.length === 0) return;
  const event: ChannelActivityEvent = {
    channelId: "",
    lastMessage: null,
    lastMessageAt: null,
    lastMessageAgentId: null,
    memberIds: ended.map(({ userId }) => userId),
    sessionRevoked: true,
    revokedSessions: ended.flatMap(({ userId, sessionId }) =>
      sessionId ? [{ userId, sessionId }] : [],
    ),
  };
  await database.execute(
    sql`select pg_notify(${CHANNEL_ACTIVITY_TOPIC}, ${JSON.stringify(event)})`,
  );
}

/**
 * Listen for activity announced by any instance, including this one.
 *
 * On its own connection, because `LISTEN` holds one for the life of the subscription: taken from the
 * pool, it would be a connection the rest of the server never gets back.
 */
export async function startChannelActivityListener(
  databaseUrl: string,
  hub: ChannelEventHub,
): Promise<ChannelActivityListener> {
  const connection = postgres(databaseUrl, { max: 1 });

  /*
   * `onlisten` fires on every establish, reconnects included — the same hook `policy-listener.ts`
   * uses to re-read its row. There is no row to re-read here, so the browsers are told to refetch
   * instead.
   *
   * The first establish is skipped so the message means one thing. It has no earlier subscription
   * behind it, so nothing can have been missed, and a resync there would say "possibly a gap" — not
   * something a client can act on differently.
   */
  let subscribed = false;
  const resync = () => {
    if (!subscribed) {
      subscribed = true;
      return;
    }
    hub.resyncAll();
  };

  await connection.listen(
    CHANNEL_ACTIVITY_TOPIC,
    (payload) => {
      try {
        // Delivering asks the gate before every recipient's frame, so it is awaited as far as
        // error handling goes and no further: one announcement's refusals must not serialize
        // the next announcement, and a rejected delivery is logged, not propagated — a failed
        // revocation check is not a reason to tear down the subscription.
        void hub
          .deliver(JSON.parse(payload) as ChannelActivityEvent)
          .catch(() => {});
      } catch {
        // A payload we cannot read is not a reason to tear down the subscription: the roster query
        // is still correct, and the next refetch shows whatever this event would have.
      }
    },
    resync,
  );

  return {
    stop: async () => {
      await connection.end();
    },
  };
}
