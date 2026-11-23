import { test, expect } from "@playwright/test";
test("hairpin reflection is opt-in, displays tuples, clears and persists only configuration", async ({
  page,
}) => {
  await page.goto("/network-studio.html");
  await page.getByRole("button", { name: "NAT pools", exact: true }).click();
  await page.getByRole("button", { name: "NAT", exact: true }).click();
  const p = page.getByRole("region", {
    name: "NAT configuration",
    exact: true,
  });
  await p.getByLabel("Enable hairpin reflection").check();
  await p.getByRole("button", { name: "Apply NAT", exact: true }).click();
  await page.getByRole("button", { name: "Realtime", exact: true }).click();
  await page.getByLabel("Ping destination").fill("203.0.113.100");
  await page.getByRole("button", { name: "Send ping", exact: true }).click();
  await expect(p.getByLabel("NAT translations")).toContainText("Hairpin ICMP");
  await expect(p.getByLabel("NAT translations")).toContainText(
    "192.168.50.1:20000",
  );
  await p
    .getByRole("button", { name: "Clear dynamic translations", exact: true })
    .click();
  await expect(p.getByLabel("NAT translations")).toContainText("No active");
  await page.reload();
  await page
    .getByRole("button", { name: "Router-1, Router", exact: true })
    .click();
  await page.getByRole("button", { name: "NAT", exact: true }).click();
  await expect(p.getByLabel("Enable hairpin reflection")).toBeChecked();
  await expect(p.getByLabel("NAT translations")).toContainText("No active");
});
test("mobile hairpin expiry uses shared virtual clock", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/network-studio.html");
  await page.getByRole("button", { name: "NAT pools", exact: true }).click();
  await page.getByRole("button", { name: "NAT", exact: true }).click();
  const p = page.getByRole("region", {
    name: "NAT configuration",
    exact: true,
  });
  await p.getByLabel("Enable hairpin reflection").check();
  await p.getByRole("button", { name: "Apply NAT", exact: true }).click();
  await page.getByRole("button", { name: "Realtime", exact: true }).click();
  await page.getByLabel("Ping destination").fill("203.0.113.100");
  await page.getByRole("button", { name: "Send ping", exact: true }).click();
  await expect(p.getByLabel("NAT translations")).toContainText("Hairpin");
  await page.getByRole("button", { name: "Advance 60s", exact: true }).click();
  await expect(p.getByLabel("NAT translations")).toContainText("No active");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
