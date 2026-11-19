import { expect, test } from "bun:test";
import {
  botCardAnswer,
  createdBotIdIn,
  wasCreated,
} from "@/lib/agents/proposal";

const MADE = {
  agentId: "agent_1",
  name: "Renewal Desk",
  granted: ["find-a-document", "check-a-claim"],
  failed: [],
};

test("the created answer carries an id the card can read back", () => {
  const answer = botCardAnswer.created(MADE);

  expect(wasCreated(answer)).toBe(true);
  expect(createdBotIdIn(answer)).toBe("agent_1");
  // A declined card is not a created one, and carries no coworker to link to.
  expect(wasCreated(botCardAnswer.declined())).toBe(false);
  expect(createdBotIdIn(botCardAnswer.declined())).toBeNull();
});

test("an answer written before Bot pages existed still links to the coworker it made", () => {
  // Conversations people scroll back through still hold the old sentence.
  expect(
    createdBotIdIn(
      "Created. Tell the person that its profile is at /agents?agent=agent_9.",
    ),
  ).toBe("agent_9");
});
