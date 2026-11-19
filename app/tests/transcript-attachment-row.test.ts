import { expect, test } from "bun:test";
import {
  sameAttachmentRow,
  TranscriptAttachments,
} from "@/components/channels/chat-transcript";
import { attachmentUrl } from "@/lib/channels/attachments";

const ONE_FILE = [
  {
    id: "user-1:0",
    attachmentId: "att-image",
    url: attachmentUrl("att-image"),
    filename: "shot.png",
    modality: "image" as const,
  },
];

test("a rebuilt but unchanged row of files compares equal", () => {
  // Same values, different objects, different array: what every render after the first hands over.
  const rebuilt = ONE_FILE.map((file) => ({ ...file }));

  expect(
    sameAttachmentRow({ attachments: ONE_FILE }, { attachments: rebuilt }),
  ).toBe(true);
});

test("a row that actually changed does not compare equal", () => {
  const changed = [
    { ...ONE_FILE[0], id: "user-1:1" },
    { ...ONE_FILE[0], attachmentId: "att-other" },
    { ...ONE_FILE[0], url: attachmentUrl("att-other") },
    { ...ONE_FILE[0], filename: "other.png" },
    { ...ONE_FILE[0], filename: undefined },
    { ...ONE_FILE[0], modality: "document" as const },
  ];

  for (const file of changed) {
    expect(
      sameAttachmentRow({ attachments: ONE_FILE }, { attachments: [file] }),
    ).toBe(false);
  }

  // A file added or a file taken away — both redraw.
  expect(
    sameAttachmentRow({ attachments: ONE_FILE }, { attachments: [] }),
  ).toBe(false);
  expect(
    sameAttachmentRow(
      { attachments: ONE_FILE },
      { attachments: [...ONE_FILE, ONE_FILE[0]] },
    ),
  ).toBe(false);
});

// A correct comparator only protects attachment identity if the rendered row uses it.
test("the row of tiles is memoised with that comparison", () => {
  expect(
    (TranscriptAttachments as unknown as { compare?: unknown }).compare,
  ).toBe(sameAttachmentRow);
});
