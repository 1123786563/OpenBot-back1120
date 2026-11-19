import { createRoot } from "react-dom/client";
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import "@/styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing browser test root");
createRoot(root).render(
  <main>
    <button type="button">Before messages</button>
    <MessageScrollerProvider>
      <MessageScroller>
        <MessageScrollerViewport tabIndex={0}>
          <MessageScrollerContent>One short message.</MessageScrollerContent>
        </MessageScrollerViewport>
      </MessageScroller>
    </MessageScrollerProvider>
    <button type="button">After messages</button>
  </main>,
);
