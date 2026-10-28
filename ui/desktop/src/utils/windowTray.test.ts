import { describe, expect, it } from 'vitest';
import {
  hideWindowToTray,
  revealWindowFromTray,
  shouldHideWindowToTray,
  shouldQuitWhenAllWindowsClosed,
  type TrayWindow,
} from './windowTray';

function fakeWindow(
  overrides: Partial<{ minimized: boolean; visible: boolean; destroyed: boolean }> = {}
) {
  const calls: string[] = [];
  const state = {
    minimized: overrides.minimized ?? false,
    visible: overrides.visible ?? true,
    destroyed: overrides.destroyed ?? false,
    skipTaskbar: false,
  };
  const win: TrayWindow = {
    hide: () => {
      calls.push('hide');
      state.visible = false;
    },
    show: () => {
      calls.push('show');
      state.visible = true;
    },
    focus: () => {
      calls.push('focus');
    },
    restore: () => {
      calls.push('restore');
      state.minimized = false;
    },
    isMinimized: () => state.minimized,
    isVisible: () => state.visible,
    isDestroyed: () => state.destroyed,
    setSkipTaskbar: (skip: boolean) => {
      calls.push(`skipTaskbar:${skip}`);
      state.skipTaskbar = skip;
    },
  };
  return { win, calls, state };
}

describe('windowTray', () => {
  it('hides to the tray while the app is running with a tray icon', () => {
    expect(shouldHideWindowToTray(false, true, true)).toBe(true);
    expect(shouldHideWindowToTray(true, true, true)).toBe(false);
    expect(shouldHideWindowToTray(false, false, true)).toBe(false);
    expect(shouldHideWindowToTray(false, true, false)).toBe(false);
  });

  it('keeps the process alive when a tray icon is present and close-to-tray is on', () => {
    expect(shouldQuitWhenAllWindowsClosed(true, true)).toBe(false);
    expect(shouldQuitWhenAllWindowsClosed(false, true)).toBe(true);
    expect(shouldQuitWhenAllWindowsClosed(true, false)).toBe(true);
    expect(shouldQuitWhenAllWindowsClosed(false, false)).toBe(true);
  });

  it('hides the window and drops it from the taskbar', () => {
    const { win, calls, state } = fakeWindow({ visible: true });
    hideWindowToTray(win);
    expect(calls).toEqual(['skipTaskbar:true', 'hide']);
    expect(state.visible).toBe(false);
    expect(state.skipTaskbar).toBe(true);
  });

  it('restores a hidden window onto the taskbar', () => {
    const { win, calls, state } = fakeWindow({ visible: false, minimized: true });
    revealWindowFromTray(win);
    expect(calls).toEqual(['restore', 'skipTaskbar:false', 'show', 'focus']);
    expect(state.visible).toBe(true);
    expect(state.minimized).toBe(false);
    expect(state.skipTaskbar).toBe(false);
  });

  it('ignores destroyed windows', () => {
    const { win, calls } = fakeWindow({ destroyed: true });
    hideWindowToTray(win);
    revealWindowFromTray(win);
    expect(calls).toEqual([]);
  });
});
