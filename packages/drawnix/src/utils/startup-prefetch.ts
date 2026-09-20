export type IdlePrefetchGroup =
  | 'ai-chat'
  | 'tool-windows'
  | 'diagram-engines'
  | 'office-data'
  | 'editor-engines'
  | 'media-viewer'
  | 'external-skills'
  | 'runtime-static-assets'
  | 'offline-static-assets';

interface IdlePrefetchMessage {
  type: 'SW_PREFETCH_GROUPS';
  groups: IdlePrefetchGroup[];
}

const requestedGroups = new Set<IdlePrefetchGroup>();
const MAX_IDLE_PREFETCH_POST_ATTEMPTS = 4;
const IDLE_PREFETCH_RETRY_DELAY_MS = 1000;

function releaseRequestedGroups(groups: IdlePrefetchGroup[]): void {
  groups.forEach((group) => requestedGroups.delete(group));
}

function canUseConnectionForPrefetch(): boolean {
  const connection =
    typeof navigator !== 'undefined'
      ? (
          navigator as Navigator & {
            connection?: { saveData?: boolean; effectiveType?: string };
          }
        ).connection
      : undefined;

  if (!connection) {
    return true;
  }

  if (connection.saveData) {
    return false;
  }

  return (
    connection.effectiveType !== 'slow-2g' && connection.effectiveType !== '2g'
  );
}

export function requestServiceWorkerIdlePrefetch(
  groups: IdlePrefetchGroup[]
): void {
  if (
    typeof window === 'undefined' ||
    !('serviceWorker' in navigator) ||
    groups.length === 0 ||
    !canUseConnectionForPrefetch()
  ) {
    return;
  }

  const pendingGroups = groups.filter((group) => {
    if (requestedGroups.has(group)) {
      return false;
    }
    requestedGroups.add(group);
    return true;
  });

  if (pendingGroups.length === 0) {
    return;
  }

  const message: IdlePrefetchMessage = {
    type: 'SW_PREFETCH_GROUPS',
    groups: pendingGroups,
  };

  const postMessage = (attempt = 1) => {
    const controller = navigator.serviceWorker.controller;
    if (controller) {
      controller.postMessage(message);
      return;
    }

    navigator.serviceWorker.ready
      .then((registration) => {
        if (registration.active) {
          registration.active.postMessage(message);
          return;
        }

        if (attempt >= MAX_IDLE_PREFETCH_POST_ATTEMPTS) {
          releaseRequestedGroups(pendingGroups);
          console.warn(
            '[StartupPrefetch] idle prefetch request dropped: no active service worker',
            {
              groups: pendingGroups,
              attempt,
            }
          );
          return;
        }

        window.setTimeout(
          () => postMessage(attempt + 1),
          IDLE_PREFETCH_RETRY_DELAY_MS
        );
      })
      .catch((error) => {
        if (attempt >= MAX_IDLE_PREFETCH_POST_ATTEMPTS) {
          releaseRequestedGroups(pendingGroups);
          console.warn(
            '[StartupPrefetch] idle prefetch request failed after retries',
            {
              groups: pendingGroups,
              attempt,
              error,
            }
          );
          return;
        }

        window.setTimeout(
          () => postMessage(attempt + 1),
          IDLE_PREFETCH_RETRY_DELAY_MS
        );
      });
  };

  const idleCallback = (
    window as Window & {
      requestIdleCallback?: (
        callback: (deadline: IdleDeadline) => void,
        options?: { timeout: number }
      ) => number;
    }
  ).requestIdleCallback;

  if (typeof idleCallback === 'function') {
    idleCallback(() => postMessage(), { timeout: 1500 });
  } else {
    window.setTimeout(postMessage, 400);
  }
}
