/**
 * The Intelligence gateway's client socket, served from OpenBot's own address.
 *
 * The browser opens the gateway itself: the runtime hands it the socket address in `/info` and with
 * every run, and the conversation streams over it. That is fine where the gateway has an address of
 * its own that the browser can reach, as managed Intelligence does. It is not fine where Intelligence
 * runs inside the cluster beside OpenBot and the only way in is OpenBot's address: a `kubectl
 * port-forward` to the server, or one Ingress host. There the browser would be told a Service name it
 * cannot resolve, every conversation would sit waiting for a socket that never opens, and nothing on
 * the screen would say why.
 *
 * With `INTELLIGENCE_GATEWAY_PROXY=on` the browser is told {@link INTELLIGENCE_CLIENT_SOCKET_PATH}
 * instead, on OpenBot, and this carries each socket on to the gateway's `/client` unchanged. The
 * gateway still authorizes every connection with the join token the runtime issued, which travels in
 * the query exactly as it would have; nothing here reads it. What this adds is OpenBot's own front
 * door in front of it (the cross-site and single-user checks every socket gets, and a session).
 *
 * Phoenix, which the browser's client is, appends `/websocket` to the address it is given, and a
 * path-only address is resolved against the page, so `ws://` or `wss://` and the port come from
 * wherever the person reached OpenBot.
 *
 * The Recorder is the one thing handed that address that is not on the page: its capture pass names
 * the socket it streams a recording on. It has no page to resolve a path against, and the runtime
 * refuses to hand a path out as that pass at all. So with no public URL, as over a port-forward, the
 * pass is answered inside {@link createCapturePassOrigin}, which makes the address whole on OpenBot's
 * origin as the Recorder reached it.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { MiddlewareHandler } from "hono";
import type { SessionGate } from "./auth/session-gate";
import type { DeploymentConfig } from "./config";
import { isTrajectoryConnectPath } from "./recorder/trajectory-gate";
import { callerOf, ownOriginOnThisMachine } from "./request-trust";

/** Where the browser is told the gateway's client socket is, when this proxy is on. */
export const INTELLIGENCE_CLIENT_SOCKET_PATH = "/api/intelligence/client";

/** The one path that socket arrives on: Phoenix's websocket transport under the address above. */
const PROXIED_PATH = `${INTELLIGENCE_CLIENT_SOCKET_PATH}/websocket`;

export function isIntelligenceClientSocketPath(pathname: string): boolean {
  return pathname === PROXIED_PATH;
}

/**
 * The address the browser is given: on the public URL when there is one, so it is a whole URL that
 * anything holding it can open, and otherwise a path that the browser resolves against the page.
 */
export function proxiedClientSocketUrl(publicUrl: string | undefined): string {
  const base = publicUrl?.trim().replace(/\/+$/, "");
  if (!base) return INTELLIGENCE_CLIENT_SOCKET_PATH;
  return `${base.replace(/^http/, "ws")}${INTELLIGENCE_CLIENT_SOCKET_PATH}`;
}

/** OpenBot's own origin while a capture pass is answered, where it is one that may be named. */
const capturePass = new AsyncLocalStorage<string>();

/**
 * In front of the runtime: answers the Recorder's capture pass (`trajectory/connect`) knowing
 * OpenBot's own origin as the Recorder reached it, so the gateway address the pass names is one the
 * Recorder can open (see {@link capturePassOrigin}).
 *
 * Only the capture pass. The page is still told a path, which it resolves against itself, and that
 * stays right behind a proxy that ends TLS, where the connection here is `http://` and the page is
 * `https://`. The origin is the one `request-trust.ts` will vouch for (`ownOriginOnThisMachine`): a
 * caller on this machine, at one of its own loopback names. Any other request is answered as before.
 */
export function createCapturePassOrigin(
  config: Pick<DeploymentConfig, "singleUser" | "singleUserAccess">,
  basePath = "/api/copilotkit",
): MiddlewareHandler {
  return async (context, next) => {
    // The raw path, which is the one the runtime routes on.
    if (!isTrajectoryConnectPath(new URL(context.req.url).pathname, basePath))
      return next();
    const origin = ownOriginOnThisMachine(
      context.req.raw,
      callerOf(context),
      config,
    );
    if (!origin) return next();
    await capturePass.run(origin, next);
  };
}

/**
 * OpenBot's own origin, while a capture pass that may name it is being answered, and otherwise
 * undefined. The platform client makes a path-only gateway address whole on it (toolkit
 * `IntelligenceKnowingANewThread`).
 */
export function capturePassOrigin(): string | undefined {
  return capturePass.getStore();
}

/**
 * The gateway socket a browser's connection is carried to: the gateway's own `/client/websocket`,
 * with the browser's query (its protocol version and join token) as it came.
 *
 * `gatewayWsUrl` is the address this server already reaches the gateway at, written any of the ways
 * the runtime accepts: the bare origin, or ending in `/client`, `/runner` or `/channels`.
 */
export function gatewayClientSocketUrl(
  gatewayWsUrl: string,
  requestUrl: URL,
): string {
  let base = gatewayWsUrl.trim().replace(/\/+$/, "");
  for (const socket of ["/client", "/runner", "/channels"]) {
    if (base.endsWith(socket)) {
      base = base.slice(0, -socket.length);
      break;
    }
  }
  return `${base.replace(/^http/, "ws")}/client/websocket${requestUrl.search}`;
}

/** What a proxied gateway socket carries in Bun's per-socket data. */
export type GatewaySocketData = {
  gatewayUpstream: string;
  inward?: WebSocket;
  /** Frames the browser sent before the gateway's side was open, in order. */
  pending: (string | Uint8Array)[];
  /**
   * Who this socket was upgraded for, read from the session the upgrade itself authenticated. The
   * socket outlives the request that opened it, so the identity travels ON the socket: every frame
   * it would carry is asked against the session as it is now, not as it was at upgrade time. A
   * sign-out mid-conversation therefore ends the socket, here and on every replica, instead of
   * leaving a signed-out browser subscribed to a conversation it may no longer hear.
   */
  sessionId?: string;
  userId?: string;
  /** Undoes the revocation registration; set when one was made. */
  detachFromRevocation?: () => void;
  /**
   * The outward frame pipeline (gateway → browser), serialized so the per-frame session check can
   * never reorder what it carries.
   */
  forward?: Promise<void>;
  /**
   * The same chain for the inward direction (browser → gateway), independent of the outward one:
   * a browser's join must never wait behind a gateway tick.
   */
  inwardBound?: Promise<void>;
  /** Set once the session was revoked or the socket ended: nothing forwards after it. */
  ended?: boolean;
};

/**
 * Where the proxied sockets live, so a revocation announced anywhere closes them everywhere.
 *
 * The gate read before each frame is the authority; this registry is the prompt part, exactly as
 * the channel hub is for its own sockets. The sign-out that ends a session closes that session's
 * proxied sockets on the replica that handled the POST directly, and the announcement that rides
 * the activity topic calls {@link GatewaySocketRegistry.revokeSession} on every other replica — so
 * a conversation socket upgraded on a replica that never saw the sign-out still closes within the
 * announcement, not at its next frame.
 */
export type GatewaySocketRegistry = {
  /** Remember a socket for a session of a person. Returns the detach. */
  track(
    userId: string,
    sessionId: string | undefined,
    close: () => void,
  ): () => void;
  /** End one session's sockets; an unnamed session ends every socket of the person. */
  revokeSession(userId: string, sessionId: string | undefined): void;
};

export function createGatewaySocketRegistry(): GatewaySocketRegistry {
  const tracked = new Set<{
    userId: string;
    sessionId: string | undefined;
    close: () => void;
  }>();
  return {
    track(userId, sessionId, close) {
      const entry = { userId, sessionId, close };
      tracked.add(entry);
      return () => {
        tracked.delete(entry);
      };
    },
    revokeSession(userId, sessionId) {
      for (const entry of [...tracked]) {
        if (entry.userId !== userId) continue;
        if (sessionId !== undefined && entry.sessionId !== sessionId) continue;
        tracked.delete(entry);
        try {
          entry.close();
        } catch {
          // A close that fails is a socket already going; its own close path detaches the rest.
        }
      }
    },
  };
}

/** What the frame paths need to keep a proxied socket behind its session. */
export type GatewayRevocation = {
  gate: SessionGate;
  registry?: GatewaySocketRegistry;
};

/**
 * End a proxied socket for good, from both sides: its session can receive nothing further, so it
 * sends nothing further and is closed rather than muted — there is nothing it may resume with.
 */
function endSocket(ws: Outward, code: number, reason: string): void {
  ws.data.ended = true;
  ws.data.pending.length = 0;
  ws.data.detachFromRevocation?.();
  ws.data.detachFromRevocation = undefined;
  closeWith(ws, code, reason);
  const inward = ws.data.inward;
  if (
    inward &&
    inward.readyState !== WebSocket.CLOSING &&
    inward.readyState !== WebSocket.CLOSED
  )
    closeWith(inward, 1000, "");
}

/** The outward socket, as much of Bun's ServerWebSocket as this uses. */
type Outward = {
  data: GatewaySocketData;
  send(message: string | Uint8Array): unknown;
  close(code?: number, reason?: string): void;
};

/**
 * A close code that may be sent on a socket. 1005, 1006 and 1015 describe a close that had no frame
 * and are never put in one; anything outside the ranges the protocol assigns is not a code at all.
 */
function sendableCloseCode(code: number | undefined): number | undefined {
  if (code === undefined) return undefined;
  if (code === 1005 || code === 1006 || code === 1015) return undefined;
  if (
    code === 1000 ||
    (code >= 1001 && code <= 1014) ||
    (code >= 3000 && code <= 4999)
  )
    return code;
  return undefined;
}

function closeWith(
  socket: { close(code?: number, reason?: string): void },
  code: number | undefined,
  reason: string | undefined,
) {
  const sendable = sendableCloseCode(code);
  try {
    if (sendable === undefined) socket.close();
    else socket.close(sendable, reason ?? "");
  } catch {
    // Already closing; the close the other side sees is the one already under way.
  }
}

/**
 * Open the gateway's side of a socket the browser has just opened.
 *
 * Every frame is carried as it came, text as text and binary as binary, because the Phoenix
 * serializer uses both. Unlike the live screen, nothing is dropped: the first thing a Phoenix client
 * sends is its channel join, the moment its own socket opens, which is before this one is, and a
 * dropped join is a conversation that waits ten seconds for a retry with nothing on the screen.
 */
export function openGatewaySocket(
  ws: Outward,
  revocation?: GatewayRevocation,
): void {
  const { sessionId, userId } = ws.data;
  if (revocation?.registry && userId) {
    ws.data.detachFromRevocation = revocation.registry.track(
      userId,
      sessionId,
      () => endSocket(ws, 1008, "Your session has ended."),
    );
  }
  /*
   * One frame, after its session has answered for it. The gate read is the authority — the sessions
   * table is the shared state every replica reads, so the answer is about the session as it is NOW;
   * the frames queue behind the read and go in order, which is why each direction is a serialized
   * chain rather than one read per fire-and-forget callback: a conversation whose frames arrive
   * reordered is a broken protocol, and a refused one is ended, not skipped. The directions are
   * independent chains — a browser's join must never wait behind a gateway tick — but within one
   * direction order is exactly arrival order.
   */
  const carryOutward = async (frame: string | Uint8Array): Promise<void> => {
    if (revocation && !(await revocation.gate.maySend(sessionId))) {
      endSocket(ws, 1008, "Your session has ended.");
      return;
    }
    try {
      ws.send(frame);
    } catch {
      // The browser's side is going; ending the gateway's side with it.
      ws.data.inward?.close();
    }
  };
  const carryInward = async (frame: string | Uint8Array): Promise<void> => {
    if (revocation && !(await revocation.gate.maySend(sessionId))) {
      endSocket(ws, 1008, "Your session has ended.");
      return;
    }
    const inward = ws.data.inward;
    if (inward?.readyState === WebSocket.OPEN) {
      inward.send(frame);
      return;
    }
    // Still connecting: held for the open, which will drain this queue through this same chain,
    // so the held frame keeps its place behind the ones before it. A frame is pushed here only
    // while the socket is CONNECTING — one synchronous check — so it is always drained by the
    // open that follows it.
    if (!inward || inward.readyState === WebSocket.CONNECTING)
      ws.data.pending.push(frame);
  };
  const outward = (frame: string | Uint8Array): void => {
    if (ws.data.ended) return;
    ws.data.forward = (ws.data.forward ?? Promise.resolve())
      .then(() => carryOutward(frame))
      .catch(() => {
        // One refused frame does not serialize the next: the chain survives, the socket above
        // already saw the refusal that ended it.
      });
  };
  const inwardBound = (frame: string | Uint8Array): void => {
    if (ws.data.ended) return;
    ws.data.inwardBound = (ws.data.inwardBound ?? Promise.resolve())
      .then(() => carryInward(frame))
      .catch(() => {});
  };

  const inward = new WebSocket(ws.data.gatewayUpstream);
  inward.binaryType = "arraybuffer";
  ws.data.inward = inward;
  inward.onopen = () => {
    // Held frames are the BROWSER's own first words, queued while the gateway's side opened: they
    // go INWARD now, asked of the gate in order like everything else this session speaks.
    for (const frame of ws.data.pending.splice(0)) inwardBound(frame);
  };
  inward.onmessage = (event) => {
    outward(
      typeof event.data === "string"
        ? event.data
        : new Uint8Array(event.data as ArrayBuffer),
    );
  };
  inward.onclose = (event) => {
    ws.data.ended = true;
    ws.data.detachFromRevocation?.();
    closeWith(ws, event.code, event.reason);
  };
  inward.onerror = () =>
    closeWith(ws, 1011, "The backend could not be reached.");
}

/**
 * A frame from the browser: on to the gateway, or held until the gateway's side is open.
 *
 * The same session rule as the inward direction, because a signed-out session has lost more than
 * its right to HEAR: it has lost its standing to speak into the conversation too. Its frames are
 * asked of the gate in order on the same serialized pipeline, and a refused one ends the socket.
 */
export function gatewaySocketMessage(
  ws: Outward,
  message: string | Uint8Array,
  revocation?: GatewayRevocation,
): void {
  /*
   * The same session rule as the outward direction, because a signed-out session has lost more
   * than its right to HEAR: it has lost its standing to speak into the conversation too. The frame
   * is asked of the gate on the inward chain, in order, and a refused one ends the socket. Without
   * a revocation to answer to — single-user mode — the frame goes as it came.
   */
  if (!revocation) {
    const inward = ws.data.inward;
    if (inward?.readyState === WebSocket.OPEN) {
      inward.send(message);
      return;
    }
    if (!inward || inward.readyState === WebSocket.CONNECTING) {
      ws.data.pending.push(message);
    }
    return;
  }
  if (ws.data.ended) return;
  const { sessionId } = ws.data;
  ws.data.inwardBound = (ws.data.inwardBound ?? Promise.resolve())
    .then(async () => {
      if (!(await revocation.gate.maySend(sessionId))) {
        endSocket(ws, 1008, "Your session has ended.");
        return;
      }
      const inward = ws.data.inward;
      if (inward?.readyState === WebSocket.OPEN) inward.send(message);
      else if (!inward || inward.readyState === WebSocket.CONNECTING)
        ws.data.pending.push(message);
    })
    .catch(() => {});
}

/** The browser went away: so does the gateway's side, with the same code where it is one to send. */
export function closeGatewaySocket(
  ws: Outward,
  code: number | undefined,
  reason: string | undefined,
): void {
  ws.data.ended = true;
  ws.data.pending.length = 0;
  ws.data.detachFromRevocation?.();
  ws.data.detachFromRevocation = undefined;
  const inward = ws.data.inward;
  if (!inward) return;
  if (
    inward.readyState === WebSocket.CLOSING ||
    inward.readyState === WebSocket.CLOSED
  )
    return;
  closeWith(inward, code, reason);
}
