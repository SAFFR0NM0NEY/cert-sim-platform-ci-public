import { test, expect } from "@playwright/test";
test("oversized startup saves are rejected atomically rather than claiming success", async ({
  page,
}) => {
  await page.goto("/network-studio.html");
  const seed = { version: 1, name: "Budget", devices: [], links: [] };
  const template = {
    id: "",
    name: "",
    kind: "server",
    x: 200,
    y: 200,
    powered: true,
    gateway: "",
    note: "",
    routes: [],
    ports: [
      {
        id: "p0",
        name: "GigabitEthernet0/0",
        media: "copper",
        enabled: true,
        ip: "",
        prefix: 24,
        vlan: 1,
        mode: "access",
        allowedVlans: [1],
      },
    ],
  };
  seed.devices = Array.from({ length: 7 }, (_, i) => ({
    ...structuredClone(template),
    id: `budget-${i}`,
    name: `Server-${i + 1}`,
    ports: [{ ...template.ports[0], ip: `10.0.0.${i + 1}` }],
    services: {
      dhcp: { enabled: false, pools: [], leases: [] },
      dns: { enabled: false, records: [] },
      http: {
        enabled: true,
        pages: Array.from({ length: 16 }, (_, p) => ({
          path: `/p${p}`,
          body: "x".repeat(16384),
        })),
      },
    },
  }));
  await page.locator("input[type=file]").setInputFiles({
    name: "budget.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(seed)),
  });
  await expect(page.getByRole("status")).toContainText("Opened");
  await page.getByRole("button", { name: "Save startup", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("2 MiB limit");
  await expect(page.getByLabel("Device startup configuration")).toContainText(
    "No startup copy saved",
  );
  expect(
    await page.evaluate(
      () =>
        "startupConfig" in
        JSON.parse(localStorage.getItem("certsim.network-studio.practice.v1"))
          .devices[0],
    ),
  ).toBe(false);
});
test.beforeEach(async ({ page }) => {
  await page.goto("/network-studio.html");
  await page
    .getByRole("heading", { name: "Your network, explained." })
    .waitFor();
});
test("startup controls restore saved config; erase/reload uses factory defaults and undo restores prior state", async ({
  page,
}) => {
  const ip = page.getByLabel("Interface IPv4 address");
  await ip.fill("192.168.10.77");
  await page
    .getByRole("button", { name: "Apply configuration", exact: true })
    .click();
  await page.getByRole("button", { name: "Save startup", exact: true }).click();
  await expect(page.getByLabel("Device startup configuration")).toContainText(
    "A startup copy is saved",
  );
  await ip.fill("192.168.10.88");
  await page
    .getByRole("button", { name: "Apply configuration", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Reload device", exact: true })
    .click();
  await expect(ip).toHaveValue("192.168.10.77");
  await page
    .getByRole("button", { name: "Erase startup", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Reload device", exact: true })
    .click();
  await expect(ip).toHaveValue("");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(ip).toHaveValue("192.168.10.77");
});
test("startup snapshots survive reload and malformed snapshot imports leave current state intact", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Save startup", exact: true }).click();
  await page.reload();
  await expect(page.getByLabel("Device startup configuration")).toContainText(
    "A startup copy is saved",
  );
  const raw = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("certsim.network-studio.practice.v1")),
  );
  raw.devices[0].startupConfig.ports[0].id = "injected";
  await page.locator("input[type=file]").setInputFiles({
    name: "invalid-startup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(raw)),
  });
  await expect(page.getByRole("status")).toContainText(
    "hardware interface inventory",
  );
  await expect(page.getByLabel("Interface IPv4 address")).toHaveValue(
    "192.168.10.10",
  );
});
