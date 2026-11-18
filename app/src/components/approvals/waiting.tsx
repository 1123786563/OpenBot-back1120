import { ErrorDetails } from "@/lib/i18n/errors";
import { ui, useLocale, uiNodes } from "@/lib/i18n";
import { offersStandingRule } from "@openbot/shared/standing-rule";
import { approvalDetails, approvalWords } from "@openbot/shared/tool-name";
import {
  IconDots,
  IconHandStop,
  IconMessageQuestion,
  IconX,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Fragment, type ReactNode, useState } from "react";
import { BotOrb } from "@/components/agents/bot-orb";
import { PageRows } from "@/components/layout/page-shell";
import { BoardRow } from "@/components/needs-you/board-row";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupText,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { useBotNames } from "@/lib/agents/bot-names";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  type ApprovalDecision,
  type ApprovalInboxData,
  answerPersonQuestionMutationOptions,
  approvalInboxOptions,
  decideApprovalMutationOptions,
  dismissPersonQuestionMutationOptions,
} from "@/lib/approvals";
import { relativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";

type WaitingQuestion = ApprovalInboxData["questions"][number];
type WaitingRequest = ApprovalInboxData["requests"][number];

/**
 * What waits on the person in the approval inbox, for one Bot or for all of them: the questions its
 * Bots asked, and the actions waiting on a decision. A question asked during a hand-off belongs to
 * the Bot whose conversation it is.
 */
function useWaiting(agentId: string | undefined) {
  useLocale();
  const inbox = useQuery(approvalInboxOptions());
  const ours = (botId: string) => agentId === undefined || botId === agentId;
  return {
    error: inbox.error,
    questions: (inbox.data?.questions ?? []).filter((question) =>
      ours(question.conversationBotId ?? question.botId),
    ),
    pending: (inbox.data?.requests ?? []).filter(
      (request) => request.status === "pending" && ours(request.action.botId),
    ),
  };
}

/** A question a Bot asked mid-run, answered on the row's own footer line. */
function QuestionRow({
  question,
  botName,
}: {
  question: WaitingQuestion;
  botName: string;
}) {
  useLocale();
  const [text, setText] = useState("");
  const answer = useMutation(answerPersonQuestionMutationOptions(queryClient));
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        <IconMessageQuestion />
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="line-clamp-none">
          {uiNodes("{{slot0}}asks: {{slot1}}", [botName, question.question])}
        </ItemTitle>
        {question.why ? (
          <ItemDescription className="line-clamp-none">
            {question.why}
          </ItemDescription>
        ) : null}
      </ItemContent>
      {/* In from the edge by the icon and its gap, so the answer lines up with the question. */}
      <ItemFooter className="flex-col items-start pl-11">
        <Textarea
          aria-label={ui("Your answer")}
          onChange={(event) => setText(event.target.value)}
          placeholder={ui("Your answer")}
          value={text}
        />
        <Button
          disabled={answer.isPending || !text.trim()}
          onClick={() => answer.mutate({ id: question.id, response: text })}
          size="sm"
        >
          {ui("Send answer")}
        </Button>
        {answer.error ? (
          <p role="alert" className="text-sm text-destructive">
            {<ErrorDetails error={answer.error} />}
          </p>
        ) : null}
      </ItemFooter>
    </Item>
  );
}

/**
 * What an approval would send, a labelled line each: "Text: hello". Nothing when it sends nothing
 * the title has not said already, as a click does: its ref and snapshot are handles for the model.
 */
function ApprovalDetails({
  args,
  className,
}: {
  args: unknown;
  className?: string;
}) {
  useLocale();
  const details = approvalDetails(args, ui);
  if (details.length === 0) return null;
  return (
    <dl
      aria-label={ui("What it would send")}
      className={cn(
        "max-h-52 space-y-1 overflow-auto rounded bg-muted p-3 text-xs",
        className,
      )}
    >
      {details.map((detail) => (
        <div key={detail.label}>
          <dt className="font-medium">{detail.label}</dt>
          <dd className="whitespace-pre-wrap break-words text-muted-foreground">
            {detail.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * An action waiting on a decision, decided on the row's own footer line, in from the edge by the
 * icon and its gap so the buttons line up with the text, as a task's and an item's do beside it.
 */
function RequestRow({
  request,
  botName,
}: {
  request: WaitingRequest;
  botName: string;
}) {
  useLocale();
  const decision = useMutation(decideApprovalMutationOptions(queryClient));
  const words = approvalWords(request.action, ui);
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        <IconHandStop />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="line-clamp-none">
          {uiNodes("{{slot0}}wants to {{slot1}}", [botName, words.action])}
        </ItemTitle>
        <ItemDescription className="line-clamp-none break-all">
          {words.place}
        </ItemDescription>
        {request.action.policy ? (
          <p className="text-sm">
            {request.action.policy.behaviour === "hand_off"
              ? ui("Handed to you: ")
              : ""}
            {request.action.policy.reason}
          </p>
        ) : null}
        <ApprovalDetails args={request.action.args} className="mt-1" />
      </ItemContent>
      {request.action.policy?.behaviour === "hand_off" ? (
        <ItemFooter className="flex-wrap justify-start pl-11">
          <Button
            disabled={decision.isPending}
            onClick={() =>
              decision.mutate({ id: request.id, choice: "handled" })
            }
            size="sm"
          >
            {ui("I did it myself")}
          </Button>
          <Button
            disabled={decision.isPending}
            onClick={() => decision.mutate({ id: request.id, choice: "deny" })}
            size="sm"
            variant="outline"
          >
            {ui("Don't do it")}
          </Button>
        </ItemFooter>
      ) : (
        <ItemFooter className="flex-wrap justify-start pl-11">
          <Button
            disabled={decision.isPending}
            onClick={() =>
              decision.mutate({
                id: request.id,
                choice: "allow_once",
              })
            }
            size="sm"
          >
            {ui("Allow once")}
          </Button>
          {offersStandingRule(request.action) ? (
            <>
              <Button
                disabled={decision.isPending}
                onClick={() =>
                  decision.mutate({
                    id: request.id,
                    choice: "allow_conversation",
                  })
                }
                size="sm"
                variant="outline"
              >
                {ui("Allow for this conversation")}
              </Button>
              <Button
                disabled={decision.isPending}
                onClick={() =>
                  decision.mutate({
                    id: request.id,
                    choice: "allow_always",
                  })
                }
                size="sm"
                variant="outline"
              >
                {ui("Always allow here")}
              </Button>
            </>
          ) : null}
          <Button
            disabled={decision.isPending}
            onClick={() => decision.mutate({ id: request.id, choice: "deny" })}
            size="sm"
            variant="outline"
          >
            {ui("Deny")}
          </Button>
        </ItemFooter>
      )}
      {decision.error ? (
        <p role="alert" className="basis-full pl-11 text-sm text-destructive">
          {<ErrorDetails error={decision.error} />}
        </p>
      ) : null}
    </Item>
  );
}

/**
 * The waiting questions and actions under each Bot's header on the Needs you board, questions first,
 * each with when it was asked so the header can say how long it has waited.
 */
export function useWaitingByBot(agentId: string | undefined) {
  useLocale();
  const waiting = useWaiting(agentId);
  const byBot = new Map<string, { rows: ReactNode[]; times: string[] }>();
  const add = (botId: string, row: ReactNode, at: string) => {
    const group = byBot.get(botId) ?? { rows: [], times: [] };
    group.rows.push(row);
    group.times.push(at);
    byBot.set(botId, group);
  };
  for (const question of waiting.questions)
    add(
      question.conversationBotId ?? question.botId,
      <QuestionBoardRow key={`question-${question.id}`} question={question} />,
      question.createdAt,
    );
  for (const request of waiting.pending)
    add(
      request.action.botId,
      <RequestBoardRow key={`request-${request.id}`} request={request} />,
      request.createdAt,
    );
  return { error: waiting.error, byBot };
}

/**
 * A question on the board: one line, and Answer (or a click on it) opens a dialog with the whole
 * question, why the Bot stopped, and the box to answer in. A question can run to a paragraph, and a
 * dialog gives it room without stretching the list.
 */
/**
 * A question, answered in the conversation it was asked in: Answer and the row itself open it, where
 * the question waits above the composer. A question with no conversation on record is answered in a
 * dialog instead.
 */
function QuestionBoardRow({ question }: { question: WaitingQuestion }) {
  useLocale();
  const navigate = useNavigate();
  const [answering, setAnswering] = useState(false);
  const { channelId } = question;
  const open = () =>
    channelId
      ? navigate({ to: "/channel/$channelId", params: { channelId } })
      : setAnswering(true);
  const dismiss = useMutation(
    dismissPersonQuestionMutationOptions(queryClient),
  );
  return (
    <>
      <BoardRow
        actions={
          <>
            <Button onClick={open} size="sm">
              {ui("Answer")}
            </Button>
            {/* Put it down unanswered: the Bot is not resumed, and nothing is sent to it. */}
            <Button
              aria-label={ui("Dismiss {{value0}}", {
                value0: String(question.question),
              })}
              disabled={dismiss.isPending}
              onClick={() => dismiss.mutate({ id: question.id })}
              size="icon-sm"
              variant="ghost"
            >
              <IconX />
            </Button>
          </>
        }
        detail={question.why}
        icon={<IconMessageQuestion />}
        meta={[
          dismiss.error ? (
            <span className="text-destructive" key="error" role="alert">
              {<ErrorDetails error={dismiss.error} />}
            </span>
          ) : null,
        ]}
        onSelect={open}
        title={question.question}
        waiting
      />
      <AnswerDialog
        onOpenChange={setAnswering}
        open={answering}
        question={question}
      />
    </>
  );
}

/** Whether the send shortcut is ⌘ or Ctrl, as the person's keyboard says it. */
const MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * Answering a Bot's question, laid out as a reply: who asked and when, the question itself as the
 * heading with the Bot's reason under it, and one box to answer in with Send in its corner. ⌘↵ or
 * Ctrl↵ sends; Escape or the close button puts it away with nothing sent.
 */
function AnswerDialog({
  question,
  open,
  onOpenChange,
}: {
  question: WaitingQuestion;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  useLocale();
  const [text, setText] = useState("");
  const answer = useMutation(answerPersonQuestionMutationOptions(queryClient));
  const agents = useQuery(agentListQueryOptions());
  const asker = question.conversationBotId ?? question.botId;
  const bot = agents.data?.find((agent) => agent.id === asker);
  const name = bot?.name ?? "Your Bot";
  const ready = text.trim().length > 0 && !answer.isPending;
  const send = () => {
    if (!ready) return;
    answer.mutate(
      { id: question.id, response: text },
      { onSuccess: () => onOpenChange(false) },
    );
  };
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="gap-5 sm:max-w-xl">
        <DialogHeader className="gap-3">
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            <BotOrb name={name} seed={bot?.avatarSeed || asker} size={20} />
            <span className="font-medium text-foreground">{name}</span>
            <span aria-hidden>·</span>
            <span>
              {uiNodes("asked {{slot0}}", [relativeTime(question.createdAt)])}
            </span>
          </div>
          <DialogTitle className="whitespace-pre-wrap font-medium text-base leading-snug">
            {question.question}
          </DialogTitle>
          {question.why ? (
            <DialogDescription className="whitespace-pre-wrap">
              {question.why}
            </DialogDescription>
          ) : (
            <DialogDescription className="sr-only">
              {uiNodes("{{slot0}}stopped until you answer.", [name])}
            </DialogDescription>
          )}
        </DialogHeader>
        <InputGroup>
          <InputGroupTextarea
            aria-label={ui("Your answer")}
            autoFocus
            className="min-h-28"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                send();
              }
            }}
            placeholder={ui("Reply to {{value0}}", { value0: String(name) })}
            value={text}
          />
          <InputGroupAddon align="block-end">
            {answer.error ? (
              <InputGroupText className="text-destructive text-xs" role="alert">
                {<ErrorDetails error={answer.error} />}
              </InputGroupText>
            ) : (
              <InputGroupText className="gap-1 font-normal text-xs">
                {/* Keys drawn as the Settings shortcuts are, so the glyphs sit centred on the row. */}
                {[MAC ? "⌘" : "Ctrl", "↵"].map((key) => (
                  <kbd
                    className="inline-flex h-5 min-w-5 items-center justify-center rounded-md border bg-muted px-1 font-sans text-[11px] text-muted-foreground leading-none"
                    key={key}
                  >
                    {key}
                  </kbd>
                ))}
                <span className="ml-0.5">{ui("to send")}</span>
              </InputGroupText>
            )}
            <InputGroupButton
              className="ml-auto"
              disabled={!ready}
              onClick={send}
              size="sm"
              variant="default"
            >
              {answer.isPending ? ui("Sending…") : ui("Send answer")}
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </DialogContent>
    </Dialog>
  );
}

/**
 * An action on the board: what it wants to do and where, with Deny and Allow on the right, and
 * Allow for this conversation and Always allow here in the menu. Where it acts and what it would send are always on screen, whole:
 * nobody allows something they were not shown.
 */
function RequestBoardRow({ request }: { request: WaitingRequest }) {
  useLocale();
  const decision = useMutation(decideApprovalMutationOptions(queryClient));
  const words = approvalWords(request.action, ui);
  const handOff = request.action.policy?.behaviour === "hand_off";
  const decide = (choice: ApprovalDecision) =>
    decision.mutate({ id: request.id, choice });
  const action = words.action.charAt(0).toUpperCase() + words.action.slice(1);
  return (
    <BoardRow
      actions={
        handOff ? (
          <>
            <Button
              disabled={decision.isPending}
              onClick={() => decide("deny")}
              size="sm"
              variant="outline"
            >
              {ui("Don't do it")}
            </Button>
            <Button
              disabled={decision.isPending}
              onClick={() => decide("handled")}
              size="sm"
            >
              {ui("I did it myself")}
            </Button>
          </>
        ) : (
          <>
            <Button
              disabled={decision.isPending}
              onClick={() => decide("deny")}
              size="sm"
              variant="outline"
            >
              {ui("Deny")}
            </Button>
            <Button
              disabled={decision.isPending}
              onClick={() => decide("allow_once")}
              size="sm"
            >
              {ui("Allow")}
            </Button>
            {offersStandingRule(request.action) ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      aria-label={ui("More for {{value0}}", {
                        value0: String(words.action),
                      })}
                      size="icon-sm"
                      variant="ghost"
                    />
                  }
                >
                  <IconDots />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    disabled={decision.isPending}
                    onClick={() => decide("allow_conversation")}
                  >
                    {ui("Allow for this conversation")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={decision.isPending}
                    onClick={() => decide("allow_always")}
                  >
                    {ui("Always allow here")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </>
        )
      }
      detail={words.place}
      icon={<IconHandStop />}
      meta={[
        request.action.policy ? (
          <span key="why">
            {handOff ? ui("Handed to you: ") : ""}
            {request.action.policy.reason}
          </span>
        ) : null,
        decision.error ? (
          <span className="text-destructive" key="error" role="alert">
            {<ErrorDetails error={decision.error} />}
          </span>
        ) : null,
      ]}
      more={<ApprovalDetails args={request.action.args} />}
      open
      title={action}
      waiting
      wholeDetail
    />
  );
}

/** The waiting questions and actions as rows, questions first, for a card that may hold more. */
export function useWaitingRows(agentId: string | undefined) {
  useLocale();
  const waiting = useWaiting(agentId);
  const botName = useBotNames();
  return {
    error: waiting.error,
    rows: [
      ...waiting.questions.map((question) => (
        <QuestionRow
          botName={botName(question.botId)}
          key={`question-${question.id}`}
          question={question}
        />
      )),
      ...waiting.pending.map((request) => (
        <RequestRow
          botName={botName(request.action.botId)}
          key={`request-${request.id}`}
          request={request}
        />
      )),
    ],
  };
}

/**
 * Questions and actions waiting on the person, one row each, decided where it is shown: the answer
 * box and the decision buttons sit on the row's own footer line. Given a Bot, only that Bot's. The
 * same requests the conversation draws inline, so a decision made in either place is the one
 * decision.
 */
export function WaitingForYou({ agentId }: { agentId?: string }) {
  useLocale();
  const { error, rows } = useWaitingRows(agentId);
  return (
    <>
      {error ? (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {<ErrorDetails error={error} />}
        </p>
      ) : null}
      {rows.length > 0 ? (
        <PageRows>
          {rows.map((row, index) => (
            <Fragment key={row.key}>
              {index > 0 ? <Separator /> : null}
              {row}
            </Fragment>
          ))}
        </PageRows>
      ) : null}
    </>
  );
}
