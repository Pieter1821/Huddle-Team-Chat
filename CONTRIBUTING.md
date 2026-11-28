# Contributing to Huddle

Thanks for helping. Small fixes, docs, bug reports and big features are all welcome.

## Find something to work on

- Browse [issues labelled `good first issue`](https://github.com/Pieter1821/Huddle-Team-Chat/labels/good%20first%20issue) or `help wanted`.
- Have an idea? Open an issue first so we can agree on the approach before you build it.
- Found a typo or unclear docs? Just send a pull request. The website and docs live in `site/`.

## Set up

You need Node 22 or newer.

```
npm install
cp .dev.vars.example .dev.vars   # set ADMIN_EMAIL and BETTER_AUTH_SECRET
npm run dev
```

The app is in `src/` (`web` is the React app, `worker` is the Cloudflare Worker, `shared` is used by both). The website is a separate Astro project in `site/`.

## Before you open a pull request

```
npm run check
```

This runs formatting, lint, types, the database check, unit tests and a build. For changes you can see in the app, also run `npm run test:e2e`. CI runs the same checks.

## Pull requests

- Keep each one focused on a single change.
- Describe what changed and why, with a screenshot for anything visual.
- Add or update a test when you fix a bug or add behaviour.
- Use [conventional commit](https://www.conventionalcommits.org) messages such as `fix(ui): ...` or `feat(site): ...`.

## Reporting security problems

Please don't open a public issue. Use [GitHub's private vulnerability reporting](https://github.com/Pieter1821/Huddle-Team-Chat/security/advisories/new).

By contributing you agree that your work is released under the [MIT license](LICENSE).
