export const catalogueNotion = {
  key: "notion",
  title: "Notion",
  vendor: "Notion",
  summary: "Pages and databases.",
  docsUrl: "",
  auth: "user-oauth",
  perInstance: false,
};

export const notionServer = {
  id: "notion",
  title: "Notion",
  vendor: "Notion",
  url: "https://mcp.notion.com/mcp",
  summary: "Pages and databases.",
  docsUrl: "",
  provenance: "first-party",
  hasCredential: true,
  toolsRefreshedAt: null,
  lastError: null,
  addedBy: "me",
  dynamicClient: true,
  authScheme: null,
  tools: [],
  withdrawn: [],
  accountMode: null,
  sharedOnly: false,
  sharedVendorConnected: false,
  ownerGrants: "any",
  ownerGrantsChosen: null,
};
export const exaServer = {
  ...notionServer,
  id: "composio-exa",
  title: "Exa",
  vendor: "Composio",
  url: "composio://exa",
  summary: "",
  provenance: "composio",
  hasCredential: false,
  dynamicClient: false,
  authScheme: "API_KEY",
  accountMode: "personal",
};
function gmailTool(
  name: string,
  effect: "read" | "write",
  description: string,
) {
  const grantedTo: string[] = [];
  return {
    serverId: "composio-gmail",
    name,
    ref: `composio-gmail/${name}`,
    description,
    inputSchema: {},
    effect,
    destructive: false,
    grantedTo,
  };
}
export const gmailServer = {
  ...notionServer,
  id: "composio-gmail",
  title: "Gmail",
  vendor: "Composio",
  url: "composio://gmail",
  summary: "",
  provenance: "composio",
  hasCredential: false,
  dynamicClient: false,
  authScheme: "OAUTH2",
  accountMode: "personal",
  tools: [
    gmailTool(
      "GMAIL_ADD_LABEL_TO_EMAIL",
      "write",
      "Adds and/or removes specified Gmail labels for a message; ensure `message_id` and all `label_ids` are valid (use 'listLabels' for custom label IDs).",
    ),
    gmailTool(
      "GMAIL_GET_DRAFT",
      "read",
      "Retrieves a single Gmail draft by its ID. Use this to fetch and inspect draft content before sending via GMAIL_SEND_DRAFT. The format parameter controls the level of detail returned.",
    ),
    gmailTool(
      "GMAIL_GET_PROFILE",
      "read",
      "Retrieves Gmail profile information (email address, aggregate messagesTotal/threadsTotal, historyId) for a user. messagesTotal counts individual emails; threadsTotal counts conversations.",
    ),
    gmailTool(
      "GMAIL_LIST_MESSAGES",
      "read",
      "DEPRECATED: Use GMAIL_FETCH_EMAILS instead. Lists the messages in the user's mailbox.",
    ),
    gmailTool(
      "GMAIL_SEND_EMAIL",
      "write",
      "Sends an email immediately through Gmail to specified To, Cc, or Bcc recipients, with a subject or body and optional attachments. Supports plain text or HTML and may append the configured Gmail signature; attachments are limited to 20 MiB in total before encoding.",
    ),
  ],
};
export const gmailToolsForModels = {
  ...gmailServer,
  tools: [
    gmailTool(
      "GMAIL_CREATE_FILTER",
      "write",
      "Tool to create a new Gmail filter with specified criteria and actions. Use when the user wants to automatically organize incoming messages based on sender, subject, size, or other criteria. Note: you can only create a maximum of 1,000 filters per account.",
    ),
    gmailTool(
      "GMAIL_DELETE_FILTER",
      "write",
      "Tool to permanently delete a Gmail filter by its ID. Use when you need to remove an existing email filtering rule.",
    ),
    gmailTool(
      "GMAIL_DELETE_THREAD",
      "write",
      "Tool to immediately and permanently delete a specified thread and all its messages. This operation cannot be undone. Use threads.trash instead for reversible deletion.",
    ),
    gmailTool(
      "GMAIL_DELETE_LABEL",
      "write",
      "Permanently DELETES a user-created Gmail label from the account (not from a message). WARNING: This action DELETES the label definition itself, removing it from all messages. System labels (INBOX, SENT, UNREAD, etc.) cannot be deleted. To add/remove labels from specific messages, use GMAIL_ADD_LABEL_TO_EMAIL action instead.",
    ),
    gmailTool(
      "GMAIL_BATCH_DELETE_MESSAGES",
      "write",
      "Permanently deletes multiple Gmail messages by ID, bypassing Trash. A successful request does not confirm individual messages existed or were deleted.",
    ),
    gmailTool(
      "GMAIL_INSERT_MESSAGE",
      "write",
      "Tool to insert a message into the user's mailbox similar to IMAP APPEND. Use when you need to add an email directly to a mailbox bypassing most scanning and classification. This does not send a message.",
    ),
  ],
};
export const gmailNamedLikeIds = {
  ...gmailServer,
  tools: [
    gmailTool(
      "GMAIL_WHO_AM_I",
      "read",
      "Return the identity (email, name) of the connected Gmail account.",
    ),
    gmailTool(
      "GMAIL_UPDATE_IMAP_SETTINGS",
      "write",
      "Tool to update IMAP settings for a Gmail account. Use when you need to modify IMAP configuration such as enabling/disabling IMAP, setting auto-expunge behavior, or configuring folder size limits.",
    ),
    gmailTool(
      "GMAIL_UPDATE_POP_SETTINGS",
      "write",
      "Tool to update POP settings for a Gmail account. Use when you need to configure POP access window or message disposition behavior.",
    ),
    gmailTool(
      "GMAIL_SETTINGS_GET_IMAP",
      "read",
      "Retrieves the IMAP settings for a Gmail user account, including whether IMAP is enabled, auto-expunge behavior, expunge behavior, and maximum folder size.",
    ),
    gmailTool(
      "GMAIL_SETTINGS_GET_POP",
      "read",
      "Tool to retrieve POP settings for a Gmail account. Use when you need to check the current POP configuration including access window and message disposition.",
    ),
    gmailTool(
      "GMAIL_SETTINGS_SEND_AS_GET",
      "read",
      "Tool to retrieve a specific send-as alias configuration for a Gmail user. Use when you need to get details about a send-as email address including display name, signature, SMTP settings, and verification status.",
    ),
    gmailTool(
      "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
      "read",
      "Fetches a Gmail message by its message ID in the requested format and returns formatted message details. Available fields depend on the format.",
    ),
    gmailTool(
      "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
      "read",
      "Retrieves messages from an accessible Gmail thread by thread ID, returning thread details and a messages array.",
    ),
    gmailTool(
      "GMAIL_LIST_CSE_IDENTITIES",
      "read",
      "Lists a page of client-side encrypted identities and their key-pair associations. A response indicating that CSE is not enabled is returned as an empty list.",
    ),
    gmailTool(
      "GMAIL_LIST_CSE_KEYPAIRS",
      "read",
      "Lists a page of client-side encryption key pairs, including public keys and enablement states.",
    ),
    gmailTool(
      "GMAIL_STOP_WATCH",
      "write",
      "Tool to stop receiving push notifications for a Gmail mailbox. Use when you need to disable watch notifications previously set up via the watch endpoint.",
    ),
    gmailTool(
      "GMAIL_UNTRASH_MESSAGE",
      "write",
      "Tool to remove a message from trash in Gmail. Use when you need to restore a previously trashed email message.",
    ),
    gmailTool(
      "GMAIL_UPDATE_CONTACT",
      "write",
      "Replace selected fields on an existing saved Google contact.",
    ),
  ],
};
