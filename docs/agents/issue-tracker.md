# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `1123786563/OpenBot`.
Use the `gh` CLI from this repository.

## Operations

- Verify the target: `gh repo view --json nameWithOwner`.
- Create: `gh issue create --title "..." --body-file <file>`.
- Read: `gh issue view <number> --json number,title,body,labels,comments`.
- List: `gh issue list --state open --json number,title,body,labels`.
- Comment: `gh issue comment <number> --body-file <file>`.
- Label: `gh issue edit <number> --add-label "..."`.
- Remove a label: `gh issue edit <number> --remove-label "..."`.
- Close: post the explanation as a comment, then run
  `gh issue close <number>`.

Before creating an issue, verify the target is `1123786563/OpenBot`.
For multiline bodies, write the text to a file and use `--body-file`.

## Relationships

Use native GitHub sub-issues and issue dependencies when supported.
Otherwise, put `Part of #<parent>` and `Blocked by: #<number>` at the
top of the child issue body. Work is unblocked when all blockers close.

## Pull requests as a triage surface

PRs as a request surface: no.

## Skill conventions

“Publish to the issue tracker” means create a GitHub issue.
“Fetch the relevant ticket” means read the GitHub issue.

For wayfinder, use a map issue labelled `wayfinder:map` with linked
child issues labelled `wayfinder:<type>` (research, prototype, grilling,
or task). Pick an unassigned child with no open blockers in map order,
assign it to the driving developer, then record the resolution in a
comment and update the map's Decisions-so-far.
