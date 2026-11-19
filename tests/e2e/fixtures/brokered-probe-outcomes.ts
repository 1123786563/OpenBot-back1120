const unchecked =
  "Connected with your key. It hasn't been checked with Gmail. At the time, Gmail had no safe way to check a key. That's about the app, not your key.";
const probe = "GMAIL_FETCH_EMAILS";

export const brokeredProbeCases = [
  {
    outcome: "nothing",
    verdict: { probe: null, verified: false, verifiedAt: null },
    description: unchecked,
  },
  {
    outcome: "answered",
    verdict: { probe, verified: true, verifiedAt: "2026-11-12T12:00:00Z" },
    description: "Connected with your key. Last checked",
  },
  {
    outcome: "complained",
    verdict: { probe, verified: false, verifiedAt: null },
    description:
      "Your key didn't pass a check with Gmail. That may be the key, or Gmail itself. Your account is still connected. Press Re-check to try again, or disconnect and connect with a new key.",
  },
  {
    outcome: "unreachable",
    verdict: { probe: null, verified: false, verifiedAt: null },
    description: unchecked,
  },
] as const;
