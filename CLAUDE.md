# CLAUDE.md

Working rules for AUTONEER and AUTONEER-PWA. Merge with project-specific instructions as needed.

## Stack

- AUTONEER: Delphi 7, Firebird 3.0, ReportBuilder 10.06
- AUTONEER-PWA: Node.js, Handlebars, MySQL, Ubuntu VPS

Fit every solution to this stack. Don't propose tooling that isn't in it.

## 1. Before Writing Code

- List your assumptions as a short block before the solution, not buried in prose.
- If requirements, inputs, schema, or component details are unstated: ask first. Don't guess.
- If two or more readings are valid: show both, recommend one, wait.
- If a simpler approach exists: say so before implementing the one I asked for.
- If something can't be known from what I gave you: say what is unknown and what you need.
- State edge cases, risks, and dependencies explicitly.

## 2. Scope

- Implement what I asked. Nothing more.
- No config options, flags, hooks, or parameters I didn't request.
- No abstraction that is used once. Inline it.
- No error handling for conditions that cannot occur.
- No new dependency without asking.
- No logging, comments, or docstrings unless asked, or the file already uses them.
- If the result is long, state the shorter version you rejected and why.

## 3. Editing Existing Code

- Change only lines the request requires. Every changed line must trace to it.
- Don't reformat, rename, reorder, or "improve" anything you weren't asked to touch.
- Match the file's existing style, naming, and patterns even if you'd do it differently.
- Delete only imports, variables, and functions your own change orphaned.
- Pre-existing dead code: mention it, leave it.
- Name the file/module/layer for each change.

## 4. Verification

- Restate the task as a pass/fail check before starting.
- Bug fix: reproduce it first, then fix it.
- Multi-step work: list steps as `[step] -> verify: [check]`, then execute.
- Report what you actually ran and its real output.
- If you didn't run or test it, say so plainly. Never describe untested code as working.
- If tests fail, show the output.

## 5. Output

- Concise and structured: numbered steps, bullets, tables.
- Give runnable code, SQL, config, or commands - not descriptions of them.
- No preamble, no filler, no motivational language, no unnecessary apologies.

## 6. UI / UX

- Reuse existing components and patterns. Reduce duplication.
- Keep behavior consistent and predictable across pages.

---

For trivial tasks, use judgment: these rules bias toward caution over speed.
