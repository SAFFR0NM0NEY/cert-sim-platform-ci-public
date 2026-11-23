import { test, expect } from "@playwright/test";

const button = (page, name) => page.getByRole("button", { name, exact: true });
const saved = (page) =>
  page.evaluate(() =>
    JSON.parse(localStorage.getItem("certsim.network-studio.practice.v1")),
  );
const state = (page, name = "GigabitEthernet0/6") =>
  page.getByRole("region", { name: name + " switchport status", exact: true });
const port = (page, id) =>
  page.getByLabel("Interface", { exact: true }).selectOption(id);
const mode = (page, value) =>
  page.getByLabel("Port mode", { exact: true }).selectOption(value);
async function inspect(page, name = "DTP-West") {
  await button(page, name + ", Switch").click();
  await button(page, "Config").click();
  await port(page, "p6");
}
async function openLab(page) {
  await page.goto("/network-studio.html");
  await button(page, "Repair DTP").click();
  await button(page, "Realtime").click();
  await port(page, "p6");
}
async function ping(page, success) {
  await page
    .getByLabel("Ping source", { exact: true })
    .selectOption({ label: "Student-West" });
  await page
    .getByLabel("Ping destination", { exact: true })
    .fill("192.168.10.11");
  await button(page, "Send ping").click();
  await expect(page.getByRole("status")).toContainText(
    success ? "echo request and reply delivered" : "ARP unresolved",
  );
}

test("DTP repair changes applied trunk status and VLAN forwarding without losing access settings", async ({
  page,
}, testInfo) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openLab(page);
  await expect(state(page)).toContainText("Both peers are dynamic auto");
  await expect(state(page).getByText("Access", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Access VLAN", { exact: true })).toHaveValue(
    "1",
  );
  await expect(page.getByLabel("Allowed VLANs", { exact: true })).toHaveValue(
    "1,10",
  );
  const initial = await saved(page);
  await button(page, "Apply configuration").click();
  expect(await saved(page)).toEqual(initial);
  await ping(page, false);
  await button(page, "VLANs").click();
  await expect(
    page.getByRole("listitem", { name: "VLAN 1", exact: true }),
  ).toContainText("GigabitEthernet0/6");
  await button(page, "Config").click();
  await mode(page, "dynamic-desirable");
  await expect(state(page)).toContainText("Applied mode: Dynamic auto");
  await button(page, "Apply configuration").click();
  await expect(state(page).getByText("Trunk", { exact: true })).toBeVisible();
  await expect(state(page)).toContainText(
    "Peer: DTP-East / GigabitEthernet0/6",
  );
  await expect(state(page)).toContainText("Applied mode: Dynamic desirable");
  await ping(page, true);
  await button(page, "VLANs").click();
  await expect(
    page.getByRole("listitem", { name: "VLAN 1", exact: true }),
  ).not.toContainText("GigabitEthernet0/6");
  await button(page, "Config").click();
  const configured = await saved(page);
  await button(page, "Apply configuration").click();
  expect(await saved(page)).toEqual(configured);
  await mode(page, "trunk");
  await button(page, "Apply configuration").click();
  await mode(page, "dynamic-desirable");
  await button(page, "Apply configuration").click();
  expect(await saved(page)).toEqual(configured);
  await state(page).screenshot({
    path: testInfo.outputPath("dtp-desktop.png"),
  });
  await page.reload();
  await inspect(page);
  await expect(page.getByLabel("Port mode", { exact: true })).toHaveValue(
    "dynamic-desirable",
  );
  await expect(state(page).getByText("Trunk", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Access VLAN", { exact: true })).toHaveValue(
    "1",
  );
  expect(errors).toEqual([]);
});

test("DTP suppression requires a static mode and a manually configured peer trunk", async ({
  page,
}) => {
  await openLab(page);
  const initial = await saved(page);
  await page.getByLabel("Disable DTP negotiation", { exact: true }).check();
  await button(page, "Apply configuration").click();
  await expect(page.getByRole("alert")).toContainText(/cannot disable DTP/i);
  expect(await saved(page)).toEqual(initial);
  await page.getByLabel("Disable DTP negotiation", { exact: true }).uncheck();
  await mode(page, "dynamic-desirable");
  await button(page, "Apply configuration").click();
  await expect(
    page.getByLabel("Secure maximum GigabitEthernet0/6", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByText("GigabitEthernet0/6 · Dynamic mode", { exact: true })
    .click();
  await expect(
    page.getByText(/Choose a fixed Access or Trunk mode in Config/),
  ).toBeVisible();
  await inspect(page, "DTP-East");
  await mode(page, "trunk");
  await page.getByLabel("Disable DTP negotiation", { exact: true }).check();
  await button(page, "Apply configuration").click();
  await expect(state(page)).toContainText("DTP off");
  await inspect(page);
  await expect(state(page).getByText("Access", { exact: true })).toBeVisible();
  await expect(state(page)).toContainText("Peer disabled DTP negotiation");
  await ping(page, false);
  await mode(page, "trunk");
  await page.getByLabel("Disable DTP negotiation", { exact: true }).check();
  await button(page, "Apply configuration").click();
  await expect(state(page)).toContainText("DTP off");
  await ping(page, true);
  await page.reload();
  await inspect(page);
  await expect(
    page.getByLabel("Disable DTP negotiation", { exact: true }),
  ).toBeChecked();
});

test("dynamic trunks carry both VLANs over LACP and preserve member propagation", async ({
  page,
}) => {
  await page.goto("/network-studio.html");
  await button(page, "LACP EtherChannel").click();
  await button(page, "Realtime").click();
  for (const [name, value] of [
    ["Channel-West", "dynamic-desirable"],
    ["Channel-East", "dynamic-auto"],
  ]) {
    await button(page, name + ", Switch").click();
    await button(page, "Config").click();
    await port(page, "port-channel:1");
    await mode(page, value);
    await button(page, "Apply configuration").click();
    const device = (await saved(page)).devices.find((d) => d.name === name);
    expect(
      device.ports.filter((p) => p.channelGroup).map((p) => p.mode),
    ).toEqual([value, value]);
    await button(page, "EtherChannel").click();
    await expect(
      page.getByLabel("Port-channel1 status", { exact: true }),
    ).toContainText("Up · LACP · 2 bundled");
    await expect(
      state(page, "Port-channel1").getByText("Trunk", { exact: true }),
    ).toBeVisible();
  }
  await ping(page, true);
  await page
    .getByLabel("Ping source", { exact: true })
    .selectOption({ label: "Staff-West" });
  await page
    .getByLabel("Ping destination", { exact: true })
    .fill("192.168.20.11");
  await button(page, "Send ping").click();
  await expect(page.getByRole("status")).toContainText(
    "echo request and reply delivered",
  );
  await button(page, "Config").click();
  await port(page, "p6");
  await page.getByLabel("Interface enabled", { exact: true }).uncheck();
  await button(page, "Apply configuration").click();
  await button(page, "EtherChannel").click();
  await expect(
    page.getByLabel("Port-channel1 status", { exact: true }),
  ).toContainText("1 bundled");
  await expect(
    state(page, "Port-channel1").getByText("Trunk", { exact: true }),
  ).toBeVisible();
  await ping(page, true);
});

test("mobile DTP controls preserve fallback VLANs and show a disconnected port", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openLab(page);
  await mode(page, "dynamic-desirable");
  await page.getByLabel("Access VLAN", { exact: true }).fill("25");
  await button(page, "Apply configuration").click();
  await expect(state(page).getByText("Trunk", { exact: true })).toBeVisible();
  await page.getByLabel("Interface enabled", { exact: true }).uncheck();
  await button(page, "Apply configuration").click();
  await expect(state(page).getByText("Down", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Access VLAN", { exact: true })).toHaveValue(
    "25",
  );
  await state(page).scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 2,
    ),
  ).toBe(true);
  await state(page).screenshot({ path: testInfo.outputPath("dtp-mobile.png") });
  await button(page, "VLANs").click();
  await expect(page.getByLabel("VLAN 25 name", { exact: true })).toHaveCount(1);
});
