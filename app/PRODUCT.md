# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The team edition serves employees and IT owners. The personal edition serves one person on their own machine.

- **Company employee (daily end user).** Usually not technical. Asks Bots to do jobs: read an expense claim, turn a meeting note into follow-ups, research a topic. Expects the ease of ChatGPT, Claude or Grok.
- **IT owner (buyer and administrator).** Chooses and deploys OpenBot. Adds Bots, grants tools and connections, answers approvals, and reads the audit log. Needs trust and control.

- **Personal edition user.** Uses the Personal Assistant for everyday work and can teach it by recording a browser workflow. The edition starts with one shared Computer and requires no sign-in.

## Product Purpose

OpenBot is a self-hostable workspace for AI coworkers. It connects agents that speak AG-UI and gives people a place to work with them. Success means people use Bots for everyday work and can see what their Bots can do.

## Positioning

OpenBot lets operators choose where the workspace, agent execution and models run. A Bot can work in a real browser with the connections and tools it has been granted. Team deployments can give Bots their own Computers. The personal edition uses one shared Computer.

## Operating Context

- The web app in `app/` is the main surface. A Tauri desktop app and a mobile client use the same frame.
- Main areas: chat with a chosen Bot, the Bot's own computer and browser, Bots, skills, routines, connections, memory, approvals, audit, admin and settings.
- OpenBot is a template. Companies clone the repository and rename it through `brand.yaml`.
- During the Astryx migration, the existing skins remain available: `openbot`, OpenDuet, OpenDots and OpenMuse.

## Capabilities and Constraints

- Light and dark mode must both ship finished.
- [The Astryx migration](../docs/adr/0001-unify-web-ui-with-astryx.md) starts with the Bots list and creation flow. The existing interface remains available as a fallback during the pilot. After the migration, retire the four skins and preserve light and dark themes, brand configuration and existing workflows.
- [Interface localization](../docs/adr/0007-interface-localization-boundary.md) covers English and Simplified Chinese. Changing the interface language preserves user input, Bot names, conversations, skill bodies and external service text.
- Desktop and mobile must both work at native quality.
- Dense admin screens (audit log, approvals, tables, settings) must stay easy to scan.
- The Web app uses React, Vite and Tailwind. Astryx is the target component system. Existing components remain in use until their callers migrate.

## Brand Commitments

- The new look is opinionated. When a company renames OpenBot, it swaps the name and logo. The visual world stays.
- The design must move away from the generic shadcn look (gray neutrals, Inter, default components).
- The user named Grok and Muse as references for simplicity, polish and elegance. The result must be unique, not a copy of either.
- Binding brand input (pinned 2026-10-28): take the pixelation and color schemes of copilotkit.ai. Pixelation means square-pixel dither fields. The colors are periwinkle `#7480F1` to mint `#23D5A2`, sky `#8DC1F1` to violet `#686FDF`, lilac `#BEC2FF`, pale lavender `#EDEDF5` and deep plum `#35295F`. The rest of that website is not a reference.
- Direction rounds 1 and 2 were rejected as generic. The user likes bold directions, except extreme ones such as a hand-drawn newsprint catalog.

## Evidence on Hand

- Product copy and workflows are documented in the [README](../README.md) and [personal edition guide](../docs/personal-edition.md).
- Real Bots: General Assistant, Knowledge, Risk Analyst, and ten catalog Bots in `examples/fintech/catalog/`.
- No customer logos, testimonials or usage numbers. Do not invent them.

## Product Principles

1. A Bot is a colleague, not a chat widget. It has a name, a computer and a record of its work.
2. Make ownership visible. People can see which Bot, Computer and connections are involved in the work.
3. The conversation leads. Chrome that does not help the current job stays out of the way.
4. Control is visible but quiet. Approvals and audit are part of the product, not an alarm system.
5. Every detail is finished. Rough spacing, type and motion break trust.
