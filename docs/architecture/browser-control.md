# Browser control

Author: lacrous.

`packages/agent-core-v2/src/features/computerUse/browser/` is the DOM-mode half
of computer control. The plan it implements is explicit: **DOM mode whenever
reliable, visual mode only as a fallback** — canvas apps, remote desktops, and
interfaces with no accessible structure.

## The boundary this enforces

Nothing in `BrowserController` accepts a pixel coordinate. Every action is
addressed by one of four selectors:

| Selector | Example | Use |
|---|---|---|
| `role` + `name` | `{ role: 'button', name: 'Sign in' }` | default — survives a layout change |
| `backendNodeId` | from the accessibility tree | when the name is ambiguous |
| `text` | `{ text: 'Sign out' }` | links and buttons with no role |
| `css` | `{ css: '#submit' }` | last resort inside DOM mode |

A caller that cannot find a semantic target has a signal to reach for the
computer tools — not a reason to guess coordinates here. That is the whole
point of the split, and it is why these types carry no `x`/`y`.

## CDP, not Playwright

`CdpBrowserBackend` speaks the Chrome DevTools Protocol directly over a
WebSocket. Playwright was the plan's suggestion, and this is a deliberate
departure:

- **No new dependency.** `agent-core-v2` does not depend on Playwright, and
  adding it pulls a browser download and a large install. CDP is the browser's
  own wire protocol.
- **Socket injection.** `CdpBrowserOptions.connectionFactory` takes a
  `CdpSocket`, so the protocol layer is tested against a fake socket and needs
  no browser at all.
- **No package dependency at all.** `connectCdpSocket` uses the platform
  `WebSocket` (Node 22+). Where one is unavailable it fails with a clear message
  telling the caller to pass `connectionFactory`, rather than importing `ws` —
  an unresolvable import is a typecheck error even in a branch that never runs,
  and silently adding a manifest dependency for a path most callers never take
  is the wrong default. `agent-core-v2/package.json` is untouched.

The trade is real: Playwright has auto-waiting, a locator engine, and network
interception. `waitFor` here is a single evaluation, not a polling loop. If
that turns out to matter, `CdpBrowserBackend` is a drop-in replacement — the
`BrowserBackend` interface is the seam.

## Observation

Every action returns a `BrowserFrame`:

```
{ url, title, text, accessibility[], screenshot?, changed }
```

`screenshot` is optional and unset in `readPage`, because DOM mode should not
pay for a frame it does not need — that is the whole argument for DOM mode
over coordinate clicking. `BrowserController.summarize` turns a frame into the
three lines the model reads: title and url, node count, and whether the page
actually changed since the last navigation.

That last field matters more than it looks. A long autonomous run clicks many
things that do nothing; without "the page did not change", the model has no way
to distinguish progress from a dead end.

## Errors

`BrowserControlError` carries one of the nine action-failure classes from
`../observation`. URLs are validated before any call: a non-http scheme
(`file:`, `javascript:`) is refused with `invalid_action`, and the browser is
never touched. That is a real guard, not ceremony — a
`javascript:` URL from a model is a code-execution path.

## What is verified

| Test file | Covers |
|---|---|
| `browserController.test.ts` | selector rendering, URL rejection, page-change detection, action records, loop detection |
| `cdpBackend.test.ts` | request/response correlation, out-of-order replies, close and error propagation, AX-tree parsing, selector expressions, missing target id, empty screenshot |

Both run without a browser. No test here has driven a real page — see the
environment note in `../computer-control.md`.

## Not wired into tools yet

`BrowserController` and `CdpBrowserBackend` are complete and tested, but no
`browser.*` tools are registered, because a tool needs a CDP endpoint and the
feature has no way to obtain one — the browser may be a local Chrome, a remote
one, or an already-open profile. That needs a decision, not a guess:

1. A `computer.browser.endpoint` config entry the user fills in, or
2. Kimi launches the browser itself and owns the process.

Option 2 is the better fit for the autonomy goal, since it also gives the run a
disposable profile. It is a bigger change, so it waits for your call.