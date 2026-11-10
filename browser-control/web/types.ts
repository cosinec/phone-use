export type Args = Record<string, unknown>;
export type TaskState =
  | "observing"
  | "thinking"
  | "awaiting_confirmation"
  | "executing"
  | "completed"
  | "failed"
  | "stopped";
export interface Task {
  model?: string;
  timings?: { observationMs?: number; modelMs?: number; actionMs?: number };
  id: string;
  instruction: string;
  state: TaskState;
  startedAt: string;
  finishedAt: string | null;
  message: string | null;
  error: string | null;
  steps: {
    id: string;
    tool: string;
    args: Args;
    reason: string;
    state: string;
    startedAt: string;
    finishedAt: string | null;
    result: { kind: string } | null;
  }[];
  confirmation: {
    actionId: string;
    tool: string;
    args: Args;
    reason: string;
  } | null;
}
export interface Setup {
  state: string;
  transcript: string;
  exitCode: number | null;
  error?: string;
}
export interface Session {
  platform?: "ios" | "android";
  id: string;
  deviceId: string;
  state: string;
  ready: boolean;
  daemon: { state?: { state?: string; message?: string } } | null;
  setup: Setup;
  task: Task | null;
}
export interface ClientState {
  phase: string;
  transportStatus?: string;
  cleanupPending?: boolean;
  device: { platform?: "ios" | "android"; productName?: string; serialNumber?: string } | null;
  session: Session | null;
  error: string | null;
  warning: string | null;
}
export interface Screen {
  timings?: { screenshotMs?: number; elementsMs?: number; sourceFormat?: string; sourceBytes?: number; uploadedBytes?: number; queueMs?: number };
  imageBase64: string;
  caption: string;
  deviceId: string;
  elementsText: string;
  elementsError?: string;
}
export interface AIConfig {
  aiReady: boolean;
  model: string | null;
  models?: string[];
  modelsError?: string;
}
export type Command = (tool: string, args: Args) => void;
export const activeTask = (task: Task | null | undefined) =>
  !!task && !["completed", "failed", "stopped"].includes(task.state);
export const taskLabels: Record<TaskState, string> = {
  observing: "正在查看屏幕",
  thinking: "正在规划下一步",
  awaiting_confirmation: "等待你的确认",
  executing: "正在操作",
  completed: "任务已完成",
  failed: "任务失败",
  stopped: "任务已停止",
};
