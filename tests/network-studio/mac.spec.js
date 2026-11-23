import { test, expect } from "@playwright/test";
test.beforeEach(async ({ page }) => {
  await page.goto("/network-studio.html");
});
async function macPanel(page) {
  await page
    .getByRole("button", { name: "Switch-1, Switch", exact: true })
    .click();
  return page.getByRole("region", { name: "MAC learning", exact: true });
}
test("ping learns MAC addresses; clearing and virtual aging update the actual table", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Realtime", exact: true }).click();
  await page.getByRole("button", { name: "Send ping", exact: true }).click();
  const panel = await macPanel(page);
  await expect(panel.getByLabel("Dynamic MAC table")).toContainText("VLAN 1");
  await expect(panel.getByLabel("Dynamic MAC table")).toContainText(
    "GigabitEthernet0/0",
  );
  await page.getByRole("button", { name: "Advance 300s", exact: true }).click();
  await expect(panel.getByLabel("Dynamic MAC table")).toContainText(
    "No learned",
  );
  await page.getByRole("button", { name: "Send ping", exact: true }).click();
  await expect(panel.getByLabel("Dynamic MAC table")).toContainText("VLAN 1");
  await panel
    .getByRole("button", { name: "Clear MAC table", exact: true })
    .click();
  await expect(panel.getByLabel("Dynamic MAC table")).toContainText(
    "No learned",
  );
});
test("frame workbench exposes flooding decisions and MAC CLI uses shared state", async ({
  page,
}) => {
  const panel = await macPanel(page);
  await panel.getByText("Ethernet frame test", { exact: true }).click();
  await panel
    .getByRole("button", { name: "Send Ethernet frame", exact: true })
    .click();
  await expect(panel.getByLabel("Dynamic MAC table")).toContainText("VLAN 1");
  await panel.getByText("Recent forwarding decisions", { exact: true }).click();
  await expect(panel.getByLabel("Ethernet forwarding decisions")).toContainText(
    "flood",
  );
  await page.getByRole("button", { name: "CLI", exact: true }).click();
  for (const line of [
    "show mac address-table",
    "enable",
    "clear mac address-table dynamic",
    "show mac address-table",
  ]) {
    await page.getByLabel("CLI command").fill(line);
    await page.getByLabel("CLI command").press("Enter");
  }
  await expect(page.getByRole("log", { name: "CLI output" })).toContainText(
    "DYNAMIC",
  );
  await expect(page.getByRole("log", { name: "CLI output" })).toContainText(
    "No learned MAC",
  );
});
test("mobile MAC settings persist but learned entries reset on browser reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const panel = await macPanel(page);
  await panel.getByLabel("MAC aging seconds").fill("1");
  await panel
    .getByRole("button", { name: "Apply MAC aging", exact: true })
    .click();
  await expect(panel.getByRole("alert")).toContainText("Use 0");
  await panel.getByLabel("MAC aging seconds").fill("60");
  await panel
    .getByRole("button", { name: "Apply MAC aging", exact: true })
    .click();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(panel.getByLabel("MAC aging seconds")).toHaveValue("300");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(panel.getByLabel("MAC aging seconds")).toHaveValue("60");
  await page.getByRole("button", { name: "Send ping", exact: true }).click();
  await expect(panel.getByLabel("Dynamic MAC table")).toContainText("VLAN 1");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.reload();
  const next = await macPanel(page);
  await expect(next.getByLabel("MAC aging seconds")).toHaveValue("60");
  await expect(next.getByLabel("Dynamic MAC table")).toContainText(
    "No learned",
  );
});
test("static MAC configuration persists and a wrong static port actually blocks forwarding", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Realtime", exact: true }).click();
  await page.getByRole("button", { name: "Send ping", exact: true }).click();
  const panel = await macPanel(page);
  const address = (
    await panel
      .getByLabel("Dynamic MAC table")
      .locator("strong")
      .last()
      .innerText()
  ).replace(/\./g, "");
  await panel.getByText("Static MAC entries", { exact: true }).click();
  await panel.getByLabel("Static MAC address").fill(address);
  await panel.getByLabel("Static MAC interface").selectOption("p3");
  await panel
    .getByRole("button", { name: "Add static MAC", exact: true })
    .click();
  await page.getByRole("button", { name: "Send ping", exact: true }).click();
  await expect(page.getByRole("status").last()).toContainText("ARP unresolved");
  await page.getByRole("button", { name: "Advance 300s", exact: true }).click();
  await expect(panel.getByLabel("Static MAC table")).toContainText(address);
  await page.reload();
  const next = await macPanel(page);
  await next.getByText("Static MAC entries", { exact: true }).click();
  await expect(next.getByLabel("Static MAC table")).toContainText(address);
});
test("the device neighbor cache shows live mappings, clears independently and resets after reload", async ({
  page,
}) => {
  await page.goto("/network-studio.html");
  await page.getByRole("button", { name: "Realtime", exact: true }).click();
  await page.getByRole("button", { name: "Send ping", exact: true }).click();
  await page
    .getByRole("button", { name: "Workstation-1, Workstation", exact: true })
    .click();
  const cache = page.getByRole("region", { name: "Address resolution cache" });
  await cache.getByText("ARP and IPv6 neighbors (1)", { exact: true }).click();
  await expect(cache).toContainText("14400s remaining");
  await page.getByRole("button", { name: "Send ping", exact: true }).click();
  await expect(
    page.getByRole("table").getByText("ARP", { exact: true }),
  ).toHaveCount(0);
  await cache.getByRole("button", { name: "Clear neighbor cache" }).click();
  await expect(cache).toContainText("No cached neighbors");
  await page.getByRole("button", { name: "Send ping", exact: true }).click();
  await expect(
    page.getByRole("table").getByText("ARP", { exact: true }),
  ).toHaveCount(2);
  await page.reload();
  await expect(
    cache.getByText("ARP and IPv6 neighbors (0)", { exact: true }),
  ).toBeVisible();
});
