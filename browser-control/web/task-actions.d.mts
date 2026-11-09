import type { BrowserClient } from "./client.mjs";
export function createTaskActions(
  client: BrowserClient,
  callbacks: {
    onBusy: (busy: boolean) => void;
    onError: (message: string) => void;
    onStopBusy: (taskKey: string | null) => void;
  },
): {
  run: (operation: () => Promise<unknown>) => Promise<void>;
  stop: (sessionId: string, taskId: string) => Promise<void>;
};
