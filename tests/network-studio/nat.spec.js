import { test, expect } from "@playwright/test";
test.beforeEach(async ({ page }) => {
  await page.goto("/network-studio.html");
  await page
    .getByRole("button", { name: "NAT edge / PAT", exact: true })
    .click();
});
const nat = (page) =>
  page.getByRole("region", { name: "NAT configuration", exact: true });
test("PAT ping and HTTP populate translations; clock expiry and clear affect shared runtime", async ({
  page,
}) => {
  await page.getByRole("button", { name: "NAT", exact: true }).click();
  await page.getByRole("button", { name: "Realtime", exact: true }).click();
  await page.getByLabel("Ping destination").fill("203.0.113.200");
  await page.getByRole("button", { name: "Send ping", exact: true }).click();
  await expect(nat(page).getByLabel("NAT translations")).toContainText(
    "ICMP 192.168.50.10:1",
  );
  await expect(nat(page).getByLabel("NAT translations")).toContainText(
    "203.0.113.1:20000",
  );
  await page.getByLabel("Application", { exact: true }).selectOption("http");
  await page
    .getByLabel("Lab URL", { exact: true })
    .fill("http://203.0.113.200/");
  await page
    .getByRole("button", { name: "Browse lab site", exact: true })
    .click();
  await expect(page.getByLabel("HTTP response body")).toContainText(
    "public server",
  );
  await expect(nat(page).getByLabel("NAT translations")).toContainText("TCP");
  await page.getByRole("button", { name: "Advance 60s", exact: true }).click();
  await expect(nat(page).getByLabel("NAT translations")).not.toContainText(
    "ICMP",
  );
  await expect(nat(page).getByLabel("NAT translations")).toContainText("TCP");
  await nat(page)
    .getByRole("button", { name: "Clear dynamic translations", exact: true })
    .click();
  await expect(nat(page).getByLabel("NAT translations")).toContainText(
    "No active",
  );
});
test("outside HTTP resolves static public alias to private service and roles change delivery", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Realtime", exact: true }).click();
  await page
    .getByLabel("Application client", { exact: true })
    .selectOption({ label: "Server-2" });
  await page.getByLabel("Application", { exact: true }).selectOption("http");
  await page
    .getByLabel("Lab URL", { exact: true })
    .fill("http://203.0.113.100/");
  await page
    .getByRole("button", { name: "Browse lab site", exact: true })
    .click();
  await expect(page.getByLabel("HTTP response body")).toContainText(
    "private server",
  );
  await page.getByRole("button", { name: "NAT", exact: true }).click();
  await nat(page)
    .getByLabel("NAT role GigabitEthernet0/1", { exact: true })
    .selectOption("");
  await nat(page)
    .getByRole("button", { name: "Apply NAT", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Browse lab site", exact: true })
    .click();
  await expect(page.getByRole("status").last()).toContainText("ARP unresolved");
});
test("mobile NAT config persists, dynamic translations do not, and invalid aliases preserve the network", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "NAT", exact: true }).click();
  await nat(page)
    .getByLabel("Inside global 1", { exact: true })
    .fill("203.0.113.101");
  await nat(page)
    .getByRole("button", { name: "Apply NAT", exact: true })
    .click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.reload();
  await page
    .getByRole("button", { name: "Router-1, Router", exact: true })
    .click();
  await page.getByRole("button", { name: "NAT", exact: true }).click();
  await expect(
    nat(page).getByLabel("Inside global 1", { exact: true }),
  ).toHaveValue("203.0.113.101");
  await expect(nat(page).getByLabel("NAT translations")).toContainText(
    "No active",
  );
  const before = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("certsim.network-studio.practice.v1")),
  );
  const bad = structuredClone(before);
  bad.devices[4].nat.static[0].outside = "203.0.113.200";
  await page.locator("input[type=file]").setInputFiles({
    name: "bad-nat.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(bad)),
  });
  await expect(page.getByRole("status").first()).toContainText(
    "conflicting NAT public",
  );
  await expect(
    nat(page).getByLabel("Inside global 1", { exact: true }),
  ).toHaveValue("203.0.113.101");
});
test("TCP port-forward controls expose a private HTTP service at a public alternate port", async ({
  page,
}) => {
  await page.getByRole("button", { name: "NAT", exact: true }).click();
  const panel = nat(page);
  await panel
    .getByRole("button", { name: "Remove static 1", exact: true })
    .click();
  await panel
    .getByRole("button", { name: "Add port forward", exact: true })
    .click();
  await panel
    .getByLabel("Port forward private address 1", { exact: true })
    .fill("192.168.50.100");
  await panel.getByRole("button", { name: "Apply NAT", exact: true }).click();
  await page
    .getByLabel("Application client", { exact: true })
    .selectOption({ label: "Server-2" });
  await page.getByLabel("Application", { exact: true }).selectOption("http");
  await page
    .getByLabel("Lab URL", { exact: true })
    .fill("http://203.0.113.1:8080/");
  await page
    .getByRole("button", { name: "Browse lab site", exact: true })
    .click();
  await expect(page.getByLabel("HTTP response body")).toContainText(
    "private server",
  );
  await page.reload();
  await page
    .getByRole("button", { name: "Router-1, Router", exact: true })
    .click();
  await page.getByRole("button", { name: "NAT", exact: true }).click();
  await expect(
    nat(page).getByLabel("Port forward public port 1", { exact: true }),
  ).toHaveValue("8080");
});
