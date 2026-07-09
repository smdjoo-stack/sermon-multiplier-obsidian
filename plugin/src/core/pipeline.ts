// 파이프라인 오케스트레이터 (설계문서 "전체 아키텍처 흐름" + "개발 로드맵" Phase 5).
// 로컬 AI CLI 산출물(요약/큐티/성경공부)과 NotebookLM 산출물(인포그래픽/슬라이드/영상/음성)을
// 순차 실행하고, 산출물별로 부분 성공을 허용하며, frontmatter/노트 본문/이력 파일을 갱신한다.
import { readFile, writeFile, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  ALL_GENERATABLE_OUTPUTS,
  LOCAL_AI_OUTPUTS,
  NOTEBOOKLM_OUTPUTS,
  OutputKind,
  OutputRunState,
  SermonFrontmatter,
  SermonMultiplierSettings,
} from "../types";
import { parseSermonNote, serializeSermonNote } from "./frontmatterManager";
import { renderPrompt, resolvePromptTemplate } from "./promptTemplates";
import { resolveAiCommand, runAiCommand } from "./aiCliClient";
import {
  createNotebookLmSession,
  generateNotebookLmOutputs,
  NotebookLmArtifactRequest,
} from "./notebooklmClient";
import { extractDriveFileId, GoogleDriveUploader } from "./gdriveClient";
import {
  categoryForOutput,
  generateDriveEmbed,
  generateWikilink,
  getRecommendedSize,
  getSizeById,
  upsertOutputSection,
  extractOutputSection,
} from "./embedWriter";
import { getSlideStylePreset } from "./slideStyles";
import { writeRunHistory, slugifyNotePath } from "./history";
import { buildLandingPage, LandingPageData } from "./landingPageBuilder";
import { LANDING_PAGE_TEMPLATE } from "./seeds";

const LOCAL_OUTPUT_LABEL: Record<"summary" | "qt" | "bible_study", string> = {
  summary: "설교문요약",
  qt: "큐티자료",
  bible_study: "성경공부자료",
};

// 파일명에 노트 제목과 날짜(YYMMDD)를 포함해 어떤 설교의 산출물인지 파일명만 보고 알 수 있게 한다.
// 예: "260709_예수와함께물위를걷다_설교문요약.md"
function buildLocalOutputFileName(kind: "summary" | "qt" | "bible_study", frontmatter: SermonFrontmatter): string {
  const dateCode = formatDateCode(frontmatter.date);
  const titlePart = sanitizeFileNamePart(frontmatter.title);
  const parts = [dateCode, titlePart, LOCAL_OUTPUT_LABEL[kind]].filter(Boolean);
  return `${parts.join("_")}.md`;
}

function formatDateCode(date: string): string {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return "";
  return `${match[1]!.slice(2)}${match[2]}${match[3]}`;
}

function sanitizeFileNamePart(value: string): string {
  return value.trim().replaceAll(/[\\/:*?"<>|]/g, "").replaceAll(/\s+/g, "").slice(0, 60);
}

export interface PipelineContext {
  vaultPath: string; // Vault 루트 절대경로
  notePath: string; // Vault 루트 기준 상대경로
  settings: SermonMultiplierSettings;
  driveUploader: GoogleDriveUploader | null;
  slideStylesDir: string; // 절대경로
  onProgress?: (state: OutputRunState) => void;
}

export interface RunPipelineOptions {
  outputs: OutputKind[]; // landing_page 제외, 생성할 산출물 목록
  // "infographic"/"slides"에 적용할 비주얼 스타일 프리셋 id(.sermon-multiplier/slide-styles/*.md).
  styleIds?: Partial<Record<"infographic" | "slides", string | null>>;
  // 프리셋 대신(또는 프리셋보다 우선해) 그 자리에서 직접 입력한 스타일 지시문.
  styleTexts?: Partial<Record<"infographic" | "slides", string | null>>;
}

export interface RunPipelineResult {
  frontmatter: SermonFrontmatter;
  results: OutputRunState[];
}

export async function runPipeline(ctx: PipelineContext, options: RunPipelineOptions): Promise<RunPipelineResult> {
  const startedAt = new Date().toISOString();
  const absNotePath = join(ctx.vaultPath, ctx.notePath);
  const raw = await readFile(absNotePath, "utf8");
  let { frontmatter, body } = parseSermonNote(raw);
  // AI 프롬프트/NotebookLM 소스는 항상 원본 본문만 사용한다 — body는 아래에서 "## 산출물" 섹션이
  // 누적 추가되므로, 이후 산출물 프롬프트에 앞서 만든 임베드가 설교 본문처럼 섞여 들어가면 안 된다.
  const originalBody = body;

  const noteDirAbs = dirname(absNotePath);
  const noteDirRel = dirname(ctx.notePath);
  const results: OutputRunState[] = [];

  const emit = (state: OutputRunState) => {
    results.push(state);
    ctx.onProgress?.(state);
  };

  const localKinds = options.outputs.filter(
    (kind): kind is "summary" | "qt" | "bible_study" => LOCAL_AI_OUTPUTS.includes(kind),
  );
  for (const kind of localKinds) ctx.onProgress?.({ kind, status: "generating" });
  const localOutcomes = await Promise.allSettled(
    localKinds.map(async (kind) => {
      const template = resolvePromptTemplate(kind, ctx.settings.promptTemplates);
      const prompt = renderPrompt(template, frontmatter, originalBody);
      const command = await resolveAiCommand(ctx.settings.aiProvider, ctx.settings.aiCommand);
      const content = await runAiCommand(command, prompt, ctx.settings.aiCliTimeoutSeconds);
      return content.trim();
    }),
  );
  localKinds.forEach((kind, index) => {
    const outcome = localOutcomes[index]!;
    if (outcome.status === "fulfilled") {
      const content = outcome.value;
      frontmatter = { ...frontmatter, outputs: { ...frontmatter.outputs, [kind]: "embedded" } };
      body = upsertOutputSection(body, kind, content);
      emit({ kind, status: "complete", link: "embedded" });
    } else {
      emit({ kind, status: "error", message: describeError(outcome.reason) });
    }
  });

  const nlmKinds = options.outputs.filter(
    (kind): kind is "infographic" | "slides" | "video" | "audio" => NOTEBOOKLM_OUTPUTS.includes(kind),
  );
  if (nlmKinds.length > 0) {
    if (!ctx.driveUploader || !ctx.driveUploader.isConnected()) {
      for (const kind of nlmKinds) {
        emit({
          kind,
          status: "error",
          message: "Google Drive가 연결되어 있지 않습니다. 설정에서 먼저 연결한 뒤 다시 시도하세요.",
        });
      }
    } else if (!frontmatter.notebooklm.notebook_id) {
      for (const kind of nlmKinds) {
        emit({
          kind,
          status: "error",
          message: "NotebookLM 노트북 ID가 설정되어 있지 않습니다. 옵시디언 노트 설정이나 frontmatter에 notebook_id를 먼저 입력하세요.",
        });
      }
    } else {
      const uploader = ctx.driveUploader;
      const requests: NotebookLmArtifactRequest[] = [];
      for (const kind of nlmKinds) {
        requests.push({ kind });
        ctx.onProgress?.({ kind, status: "generating", message: "NotebookLM에서 가져오는 중..." });
      }

      const session = createNotebookLmSession(
        ctx.settings.notebooklmMcpCommand,
        300000,
      );
      const slug = slugifyNotePath(ctx.notePath);
      try {
        await session.start();
        const nlmResult = await generateNotebookLmOutputs({
          session,
          notebookId: frontmatter.notebooklm.notebook_id,
          requests,
          downloadDir: join(ctx.vaultPath, ".sermon-multiplier", "tmp", slug),
        });

        for (const artifact of nlmResult.results) {
          if (artifact.status === "waiting") {
            emit({
              kind: artifact.kind,
              status: "waiting",
              message: artifact.error || "NotebookLM Studio 웹 UI에서 아티팩트를 먼저 생성해주세요.",
            });
            continue;
          }

          if (artifact.status === "error" || !artifact.localFilePath || !artifact.mimeType) {
            emit({
              kind: artifact.kind,
              status: "error",
              message: `${artifact.error || "가져오기 실패"} — NotebookLM에서 아티팩트가 생성되어 있는지 확인하세요.`,
            });
            continue;
          }

          try {
            const driveResult = await uploader.uploadFile(
              artifact.localFilePath,
              `${artifact.kind}${extensionOf(artifact.localFilePath)}`,
              artifact.mimeType,
              `${ctx.settings.driveFolderRoot}/${basename(noteDirRel)}`,
            );

            // 로컬 임시 다운로드 파일 즉시 삭제
            try {
              await unlink(artifact.localFilePath);
            } catch (unlinkError) {
              console.error(`임시 파일 삭제 실패 (${artifact.localFilePath}):`, unlinkError);
            }

            const appliedStyleId =
              artifact.kind === "slides" || artifact.kind === "infographic" ? options.styleIds?.[artifact.kind] : null;
            frontmatter = {
              ...frontmatter,
              outputs: {
                ...frontmatter.outputs,
                [artifact.kind]: driveResult.webViewLink,
                ...(artifact.kind === "slides" && appliedStyleId ? { slides_style: appliedStyleId } : {}),
                ...(artifact.kind === "infographic" && appliedStyleId ? { infographic_style: appliedStyleId } : {}),
              },
            };
            const size = getRecommendedSize(categoryForOutput(artifact.kind));
            body = upsertOutputSection(body, artifact.kind, generateDriveEmbed(driveResult, size));
            emit({ kind: artifact.kind, status: "complete", link: driveResult.webViewLink });
          } catch (uploadError) {
            emit({ kind: artifact.kind, status: "error", message: `Drive 업로드 실패: ${describeError(uploadError)}` });
          }
        }
      } catch (error) {
        for (const kind of nlmKinds) {
          if (results.some((r) => r.kind === kind)) continue;
          emit({
            kind,
            status: "error",
            message: `NotebookLM 가져오기 실패: ${describeError(error)}`,
          });
        }
      } finally {
        session.stop();
      }
    }
  }

  frontmatter = { ...frontmatter, status: computeStatus(frontmatter) };
  await writeFile(absNotePath, serializeSermonNote(frontmatter, body), "utf8");

  await writeRunHistory(join(ctx.vaultPath, ".sermon-multiplier", "history"), slugifyNotePath(ctx.notePath), {
    notePath: ctx.notePath,
    startedAt,
    finishedAt: new Date().toISOString(),
    results,
  });

  return { frontmatter, results };
}

export interface GenerateLandingPageResult {
  outputPath: string;
  relativePath: string;
}

export async function generateLandingPage(ctx: Pick<PipelineContext, "vaultPath" | "notePath">): Promise<GenerateLandingPageResult> {
  const absNotePath = join(ctx.vaultPath, ctx.notePath);
  const raw = await readFile(absNotePath, "utf8");
  const { frontmatter, body } = parseSermonNote(raw);
  const noteDirAbs = dirname(absNotePath);
  const noteDirRel = dirname(ctx.notePath);

  const data: LandingPageData = {
    frontmatter,
    noteFileName: basename(ctx.notePath),
    infographic: toDriveResult(frontmatter.outputs.infographic),
    slides: toDriveResult(frontmatter.outputs.slides),
    video: toDriveResult(frontmatter.outputs.video),
    audio: toDriveResult(frontmatter.outputs.audio),
    summaryMarkdown: frontmatter.outputs.summary === "embedded"
      ? extractOutputSection(body, "summary")
      : await readLocalOutput(noteDirAbs, frontmatter.outputs.summary),
    qtMarkdown: frontmatter.outputs.qt === "embedded"
      ? extractOutputSection(body, "qt")
      : await readLocalOutput(noteDirAbs, frontmatter.outputs.qt),
    bibleStudyMarkdown: frontmatter.outputs.bible_study === "embedded"
      ? extractOutputSection(body, "bible_study")
      : await readLocalOutput(noteDirAbs, frontmatter.outputs.bible_study),
  };

  const html = buildLandingPage(LANDING_PAGE_TEMPLATE, data);
  const outputPath = join(noteDirAbs, "랜딩페이지.html");
  await writeFile(outputPath, html, "utf8");

  const updatedFrontmatter = { ...frontmatter, outputs: { ...frontmatter.outputs, landing_page: "랜딩페이지.html" } };
  await writeFile(absNotePath, serializeSermonNote(updatedFrontmatter, body), "utf8");

  return { outputPath, relativePath: join(noteDirRel, "랜딩페이지.html") };
}

// 임베드 크기 선택 모달(화면 4번)에서 호출 — 재생성 없이 이미 저장된 Drive 링크의 임베드 크기만 바꾼다.
export async function reembedOutput(
  ctx: Pick<PipelineContext, "vaultPath" | "notePath">,
  kind: "infographic" | "slides" | "video" | "audio",
  sizeId: string,
): Promise<void> {
  const absNotePath = join(ctx.vaultPath, ctx.notePath);
  const raw = await readFile(absNotePath, "utf8");
  const { frontmatter, body } = parseSermonNote(raw);
  const webViewLink = frontmatter.outputs[kind];
  if (!webViewLink) throw new Error("먼저 산출물을 생성하세요.");
  const fileId = extractDriveFileId(webViewLink);
  if (!fileId) throw new Error("Drive 파일 링크를 해석할 수 없습니다.");

  const size = getSizeById(categoryForOutput(kind), sizeId);
  const newBody = upsertOutputSection(
    body,
    kind,
    generateDriveEmbed({ fileId, webViewLink, fileName: "", mimeType: "" }, size),
  );
  await writeFile(absNotePath, serializeSermonNote(frontmatter, newBody), "utf8");
}

function buildSourceText(frontmatter: SermonFrontmatter, body: string): string {
  return [
    `제목: ${frontmatter.title}`,
    `본문 구절: ${frontmatter.scripture}`,
    `날짜: ${frontmatter.date}`,
    frontmatter.series ? `시리즈: ${frontmatter.series}` : "",
    "",
    body.trim(),
  ]
    .filter(Boolean)
    .join("\n");
}

function computeStatus(frontmatter: SermonFrontmatter): SermonFrontmatter["status"] {
  const generatedCount = ALL_GENERATABLE_OUTPUTS.filter((kind) => Boolean(frontmatter.outputs[kind])).length;
  if (generatedCount === 0) return "draft";
  if (generatedCount === ALL_GENERATABLE_OUTPUTS.length) return "complete";
  return "partial";
}

async function readLocalOutput(noteDirAbs: string, fileName: string | null): Promise<string | null> {
  if (!fileName) return null;
  try {
    return await readFile(join(noteDirAbs, fileName), "utf8");
  } catch {
    return null;
  }
}

function toDriveResult(webViewLink: string | null): LandingPageData["infographic"] {
  if (!webViewLink) return null;
  const fileId = extractDriveFileId(webViewLink);
  if (!fileId) return null;
  return { fileId, webViewLink, fileName: "", mimeType: "" };
}

function extensionOf(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  return dot === -1 ? "" : filePath.slice(dot);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
