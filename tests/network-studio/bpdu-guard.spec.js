import { test, expect } from "@playwright/test";

const button = (page, name) => page.getByRole("button", { name, exact: true });
const panel = (page) =>
  page.getByRole("region", { name: "Spanning tree", exact: true });
const status = (page, port) =>
  panel(page).getByLabel("Spanning-tree protection GigabitEthernet0/" + port, {
    exact: true,
  });
const details = (page, port) =>
  panel(page)
    .locator("details.ns-stp-protection")
    .filter({
      has: page.getByLabel("PortFast GigabitEthernet0/" + port, {
        exact: true,
      }),
    });
async function reveal(page, port) {
  const row = details(page, port);
  if ((await row.getAttribute("open")) === null)
    await row.locator("summary").click();
}
async function openLab(page) {
  await page.goto("/network-studio.html");
  await button(page, "PortFast / BPDU Guard").click();
  await button(page, "Realtime").click();
}
async function roguePower(page, enabled) {
  await page
    .getByRole("button", { name: /^Unapproved-Switch, Switch/ })
    .click();
  await page.getByLabel("Power on", { exact: true }).setChecked(enabled);
  await button(page, "Apply configuration").click();
  await button(page, "Edge-Access, Switch").click();
}

test("guarded host ports forward while a switch BPDU shuts only its edge port, with latched recovery", async ({
  page,
}, testInfo) => {
  await openLab(page);
  await expect(status(page, 0)).toContainText("Operational edge: yes");
  await expect(status(page, 7)).toContainText(
    "Configured PortFast: enabled · Operational edge: no",
  );
  await expect(status(page, 2)).toContainText("Err-disabled · BPDU Guard");
  await page.getByLabel("Ping destination").fill("192.168.44.100");
  await button(page, "Send ping").click();
  await expect(page.getByRole("status")).toContainText(
    "echo request and reply delivered",
  );
  await page.getByLabel("Ping source").selectOption({ label: "Branch-PC" });
  await button(page, "Send ping").click();
  await expect(page.getByRole("status")).not.toContainText(
    "echo request and reply delivered",
  );
  await reveal(page, 2);
  await button(page, "Recover BPDU Guard GigabitEthernet0/2").click();
  await expect(status(page, 2)).toContainText("Err-disabled · BPDU Guard");
  await details(page, 2).screenshot({
    path: testInfo.outputPath("bpdu-guard-desktop.png"),
  });
  await roguePower(page, false);
  await expect(status(page, 2)).toContainText("Err-disabled · BPDU Guard");
  await button(page, "Clear learned state").click();
  await expect(status(page, 2)).toContainText("Err-disabled · BPDU Guard");
  await reveal(page, 2);
  await button(page, "Recover BPDU Guard GigabitEthernet0/2").click();
  await expect(status(page, 2)).not.toContainText("Err-disabled");
  await expect(status(page, 2)).toContainText("Operational edge: no");
  await expect(
    button(page, "Recover BPDU Guard GigabitEthernet0/2"),
  ).toBeDisabled();
  await roguePower(page, true);
  await expect(status(page, 2)).toContainText("Err-disabled · BPDU Guard");
  await button(page, "Links").click();
  await expect(page.locator(".ns-device-links")).toContainText(/BPDU Guard/i);
});

test("automatic BPDU recovery shares the security interval and startup configuration survives reload", async ({
  page,
}) => {
  await openLab(page);
  const recovery = panel(page).getByRole("form", {
    name: "BPDU Guard recovery",
  });
  await recovery
    .getByLabel("Recover BPDU Guard shutdowns automatically")
    .check();
  await recovery.getByLabel("Shared recovery interval (seconds)").fill("60");
  await button(page, "Apply BPDU Guard recovery").click();
  const security = page.getByRole("form", {
    name: "Automatic security recovery",
  });
  await security.getByLabel("Recover security shutdowns automatically").check();
  await security.getByLabel("Recovery interval (seconds)").fill("30");
  await button(page, "Apply recovery settings").click();
  await expect(
    recovery.getByLabel("Shared recovery interval (seconds)"),
  ).toHaveValue("30");
  await expect(
    recovery.getByLabel("Recover BPDU Guard shutdowns automatically"),
  ).toBeChecked();
  await roguePower(page, false);
  await expect(status(page, 2)).toContainText("Automatic recovery in 30s");
  await button(page, "Advance 10s").click();
  await expect(status(page, 2)).toContainText("Automatic recovery in 20s");
  await button(page, "Advance 60s").click();
  await expect(status(page, 2)).not.toContainText("Err-disabled");
  await button(page, "Save startup").click();
  await panel(page).getByLabel("PortFast by default on access ports").uncheck();
  await panel(page)
    .getByLabel("BPDU Guard by default on PortFast ports")
    .uncheck();
  await button(page, "Apply spanning tree").click();
  await button(page, "Reload device").click();
  await expect(
    panel(page).getByLabel("PortFast by default on access ports"),
  ).toBeChecked();
  await expect(
    panel(page).getByLabel("BPDU Guard by default on PortFast ports"),
  ).toBeChecked();
  await expect(
    recovery.getByLabel("Shared recovery interval (seconds)"),
  ).toHaveValue("30");
  await expect(
    security.getByLabel("Recover security shutdowns automatically"),
  ).toBeChecked();
  await page.reload();
  await button(page, "Edge-Access, Switch").click();
  await expect(
    recovery.getByLabel("Recover BPDU Guard shutdowns automatically"),
  ).toBeChecked();
  await expect(
    recovery.getByLabel("Shared recovery interval (seconds)"),
  ).toHaveValue("30");
});

test("mobile PortFast overrides distinguish configured and effective edge and exclude routed ports", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/network-studio.html");
  await button(page, "Switch-1, Switch").click();
  await panel(page).getByLabel("PortFast by default on access ports").check();
  await panel(page)
    .getByLabel("BPDU Guard by default on PortFast ports")
    .check();
  await reveal(page, 0);
  await page
    .getByLabel("PortFast GigabitEthernet0/0", { exact: true })
    .selectOption("disable");
  await page
    .getByLabel("BPDU Guard GigabitEthernet0/0", { exact: true })
    .selectOption("enable");
  await button(page, "Apply spanning tree").click();
  await expect(status(page, 0)).toContainText(
    "Configured PortFast: disabled · Operational edge: no",
  );
  await expect(status(page, 0)).toContainText("Effective BPDU Guard: enabled");
  await page.getByLabel("Interface", { exact: true }).selectOption("p1");
  await page
    .getByRole("combobox", { name: "Port mode", exact: true })
    .selectOption("trunk");
  await button(page, "Apply configuration").click();
  await expect(status(page, 1)).toContainText("Configured PortFast: disabled");
  await reveal(page, 1);
  await page
    .getByLabel("PortFast GigabitEthernet0/1", { exact: true })
    .selectOption("trunk");
  await button(page, "Apply spanning tree").click();
  await expect(status(page, 1)).toContainText(
    "Configured PortFast: enabled · Operational edge: yes",
  );
  await page.getByLabel("Interface", { exact: true }).selectOption("p7");
  await page.getByLabel("Routed port", { exact: true }).check();
  await button(page, "Apply configuration").click();
  await expect(
    page.getByLabel("PortFast GigabitEthernet0/7", { exact: true }),
  ).toHaveCount(0);
  await reveal(page, 1);
  await button(page, "Apply spanning tree").click();
  await expect(button(page, "Apply spanning tree")).toBeInViewport();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 2,
    ),
  ).toBe(true);
  await panel(page).screenshot({
    path: testInfo.outputPath("bpdu-mobile.png"),
  });
  await page.reload();
  await button(page, "Switch-1, Switch").click();
  await reveal(page, 1);
  await expect(
    page.getByLabel("PortFast GigabitEthernet0/1", { exact: true }),
  ).toHaveValue("trunk");
});

test("a rejected VTP expansion leaves the imported topology and BPDU runtime unchanged", async ({
  page,
}) => {
  await openLab(page);
  const original = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("certsim.network-studio.practice.v1")),
  );
  original.name = "Pending protocol changes";
  const template = original.devices.find((d) => d.name === "Edge-Access");
  const defaults = template.vlans;
  const switches = Array.from({ length: 40 }, (_, i) => {
    const d = structuredClone(template);
    d.id = "vtp-limit-" + i;
    d.name = "VTP peer " + i;
    d.x = 40 + (i % 20) * 52;
    d.y = 560 + Math.floor(i / 20) * 60;
    d.spanningTree = { priorities: [] };
    d.vtp = {
      mode: i ? "client" : "server",
      domain: "LIMIT",
      version: 1,
      revision: i ? 0 : 1,
    };
    d.ports.slice(0, 2).forEach((p) => {
      p.mode = "trunk";
      p.allowedVlans = [1];
    });
    if (i === 0)
      d.vlans = [
        ...defaults,
        ...Array.from({ length: 1000 }, (_, n) => ({
          id: n + 2,
          name: "Managed VLAN " + (n + 2),
          state: "active",
        })),
      ];
    return d;
  });
  original.devices.push(...switches);
  for (let i = 1; i < switches.length; i++)
    original.links.push({
      id: "vtp-limit-link-" + i,
      a: { device: switches[i - 1].id, port: "p1" },
      b: { device: switches[i].id, port: "p0" },
      cable: "copper",
    });
  await page.locator("input[type=file]").setInputFiles({
    name: "pending.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(original)),
  });
  await expect(page.getByLabel("Network name")).toHaveValue(original.name);
  await button(page, "Edge-Access, Switch").click();
  await expect(status(page, 2)).not.toContainText("Err-disabled");
  await page
    .getByLabel("Device palette")
    .getByRole("button", { name: /Workstation/ })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Workspace exceeds the 2 MiB limit",
  );
  await button(page, "Edge-Access, Switch").click();
  await expect(status(page, 2)).not.toContainText("Err-disabled");
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("certsim.network-studio.practice.v1")),
  );
  expect(saved.devices).toHaveLength(original.devices.length);
  expect(saved.devices.find((d) => d.name === "VTP peer 1").vtp.revision).toBe(
    0,
  );
});
