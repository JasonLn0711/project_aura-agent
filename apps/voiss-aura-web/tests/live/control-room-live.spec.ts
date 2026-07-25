import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("live local end-to-end uses AURA evidence and official Codex runtime", async ({
  page,
}) => {
  test.skip(
    process.env.VOISS_LIVE_E2E !== "1",
    "Requires both loopback bridges.",
  );

  const runtimeErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error")
      runtimeErrors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) =>
    runtimeErrors.push(`pageerror: ${error.message}`),
  );
  page.on("response", (response) => {
    if (response.status() >= 500) {
      runtimeErrors.push(`http ${response.status()}: ${response.url()}`);
    }
  });

  await page.goto("/");
  await expect(page.getByText("LOCAL MODE")).toBeVisible();
  await expect(page.getByText("本機服務就緒")).toHaveCount(2, {
    timeout: 30_000,
  });
  await expect(page.getByLabel("資料邊界：Cloud model enabled")).toBeVisible();

  await page.getByRole("button", { name: /會議紀錄/ }).click();
  const claim = page
    .getByText(/src\/aura\/asr\/threads\.py.*python3 -m pytest -q/)
    .locator("..");
  await claim.getByRole("button", { name: /確認/ }).click();
  await expect(page.getByText(/已記錄/)).toBeVisible();

  await page.getByRole("button", { name: /Control Room/ }).click();
  await page.getByRole("button", { name: /Codex delegation/ }).click();
  await page.getByRole("tab", { name: "Approvals" }).click();
  const writeApproval = page.getByRole("heading", {
    name: "啟用隔離工作樹寫入",
  });
  for (
    let attempt = 0;
    attempt < 90 && !(await writeApproval.isVisible());
    attempt += 1
  ) {
    if (await page.getByText(/Codex runtime 回報可復原錯誤/).isVisible()) {
      throw new Error("Codex runtime reported a recoverable planning error.");
    }
    await page.waitForTimeout(2_000);
  }
  await expect(writeApproval).toBeVisible();

  const exportButton = page.getByRole("button", { name: /匯出/ }).last();
  for (
    let attempt = 0;
    attempt < 120 && !(await exportButton.isEnabled());
    attempt += 1
  ) {
    if (await page.getByText(/Codex runtime 回報可復原錯誤/).isVisible()) {
      throw new Error("Codex runtime reported a recoverable error.");
    }
    const approval = page.getByRole("button", { name: "允許這一次" });
    if (await approval.isVisible()) await approval.click();
    await page.waitForTimeout(2_000);
  }

  await expect(exportButton).toBeEnabled({ timeout: 180_000 });
  await page.getByRole("tab", { name: "Changes" }).click();
  await expect(page.getByLabel("真實 Codex diff")).toContainText("maxsize=8");
  await page.getByRole("tab", { name: "Validation" }).click();
  const validationPanel = page.getByRole("tabpanel", { name: "Validation" });
  await expect(
    validationPanel.getByRole("heading", { name: "Validation" }),
  ).toBeVisible();
  await expect(validationPanel.getByText(/pytest/)).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 30_000 }),
    exportButton.click(),
  ]);
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const manifest = JSON.parse(await readFile(downloadPath!, "utf-8")) as {
    schema: string;
    classification: string;
    correlationId: string;
    runId: string;
    sourceSessionId: string;
    sourceAction: {
      id: string;
      evidence: Array<{ locator: string }>;
    };
    sourceEvidenceRefs: string[];
    artifacts: Array<{ kind: string; sha256?: string }>;
  };
  expect(manifest.schema).toBe("voiss.codex.export-manifest.v1");
  expect(manifest.classification).toBe("live_codex_evidence");
  expect(manifest.correlationId).toMatch(/^corr-[a-f0-9]{32}$/);
  expect(manifest.runId).toBeTruthy();
  expect(manifest.sourceSessionId).toBeTruthy();
  expect(manifest.sourceAction.id).toBeTruthy();
  expect(manifest.sourceEvidenceRefs).toEqual(
    manifest.sourceAction.evidence.map((item) => item.locator),
  );
  expect(manifest.sourceEvidenceRefs.length).toBeGreaterThan(0);
  expect(manifest.artifacts.map((item) => item.kind)).toEqual(
    expect.arrayContaining(["patch", "evidence", "checksums"]),
  );
  expect(
    manifest.artifacts.find((item) => item.kind === "evidence")?.sha256,
  ).toMatch(/^[a-f0-9]{64}$/);

  await page.getByRole("tab", { name: "Evidence Packet" }).click();
  const [patchDownload] = await Promise.all([
    page.waitForEvent("download", { timeout: 30_000 }),
    page.getByRole("link", { name: /changes\.patch/ }).click(),
  ]);
  const patchPath = await patchDownload.path();
  expect(patchPath).not.toBeNull();
  expect(await readFile(patchPath!, "utf-8")).toContain(
    "queue.Queue(maxsize=8)",
  );

  await page.getByRole("button", { name: /信任與稽核/ }).click();
  await page.getByRole("tab", { name: "Audit Timeline" }).click();
  await expect(page.getByText("evidence.exported").last()).toBeVisible();
  await page.getByRole("tab", { name: "Findings" }).click();
  await expect(
    page.locator(".finding").filter({ hasText: "R-002" }),
  ).toContainText("open");

  const localRoot = process.env.VOISS_LIVE_REPO_ROOT;
  if (localRoot)
    await expect(page.locator("body")).not.toContainText(localRoot);
  expect(runtimeErrors).toEqual([]);
});
