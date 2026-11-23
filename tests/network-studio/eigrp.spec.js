import { test, expect } from "@playwright/test";

const button = (page, name) => page.getByRole("button", { name, exact: true });
const saved = (page) =>
  page.evaluate(() =>
    JSON.parse(localStorage.getItem("certsim.network-studio.practice.v1")),
  );
const state = (page) =>
  page.getByLabel("Learned routing state", { exact: true });
const route = (page, prefix = "10.20.20.0/24") =>
  state(page)
    .locator("p")
    .filter({ hasText: `EIGRP ${prefix}` });
const port = (page, id) =>
  page.getByLabel("Interface", { exact: true }).selectOption(id);
const metric = (page, name) => page.getByLabel(name, { exact: true });

async function inspect(page, name = "EIGRP-West", tab = "Routing") {
  await button(page, name + ", Router").click();
  await button(page, tab).click();
}
async function openLab(page) {
  await page.goto("/network-studio.html");
  await button(page, "Repair EIGRP").click();
  await button(page, "Realtime").click();
  await button(page, "Routing").click();
}
async function repair(page) {
  await metric(page, "Autonomous system (AS)").fill("10");
  await button(page, "Apply routing").click();
}
async function ping(page, success) {
  await page.getByLabel("Ping source", { exact: true }).selectOption({
    label: "Student-West",
  });
  await page
    .getByLabel("Ping destination", { exact: true })
    .fill("10.20.20.10");
  await button(page, "Send ping").click();
  await expect(page.locator(".ns-ping-result")).toContainText(
    success ? "echo request and reply delivered" : "No usable route",
  );
}

test("EIGRP AS repair updates applied neighbors, selected routes and forwarding", async ({
  page,
}, testInfo) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openLab(page);
  await expect(page.getByLabel("Protocol", { exact: true })).toHaveValue(
    "eigrp",
  );
  await expect(state(page)).toContainText("Applied EIGRP AS: 99");
  await expect(state(page)).toContainText("Neighbors · 0");
  await ping(page, false);
  await metric(page, "Autonomous system (AS)").fill("10");
  await expect(state(page)).toContainText("Applied EIGRP AS: 99");
  await expect(state(page)).toContainText("Neighbors · 0");
  await button(page, "Apply routing").click();
  await expect(state(page)).toContainText("Applied EIGRP AS: 10");
  await expect(state(page)).toContainText("Neighbors · 2");
  await ping(page, true);
  await inspect(page);
  await expect(route(page)).toContainText("via 192.0.2.2");
  await expect(route(page)).toContainText(
    "Local interface: GigabitEthernet0/1",
  );
  await expect(route(page)).toContainText("Minimum bandwidth: 1000000 Kbit/s");
  await expect(route(page)).toContainText("Total delay:");
  const configured = await saved(page);
  await button(page, "Apply routing").click();
  expect(await saved(page)).toEqual(configured);
  await state(page).screenshot({
    path: testInfo.outputPath("eigrp-desktop.png"),
  });
  await page.reload();
  await inspect(page, "EIGRP-East");
  await expect(metric(page, "Autonomous system (AS)")).toHaveValue("10");
  await expect(state(page)).toContainText("Neighbors · 2");
  expect(errors).toEqual([]);
});

test("EIGRP bandwidth, delay and interface loss select the working diamond path", async ({
  page,
}) => {
  await openLab(page);
  await repair(page);
  await inspect(page, "EIGRP-West", "Config");
  await port(page, "p1");
  await metric(page, "Delay (10 µs units)").fill("1000");
  await button(page, "Apply configuration").click();
  await button(page, "Routing").click();
  await expect(route(page)).toContainText("via 192.0.2.10");
  await ping(page, true);
  await button(page, "Config").click();
  await port(page, "p2");
  await page.getByLabel("Interface enabled", { exact: true }).uncheck();
  await button(page, "Apply configuration").click();
  await button(page, "Routing").click();
  await expect(route(page)).toContainText("via 192.0.2.2");
  await ping(page, true);
  await button(page, "Config").click();
  await page.getByLabel("Interface enabled", { exact: true }).check();
  await metric(page, "Bandwidth (Kbit/s)").fill("1000");
  await button(page, "Apply configuration").click();
  await button(page, "Routing").click();
  await expect(route(page)).toContainText("via 192.0.2.2");
  await button(page, "Config").click();
  await metric(page, "Bandwidth (Kbit/s)").fill("");
  await button(page, "Apply configuration").click();
  await button(page, "Routing").click();
  await expect(route(page)).toContainText("via 192.0.2.10");
  await ping(page, true);
  await page.reload();
  await inspect(page, "EIGRP-West", "Config");
  await port(page, "p1");
  await expect(metric(page, "Delay (10 µs units)")).toHaveValue("1000");
  await port(page, "p2");
  await expect(metric(page, "Bandwidth (Kbit/s)")).toHaveValue("");
  await button(page, "Routing").click();
  await expect(route(page)).toContainText("via 192.0.2.10");
});

test("passive EIGRP interfaces keep LAN advertisements and remove transit neighbors", async ({
  page,
}) => {
  await openLab(page);
  await repair(page);
  await expect(route(page, "10.10.10.0/24")).toHaveCount(1);
  await inspect(page);
  await expect(
    page.getByLabel("GigabitEthernet0/0", { exact: true }),
  ).toBeChecked();
  await page.getByLabel("GigabitEthernet0/1", { exact: true }).check();
  await page.getByLabel("GigabitEthernet0/2", { exact: true }).check();
  await expect(state(page)).toContainText("Neighbors · 2");
  await button(page, "Apply routing").click();
  await expect(state(page)).toContainText("Neighbors · 0");
  await expect(route(page)).toHaveCount(0);
  await ping(page, false);
  await page.getByLabel("GigabitEthernet0/2", { exact: true }).uncheck();
  await button(page, "Apply routing").click();
  await expect(state(page)).toContainText("Neighbors · 1");
  await expect(route(page)).toContainText("via 192.0.2.10");
  await ping(page, true);
});

test("EIGRP controls reject invalid AS and metrics while blank defaults survive no-op apply", async ({
  page,
}) => {
  await openLab(page);
  const initial = await saved(page);
  const as = metric(page, "Autonomous system (AS)");
  for (const value of ["0", "65536", "1.5"]) {
    await as.fill(value);
    await button(page, "Apply routing").click();
    expect(await as.evaluate((input) => input.validity.valid)).toBe(false);
    expect(await saved(page)).toEqual(initial);
    await expect(state(page)).toContainText("Applied EIGRP AS: 99");
  }
  await as.fill("99");
  await button(page, "Config").click();
  await port(page, "p0");
  await expect(metric(page, "Bandwidth (Kbit/s)")).toHaveValue("");
  await expect(metric(page, "Delay (10 µs units)")).toHaveValue("");
  await button(page, "Apply configuration").click();
  expect(await saved(page)).toEqual(initial);
  for (const [name, values] of [
    ["Bandwidth (Kbit/s)", ["0", "2147483648", "1.5"]],
    ["Delay (10 µs units)", ["0", "16777216", "1.5"]],
  ]) {
    const input = metric(page, name);
    for (const value of values) {
      await input.fill(value);
      await button(page, "Apply configuration").click();
      expect(await input.evaluate((element) => element.validity.valid)).toBe(
        false,
      );
      expect(await saved(page)).toEqual(initial);
    }
    await input.fill("");
  }
  await button(page, "Apply configuration").click();
  expect(await saved(page)).toEqual(initial);
});

test("EIGRP metric controls support routed logical interfaces without configuring defaults", async ({
  page,
}) => {
  await page.goto("/network-studio.html");
  for (const [lab, device, kind, portName] of [
    ["Router-on-a-stick", "Router-1", "Router", "GigabitEthernet0/0.10"],
    ["Multilayer switch", "Switch-1", "Switch", "Vlan10"],
  ]) {
    await button(page, lab).click();
    await button(page, device + ", " + kind).click();
    await button(page, "Config").click();
    const initial = await saved(page);
    const selected = initial.devices.find((entry) => entry.name === device);
    const logical = selected.ports.find((entry) => entry.name === portName);
    expect(logical).toBeTruthy();
    await port(page, logical.id);
    await expect(metric(page, "Bandwidth (Kbit/s)")).toHaveValue("");
    await expect(metric(page, "Delay (10 µs units)")).toHaveValue("");
    await button(page, "Apply configuration").click();
    expect(await saved(page)).toEqual(initial);
    await metric(page, "Bandwidth (Kbit/s)").fill("50000");
    await metric(page, "Delay (10 µs units)").fill("20");
    await button(page, "Apply configuration").click();
    const applied = (await saved(page)).devices
      .find((entry) => entry.name === device)
      .ports.find((entry) => entry.id === logical.id);
    expect(applied.bandwidth).toBe(50000);
    expect(applied.delay).toBe(20);
  }
});

test("mobile EIGRP repair and metric controls fit the CertSim inspector", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openLab(page);
  await repair(page);
  await expect(state(page)).toContainText("Neighbors · 2");
  await inspect(page, "EIGRP-West", "Config");
  await port(page, "p1");
  await metric(page, "Delay (10 µs units)").fill("1000");
  await button(page, "Apply configuration").click();
  await button(page, "Routing").click();
  await expect(route(page)).toContainText("via 192.0.2.10");
  await state(page).scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 2,
    ),
  ).toBe(true);
  await state(page).screenshot({
    path: testInfo.outputPath("eigrp-mobile.png"),
  });
});
