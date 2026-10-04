# Computer control

Author: lacrous.

`packages/agent-core-v2/src/features/computerUse/` adds the `ComputerController`
seam: a platform-independent interface for seeing and operating a machine, with
an Ubuntu/X11 adapter behind it.

`agent-core-v2` is a comment-free zone enforced by `scripts/check-no-comments.mjs`,
so the reasoning that would normally live in doc comments lives here instead.

## Layering

```
agent (model chooses the action)
  |
  v
computer.* tools           zod schema in, structured result out
  |
  v
ComputerController         validates coordinates, records actions, tracks state
  |
  v
ComputerBackend             the interface an adapter implements
  |
  v
UbuntuBackend              xdotool / wmctrl / import / xrandr
  |
  v
X11 desktop
```

The model never names an OS API. Everything platform-specific is behind
`ComputerBackend`, so a macOS or Windows adapter is a new file and no change
above it.

## Files

| File | Role |
|---|---|
| `types.ts` | `ComputerBackend` interface, geometry and window types, `ComputerControlError` |
| `computerController.ts` | Validation, action recording, state snapshot, loop detection |
| `ubuntuBackend.ts` | X11 bindings; `parseGeometry`, `parseMonitors`, `parseWindows`, `normalizeKey` |
| `observation.ts` | Failure classes, `observationPolicy`, `LoopDetector`, `ComputerState` |
| `computerUseService.ts` | DI service; owns the controller and the media handoff |
| `computerUseFeature.ts` | Feature registration, gated on the experimental flag |
| `flag.ts` | `KIMI_CODE_EXPERIMENTAL_COMPUTER_USE` |
| `tools/computer-use.ts` | zod schemas and tool service identifiers |
| `tools/computerUseTools.ts` | The five tools |

## Three decisions worth knowing

**Coordinates are validated before they reach the desktop.** A click at
(99999, 0) is almost always the model doing arithmetic wrong. Letting the X
server silently ignore it and return "success" teaches the model that clicks
work when they did not, so `ComputerController` rejects out-of-bounds and
non-integer points with `failureClass: 'invalid_action'` and the actual screen
size in the message.

**Errors carry a class, and the class is actionable.** Every backend failure
becomes a `ComputerControlError` with one of nine classes (`transient`,
`environment`, `invalid_action`, `authentication`, `network`, `application`,
`tool`, `model`, `unknown`). A missing binary is not a crash: `UbuntuBackend`
maps `ENOENT` to class `environment` and names the dependency, so the tool
returns "Computer control requires 'xdotool', which is not installed" instead of
dying at import.

**Key aliases are normalized at the edge.** The model is told it may say
`enter`, `esc`, `cmd` or `pageup`; `normalizeKey` maps those to the names
xdotool wants. Keeping the translation in the adapter means the tool schema can
stay in the model's vocabulary.

## Screenshots reach the model through the existing media path

No new plumbing was needed. `MediaStore` is content-addressed, so two identical
frames — common when a click changed nothing — collapse to one stored object.
`ComputerScreenshotTool` writes the PNG and returns an `image_url` content part
plus a text summary carrying the geometry and the focused window, so a model
that cannot see images still learns something.

## Observation policy

`observationPolicy(reason)` decides whether an action earns a fresh frame:

| Reason | Screenshot | State |
|---|---|---|
| `after_failure` | yes | yes |
| `after_navigation`, `after_major_change` | yes | yes |
| `before_important_action` | yes | yes |
| `after_click` | yes | no |
| `after_typing` | no | no |
| `manual` | yes | yes |

Full-resolution frames are the dominant context cost in a computer-use loop. An
unconditional capture per action fills a context window in a few dozen actions,
so failures and navigations always earn one and typing does not.

## Environment notes

Verified on the dev machine (Ubuntu 26.04.1, display `:0`):

- screen 1366x768, single primary `eDP-1` — `parseMonitors` is pinned to real
  `xrandr --query` output in the test
- `xrandr` present; `xdotool`, `wmctrl`, `scrot`, `import` **absent**

So mouse, keyboard, window and screenshot paths are covered by parsing tests and
a fake backend, not by live interaction. `UbuntuBackend.capabilities()` reports
what is missing so the caller can refuse early instead of failing per action.

To use it for real:

```sh
sudo apt-get install -y xdotool wmctrl imagemagick
export KIMI_CODE_EXPERIMENTAL_COMPUTER_USE=1
```

## Enabling

Off by default. The feature is assembled only when the flag is on, so a machine
with no display pays nothing:

```sh
KIMI_CODE_EXPERIMENTAL_COMPUTER_USE=1 kimi
```

Tools: `ComputerScreenshot`, `ComputerClick`, `ComputerType`, `ComputerKey`,
`ComputerApplication`.

## Testing note

`computerController.test.ts` drives a fake backend, so coordinate validation,
failure classification, action records and loop detection are all proven without
a display. `ubuntuBackend.test.ts` pins the parsers to captured real output.

One test detail worth keeping: the click tests assert that a rejected
coordinate never reaches the backend (`expect(backend.calls).toHaveLength(0)`).
Validation that runs but still dispatches would defeat the point.

## Not built here

- **Browser control (Phase 7).** Belongs in a Playwright-backed
  `BrowserController`, not behind `ComputerBackend` — the plan is explicit that
  DOM mode is preferred over coordinate clicking.
- **A supervisory loop above the turn.** Goal budget, deadline and completion
  verification all run *inside* one turn. "Run until a deadline" needs a runtime
  above `HumanTurn`, and no such loop exists today.