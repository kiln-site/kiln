# Writing Kiln's docs

Kiln's docs live in `apps/docs/content` as Markdown, one file per page. The
docs site at `kiln.site/docs` builds them into pages, the sidebar, search, and
`llms.txt`. This guide covers the file format and the voice.

## Files and URLs

A page at `content/<section>/<page>.md` is served at `/docs/<section>/<page>`.
`content/<section>/index.md`, if there is one, is the section's own page at
`/docs/<section>`. The sidebar's sections and their order come from
`src/content/navigation.ts`; add a page there when you add its file.

Every page starts with frontmatter:

```md
---
title: Create a game server
description: Start a game server from a Brick and choose the Relay it runs on.
---
```

- `title` is the page's heading and its title in search and link previews. Use
  sentence case.
- `description` is one sentence, under 160 characters. It shows under the
  title, in search results, and in link previews.

Don't add an `# H1`; the title is the page's heading. Use `##` for sections and
`###` below them. Every `##` and `###` appears in "On this page" and in search,
so keep headings short and specific.

## Markdown

GitHub-flavored Markdown: tables, task lists, strikethrough, and autolinks.

**Links between pages** start at the docs' root, without `/docs`:
`[Add a Relay](/relays/add)` or `[ports](/game-servers/create#ports)`. The site
adds its base path. Link to Kiln's code with full GitHub URLs.

**Code** fences name their language. A `title` labels the block:

````md
```sh title="On the machine that will run Hearth"
curl -fsSL https://kiln.site/install | sh
```
````

**Callouts** use GitHub's syntax:

```md
> [!NOTE]
> Something worth knowing.
```

`NOTE`, `TIP`, `WARNING` (something can go wrong), and `CAUTION` (something
can be lost or exposed).

**Keys** use `<kbd>`: `<kbd>Ctrl</kbd> <kbd>C</kbd>`.

**Steps** are a numbered list. Name buttons and fields in **bold**, exactly as
Hearth labels them.

## Voice

- Write to the reader ("you"), in short, plain sentences. Say what to do and
  what happens, then why if it isn't obvious.
- Lead with the task. Background goes after, or on its own page.
- No marketing: no "powerful", "seamless", "simply", or "just".
- Match Hearth's own words for buttons, pages, and settings. Search
  `apps/web/src` for the label before writing it.
- Only document what Kiln does today. Check behavior against the code, not
  plans or wishes. `docs/*-plan.md` files describe work that may not have
  shipped.

## Naming

Readers see different names than the code uses:

- **Game server**, not "instance" or "server", wherever it sits beside apps,
  databases, or Relays. On a game server's own page, "server" alone is fine.
- **App** and **database**.
- **Relay** for the agent on each machine. Never call a Relay or its machine a
  "server"; say "Relay", "machine", or "host".
- **Hearth** for the web panel.
- **Instance** means any of game server, app, or database, as in "All
  instances".
- **Brick** for a game server's recipe, and **Ember** for the runtime images
  Bricks use.
- CLI commands keep their own words: `kiln servers list`, `kiln server info`.
