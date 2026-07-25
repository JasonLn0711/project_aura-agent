import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function confirmQueueAction(page: Page) {
  await page.getByRole("button", { name: /會議紀錄/ }).click();
  const claim = page
    .getByText("目前 ASR 工作佇列未設定容量上限。", { exact: true })
    .locator("..");
  await expect(claim.getByText("待覆核")).toBeVisible();
  await claim.getByRole("button", { name: /確認/ }).click();
  await expect(claim.getByText("已確認")).toBeVisible();
}

async function openQueueRun(page: Page) {
  await confirmQueueAction(page);
  await page.getByRole("button", { name: /行動項目/ }).click();
  await page.getByRole("button", { name: /限制 ASR 佇列並加入背壓/ }).click();
  const planButton = page.getByRole("button", { name: "Delegate to Codex" });
  await expect(planButton).toBeEnabled();
  await planButton.click();
}

async function openQueueApproval(page: Page) {
  await openQueueRun(page);
  await page.getByRole("tab", { name: "Approvals" }).click();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /把會議證據/ })).toBeVisible();
});

test("01 demo boots without credentials and passes the main accessibility scan", async ({
  page,
}) => {
  await expect(page.getByText("DEMO MODE")).toBeVisible();
  await expect(page.getByText("Fixture ready")).toBeVisible();
  await expect(page.getByLabel("資料邊界：Local only")).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test("02 demo session loads", async ({ page }) => {
  await page.getByRole("button", { name: /會議紀錄/ }).click();
  await expect(
    page.getByText("VOISS × AURA 架構與可信任執行檢視"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Max.*先把會議證據/ }),
  ).toBeVisible();
});

test("03 unsupported claim cannot be confirmed", async ({ page }) => {
  await page.getByRole("button", { name: /會議紀錄/ }).click();
  const claim = page.getByText("目標設備具備可用 GPU。").locator("..");
  await expect(claim.getByRole("button", { name: /確認/ })).toBeDisabled();
  await expect(claim.getByText(/尚未提供設備探測證據/)).toBeVisible();
});

test("04 confirmed supported action becomes delegable", async ({ page }) => {
  await page.getByRole("button", { name: /行動項目/ }).click();
  await page.getByRole("button", { name: /限制 ASR 佇列並加入背壓/ }).click();
  for (const column of [
    "Action",
    "Meeting",
    "Owner",
    "Deadline",
    "Action status",
    "Support status",
    "Review status",
    "Sources",
    "Delegation",
    "Last agent run",
  ]) {
    await expect(
      page.getByRole("columnheader", { name: column, exact: true }),
    ).toBeVisible();
  }
  for (const filter of [
    "依 owner 篩選",
    "依期限篩選",
    "依證據狀態篩選",
    "依覆核狀態篩選",
    "依工作類型篩選",
    "依委派狀態篩選",
  ]) {
    await expect(page.getByLabel(filter)).toBeVisible();
  }
  await expect(
    page.getByRole("button", { name: "Delegate to Codex" }),
  ).toBeDisabled();

  await confirmQueueAction(page);
  await page.getByRole("button", { name: /行動項目/ }).click();
  await page.getByRole("button", { name: /限制 ASR 佇列並加入背壓/ }).click();
  await expect(
    page.getByRole("button", { name: "Delegate to Codex" }),
  ).toBeEnabled();
});

test("05 unconfirmed action cannot start Codex", async ({ page }) => {
  await page.getByRole("button", { name: /行動項目/ }).click();
  await page.getByRole("button", { name: /記錄模型 revision/ }).click();
  await expect(
    page.getByRole("button", { name: "Delegate to Codex" }),
  ).toBeDisabled();
});

test("06 read-only plan streams into the trusted run view", async ({
  page,
}) => {
  await openQueueRun(page);
  for (const tab of [
    "Overview",
    "Plan",
    "Activity",
    "Changes",
    "Validation",
    "Approvals",
    "Evidence Packet",
  ]) {
    await expect(page.getByRole("tab", { name: tab })).toBeVisible();
  }
  await page.getByRole("tab", { name: "Plan" }).click();
  await expect(page.getByRole("heading", { name: "唯讀計畫" })).toBeVisible();
  await expect(page.getByText("追蹤真實資料流")).toBeVisible();
  await expect(page.getByText("read-only")).toBeVisible();
});

test("07 write request pauses for operator approval", async ({ page }) => {
  await openQueueApproval(page);
  await expect(page.getByText("等待一次性檔案變更核准")).toBeVisible();
  await expect(page.getByRole("button", { name: "允許這一次" })).toBeEnabled();
});

test("08 denial preserves read-only state", async ({ page }) => {
  await openQueueApproval(page);
  await page.getByRole("button", { name: "拒絕" }).click();
  await expect(page.getByText(/工作樹保持未變更/)).toBeVisible();
  await expect(page.getByText("read-only")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Trusted diff" })).toHaveCount(
    0,
  );
});

test("09 allow once resumes the run", async ({ page }) => {
  await openQueueApproval(page);
  await page.getByRole("button", { name: "允許這一次" }).click();
  await expect(page.getByText("workspace-write")).toBeVisible();
  await page.getByRole("tab", { name: "Activity" }).click();
  await expect(page.getByText("建立隔離工作樹")).toBeVisible({
    timeout: 3_000,
  });
});

test("10 file changes appear in the trusted diff", async ({ page }) => {
  await openQueueApproval(page);
  await page.getByRole("button", { name: "允許這一次" }).click();
  await page.getByRole("tab", { name: "Changes" }).click();
  await expect(
    page.getByRole("heading", { name: "Trusted diff" }),
  ).toBeVisible();
  await expect(page.getByLabel("預期 demo diff")).toContainText(
    "queue.Queue(maxsize=",
  );
});

test("11 failed test prevents finding closure", async ({ page }) => {
  await openQueueApproval(page);
  await page.getByText("Demo validation branch").click();
  await page.getByLabel("示範測試失敗與 finding 保持 open").check();
  await page.getByRole("button", { name: "允許這一次" }).click();
  await page.getByRole("tab", { name: "Activity" }).click();
  await expect(page.getByText("驗證發現失敗")).toBeVisible({ timeout: 4_000 });
  await expect(
    page.getByText(/finding 與 evidence export gate 維持開放/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /匯出/ }).last(),
  ).toBeDisabled();
});

test("12 passed validation permits evidence export", async ({ page }) => {
  await openQueueApproval(page);
  await page.getByRole("button", { name: "允許這一次" }).click();
  await page.getByRole("tab", { name: "Activity" }).click();
  await expect(page.getByText("Run 已完成")).toBeVisible({ timeout: 4_000 });
  await page.getByRole("tab", { name: "Evidence Packet" }).click();
  const exportButton = page.getByRole("button", { name: /匯出/ }).last();
  await expect(exportButton).toBeEnabled();
  const download = page.waitForEvent("download");
  await exportButton.click();
  await expect(await download).toBeTruthy();
});

test("13 stop run terminates pending activity", async ({ page }) => {
  await openQueueApproval(page);
  await page.getByRole("button", { name: "允許這一次" }).click();
  await page.getByRole("tab", { name: "Activity" }).click();
  await page.getByRole("button", { name: /停止/ }).click();
  await expect(page.getByText(/事件串流已關閉/)).toBeVisible();
  await page.waitForTimeout(2_300);
  await expect(page.getByText("Run 已完成")).toHaveCount(0);
});

test("14 browser responses and DOM never receive auth tokens", async ({
  page,
}) => {
  const session = await page.request.get("/api/session");
  const body = await session.json();
  expect(body).toEqual(
    expect.objectContaining({
      mode: "demo",
      csrfToken: expect.any(String),
    }),
  );
  expect(JSON.stringify(body)).not.toContain("AURA_BRIDGE_TOKEN");
  await expect(page.locator("body")).not.toContainText(
    /Bearer |AURA_BRIDGE_TOKEN|CODEX_BRIDGE_TOKEN/,
  );
});

test("15 path traversal is rejected at the browser boundary", async ({
  page,
}) => {
  const response = await page.request.get(
    "/api/aura/v1/sessions/%2e%2e%2f%2e%2e%2fetc%2fpasswd",
  );
  expect([400, 404]).toContain(response.status());
});

test("16 disconnected bridge produces a recoverable local-mode error", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:3001");
  await expect(page.getByText("LOCAL MODE")).toBeVisible();
  await expect(
    page.getByLabel("資料邊界：Unknown/misconfigured"),
  ).toBeVisible();
  await expect(page.getByText(/bridge 尚未連線|可復原/).first()).toBeVisible();
  await page.getByRole("button", { name: /信任與稽核/ }).click();
  await page.getByRole("tab", { name: "Audit Timeline" }).click();
  await expect(page.getByText("control_plane.initialized")).toBeVisible();
  await page.getByRole("tab", { name: "Controls" }).click();
  await expect(page.getByText("CTRL-AURA-001")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("demo0004");
  await expect(
    page.getByText("限制 ASR 佇列並加入背壓", { exact: true }),
  ).toHaveCount(0);
});

test("17 local and demo modes cannot silently switch", async ({ page }) => {
  await page.getByRole("button", { name: /設定/ }).click();
  await expect(page.getByText("DEMO MODE")).toBeVisible();
  await expect(page.getByText("SEPARATE START")).toBeVisible();
  await expect(page.getByRole("radio").nth(1)).not.toBeChecked();
  await expect(
    page.getByText("VOISS_AGENT_DB_PATH", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("VOISS_OBSERVABILITY_LOG", { exact: true }).first(),
  ).toBeVisible();
});

test("18 audit events link the complete workflow", async ({ page }) => {
  await openQueueApproval(page);
  await page.getByRole("button", { name: "允許這一次" }).click();
  await page.getByRole("tab", { name: "Activity" }).click();
  await expect(page.getByText("Run 已完成")).toBeVisible({ timeout: 4_000 });
  await page.getByRole("button", { name: /信任與稽核/ }).click();
  await page.getByRole("tab", { name: "Audit Timeline" }).click();
  await expect(page.getByText("corr-demo-voiss-001")).toBeVisible();
  await expect(page.getByText("action.delegated")).toBeVisible();
  await expect(page.getByText("approval.allow_once")).toBeVisible();
  await expect(page.getByText("run.validated")).toBeVisible();
});

test("19 repeated demo executions use unique run IDs without an unhandled persistence response", async ({
  page,
}) => {
  const failedResponses: string[] = [];
  const pageErrors: string[] = [];
  page.on("response", (response) => {
    if (response.status() >= 500)
      failedResponses.push(`${response.status()} ${response.url()}`);
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await openQueueRun(page);
  const firstRunId = await page.getByLabel("Active run ID").textContent();
  expect(firstRunId).toMatch(/^run-demo-001-/);

  await page.reload();
  await confirmQueueAction(page);
  await page.getByRole("button", { name: /行動項目/ }).click();
  await page.getByRole("button", { name: /限制 ASR 佇列並加入背壓/ }).click();
  await page.getByRole("button", { name: "Delegate to Codex" }).click();
  const secondRunId = await page.getByLabel("Active run ID").textContent();

  expect(secondRunId).toMatch(/^run-demo-001-/);
  expect(secondRunId).not.toBe(firstRunId);
  expect(failedResponses).toEqual([]);
  expect(pageErrors).toEqual([]);
});
