//! Scoping for `tabs.onActivated`: only activations in the window that
//! currently holds OS focus may drive the span machine. A tab switch in a
//! background Chrome window must not overwrite the tracked tab - the user is
//! not looking at it, and the machine's window-focus flag alone cannot tell
//! the two windows apart.

/**
 * True when an activation event belongs to the OS-focused window. While no
 * window holds focus (`focusedWindowId` is null) every activation is ignored.
 */
export function shouldApplyTabActivation(
  activeWindowId: number,
  focusedWindowId: number | null,
): boolean {
  return focusedWindowId !== null && activeWindowId === focusedWindowId;
}
