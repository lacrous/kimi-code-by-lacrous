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

## Launching a browser Kimi owns

`launchBrowser` starts Chromium and waits for its CDP endpoint to answer,
returning the endpoint plus a `close()` that tears the process down and removes
the profile.

Owning the process is the reason this exists. A run gets a throwaway
`user-data-dir`, so no personal session, cookie jar or password store is
reachable, and a wedged browser can be killed and replaced without touching
anything else. Connecting to a browser the user already had open offers neither
guarantee.

Chromium is found by reading the cache directories Playwright and Puppeteer
leave behind (`~/.cache/ms-playwright`, `/usr/lib/chromium`), newest version
first. That is what keeps the launcher dependency-free: a machine that has ever
run either already has a usable Chrome on disk. If none is found the error says
so and names `executablePath` as the override.

### Sandbox

`--no-sandbox` is the default. Ubuntu 23.10 and later disable unprivileged user
namespaces under AppArmor, and Chromium's zygote sandbox aborts at startup with
`No usable sandbox!` — without the flag the browser never comes up at all on
this machine. Pass `sandbox: true` to keep it.

This is not the isolation story. The isolation is the disposable profile plus
the fact that Kimi owns the lifecycle; the namespace sandbox would be defence
in depth on top of that. On a host where a real sandbox is available, prefer
`sandbox: true` — it is one option away.

### Shutdown

`close()` waits for the process to actually exit before removing the profile.
Chromium keeps writing to its directory as it shuts down, so removing first
races it and fails with `ENOTEMPTY`. A directory that survives anyway is treated
as a non-fatal miss: the browser is gone, which is what `close()` promises.

## What is verified

| Test file | Covers |
|---|---|
| `browserController.test.ts` | selectors, URL rejection, page-change detection, action records, loop detection |
| `cdpBackend.test.ts` | request/response correlation, out-of-order replies, close and error propagation, AX-tree parsing, selector expressions |
| `browserLauncher.test.ts` | binary discovery, launch, disposable profile, cleanup, double-close, and **a real browser driven end to end** |

The end-to-end test starts Chromium, serves a page over real HTTP, navigates to
it through `BrowserController`, and asserts the title, body text and
accessibility tree that come back. It would catch a protocol regression that the
fake socket cannot.

## Not wired into tools yet

`BrowserController`, `CdpBrowserBackend` and `launchBrowser` are complete and
tested, but no `browser.*` tools are registered. A tool needs a session that
lives across turns — launch once, reuse, and tear down when the agent stops —
and that lifetime has to be owned somewhere. `features/computerUse` does not yet
hold a session service, so a tool would launch a new browser per call.