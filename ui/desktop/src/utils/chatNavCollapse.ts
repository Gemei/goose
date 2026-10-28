export const COLLAPSED_PROJECTS_KEY = 'navigation_collapsed_projects';
export const CHATS_EXPANDED_KEY = 'navigation_chats_expanded';

export function readCollapsedProjects(): Set<string> {
  try {
    const stored = localStorage.getItem(COLLAPSED_PROJECTS_KEY);
    if (!stored) return new Set();
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((path): path is string => typeof path === 'string'));
  } catch {
    return new Set();
  }
}

export function writeCollapsedProjects(paths: Set<string>) {
  localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify([...paths]));
}

export function readChatsExpanded(): boolean {
  return localStorage.getItem(CHATS_EXPANDED_KEY) !== 'false';
}

export function writeChatsExpanded(expanded: boolean) {
  localStorage.setItem(CHATS_EXPANDED_KEY, String(expanded));
}
