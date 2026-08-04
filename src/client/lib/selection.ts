import type { MouseEvent } from 'react';

/**
 * Lets a user drag-select text inside an accordion header without the accordion toggling.
 *
 * `<summary>` is a button-like control: any click on it opens or closes the `<details>`. So merely
 * allowing text selection in the header is half a fix -- releasing the mouse after a drag-select would
 * immediately collapse the panel, which reads as "selecting doesn't work" even though the selection
 * technically happened.
 *
 * This swallows the toggle only when the click ended a real selection lying inside this summary. A
 * plain click still toggles, so nothing about the normal interaction changes.
 */
export function preventToggleOnTextSelection(event: MouseEvent<HTMLElement>) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return;

  // Scope it to THIS header: a selection the user made elsewhere on the page must not make the
  // accordion unclickable.
  const anchor = selection.anchorNode;
  if (anchor && event.currentTarget.contains(anchor)) {
    event.preventDefault();
  }
}
