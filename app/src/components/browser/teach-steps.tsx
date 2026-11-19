import type { BrowserApiState } from "@openbot/shared/openbot-browser";
import { IconArrowLeft, IconPlayerRecordFilled } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { PageRows } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Item, ItemContent, ItemMedia } from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { openBrowserMutationOptions } from "@/lib/browser/mutations";
import { ui, uiNodes, useLocale } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";
import {
  LearningNextRow,
  learningNextWords,
  savedToLearning,
  useLearningNext,
  YOUR_SKILLS,
} from "./learning-next";
import { NativeNarrationRow } from "./narration";
import { NarrationChoiceDialog, useNarrationChoice } from "./narration-choice";
import {
  RecordingRow,
  type Stopped,
  StoppedRow,
  useRecording,
} from "./recording";

/** Kept once the person has saved a recording: from then on the page opens on naming the task, past the introduction. */
export const INTRODUCED_KEY = "openbot.teach-a-bot.introduced";

export const OPEN_AND_RECORD = "Open browser and record";

type Step = 1 | 2 | 3;

function introduced(): boolean {
  try {
    return localStorage.getItem(INTRODUCED_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberIntroduced() {
  try {
    localStorage.setItem(INTRODUCED_KEY, "1");
  } catch {
    // Storage refused (a private window): the introduction shows again next time, which is harmless.
  }
}

/**
 * Teach a Bot where the person's browser is a window on their desktop (a host-side computer of people's browsers), as three steps on one stage:
 * what it does, naming the task (with narration), and opening the browser already recording. While a recording runs the
 * third step is the recording itself, with Show browser and Stop; once it stops it says what became of it, with Record
 * another, and once it is saved, what Learning does with it next (`SavedStep`). The introduction shows until the person has saved a recording, and Back always reaches it.
 */
export function TeachSteps({ state }: { state: BrowserApiState }) {
  useLocale();
  const choice = useNarrationChoice();
  const recording = useRecording(state, choice, {}, { opens: true });
  const show = useMutation(openBrowserMutationOptions(queryClient));
  const live = recording.phase !== "idle";
  const [step, setStep] = useState<Step>(() =>
    live || recording.stopped ? 3 : introduced() ? 2 : 1,
  );

  const saved =
    recording.stopped &&
    !recording.stopped.discarded &&
    !recording.stopped.empty &&
    !recording.stopped.kept;
  useEffect(() => {
    if (saved) rememberIntroduced();
  }, [saved]);

  const error = state.problem ?? (show.error ?? recording.error)?.message;
  const named = !!recording.title.trim();
  // A recording that is running, or one that just ended, is always the third step. Without a name or a result there is
  // nothing for it to show, so it is naming the task again.
  const shown: Step = live
    ? 3
    : step === 3 && !named && !recording.stopped
      ? 2
      : step;

  let body: ReactNode;
  if (shown === 1) {
    body = (
      <Slide
        title={ui("Do it once, and your Bots learn it")}
        description={ui(
          "Do a task in your browser as you always would. The Recorder follows each step, and your Bots learn to do it for you.",
        )}
        action={
          <Button key="continue-introduction" onClick={() => setStep(2)}>
            {ui("Continue")}
          </Button>
        }
      >
        <RecorderIllustration />
      </Slide>
    );
  } else if (shown === 2) {
    body = (
      <Slide
        title={ui("Name the task")}
        description={ui(
          "Say what you're about to do. Your Bots use the name to know when to do it.",
        )}
        onBack={() => setStep(1)}
        action={
          <Button disabled={!named} form="teach-a-bot-name" type="submit">
            {ui("Continue")}
          </Button>
        }
      >
        <PageRows className="mt-0 w-full max-w-md shadow-lg">
          <Item
            size="sm"
            render={
              <form
                id="teach-a-bot-name"
                aria-label={ui("Name the task")}
                onSubmit={(event) => {
                  event.preventDefault();
                  if (named) setStep(3);
                }}
              />
            }
          >
            <ItemMedia variant="icon">
              <IconPlayerRecordFilled className="text-destructive" />
            </ItemMedia>
            <ItemContent>
              <Input
                aria-label={ui("Task name")}
                autoFocus
                maxLength={200}
                onChange={(event) => recording.setTitle(event.target.value)}
                placeholder={ui("Like Submit an expense report")}
                value={recording.title}
              />
            </ItemContent>
          </Item>
          <Separator />
          <NativeNarrationRow
            voice={state.recorder?.voice}
            choice={choice}
            recording={false}
          />
        </PageRows>
      </Slide>
    );
  } else if (live) {
    body = (
      <Slide
        title={ui("Recording in your browser")}
        description={ui(
          "Do the task in your browser. When you're done, press Stop at the top of the tab and save.",
        )}
      >
        <PageRows className="mt-0 w-full max-w-md shadow-lg">
          <RecordingRow
            recording={recording}
            whileRecording={
              <Button
                disabled={show.isPending}
                onClick={() => show.mutate()}
                size="sm"
                variant="outline"
              >
                {ui("Show browser")}
              </Button>
            }
          />
          <Separator />
          <NativeNarrationRow
            voice={state.recorder?.voice}
            choice={choice}
            recording
          />
        </PageRows>
      </Slide>
    );
  } else if (named) {
    body = (
      <Slide
        title={ui("Do it in your browser")}
        description={ui(
          "Recording starts as your browser opens. When you're done, press Stop at the top of the tab and save.",
        )}
        onBack={() => setStep(2)}
      >
        <div className="flex h-40 w-full max-w-md flex-col items-center justify-center gap-3 rounded-xl border border-foreground/20 border-dashed bg-background/50">
          <Button
            disabled={recording.starting}
            onClick={() => void recording.record()}
          >
            {recording.starting ? ui("Opening…") : ui(OPEN_AND_RECORD)}
          </Button>
          <span className="max-w-[90%] truncate rounded-full bg-background px-3 py-1 text-muted-foreground text-xs shadow-sm">
            “{recording.title.trim()}
            {ui("” · Narration")}{" "}
            {choice.narration === "on" ? ui("on") : ui("off")}
          </span>
        </div>
      </Slide>
    );
  } else if (recording.stopped && savedToLearning(recording.stopped)) {
    body = <SavedStep stopped={recording.stopped} another={() => setStep(2)} />;
  } else if (recording.stopped) {
    const stopped = recording.stopped;
    body = (
      <Slide
        title={
          stopped.discarded
            ? ui("Recording discarded")
            : ui("Recording finished")
        }
        description={
          stopped.discarded
            ? ui(
                "Nothing more is sent. Record the task again whenever you're ready.",
              )
            : ui(
                "Record another task, or the same one again, to teach your Bots more.",
              )
        }
        action={
          <Button onClick={() => setStep(2)}>{ui("Record another")}</Button>
        }
      >
        <PageRows className="mt-0 w-full max-w-md shadow-lg">
          <StoppedRow stopped={stopped} />
        </PageRows>
      </Slide>
    );
  }

  return (
    <section aria-label={ui("Teach a Bot")} className="mt-6">
      <div className="teach-stage relative flex min-h-[26rem] flex-col overflow-hidden rounded-2xl">
        <StepDots step={shown} />
        {body}
      </div>
      {error ? (
        <p className="mt-2 text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
      <NarrationChoiceDialog {...recording.question} />
    </section>
  );
}

/** Where the person is among the three steps. Decorative: each step's heading says what it is. */
function StepDots({ step }: { step: Step }) {
  useLocale();
  return (
    <div
      aria-hidden="true"
      className="absolute top-4 left-1/2 flex -translate-x-1/2 gap-1.5"
    >
      {([1, 2, 3] as const).map((each) => (
        <span
          key={each}
          className={cn(
            "h-1.5 rounded-full transition-all",
            each === step ? "w-5 bg-foreground" : "w-1.5 bg-foreground/20",
          )}
        />
      ))}
    </div>
  );
}

/**
 * The last step once a recording is saved: what it held, what Learning does with it next (Learn now, then Review or
 * Try it once a skill from it is there), and the way on from here, to the skills in Settings, Learning or another
 * recording. A saved recording is not a skill yet, so the step says what turns it into one.
 */
function SavedStep({
  stopped,
  another,
}: {
  stopped: Stopped;
  another: () => void;
}) {
  useLocale();
  const learning = useLearningNext(stopped);
  const { heading, sentence } = learningNextWords(learning, stopped.title);
  const learned = learning.next.kind === "learned";
  return (
    <Slide
      title={heading}
      description={sentence}
      action={
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" render={<Link to={YOUR_SKILLS} />}>
            {ui("See your skills")}
          </Button>
          <Button variant={learned ? "outline" : "default"} onClick={another}>
            {ui("Record another")}
          </Button>
        </div>
      }
    >
      <PageRows className="mt-0 w-full max-w-md shadow-lg">
        <StoppedRow stopped={stopped} />
        {learning.loaded ? (
          <>
            <Separator />
            <LearningNextRow learning={learning} title={stopped.title} />
          </>
        ) : null}
      </PageRows>
    </Slide>
  );
}

/** One step: what it shows in the middle of the stage, and its heading, sentence and button along the bottom. */
function Slide({
  title,
  description,
  action,
  onBack,
  children,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  onBack?: () => void;
  children: ReactNode;
}) {
  useLocale();
  return (
    <>
      {onBack ? (
        <Button
          className="absolute top-2.5 left-2.5"
          onClick={onBack}
          size="sm"
          variant="ghost"
        >
          {uiNodes("{{slot0}}Back", [<IconArrowLeft key="slot0" />])}
        </Button>
      ) : null}
      <div className="flex flex-1 items-center justify-center px-6 pt-12 pb-4">
        {children}
      </div>
      {/* The buttons go under the words once the two can't share a line without squeezing the sentence. */}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 px-6 pb-6">
        <div className="min-w-64 flex-1">
          <h2 className="font-semibold text-lg">{title}</h2>
          <p className="mt-1 text-pretty text-foreground/75 text-sm">
            {description}
          </p>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    </>
  );
}

/**
 * A browser window with the Recorder's mark at the top of its tab, a form being filled in, and the steps the Recorder
 * keeps appearing beside it. Drawn rather than a picture, so it follows the theme. Decorative: the step's sentence says
 * what it shows.
 */
function RecorderIllustration() {
  useLocale();
  return (
    <div aria-hidden="true" className="relative w-full max-w-sm select-none">
      <div className="overflow-hidden rounded-xl bg-card shadow-xl">
        <div className="flex items-center gap-1.5 border-b bg-muted px-3 py-2">
          <span className="size-2 rounded-full bg-foreground/15" />
          <span className="size-2 rounded-full bg-foreground/15" />
          <span className="size-2 rounded-full bg-foreground/15" />
          <span className="ml-2 flex-1 truncate rounded-md bg-card px-2 py-0.5 text-[10px] text-muted-foreground">
            {ui("expenses.example.com/new")}
          </span>
        </div>
        <div className="mx-auto flex w-max items-center gap-2 rounded-b-lg border border-t-0 px-2.5 py-1 text-[11px] font-medium">
          <span className="size-1.5 rounded-full bg-destructive motion-safe:animate-pulse" />
          {ui("Recording")}
          <span className="rounded border px-1.5 text-[10px]">
            {ui("Stop")}
          </span>
        </div>
        <div className="space-y-1.5 px-4 pt-2 pb-4 text-[11px]">
          <div className="h-1.5 w-2/5 rounded-full bg-muted" />
          <div className="flex justify-between rounded-md border px-2 py-1">
            <span className="text-muted-foreground">{ui("Amount")}</span>
            <span className="teach-type font-medium">42.50</span>
          </div>
          <div className="flex justify-between rounded-md border px-2 py-1">
            <span className="text-muted-foreground">{ui("Category")}</span>
            <span className="teach-type teach-delay-1 font-medium">
              {ui("Travel")}
            </span>
          </div>
          <span className="inline-block rounded-md bg-foreground px-2.5 py-1 text-background">
            {ui("Submit")}
          </span>
        </div>
      </div>
      <div className="absolute top-14 -right-6 w-36 space-y-1 rounded-lg bg-card p-2 text-[10px] text-muted-foreground shadow-lg sm:-right-28">
        {[
          ui("Opened expenses"),
          ui("Typed Amount"),
          ui("Chose Travel"),
          ui("Clicked Submit"),
        ].map((step, index) => (
          <div
            key={step}
            className="teach-step flex items-center gap-1.5"
            style={{ animationDelay: `${0.4 + index * 0.6}s` }}
          >
            <span className="size-1 shrink-0 rounded-full bg-primary" />
            {step}
          </div>
        ))}
      </div>
    </div>
  );
}
