// NotebookLM 연동 계층 (산출물 1~4: 인포그래픽/슬라이드/영상/음성).
// notebooklm-mcp-cli(jacob-bd)를 stdio MCP 서버로 실행해 raw JSON-RPC로 통신한다.
// 실제 설치된 notebooklm-mcp-cli(v3.0.2)의 tools/list 응답을 직접 조회해 확인한
// 툴 이름/파라미터를 그대로 사용한다(추측 아님):
//   notebook_create, source_add, studio_create, studio_status, download_artifact
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { OutputKind } from "../types";

// 우리 산출물 이름 -> notebooklm-mcp-cli의 artifact_type 값
const ARTIFACT_TYPE: Record<"infographic" | "slides" | "video" | "audio", string> = {
  infographic: "infographic",
  slides: "slide_deck",
  video: "video",
  audio: "audio",
};

const ARTIFACT_FILE: Record<"infographic" | "slides" | "video" | "audio", { ext: string; mime: string }> = {
  infographic: { ext: "png", mime: "image/png" },
  slides: { ext: "pdf", mime: "application/pdf" },
  video: { ext: "mp4", mime: "video/mp4" },
  audio: { ext: "mp3", mime: "audio/mpeg" },
};

export interface McpSession {
  start(): Promise<void>;
  callTool<T = Record<string, unknown>>(name: string, args: Record<string, unknown>, timeoutMsOverride?: number): Promise<T>;
  stop(): void;
}

interface JsonRpcIncomingMessage {
  jsonrpc?: string;
  id?: number;
  result?: McpToolCallResult;
  error?: { code: number; message: string };
}

interface McpToolCallResult {
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type?: string; text?: string }>;
  [key: string]: unknown;
}

export function createNotebookLmSession(command: string, timeoutMs: number): McpSession {
  let child: ChildProcessWithoutNullStreams | null = null;
  let stdout = "";
  let stderr = "";
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: McpToolCallResult | undefined) => void; reject: (error: Error) => void }
  >();

  function start(): Promise<void> {
    return new Promise((resolve, reject) => {
      child = spawn(command, { shell: process.platform === "win32" ? true : "/bin/zsh", stdio: ["pipe", "pipe", "pipe"] });
      const timer = setTimeout(() => reject(new Error(`NotebookLM MCP 초기화 실패: ${command}`)), 30000);

      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        drainStdout();
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(new Error(`NotebookLM MCP 실행 실패: ${error.message}`));
      });
      child.on("close", (code) => {
        const error = new Error(`NotebookLM MCP 프로세스 종료(${code}): ${stderr.trim() || command}`);
        for (const waiter of pending.values()) waiter.reject(error);
        pending.clear();
      });

      send("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "sermon-multiplier2", version: "0.1.0" },
      })
        .then(() => {
          clearTimeout(timer);
          write({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
          resolve();
        })
        .catch((error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  function callTool<T>(name: string, args: Record<string, unknown>, timeoutMsOverride?: number): Promise<T> {
    return send("tools/call", { name, arguments: args }, timeoutMsOverride).then((result) =>
      normalizeToolResult<T>(result),
    );
  }

  function send(
    method: string,
    params: Record<string, unknown>,
    timeoutMsOverride?: number,
  ): Promise<McpToolCallResult | undefined> {
    if (!child) return Promise.reject(new Error("NotebookLM MCP 세션이 시작되지 않았습니다."));
    const id = nextId++;
    const effectiveTimeoutMs = timeoutMsOverride ?? timeoutMs;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`NotebookLM MCP 응답 시간 초과(${method}): ${stderr.trim() || command}`));
    }, effectiveTimeoutMs);
    let reject!: (error: Error) => void;
    const promise = new Promise<McpToolCallResult | undefined>((resolve, rejectPromise) => {
      reject = rejectPromise;
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectPromise(error);
        },
      });
    });
    write({ jsonrpc: "2.0", id, method, params });
    return promise;
  }

  function write(message: Record<string, unknown>): void {
    child?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function drainStdout(): void {
    let newline = stdout.indexOf("\n");
    while (newline !== -1) {
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (line) {
        try {
          const message = JSON.parse(line) as JsonRpcIncomingMessage;
          const waiter = message.id === undefined ? undefined : pending.get(message.id);
          if (waiter) {
            pending.delete(message.id!);
            if (message.error) waiter.reject(new Error(message.error.message || JSON.stringify(message.error)));
            else waiter.resolve(message.result);
          }
        } catch {
          stderr += `\n${line}`;
        }
      }
      newline = stdout.indexOf("\n");
    }
  }

  function stop(): void {
    if (child && !child.killed) child.kill("SIGTERM");
  }

  return { start, callTool, stop };
}

function normalizeToolResult<T>(result: McpToolCallResult | undefined): T {
  if (result?.structuredContent && Object.keys(result.structuredContent).length) {
    return result.structuredContent as T;
  }
  const text = Array.isArray(result?.content)
    ? result.content
        .map((item) => (item?.type === "text" ? item.text || "" : ""))
        .join("\n")
        .trim()
    : "";
  if (text) {
    try {
      return JSON.parse(text) as T;
    } catch {
      return { status: "success", text } as T;
    }
  }
  return (result || {}) as T;
}

export interface NotebookLmArtifactRequest {
  kind: "infographic" | "slides" | "video" | "audio";
  styleText?: string;
}

export interface NotebookLmArtifactResult {
  kind: OutputKind;
  status: "complete" | "error" | "waiting";
  localFilePath?: string;
  mimeType?: string;
  error?: string;
}

export interface GenerateNotebookLmOutputsParams {
  session: McpSession;
  notebookId: string | null;
  notebookTitle?: string;
  sourceTitle?: string;
  sourceText?: string;
  requests: NotebookLmArtifactRequest[];
  downloadDir: string;
  maxWaitSeconds?: number;
  onPollTick?: (elapsedSeconds: number) => void;
}

export interface GenerateNotebookLmOutputsResult {
  notebookId: string;
  results: NotebookLmArtifactResult[];
}

export async function generateNotebookLmOutputs(
  params: GenerateNotebookLmOutputsParams,
): Promise<GenerateNotebookLmOutputsResult> {
  const { session, requests, downloadDir, notebookId } = params;
  await mkdir(downloadDir, { recursive: true });

  if (!notebookId) {
    throw new Error("NotebookLM 노트북 ID가 설정되어 있지 않습니다. 옵시디언 노트 설정이나 frontmatter에 notebook_id를 먼저 입력하세요.");
  }

  const results: NotebookLmArtifactResult[] = [];

  // ① NotebookLM Studio의 현재 아티팩트 목록 및 상태 조회
  let existingArtifacts: StudioArtifact[] = [];
  try {
    const status = await session.callTool<{ artifacts?: StudioArtifact[] }>("studio_status", {
      notebook_id: notebookId,
      action: "status",
    });
    existingArtifacts = status.artifacts || [];
  } catch (error) {
    throw new Error(`NotebookLM 아티팩트 상태 조회 실패: ${describeError(error)}`);
  }

  // ② 요청된 각 아티팩트를 이미 완성된 항목 목록에서 찾아 다운로드
  for (const request of requests) {
    const artifact = existingArtifacts.find(
      (a) => a.type === ARTIFACT_TYPE[request.kind]
    );

    if (!artifact) {
      // 아티팩트 자체가 노트북에 아직 생성되지 않은 상태
      results.push({
        kind: request.kind,
        status: "waiting",
        error: "NotebookLM Studio 웹 UI에서 아티팩트를 먼저 생성해주세요.",
      });
      continue;
    }

    if (artifact.status !== "completed") {
      // 아티팩트가 생성 중이거나 다른 상태
      results.push({
        kind: request.kind,
        status: "waiting",
        error: `NotebookLM 생성 대기 중 (현재 상태: ${artifact.status})`,
      });
      continue;
    }

    // 아티팩트 생성이 완료된 상태 -> 다운로드 진행
    try {
      const file = ARTIFACT_FILE[request.kind];
      const outputPath = `${downloadDir}/${request.kind}.${file.ext}`;
      await session.callTool("download_artifact", {
        notebook_id: notebookId,
        artifact_type: ARTIFACT_TYPE[request.kind],
        output_path: outputPath,
        artifact_id: artifact.artifact_id,
      });
      results.push({ kind: request.kind, status: "complete", localFilePath: outputPath, mimeType: file.mime });
    } catch (error) {
      results.push({ kind: request.kind, status: "error", error: `다운로드 실패: ${describeError(error)}` });
    }
  }

  return { notebookId, results };
}

interface StudioArtifact {
  artifact_id: string;
  type: string;
  status: string;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 브라우저 로그인 상호작용을 기다려야 하므로 넉넉하게 5분

// 터미널 없이 설정 화면의 "로그인" 버튼에서 바로 실행한다.
// nlm login은 자체적으로 브라우저를 띄우고 로컬 콜백을 기다리는 방식이라
// stdin 입력 없이도 완료되지만, 사용자가 브라우저에서 로그인을 마칠 때까지 오래 걸릴 수 있다.
export function runNotebookLmLogin(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("uvx", ["--from", "notebooklm-mcp-cli", "nlm", "login"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("로그인이 시간 초과되었습니다(5분). 다시 시도해주세요."));
    }, LOGIN_TIMEOUT_MS);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`nlm login 실행 실패: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(output.trim() || `로그인 실패 (종료 코드 ${code})`));
    });
  });
}

export interface NotebookLmConnectionStatus {
  ok: boolean;
  message: string;
}

// notebook_list를 가볍게 호출해 로그인 세션이 살아있는지 확인한다.
export async function testNotebookLmConnection(command: string): Promise<NotebookLmConnectionStatus> {
  const session = createNotebookLmSession(command, 30000);
  try {
    await session.start();
    const result = await session.callTool<{ status?: string; error?: string }>("notebook_list", { max_results: 1 });
    if (result.status === "error") {
      return { ok: false, message: result.error || "인증이 필요합니다. 로그인 버튼을 눌러주세요." };
    }
    return { ok: true, message: "NotebookLM에 정상적으로 연결되어 있습니다." };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  } finally {
    session.stop();
  }
}

export interface NotebookLmBrief {
  id: string;
  title: string;
}

// 전체 노트북 목록을 조회한다.
export async function listNotebooks(command: string): Promise<NotebookLmBrief[]> {
  const session = createNotebookLmSession(command, 30000);
  try {
    await session.start();
    const result = await session.callTool<{ notebooks?: NotebookLmBrief[]; status?: string; error?: string }>(
      "notebook_list",
      { max_results: 50 },
    );
    if (result.status === "error") {
      throw new Error(result.error || "노트북 목록을 불러오지 못했습니다.");
    }
    return result.notebooks || [];
  } finally {
    session.stop();
  }
}
