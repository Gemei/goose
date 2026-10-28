export type TrayWindow = {
  hide: () => void;
  show: () => void;
  focus: () => void;
  restore: () => void;
  isMinimized: () => boolean;
  isVisible: () => boolean;
  isDestroyed: () => boolean;
  setSkipTaskbar: (skip: boolean) => void;
};

export function shouldHideWindowToTray(
  isQuitting: boolean,
  hasTray: boolean,
  closeToTray: boolean
): boolean {
  return !isQuitting && hasTray && closeToTray;
}

export function shouldQuitWhenAllWindowsClosed(hasTray: boolean, closeToTray: boolean): boolean {
  return !hasTray || !closeToTray;
}

export function hideWindowToTray(win: TrayWindow): void {
  if (win.isDestroyed()) {
    return;
  }
  win.setSkipTaskbar(true);
  win.hide();
}

export function revealWindowFromTray(win: TrayWindow): void {
  if (win.isDestroyed()) {
    return;
  }
  if (win.isMinimized()) {
    win.restore();
  }
  win.setSkipTaskbar(false);
  if (!win.isVisible()) {
    win.show();
  }
  win.focus();
}
