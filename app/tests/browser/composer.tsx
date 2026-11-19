import {
  AttachmentStrip,
  type StagedFile,
  type StagedImage,
} from "@/components/channels/composer/attachment-strip";
import {
  Composer,
  type DroppedAttachments,
} from "@/components/channels/composer/composer";
import type { ComposerDraft } from "@/components/channels/composer/draft";
import { RejectedFiles } from "@/components/channels/composer/rejected-files";
import { ConversationView } from "@/components/channels/conversation-view";
import "@/styles.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { refreshNotificationPermission } from "@/lib/notifications/permission";

const parameters = new URLSearchParams(location.search);
const channelId = parameters.get("channel") ?? undefined;

function submittedAttachmentIds(drafts: ComposerDraft[]) {
  return JSON.stringify(
    drafts.map((draft) =>
      draft.attachments.map((file) => file.metadata?.attachmentId),
    ),
  );
}

function ComposerFixture() {
  const compact = parameters.get("layout") === "compact";
  const [connected, setConnected] = useState(!compact);
  return (
    <>
      {compact && (
        <button type="button" onClick={() => setConnected(true)}>
          Set conversation
        </button>
      )}
      <Composer
        channelId={connected ? channelId : undefined}
        compact={compact}
        onSubmit={() => undefined}
      />
    </>
  );
}

function RejectedFilesFixture() {
  const [rejected, setRejected] = useState([
    { id: "large", name: "screenshot.png", reason: "File is too large" },
    {
      id: "unsupported",
      name: "screenshot.png",
      reason: "Unsupported file type",
    },
  ]);
  return (
    <>
      <button
        type="button"
        onClick={() => setRejected((files) => files.slice(1))}
      >
        Remove first refusal
      </button>
      <RejectedFiles rejected={rejected} onDismiss={() => setRejected([])} />
    </>
  );
}

function SendingFixture({ pending }: { pending: boolean }) {
  const [completion] = useState(() => Promise.withResolvers<void>());
  const [sent, setSent] = useState<ComposerDraft[]>([]);
  const [queued, setQueued] = useState<ComposerDraft[]>([]);
  return (
    <>
      <button type="button" onClick={() => completion.resolve()}>
        Finish send
      </button>
      <button
        type="button"
        onClick={() => completion.reject(new Error("The run did not start"))}
      >
        Fail send
      </button>
      <output aria-label="Sent drafts">{submittedAttachmentIds(sent)}</output>
      <output aria-label="Queued drafts">
        {submittedAttachmentIds(queued)}
      </output>
      <Composer
        channelId={channelId}
        compact
        pending={pending}
        onQueue={(draft) => setQueued((drafts) => [...drafts, draft])}
        onSubmit={async (draft) => {
          setSent((drafts) => [...drafts, draft]);
          await completion.promise;
        }}
      />
    </>
  );
}

function ConversationFixture() {
  const [disabled, setDisabled] = useState(false);
  const [sent, setSent] = useState<ComposerDraft[]>([]);
  return (
    <>
      <button type="button" onClick={() => setDisabled(true)}>
        Finish turn and disable conversation
      </button>
      <output aria-label="Sent drafts">{submittedAttachmentIds(sent)}</output>
      <ConversationView
        messages={[]}
        channelId={channelId}
        onSubmit={(draft) => setSent((drafts) => [...drafts, draft])}
        pending={!disabled}
        disabled={disabled}
        queueWhileBusy
      />
    </>
  );
}

function AttachmentStripFixture() {
  const [files, setFiles] = useState<StagedFile[]>([]);
  const [images, setImages] = useState<StagedImage[]>([]);
  return (
    <>
      <button
        type="button"
        onClick={() =>
          setFiles([
            { id: "notes", name: "notes.txt", size: 2048, loading: false },
            {
              id: "long",
              name: "long.txt",
              size: 125_000,
              loading: false,
              mayTruncate: true,
            },
          ])
        }
      >
        Add text files
      </button>
      <button
        type="button"
        onClick={() =>
          setImages([{ id: "named", url: "", alt: "A cat", loading: true }])
        }
      >
        Add a named image
      </button>
      <button
        type="button"
        onClick={() => setImages([{ id: "unnamed", url: "", loading: true }])}
      >
        Add an unnamed image
      </button>
      <AttachmentStrip
        files={files}
        images={images}
        onRemove={(id) => {
          setFiles((files) => files.filter((file) => file.id !== id));
          setImages((images) => images.filter((image) => image.id !== id));
        }}
      />
    </>
  );
}

const invoice = {
  id: "invoice",
  filename: "invoice.pdf",
  source: { type: "url", value: "/invoice.pdf" },
  status: "ready",
  type: "image",
} satisfies DroppedAttachments["attachments"][number];

const receipt = { ...invoice, id: "receipt", filename: "receipt.png" };
const unnamed = {
  id: "unnamed",
  source: invoice.source,
  status: invoice.status,
  type: invoice.type,
};

function DroppedAttachmentsFixture() {
  const [revision, setRevision] = useState(0);
  const [dropped, setDropped] = useState<DroppedAttachments>({
    cause: "merged-over-cap",
    attachments: [],
  });
  return (
    <>
      <button type="button" onClick={() => setRevision((value) => value + 1)}>
        Refresh composer
      </button>
      <output aria-label="Composer revision">{revision}</output>
      <button
        type="button"
        onClick={() =>
          setDropped({
            cause: "merged-over-cap",
            attachments: [invoice, receipt],
          })
        }
      >
        Report merged files
      </button>
      <button
        type="button"
        onClick={() =>
          setDropped({
            cause: "queued-message-removed",
            attachments: [invoice],
          })
        }
      >
        Report removed file
      </button>
      <button
        type="button"
        onClick={() =>
          setDropped({ cause: "merged-over-cap", attachments: [unnamed] })
        }
      >
        Report unnamed file
      </button>
      <Composer
        compact
        channelId={channelId}
        className={`fixture-revision-${revision}`}
        droppedAttachments={dropped}
        onSubmit={() => undefined}
      />
    </>
  );
}

const starterMessage = [
  { id: "question", role: "user" as const, content: "Find three things to do" },
];

function StarterDrawerFixture() {
  const [asking, setAsking] = useState(parameters.has("question"));
  return (
    <main className="h-screen">
      <ConversationView
        messages={starterMessage}
        onSubmit={() => {}}
        attached={
          asking ? (
            <section
              aria-label="Personal Assistant is waiting on your answer"
              className="space-y-2 p-4"
            >
              <p>Which city should I look in?</p>
              <button type="button" onClick={() => setAsking(false)}>
                Send answer
              </button>
            </section>
          ) : undefined
        }
        starterSuggestions={
          <section aria-label="Starter tasks">
            <button type="button">Find weekend plans</button>
          </section>
        }
      />
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("The browser fixture needs a root");
const run = parameters.get("run");
if (parameters.has("starter-drawer")) refreshNotificationPermission();
createRoot(root).render(
  parameters.has("starter-drawer") ? (
    <StarterDrawerFixture />
  ) : parameters.has("rejections") ? (
    <RejectedFilesFixture />
  ) : parameters.has("strip") ? (
    <AttachmentStripFixture />
  ) : parameters.has("dropped") ? (
    <DroppedAttachmentsFixture />
  ) : parameters.has("conversation") ? (
    <ConversationFixture />
  ) : run === "send" || run === "queue" ? (
    <SendingFixture pending={run === "queue"} />
  ) : (
    <ComposerFixture />
  ),
);
