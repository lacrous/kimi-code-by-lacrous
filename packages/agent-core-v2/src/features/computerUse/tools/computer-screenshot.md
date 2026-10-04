Capture the screen as an image the model can see.

Returns the PNG plus a text summary of the screen size and the focused window's title.

Use this before acting on anything you cannot otherwise verify — after a page
loads, after a layout changes, or when a previous action's effect is unclear.
Prefer reading the accessibility tree or the DOM when one is available; fall back
to a screenshot for canvas apps, remote desktops, and custom interfaces.