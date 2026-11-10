import type { BrowserClient } from "./client.mjs";
import type { Screen } from "./types";
export function startSessionPolling(client: BrowserClient, callbacks: {
  onScreen: (screen: Screen | null) => void;
  onError: (message: string) => void;
}): () => void;
