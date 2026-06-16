# tools/

Repo tooling that is not part of the shipped CLI.

## `render-demo-gif.js` — the README / docs hero demo

Renders `docs/public/demo.gif`, the looping terminal demo at the top of the root
`README.md` and on the docs home page. The inline **scene script** in this file
is the source of truth for the GIF — edit it, then regenerate.

It is a scripted terminal animation (canvas → GIF), not a recording of a live
session, so the output is curated. Keep it faithful to how the CLI actually
behaves: real command names and real message shapes — `what / why / next`
refusals, the `Filling N unverified pairs … (consensus included)` approve header,
and the `yg check: PASS  N nodes · X/Y files · Z aspects · W flows` summary.

### Narrative intent (read before editing the scene script)

Weighted toward the value real adopters actually get, in this order:

1. **Prevention** — `yg context` hands the agent the few rules that touch the
   file *before* it writes, so the code fits on the first draft.
2. **Un-ignorable enforcement** — the deterministic checks and the built-in
   relation-conformance check run live, for free, on every check, and cannot be
   quietly optimized away the way a `CLAUDE.md` line can.
3. **One LLM beat** — the reviewer catches a semantic rule (audit logging) a
   script can't express. A single beat, not the spine.

Do not re-center the demo on the LLM refusal loop — that is the least
consistently-delivered part in practice.

### Regenerate

```bash
# from repo root
node tools/render-demo-gif.js
```

Requires `canvas` and `gifencoder` (the native `canvas` build needs the usual
cairo/pango system libs):

```bash
npm install canvas gifencoder
```

Output is written to `docs/public/demo.gif`; review it, then commit the
regenerated GIF alongside the script change.

> **Keep `docs/public/demo.html` in sync.** That file is a standalone HTML/CSS
> animation of the same scene. When you change the scene script here, update the
> HTML to match (or it drifts from the GIF the README actually shows).
