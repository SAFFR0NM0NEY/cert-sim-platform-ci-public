import { test, expect } from "@playwright/test";

const button = (page, name) => page.getByRole("button", { name, exact: true });
const inspect = async (page, name) => button(page, name + ", Switch").click();
const port = (page, id) =>
  page.getByLabel("Interface", { exact: true }).selectOption(id);
const configured = (page) =>
  page.evaluate(() =>
    JSON.parse(localStorage.getItem("certsim.network-studio.practice.v1")),
  );

test("VLAN management creates, renames and removes VLANs, retaining inactive SVI assignments", async ({
  page,
}) => {
  await page.goto("/network-studio.html");
  await page
    .getByRole("complementary", { name: "Device palette" })
    .getByRole("button", { name: "Switch Connect your LAN" })
    .click();
  await page.getByLabel("Device name").fill("VLAN-Test");
  await button(page, "Apply configuration").click();
  await button(page, "VLANs").click();
  await expect(page.getByLabel("VLAN 1 name", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("VTP status")).toContainText("revision 0");
  await page.getByLabel("New VLAN ID").fill("31");
  await button(page, "Add VLAN").click();
  await page.getByLabel("VLAN 31 name").fill("Learners");
  await button(page, "Apply VLANs").click();
  await expect(page.getByLabel("VTP status")).toContainText("revision 1");
  await button(page, "Config").click();
  await page.getByLabel("Access VLAN", { exact: true }).fill("32");
  await page.getByLabel("Voice VLAN", { exact: true }).fill("33");
  await button(page, "Apply configuration").click();
  await page.getByText("Add VLAN interface", { exact: true }).click();
  await page.getByLabel("SVI VLAN").fill("34");
  await button(page, "Add interface").click();
  await button(page, "Apply configuration").click();
  await port(page, "p1");
  await page
    .getByRole("combobox", { name: "Port mode", exact: true })
    .selectOption("trunk");
  await page.getByLabel("Allowed VLANs").fill("35");
  await button(page, "Apply configuration").click();
  await button(page, "VLANs").click();
  for (const id of [31, 32, 33, 34])
    await expect(page.getByLabel("VLAN " + id + " name")).toHaveCount(1);
  await expect(page.getByLabel("VLAN 35 name")).toHaveCount(0);
  await button(page, "Delete VLAN 34").click();
  await button(page, "Apply VLANs").click();
  await button(page, "Config").click();
  await page
    .getByLabel("Interface", { exact: true })
    .selectOption({ label: "Vlan34 · SVI" });
  await expect(page.getByLabel("Interface operational state")).toHaveText(
    "Operationally down",
  );
  await button(page, "Apply configuration").click();
  await button(page, "VLANs").click();
  await expect(page.getByLabel("VLAN 34 name")).toHaveCount(0);
  await page.reload();
  await inspect(page, "VLAN-Test");
  await button(page, "VLANs").click();
  await expect(page.getByLabel("VLAN 31 name")).toHaveValue("Learners");
  const saved = (await configured(page)).devices.find(
    (d) => d.name === "VLAN-Test",
  );
  expect(saved.vlans.some((v) => v.id === 34)).toBe(false);
  expect(
    saved.ports.some((p) => p.virtual?.kind === "svi" && p.virtual.vlan === 34),
  ).toBe(true);
  await page.getByLabel("VTP mode").selectOption("client");
  await button(page, "Apply VTP").click();
  await button(page, "Config").click();
  await port(page, "p2");
  await page.getByLabel("Access VLAN", { exact: true }).fill("77");
  await button(page, "Apply configuration").click();
  await button(page, "VLANs").click();
  await expect(page.getByLabel("VLAN 77 name")).toHaveCount(0);
  await button(page, "Config").click();
  await page.getByText("Add VLAN interface", { exact: true }).click();
  await page.getByLabel("SVI VLAN").fill("78");
  await button(page, "Add interface").click();
  await button(page, "Apply configuration").click();
  await button(page, "VLANs").click();
  await expect(page.getByLabel("VLAN 78 name")).toHaveValue("VLAN0078");
  await expect(page.getByLabel("VLAN 78 name")).toBeDisabled();
});

test("VTP campus synchronizes names and VLAN state, enforces client controls and restores traffic", async ({
  page,
}, testInfo) => {
  await page.goto("/network-studio.html");
  await button(page, "VTP campus").click();
  await button(page, "Realtime").click();
  await button(page, "Request lease").click();
  await expect(page.getByRole("status")).toContainText("DHCP ACK");
  await page.getByLabel("Application", { exact: true }).selectOption("http");
  await button(page, "Browse lab site").click();
  await expect(page.getByRole("status")).toContainText("HTTP 200");
  await inspect(page, "Campus-Access");
  await button(page, "VLANs").click();
  await expect(page.getByLabel("VLAN 10 name")).toHaveValue("Students");
  await expect(page.getByLabel("VLAN 10 name")).toBeDisabled();
  await expect(button(page, "Apply VLANs")).toBeDisabled();
  await page.getByLabel("VTP password").fill("mismatch");
  await button(page, "Apply VTP").click();
  await inspect(page, "Campus-Core");
  await button(page, "VLANs").click();
  await page.getByLabel("VLAN 10 name").fill("Classroom");
  await button(page, "Apply VLANs").click();
  await inspect(page, "Campus-Access");
  await button(page, "VLANs").click();
  await expect(page.getByLabel("VLAN 10 name")).toHaveValue("Students");
  await page.getByLabel("VTP password").fill("campus-lab");
  await button(page, "Apply VTP").click();
  await expect(page.getByLabel("VLAN 10 name")).toHaveValue("Classroom");
  await inspect(page, "Campus-Core");
  await button(page, "VLANs").click();
  await page.getByLabel("VLAN 10 state").selectOption("suspended");
  await button(page, "Apply VLANs").click();
  await page.getByLabel("Ping destination").fill("192.168.30.100");
  await button(page, "Send ping").click();
  await expect(page.getByRole("status")).not.toContainText(
    "echo request and reply delivered",
  );
  await inspect(page, "Campus-Access");
  await button(page, "VLANs").click();
  await expect(page.getByLabel("VLAN 10 state")).toHaveValue("suspended");
  await inspect(page, "Campus-Core");
  await button(page, "VLANs").click();
  await page.getByLabel("VLAN 10 state").selectOption("active");
  await button(page, "Apply VLANs").click();
  await button(page, "Send ping").click();
  await expect(page.getByRole("status")).toContainText(
    "echo request and reply delivered",
  );
  await page.getByLabel("Device inspector").evaluate((element) => {
    element.scrollTop = 0;
  });
  await page
    .getByLabel("Device inspector")
    .screenshot({ path: testInfo.outputPath("vlans-desktop.png") });
});

test("routed switchports retain links and discovery while using Layer 3 selectors", async ({
  page,
}) => {
  await page.goto("/network-studio.html");
  await button(page, "VTP campus").click();
  await inspect(page, "Campus-Core");
  await port(page, "p2");
  await expect(page.getByLabel("Routed port", { exact: true })).toBeChecked();
  await expect(page.getByLabel("Interface IPv4 address")).toHaveValue(
    "172.16.0.1",
  );
  await expect(page.getByLabel("Interface operational state")).toHaveText(
    "Operationally up",
  );
  await expect(page.getByLabel("Port mode", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Switch port security" }),
  ).not.toContainText("GigabitEthernet0/2");
  await page.getByText("Interface path costs", { exact: true }).click();
  await expect(
    page.getByLabel("Spanning-tree cost GigabitEthernet0/2", { exact: true }),
  ).toHaveCount(0);
  await page.getByText("Static MAC entries", { exact: true }).click();
  await expect(
    page
      .getByLabel("Static MAC interface")
      .getByRole("option", { name: "GigabitEthernet0/2", exact: true }),
  ).toHaveCount(0);
  await button(page, "Discovery").click();
  await expect(
    page
      .getByLabel("Discovery interface")
      .getByRole("option", { name: "GigabitEthernet0/2", exact: true }),
  ).toHaveCount(1);
  await button(page, "IPv6").click();
  await expect(
    page
      .getByLabel("IPv6 interface")
      .getByRole("option", { name: "GigabitEthernet0/2", exact: true }),
  ).toHaveCount(1);
  const pdus = page.getByRole("region", { name: "User-created PDUs" });
  await pdus.getByText("User-created PDUs (0)", { exact: true }).click();
  await pdus
    .getByRole("combobox", { name: "PDU source", exact: true })
    .selectOption({ label: "Router-1" });
  await pdus
    .getByRole("combobox", { name: "PDU destination", exact: true })
    .selectOption({ label: "Campus-Core" });
  await pdus
    .getByRole("combobox", { name: "Destination interface", exact: true })
    .selectOption("p2");
  await button(page, "Add and send PDU").click();
  await expect(pdus).toContainText("Delivered");
  await button(page, "Config").click();
  await port(page, "p2");
  await page.getByLabel("Routed port", { exact: true }).uncheck();
  await button(page, "Apply configuration").click();
  await expect(pdus).toContainText("User-created PDUs (0)");
  await expect(page.getByLabel("Access VLAN", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Interface IPv4 address")).toHaveCount(0);
  await page.getByLabel("Routed port", { exact: true }).check();
  await page.getByLabel("Interface IPv4 address").fill("172.16.0.1");
  await page.getByLabel("Prefix length", { exact: true }).fill("30");
  await button(page, "Apply configuration").click();
  await expect(page.getByLabel("Interface operational state")).toHaveText(
    "Operationally up",
  );
  const saved = await configured(page);
  const core = saved.devices.find((d) => d.name === "Campus-Core");
  expect(
    saved.links.some((l) =>
      [l.a, l.b].some((end) => end.device === core.id && end.port === "p2"),
    ),
  ).toBe(true);
});

test("first PDU uses the converged VLAN database after importing an unsynchronized snapshot", async ({
  page,
}) => {
  await page.goto("/network-studio.html");
  await button(page, "VTP campus").click();
  const snapshot = await configured(page);
  snapshot.name = "Unconverged campus";
  const client = snapshot.devices.find((d) => d.kind === "pc");
  client.ports[0].addressMode = "static";
  client.ports[0].ip = "192.168.10.10";
  client.gateway = "192.168.10.1";
  const access = snapshot.devices.find((d) => d.name === "Campus-Access");
  access.vtp.revision = 0;
  access.vlans = access.vlans.filter((v) => v.id !== 10 && v.id !== 20);
  await page.locator("input[type=file]").setInputFiles({
    name: "unsynchronized.certsim.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(snapshot)),
  });
  await expect(page.getByLabel("Network name")).toHaveValue(
    "Unconverged campus",
  );
  await inspect(page, "Campus-Access");
  await button(page, "VLANs").click();
  await expect(page.getByLabel("VLAN 10 name")).toHaveCount(0);
  const pdus = page.getByRole("region", { name: "User-created PDUs" });
  await pdus.getByText("User-created PDUs (0)", { exact: true }).click();
  await pdus
    .getByRole("combobox", { name: "PDU destination", exact: true })
    .selectOption({ label: "Server-1" });
  await button(page, "Add and send PDU").click();
  await expect(pdus).toContainText("Delivered");
  await expect(page.getByLabel("VLAN 10 name")).toHaveValue("Students");
});

test("a switch with only a routed physical interface can persist IPv6 addressing and route scope", async ({
  page,
}) => {
  await page.goto("/network-studio.html");
  await page
    .getByRole("complementary", { name: "Device palette" })
    .getByRole("button", { name: "Switch Connect your LAN" })
    .click();
  await page.getByLabel("Device name").fill("Routed-Only");
  await page.getByLabel("Routed port", { exact: true }).check();
  await page.getByLabel("Interface IPv4 address").fill("192.0.2.1");
  await button(page, "Apply configuration").click();
  await button(page, "IPv6").click();
  await expect(
    page.getByLabel("IPv6 interface").getByRole("option"),
  ).toHaveCount(1);
  await page.getByLabel("Interface IPv6 address").fill("2001:db8:77::1");
  await page.getByLabel("Enable IPv6 forwarding").check();
  await button(page, "+ Add IPv6 route").click();
  const scope = page.getByLabel("IPv6 route interface", { exact: true });
  await expect(scope.getByRole("option")).toHaveCount(2);
  await scope.selectOption("p0");
  await page.getByLabel("IPv6 next hop").fill("2001:db8:77::2");
  await button(page, "Apply IPv6 configuration").click();
  const saved = (await configured(page)).devices.find(
    (d) => d.name === "Routed-Only",
  );
  expect(saved.ports.some((p) => p.virtual)).toBe(false);
  expect(saved.ports[0].addressMode).toBeUndefined();
  expect(saved.routes6[0].interface).toBe("p0");
  await page.reload();
  await inspect(page, "Routed-Only");
  await button(page, "IPv6").click();
  await expect(page.getByLabel("Interface IPv6 address")).toHaveValue(
    "2001:db8:77::1",
  );
  await expect(scope).toHaveValue("p0");
});

test("mobile VLAN and VTP controls remain reachable and validate extended VLAN mode", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/network-studio.html");
  await button(page, "VTP campus").click();
  await inspect(page, "Campus-Core");
  await button(page, "VLANs").click();
  await page.getByLabel("New VLAN ID").fill("2000");
  await button(page, "Add VLAN").click();
  await expect(page.getByRole("alert")).toContainText(
    "Extended VLANs require VTP transparent mode",
  );
  await page.getByLabel("VTP mode").selectOption("transparent");
  await button(page, "Apply VTP").click();
  await button(page, "Add VLAN").click();
  await page.getByLabel("VLAN 2000 name").fill("Research");
  await button(page, "Apply VLANs").click();
  await expect(page.getByLabel("VLAN 2000 name")).toHaveValue("Research");
  await button(page, "Delete VLAN 2000").click();
  await button(page, "Apply VLANs").click();
  await expect(page.getByLabel("VLAN 2000 name")).toHaveCount(0);
  await button(page, "Apply VTP").click();
  await expect(button(page, "Apply VTP")).toBeInViewport();
  await page
    .getByLabel("Device inspector")
    .screenshot({ path: testInfo.outputPath("vlans-mobile.png") });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 2,
    ),
  ).toBe(true);
});
