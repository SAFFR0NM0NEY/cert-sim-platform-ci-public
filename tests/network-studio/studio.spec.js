import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/network-studio.html");
  await expect(
    page.getByRole("heading", { name: "Your network, explained." }),
  ).toBeVisible();
});
test("example LAN traces packets, inspects events and fails after a real configuration change", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByLabel("Ping destination").fill("192.168.10.20");
  await page.getByRole("button", { name: "Send ping" }).click();
  await expect(page.getByRole("status")).toContainText("queued");
  await page.getByRole("button", { name: "Step forward" }).click();
  await expect(
    page.getByRole("button", { name: "Inspect event 1", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Inspect event 1", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Address resolution" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Realtime", exact: true }).click();
  await page.getByRole("button", { name: "Send ping" }).click();
  await expect(page.getByRole("status")).toContainText(
    "echo request and reply delivered",
  );
  await page
    .getByRole("button", { name: "Workstation-2, Workstation", exact: true })
    .click();
  await page.getByRole("checkbox", { name: "Power on", exact: true }).uncheck();
  await page.getByRole("button", { name: "Apply configuration" }).click();
  await page.getByRole("button", { name: "Send ping" }).click();
  await expect(page.getByRole("status")).toContainText("ARP unresolved");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.getByRole("button", { name: "Send ping" }).click();
  await expect(page.getByRole("status")).toContainText(
    "echo request and reply delivered",
  );
  expect(errors).toEqual([]);
});
test("create and connect a new topology, configure hosts, then export and reimport", async ({
  page,
}) => {
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page
    .getByLabel("Device palette")
    .getByRole("button", { name: /Workstation/ })
    .click();
  await page.getByLabel("Interface IPv4 address").fill("10.0.0.1");
  await page.getByRole("button", { name: "Apply configuration" }).click();
  await page
    .getByLabel("Device palette")
    .getByRole("button", { name: /Workstation/ })
    .click();
  await page.getByLabel("Interface IPv4 address").fill("10.0.0.2");
  await page.getByRole("button", { name: "Apply configuration" }).click();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page
    .getByRole("button", { name: "Workstation-1, Workstation", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Workstation-2, Workstation", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Connect devices" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Connect ports", exact: true })
    .click();
  await page.getByRole("button", { name: "Realtime", exact: true }).click();
  await page.getByLabel("Ping source").selectOption({ label: "Workstation-1" });
  await page.getByLabel("Ping destination").fill("10.0.0.2");
  await page.getByRole("button", { name: "Send ping" }).click();
  await expect(page.getByRole("status")).toContainText(
    "echo request and reply delivered",
  );
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export network" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.certsim\.json$/);
  const file = await download.path();
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.locator("input[type=file]").setInputFiles(file);
  await expect(
    page.getByRole("button", {
      name: "Workstation-2, Workstation",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Opened");
});
test("CLI mutations reach the configuration model; invalid import preserves existing work", async ({
  page,
}) => {
  await page
    .getByLabel("Device palette")
    .getByRole("button", { name: /Router/ })
    .click();
  await page.getByRole("button", { name: "CLI", exact: true }).click();
  for (const line of [
    "enable",
    "configure terminal",
    "interface GigabitEthernet0/0",
    "ip address 10.4.0.1 255.255.255.0",
    "end",
    "show ip interface brief",
  ]) {
    await page.getByLabel("CLI command").fill(line);
    await page.getByRole("button", { name: "Run", exact: true }).click();
  }
  await expect(page.getByRole("log")).toContainText("10.4.0.1");
  await page.getByRole("button", { name: "Config", exact: true }).click();
  await expect(page.getByLabel("Interface IPv4 address")).toHaveValue(
    "10.4.0.1",
  );
  await page.locator("input[type=file]").setInputFiles({
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"version":99}'),
  });
  await expect(page.getByRole("status")).toContainText("Import failed");
  await expect(page.getByLabel("Interface IPv4 address")).toHaveValue(
    "10.4.0.1",
  );
});
test("mobile layout has bounded overflow, keyboard config and a working guide dialog", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Workspace guide" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByLabel("Interface IPv4 address").fill("192.168.10.30");
  await page.getByRole("button", { name: "Apply configuration" }).click();
  await page.getByLabel("Device inspector").evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.screenshot({
    path: "test-results/network-studio-mobile.png",
    fullPage: true,
  });
});
test("undo to the initial workspace is durable, and redo is durable too", async ({
  page,
}) => {
  const address = page.getByLabel("Interface IPv4 address");
  await address.fill("192.168.10.77");
  await page.getByRole("button", { name: "Apply configuration" }).click();
  await expect(
    page.getByText("Saved on this device", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(address).toHaveValue("192.168.10.10");
  const saved = () =>
    page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("certsim.network-studio.practice.v1"))
          .devices[0].ports[0].ip,
    );
  await expect.poll(saved).toBe("192.168.10.10");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect.poll(saved).toBe("192.168.10.77");
  await page.reload();
  await expect(page.getByLabel("Interface IPv4 address")).toHaveValue(
    "192.168.10.77",
  );
});

test("corrupt autosave is retained until an explicit edit and can then be replaced", async ({
  page,
}) => {
  await page.evaluate(() =>
    localStorage.setItem("certsim.network-studio.practice.v1", "broken-data"),
  );
  await page.reload();
  await expect(page.getByRole("status")).toContainText("could not be loaded");
  expect(
    await page.evaluate(() =>
      localStorage.getItem("certsim.network-studio.practice.v1"),
    ),
  ).toBe("broken-data");
  await page.getByLabel("Interface IPv4 address").fill("192.168.10.88");
  await page.getByRole("button", { name: "Apply configuration" }).click();
  await page.reload();
  await expect(page.getByLabel("Interface IPv4 address")).toHaveValue(
    "192.168.10.88",
  );
});

test("playback pauses at the final event and edits invalidate stale events", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Send ping" }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "echo request and reply delivered",
    { timeout: 12000 },
  );
  await expect(
    page.getByRole("button", { name: "Play", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Interface IPv4 address").fill("192.168.10.31");
  await page.getByRole("button", { name: "Apply configuration" }).click();
  await expect(
    page.getByRole("button", { name: "Play", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: /^Inspect event/ }),
  ).toHaveCount(0);
});

test("keyboard movement, removal and undo preserve devices and attached cables", async ({
  page,
}) => {
  const node = page.getByRole("button", {
    name: "Workstation-1, Workstation",
    exact: true,
  });
  const original = await node.getAttribute("style");
  await node.focus();
  await page.keyboard.press("ArrowRight");
  expect(await node.getAttribute("style")).not.toBe(original);
  const beforeDrag = await node.getAttribute("style");
  const box = await node.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 70, box.y + 60, { steps: 5 });
  await page.mouse.up();
  expect(await node.getAttribute("style")).not.toBe(beforeDrag);
  await page
    .getByRole("button", { name: "Remove device", exact: true })
    .click();
  await expect(node).toHaveCount(0);
  await expect(page.getByText("3 devices · 2 connections")).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(node).toBeVisible();
  await expect(page.getByText("4 devices · 3 connections")).toBeVisible();
});

test("desktop candidate renders without external service calls", async ({
  page,
}) => {
  const external = [];
  page.on("request", (r) => {
    if (!new URL(r.url()).hostname.match(/^(127\.0\.0\.1|localhost)$/))
      external.push(r.url());
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Packet simulation", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/network-studio-desktop.png",
    fullPage: true,
  });
  expect(external).toEqual([]);
});
test("a trunk's native VLAN enables untagged hosts and persists after reload", async ({
  page,
}) => {
  await page.goto("/network-studio.html");
  await page
    .getByRole("button", { name: "Switch-1, Switch", exact: true })
    .click();
  const inspector = page.getByRole("complementary", {
    name: "Device inspector",
  });
  await inspector
    .getByRole("combobox", { name: "Port mode", exact: true })
    .selectOption("trunk");
  await expect(inspector.getByLabel("Native VLAN")).toHaveValue("1");
  await inspector.getByLabel("Native VLAN").fill("10");
  await inspector.getByLabel("Allowed VLANs").fill("1,10");
  await inspector.getByRole("button", { name: "Apply configuration" }).click();
  await inspector
    .getByRole("combobox", { name: "Interface", exact: true })
    .selectOption("p1");
  await inspector.getByLabel("Access VLAN", { exact: true }).fill("10");
  await inspector.getByRole("button", { name: "Apply configuration" }).click();
  await page.getByRole("button", { name: "Realtime", exact: true }).click();
  await page.getByRole("button", { name: "Send ping", exact: true }).click();
  await expect(page.getByRole("status").last()).toContainText("Reply from");
  await page.reload();
  await page
    .getByRole("button", { name: "Switch-1, Switch", exact: true })
    .click();
  await expect(inspector.getByLabel("Native VLAN")).toHaveValue("10");
});
test("canvas simple PDU queues a trace, persists for replay and reruns after reload", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "Add Simple PDU", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Workstation-1, Workstation", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Workstation-2, Workstation", exact: true })
    .click();
  await expect(page.getByRole("status").last()).toContainText("queued");
  const pdus = page.getByRole("region", { name: "User-created PDUs" });
  await pdus.getByText("User-created PDUs (1)", { exact: true }).click();
  await expect(pdus).toContainText("Delivered");
  await page.reload();
  await pdus.getByText("User-created PDUs (1)", { exact: true }).click();
  await expect(pdus.getByRole("button", { name: "View trace" })).toBeDisabled();
  await pdus.getByRole("button", { name: "Send again" }).click();
  await expect(pdus.getByRole("button", { name: "View trace" })).toBeEnabled();
  await pdus.getByRole("button", { name: "View trace" }).click();
  await page.getByRole("button", { name: "Step forward" }).click();
  await expect(
    page.getByRole("button", { name: "Inspect event 1", exact: true }),
  ).toBeVisible();
  await pdus.getByRole("button", { name: "Remove PDU" }).click();
  await expect(pdus).toContainText("User-created PDUs (0)");
});
test("mobile transport PDU editor saves a UDP probe and shows a failed rerun when the destination loses power", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const pdus = page.getByRole("region", { name: "User-created PDUs" });
  await pdus.getByText("User-created PDUs (0)", { exact: true }).click();
  await pdus
    .getByRole("combobox", { name: "PDU protocol" })
    .selectOption("udp");
  await pdus.getByLabel("Destination port", { exact: true }).fill("1812");
  await pdus.getByRole("button", { name: "Add and send PDU" }).click();
  await expect(pdus).toContainText("Delivered · port 1812");
  await page
    .getByRole("button", { name: "Workstation-2, Workstation", exact: true })
    .click();
  await page.getByRole("checkbox", { name: "Power on", exact: true }).uncheck();
  await page.getByRole("button", { name: "Apply configuration" }).click();
  await pdus.getByRole("button", { name: "Send again" }).click();
  await expect(pdus).toContainText("Failed · port 1812");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("periodic user packets run at clock deadlines and restart after reload", async ({
  page,
}) => {
  const pdus = page.getByRole("region", { name: "User-created PDUs" });
  await pdus.getByText("User-created PDUs (0)", { exact: true }).click();
  await pdus
    .getByRole("combobox", { name: "PDU timing" })
    .selectOption("periodic");
  await pdus.getByLabel("Initial delay (seconds)").fill("5");
  await pdus.getByLabel("Repeat interval (seconds)").fill("3");
  await pdus.getByRole("button", { name: "Schedule PDU" }).click();
  const status = pdus.getByLabel("PDU schedule status");
  await expect(status).toContainText("0 scheduled sends · Next at 5s");
  await page.getByRole("button", { name: "Advance 10s", exact: true }).click();
  await expect(status).toContainText(
    "2 scheduled sends · Next at 11s · Last at 8s",
  );
  await expect(pdus).toContainText("Delivered");
  await pdus.getByRole("button", { name: "View trace" }).click();
  await expect(page.getByRole("status").last()).toContainText("queued");
  await page.reload();
  await pdus.getByText("User-created PDUs (1)", { exact: true }).click();
  await expect(status).toContainText("0 scheduled sends · Next at 5s");
});
test("scenario selection isolates canvas PDUs, survives reload and supports deletion and undo", async ({
  page,
}) => {
  const panel = page.getByRole("region", { name: "User-created PDUs" });
  await panel.getByText("User-created PDUs (0)", { exact: true }).click();
  await panel.getByRole("button", { name: "Add and send PDU" }).click();
  await panel.getByText("Scenario settings", { exact: true }).click();
  await panel
    .getByRole("button", { name: "New scenario", exact: true })
    .click();
  await expect(panel).toContainText("User-created PDUs (0)");
  await panel.getByLabel("Scenario name", { exact: true }).fill("Branch test");
  await panel.getByLabel("Scenario description").fill("Compare a second path");
  await panel.getByRole("button", { name: "Save scenario" }).click();
  await page
    .getByRole("button", { name: "Add Simple PDU", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Workstation-2, Workstation", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Workstation-1, Workstation", exact: true })
    .click();
  await expect(panel).toContainText("Workstation-2 → Workstation-1");
  await expect(panel).not.toContainText("Workstation-1 → Workstation-2");
  await page.reload();
  await panel.getByText("User-created PDUs (1)", { exact: true }).click();
  await expect(
    panel
      .getByRole("combobox", { name: "Packet scenario" })
      .locator("option:checked"),
  ).toHaveText("Branch test");
  await panel.getByText("Scenario settings", { exact: true }).click();
  await panel.getByRole("button", { name: "Remove scenario" }).click();
  await expect(panel).toContainText("Workstation-1 → Workstation-2");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(panel).toContainText("Workstation-2 → Workstation-1");
});

test("hardware slots participate in port selection, cabling, undo and reload", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "Routed campus / OSPF", exact: true })
    .click();
  const router = page.getByRole("button", {
    name: "Router-1, Router",
    exact: true,
  });
  await router.click();
  await page.getByRole("button", { name: "Hardware", exact: true }).click();
  const panel = page.getByRole("region", { name: "Device hardware" });
  const slot = panel.getByRole("group", { name: "Expansion slot 1" });
  await expect(
    slot.getByRole("button", { name: "Install module" }),
  ).toBeDisabled();
  await panel.getByRole("button", { name: "Power off device" }).click();
  await slot.getByLabel("Module for slot 1").selectOption("fiber");
  await slot.getByRole("button", { name: "Install module" }).click();
  await expect(slot).toContainText("GigabitEthernet1/0");
  await panel.getByRole("button", { name: "Power on device" }).click();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await router.click();
  await page
    .getByRole("button", { name: "Router-2, Router", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Connect devices" });
  await expect(dialog.getByLabel("Cable media", { exact: true })).toHaveValue(
    "fiber",
  );
  await dialog
    .getByLabel("Source port", { exact: true })
    .selectOption("module-1");
  await dialog
    .getByRole("button", { name: "Connect ports", exact: true })
    .click();
  await router.click();
  await page.getByRole("button", { name: "Links", exact: true }).click();
  await expect(
    page.getByRole("complementary", { name: "Device inspector" }),
  ).toContainText("GigabitEthernet1/0");
  await page.getByRole("button", { name: "Hardware", exact: true }).click();
  await panel.getByRole("button", { name: "Power off device" }).click();
  await slot.getByRole("button", { name: "Remove module" }).click();
  await expect(
    slot.getByRole("button", { name: "Install module" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(slot).toContainText("GigabitEthernet1/0");
  await page.reload();
  await page
    .getByRole("button", { name: "Router-1, Router, powered off", exact: true })
    .click();
  await page.getByRole("button", { name: "Hardware", exact: true }).click();
  await expect(slot).toContainText("GigabitEthernet1/0");
});

test("serial WAN loses its routed path without the DCE clock and recovers after reconfiguration", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Serial WAN", exact: true }).click();
  await page.getByRole("button", { name: "Realtime", exact: true }).click();
  await page.getByRole("button", { name: "Send ping", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "echo request and reply delivered",
  );
  await page
    .getByRole("button", { name: "Router-1, Router", exact: true })
    .click();
  const inspector = page.getByRole("complementary", {
    name: "Device inspector",
  });
  await inspector
    .getByRole("combobox", { name: "Interface", exact: true })
    .selectOption("module-1");
  const clock = inspector.getByLabel("Serial clock rate", { exact: true });
  await expect(clock).toHaveValue("64000");
  await clock.selectOption("");
  await inspector.getByRole("button", { name: "Apply configuration" }).click();
  await page.getByRole("button", { name: "Send ping", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("No usable route");
  await clock.selectOption("128000");
  await inspector.getByRole("button", { name: "Apply configuration" }).click();
  await page.getByRole("button", { name: "Send ping", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "echo request and reply delivered",
  );
  await inspector.getByRole("button", { name: "Links", exact: true }).click();
  await expect(inspector).toContainText("Serial DCE");
  await page.reload();
  await page
    .getByRole("button", { name: "Router-1, Router", exact: true })
    .click();
  await inspector
    .getByRole("combobox", { name: "Interface", exact: true })
    .selectOption("module-1");
  await expect(clock).toHaveValue("128000");
});
