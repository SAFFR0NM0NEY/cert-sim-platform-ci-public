import { test, expect } from "@playwright/test";
test.beforeEach(async ({ page }) => {
  await page.goto("/network-studio.html");
  await page
    .getByRole("button", { name: "Redundant LAN / STP", exact: true })
    .click();
});
async function saved(page) {
  return page.evaluate(() =>
    JSON.parse(localStorage.getItem("certsim.network-studio.practice.v1")),
  );
}
test("root selection config changes operational roles and persists with undo", async ({
  page,
}) => {
  const panel = page.getByRole("region", {
    name: "Spanning tree",
    exact: true,
  });
  await expect(panel).toContainText("Root: Switch-1");
  await page.getByRole("button", { name: /^Switch-2, Switch/ }).click();
  await panel.getByLabel("Bridge priority", { exact: true }).selectOption("0");
  await panel
    .getByRole("button", { name: "Apply spanning tree", exact: true })
    .click();
  await expect(panel).toContainText("Root: Switch-2");
  const before = await saved(page);
  expect(before.devices[3].spanningTree.priorities[0].priority).toBe(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(panel).toContainText("Root: Switch-1");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: /^Switch-2, Switch/ }).click();
  await expect(panel).toContainText("Root: Switch-2");
});
test("blocked redundant path becomes a root path after actual link failure and carries ICMP", async ({
  page,
}) => {
  await page.getByRole("button", { name: /^Switch-3, Switch/ }).click();
  const panel = page.getByRole("region", {
    name: "Spanning tree",
    exact: true,
  });
  await expect(panel.getByLabel("Spanning-tree port roles")).toContainText(
    "alternate · blocking",
  );
  const t = await saved(page);
  t.devices[2].ports[1].enabled = false;
  await page.locator("input[type=file]").setInputFiles({
    name: "link-failed.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(t)),
  });
  await page.getByRole("button", { name: /^Switch-2, Switch/ }).click();
  await expect(panel.getByLabel("Spanning-tree port roles")).toContainText(
    "root · forwarding",
  );
  await page.getByRole("button", { name: "Realtime", exact: true }).click();
  await page
    .getByLabel("Ping destination", { exact: true })
    .fill("192.168.30.20");
  await page.getByRole("button", { name: "Send ping", exact: true }).click();
  await expect(page.getByRole("status").last()).toContainText(
    "echo request and reply delivered",
  );
  await expect(page.locator(".ns-event-table")).toContainText("Switch-3");
});
test("mobile spanning tree controls validate costs and CLI shows actual configured state", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const panel = page.getByRole("region", {
    name: "Spanning tree",
    exact: true,
  });
  await panel.getByText("Interface path costs", { exact: true }).click();
  const first = panel
    .getByRole("spinbutton", { name: /Spanning-tree cost/ })
    .first();
  await first.fill("30");
  await panel
    .getByRole("button", { name: "Apply spanning tree", exact: true })
    .click();
  expect((await saved(page)).devices[2].ports[0].spanningTreeCost).toBe(30);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "CLI", exact: true }).click();
  const cli = page.getByLabel("CLI command", { exact: true });
  await cli.fill("show spanning-tree vlan 1");
  await cli.press("Enter");
  await expect(page.getByRole("log", { name: "CLI output" })).toContainText(
    "Root: Switch-1",
  );
  await expect(page.getByRole("log", { name: "CLI output" })).toContainText(
    "forwarding",
  );
});
