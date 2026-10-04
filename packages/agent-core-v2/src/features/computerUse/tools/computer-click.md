Click at a pixel coordinate on the screen.

Coordinates are measured from the top-left of the screen, so read them off a
screenshot you have already taken — do not guess. A coordinate outside the
current screen bounds is rejected rather than silently ignored.

Set `double` for a double-click, and `button` for right- or middle-click.

This is a last resort. When the target is a link, button, or field that the
accessibility tree or the DOM exposes, address it by name instead: a click on a
coordinate breaks the moment the layout shifts.