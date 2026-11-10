import type {
  AIConfig,
  Args,
  ClientState,
  Screen,
  Session,
  Task,
} from "./types";
export class BrowserClient {
  constructor(
    options?: object & {
      usbEvents?: Pick<
        EventTarget,
        "addEventListener" | "removeEventListener"
      > | null;
    },
  );
  snapshot(): ClientState;
  subscribe(listener: () => void): () => void;
  connect(options: { apiBase: string; accessToken: string; platform?: "ios" | "android" }): Promise<void>;
  disconnect(): Promise<void>;
  config(apiBase?: string): Promise<AIConfig>;
  refresh(): Promise<Session>;
  screen(): Promise<Screen | null>;
  command(
    tool: string,
    args: Args,
  ): Promise<{ kind?: string; message?: string; text?: string }>;
  startSetup(): Promise<unknown>;
  setupInput(line: string): Promise<unknown>;
  startTask(instruction: string, model?: string): Promise<Task>;
  confirmTask(id: string, actionId: string, approved: boolean): Promise<Task>;
  stopTask(id: string): Promise<Task>;
}
