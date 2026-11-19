import type { Browser } from "@e2e-dev/web";

export async function observeLiveScreen(
  browser: Browser,
  computerId: string,
  holdReconnect = false,
) {
  await browser.addInitScript(
    ({ computerId, holdReconnect }) => {
      const requests: string[] = [];
      const keys: unknown[] = [];
      const keyboardMessages: unknown[] = [];
      const messages: unknown[] = [];
      let current: ScreenSocket | undefined;
      let reconnect: ScreenSocket | undefined;
      let interrupted = false;
      Object.defineProperty(window, "teachScreenObservation", {
        value: { requests, keys },
      });
      Object.defineProperty(window, "screenKeyboardMessages", {
        value: keyboardMessages,
      });
      Object.defineProperty(window, "screenFixture", {
        value: {
          messages,
          isOpen: () => current?.readyState === Socket.OPEN,
          receive(message: object) {
            if (!current?.onmessage || current.readyState !== Socket.OPEN)
              throw new Error("No open screen to receive the message");
            current.onmessage({ data: JSON.stringify(message) });
          },
          disconnect() {
            if (!current) throw new Error("No live screen to disconnect");
            interrupted = true;
            current.close();
            current.onclose?.();
          },
          resume() {
            if (!reconnect) throw new Error("No pending screen reconnect");
            reconnect.open();
            reconnect = undefined;
            interrupted = false;
          },
          frame(color: string, width = 4, height = 4) {
            if (!current?.onmessage || current.readyState !== Socket.OPEN)
              throw new Error("No open screen to send a frame to");
            const image = document.createElement("canvas");
            image.width = width;
            image.height = height;
            const context = image.getContext("2d");
            if (!context) throw new Error("No frame canvas context");
            context.fillStyle = color;
            context.fillRect(0, 0, width, height);
            current.onmessage({
              data: JSON.stringify({
                type: "frame",
                data: image.toDataURL("image/jpeg").split(",")[1],
                width: image.width,
                height: image.height,
              }),
            });
          },
        },
      });
      const Socket = window.WebSocket;
      class ScreenSocket {
        readyState: number = Socket.OPEN;
        onopen: (() => void) | null = null;
        onclose: (() => void) | null = null;
        onmessage: ((event: { data: string }) => void) | null = null;
        constructor(url: string) {
          current = this;
          requests.push(new URL(url).pathname);
          if (holdReconnect && interrupted) reconnect = this;
          else queueMicrotask(() => this.open());
        }
        open() {
          if (this.readyState === Socket.OPEN) this.onopen?.();
        }
        send(payload: string) {
          const data = JSON.parse(payload);
          messages.push(data);
          if (data.type === "key") keys.push([data.event, data.key]);
          if (data.type === "key" || data.type === "text")
            keyboardMessages.push(data);
        }
        close() {
          this.readyState = Socket.CLOSED;
        }
      }
      window.WebSocket = new Proxy(Socket, {
        construct(target, args) {
          const url = String(args[0]);
          const path = new URL(url, location.origin).pathname;
          if (path === `/api/computers/${computerId}/stream`)
            return new ScreenSocket(url);
          return Reflect.construct(target, args);
        },
      });
    },
    { computerId, holdReconnect },
  );
  return async (): Promise<{ requests: string[]; keys: unknown[] }> => {
    const observation = await browser.evaluate(() =>
      JSON.stringify(Reflect.get(window, "teachScreenObservation")),
    );
    return JSON.parse(observation);
  };
}
