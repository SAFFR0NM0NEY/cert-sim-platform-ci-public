import { test, expect } from "@playwright/test";
test.beforeEach(async ({ page }) => {
  await page.goto("/network-studio.html");
  await page.getByRole("button", { name: "NAT pools", exact: true }).click();
  await page.getByRole("button", { name: "NAT", exact: true }).click();
  await page.getByRole("button", { name: "Realtime", exact: true }).click();
  await page.getByLabel("Ping destination").fill("203.0.113.200");
});
const panel = (page) =>
  page.getByRole("region", { name: "NAT configuration", exact: true });
test("one-to-one pools allocate two addresses and shared clear/expiry release bindings", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Send ping", exact: true }).click();
  await expect(panel(page).getByLabel("NAT translations")).toContainText(
    "203.0.113.10",
  );
  await page.getByLabel("Ping source").selectOption({ label: "Workstation-2" });
  await page.getByRole("button", { name: "Send ping", exact: true }).click();
  await expect(panel(page).getByLabel("NAT translations")).toContainText(
    "203.0.113.11",
  );
  await page.getByRole("button", { name: "Advance 300s", exact: true }).click();
  await expect(panel(page).getByLabel("NAT translations")).toContainText(
    "No active",
  );
  await page.getByRole("button", { name: "Send ping", exact: true }).click();
  await panel(page)
    .getByRole("button", { name: "Clear dynamic translations", exact: true })
    .click();
  await expect(panel(page).getByLabel("NAT translations")).toContainText(
    "No active",
  );
});
test("exhaustion is visible and switching the rule to overload enables shared public tuples", async ({
  page,
}) => {
  const p = panel(page);
  await p.getByLabel("Pool end 1", { exact: true }).fill("203.0.113.10");
  await p.getByRole("button", { name: "Apply NAT", exact: true }).click();
  await page.getByRole("button", { name: "Send ping", exact: true }).click();
  await page.getByLabel("Ping source").selectOption({ label: "Workstation-2" });
  await page.getByRole("button", { name: "Send ping", exact: true }).click();
  await expect(page.getByRole("status").last()).toContainText(
    "pool public exhausted",
  );
  await p
    .getByLabel("Pool allocation 1", { exact: true })
    .selectOption("overload");
  await p.getByRole("button", { name: "Apply NAT", exact: true }).click();
  for (const source of ["Workstation-1", "Workstation-2"]) {
    await page.getByLabel("Ping source").selectOption({ label: source });
    await page.getByRole("button", { name: "Send ping", exact: true }).click();
  }
  await expect(p.getByLabel("NAT translations")).toContainText(
    "203.0.113.10:20000",
  );
  await expect(p.getByLabel("NAT translations")).toContainText(
    "203.0.113.10:20001",
  );
});
test("mobile pool editing persists configuration and rejects a bad range without replacing state", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const p = panel(page);
  await p.getByLabel("Pool name 1", { exact: true }).fill("WAN");
  await p.getByRole("button", { name: "Apply NAT", exact: true }).click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await p.getByLabel("Pool end 1", { exact: true }).fill("203.0.113.9");
  await p.getByRole("button", { name: "Apply NAT", exact: true }).click();
  await expect(p.getByRole("alert")).toContainText("NAT pools");
  await page.reload();
  await page
    .getByRole("button", { name: "Router-1, Router", exact: true })
    .click();
  await page.getByRole("button", { name: "NAT", exact: true }).click();
  await expect(
    panel(page).getByLabel("Pool name 1", { exact: true }),
  ).toHaveValue("WAN");
  await expect(
    panel(page).getByLabel("Pool rule name 1", { exact: true }),
  ).toHaveValue("WAN");
  await expect(panel(page).getByLabel("NAT translations")).toContainText(
    "No active",
  );
});
