import { test, expect } from "@playwright/test";
test.beforeEach(async ({ page }) => {
  await page.goto("/network-studio.html");
  await page
    .getByRole("button", { name: "Dual-stack / IPv6", exact: true })
    .click();
  await page.getByRole("button", { name: "Realtime", exact: true }).click();
  await page
    .getByLabel("Ping address family", { exact: true })
    .selectOption("ipv6");
});
test("IPv6 ping family controls trace real neighbor discovery and forwarding changes stop traffic", async ({
  page,
}) => {
  await expect(page.getByLabel("Ping destination")).toHaveValue(
    "2001:db8:20::100",
  );
  await page.getByRole("button", { name: "Send ping", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "IPv6 echo request and reply delivered",
  );
  await page.getByLabel("Protocol filter", { exact: true }).selectOption("NDP");
  await expect(page.getByRole("table").getByText("NDP").first()).toBeVisible();
  await page
    .getByRole("button", { name: "Router-1, Router", exact: true })
    .click();
  await page.getByRole("button", { name: "IPv6", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "Enable IPv6 forwarding" })
    .uncheck();
  await page
    .getByRole("button", { name: "Apply IPv6 configuration", exact: true })
    .click();
  await page.getByRole("button", { name: "Send ping", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "IPv6 forwarding is disabled",
  );
});
test("IPv6 route controls enforce independent reply paths and edits survive reload", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "Router-2, Router", exact: true })
    .click();
  await page.getByRole("button", { name: "IPv6", exact: true }).click();
  await page
    .getByRole("button", { name: "Remove IPv6 route", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Apply IPv6 configuration", exact: true })
    .click();
  await page.getByRole("button", { name: "Send ping", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "IPv6 request delivered; reply failed",
  );
  await page
    .getByRole("button", { name: "+ Add IPv6 route", exact: true })
    .click();
  await page
    .getByLabel("IPv6 next hop", { exact: true })
    .fill("2001:db8:ff::1");
  await page
    .getByRole("button", { name: "Apply IPv6 configuration", exact: true })
    .click();
  await page.getByRole("button", { name: "Send ping", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "IPv6 echo request and reply delivered",
  );
  await page.reload();
  await page
    .getByRole("button", { name: "Router-2, Router", exact: true })
    .click();
  await page.getByRole("button", { name: "IPv6", exact: true }).click();
  await expect(page.getByLabel("IPv6 next hop", { exact: true })).toHaveValue(
    "2001:db8:ff::1",
  );
});
test("mobile IPv6 config rejects malformed addresses and keeps the previous address", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Workstation-1, Workstation", exact: true })
    .click();
  await page.getByRole("button", { name: "IPv6", exact: true }).click();
  await page.getByLabel("Interface IPv6 address").fill("2001:::broken");
  await page
    .getByRole("button", { name: "Apply IPv6 configuration", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Invalid unicast IPv6");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.reload();
  await page.getByRole("button", { name: "IPv6", exact: true }).click();
  await expect(page.getByLabel("Interface IPv6 address")).toHaveValue(
    "2001:db8:10::10",
  );
});

test("AAAA queries and cached HTTP answers use the configured server and TTL", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "Server-1, Server", exact: true })
    .click();
  await page.getByRole("button", { name: "Services", exact: true }).click();
  await page.getByLabel("TTL (seconds)", { exact: true }).first().fill("10");
  await page
    .getByRole("button", { name: "Apply services", exact: true })
    .click();
  await page.getByLabel("Application", { exact: true }).selectOption("dns");
  await page.getByLabel("Query type", { exact: true }).selectOption("AAAA");
  await page.getByRole("button", { name: "Resolve name" }).click();
  await expect(page.getByRole("status")).toContainText("2001:db8:20::100");
  await page.getByLabel("Application", { exact: true }).selectOption("http");
  await page.getByRole("button", { name: "Browse lab site" }).click();
  await page
    .getByRole("button", { name: "Workstation-1, Workstation", exact: true })
    .click();
  const cache = page.getByRole("region", { name: "Address resolution cache" });
  await cache.getByText("DNS resolver cache (1)", { exact: true }).click();
  await expect(cache).toContainText("10s remaining");
  await page.getByRole("button", { name: "Advance 10s" }).click();
  await expect(cache.getByText("No cached DNS answers.")).toBeVisible();
  await page.getByRole("button", { name: "Browse lab site" }).click();
  await cache.getByRole("button", { name: "Clear DNS cache" }).click();
  await expect(cache.getByText("No cached DNS answers.")).toBeVisible();
});

test("saved IPv6 probes stop at their hop limit and replay a routed delivery", async ({
  page,
}) => {
  const panel = page.getByRole("region", { name: "User-created PDUs" });
  await panel.getByText("User-created PDUs (0)", { exact: true }).click();
  await panel.getByLabel("PDU protocol").selectOption("icmpv6");
  await panel.getByLabel("PDU destination").selectOption({ label: "Server-1" });
  await panel.getByLabel("Hop limit").fill("2");
  await panel.getByRole("button", { name: "Add and send PDU" }).click();
  await expect(panel).toContainText("Failed · Hop limit 2");
  await expect(page.getByRole("status")).toContainText("expired on Router-2");
  await panel.getByLabel("Hop limit").fill("3");
  await panel.getByLabel("IPv6 PDU source interface").selectOption("p0");
  await panel.getByRole("button", { name: "Add and send PDU" }).click();
  await expect(panel).toContainText("Delivered · Hop limit 3");
  await page.reload();
  await page.getByRole("button", { name: "Realtime", exact: true }).click();
  await panel.getByText("User-created PDUs (2)", { exact: true }).click();
  await panel.getByRole("button", { name: "Send again" }).last().click();
  await panel.getByRole("button", { name: "View trace" }).last().click();
  await expect(page.getByRole("status")).toContainText(
    "IPv6 echo request and reply delivered",
  );
});
