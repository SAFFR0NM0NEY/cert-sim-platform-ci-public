import { test, expect } from "@playwright/test";

const button = (page, name) => page.getByRole("button", { name, exact: true });
const saved = (page) =>
  page.evaluate(() =>
    JSON.parse(localStorage.getItem("certsim.network-studio.practice.v1")),
  );
const channel = (page) =>
  page.getByRole("region", { name: "EtherChannel", exact: true });
const state = (page) =>
  page.getByLabel("Port-channel1 status", { exact: true });
const port = (page, id) =>
  page.getByLabel("Interface", { exact: true }).selectOption(id);
const mode = (page, member, value) =>
  page
    .getByLabel(`Channel mode GigabitEthernet0/${member}`, { exact: true })
    .selectOption(value);
async function inspect(page, name = "Channel-West") {
  await button(page, name + ", Switch").click();
}
async function openLab(page, repair = false) {
  await page.goto("/network-studio.html");
  await button(
    page,
    repair ? "Repair EtherChannel" : "LACP EtherChannel",
  ).click();
  await button(page, "Realtime").click();
  await button(page, "EtherChannel").click();
}
async function ping(
  page,
  source = "Student-West",
  destination = "192.168.10.11",
) {
  await page
    .getByLabel("Ping source", { exact: true })
    .selectOption({ label: source });
  await page.getByLabel("Ping destination", { exact: true }).fill(destination);
  await button(page, "Send ping").click();
  await expect(page.getByRole("status")).toContainText(
    "echo request and reply delivered",
  );
}

test("LACP aggregates VLAN traffic, propagates aggregate edits, and survives a member failure", async ({
  page,
}, testInfo) => {
  await openLab(page);
  await expect(state(page)).toContainText("Up · LACP · 2 bundled");
  const original = await saved(page);
  await button(page, "Apply EtherChannel").click();
  expect(await saved(page)).toEqual(original);
  await button(page, "Config").click();
  await page.getByLabel("Inspect VLAN", { exact: true }).fill("10");
  await page.getByText("Interface path costs", { exact: true }).click();
  await expect(
    page.getByLabel("Spanning-tree cost Port-channel1", { exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByLabel("Spanning-tree cost Port-channel1", { exact: true }),
  ).toHaveAttribute("placeholder", "Auto (2)");
  await button(page, "Apply spanning tree").click();
  expect(await saved(page)).toEqual(original);
  await button(page, "EtherChannel").click();
  await ping(page);
  await ping(page, "Staff-West", "192.168.20.11");
  await button(page, "Configure Port-channel1").click();
  await expect(page.getByLabel("Interface", { exact: true })).toHaveValue(
    "port-channel:1",
  );
  await expect(page.getByLabel("Voice VLAN", { exact: true })).toHaveCount(0);
  await page.getByLabel("Allowed VLANs", { exact: true }).fill("10,20,30");
  await button(page, "Apply configuration").click();
  const edited = (await saved(page)).devices[0];
  for (const member of edited.ports.filter((p) => p.channelGroup))
    expect(member.allowedVlans).toEqual([10, 20, 30]);
  await port(page, "p6");
  await page.getByLabel("Allowed VLANs", { exact: true }).fill("10");
  await button(page, "Apply configuration").click();
  await button(page, "EtherChannel").click();
  await expect(state(page)).toContainText("1 bundled");
  await expect(state(page)).toContainText("suspended");
  await ping(page);
  await button(page, "Config").click();
  await port(page, "p6");
  await page.getByLabel("Allowed VLANs", { exact: true }).fill("10,20,30");
  await page.getByLabel("Interface enabled", { exact: true }).uncheck();
  await button(page, "Apply configuration").click();
  await page.getByLabel("Inspect VLAN", { exact: true }).fill("10");
  await expect(page.getByLabel("Spanning-tree port roles")).toContainText(
    "Port-channel1",
  );
  await expect(page.getByLabel("Spanning-tree port roles")).not.toContainText(
    "GigabitEthernet0/6",
  );
  await expect(
    page.getByLabel("Secure maximum GigabitEthernet0/7", { exact: true }),
  ).toHaveCount(0);
  await button(page, "EtherChannel").click();
  await expect(state(page)).toContainText("Up · LACP · 1 bundled");
  await expect(state(page)).toContainText("down");
  await channel(page)
    .getByText("Preview member selection", { exact: true })
    .click();
  await expect(
    page.getByLabel("Port-channel1 selected member", { exact: true }),
  ).toContainText("GigabitEthernet0/7");
  await ping(page, "Staff-West", "192.168.20.11");
  await page.getByLabel("Device inspector").screenshot({
    path: testInfo.outputPath("etherchannel-desktop.png"),
  });
  await button(page, "Config").click();
  await page.getByText("Recent forwarding decisions", { exact: true }).click();
  await expect(page.getByLabel("Ethernet forwarding decisions")).toContainText(
    "Selected member: Port-channel1 → GigabitEthernet0/7",
  );
});

test("PAgP repair, static bundles and protocol validation preserve a valid applied configuration", async ({
  page,
}) => {
  await openLab(page, true);
  await expect(state(page)).toContainText("Down · PAGP · 0 bundled");
  await expect(state(page)).toContainText("individual");
  for (const member of [6, 7]) await mode(page, member, "desirable");
  await button(page, "Apply EtherChannel").click();
  await expect(state(page)).toContainText("Up · PAGP · 2 bundled");
  for (const member of [6, 7]) await mode(page, member, "on");
  await button(page, "Apply EtherChannel").click();
  await expect(state(page)).toContainText("Down · Static · 0 bundled");
  await inspect(page, "Channel-East");
  await button(page, "EtherChannel").click();
  for (const member of [6, 7]) await mode(page, member, "on");
  await button(page, "Apply EtherChannel").click();
  await expect(state(page)).toContainText("Up · Static · 2 bundled");
  await ping(page);
  const baseline = await saved(page);
  await page
    .getByLabel("Channel protocol GigabitEthernet0/6", { exact: true })
    .selectOption("lacp");
  await button(page, "Apply EtherChannel").click();
  await expect(channel(page).getByRole("alert")).toContainText(/protocol/i);
  expect(await saved(page)).toEqual(baseline);
  await page
    .getByLabel("Channel protocol GigabitEthernet0/6", { exact: true })
    .selectOption("");
  await page
    .getByLabel("EtherChannel load balancing")
    .selectOption("src-dst-mac");
  await button(page, "Apply EtherChannel").click();
  await page.reload();
  await inspect(page, "Channel-East");
  await button(page, "EtherChannel").click();
  await expect(page.getByLabel("EtherChannel load balancing")).toHaveValue(
    "src-dst-mac",
  );
  await expect(state(page)).toContainText("Up · Static · 2 bundled");
});

test("routed Port-channels own addressing and PDU interfaces, and removing a group retains cables", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openLab(page);
  for (const [name, address] of [
    ["Channel-West", "192.0.2.1"],
    ["Channel-East", "192.0.2.2"],
  ]) {
    await inspect(page, name);
    await button(page, "Config").click();
    await port(page, "port-channel:1");
    await page.getByLabel("Routed port", { exact: true }).check();
    await page.getByLabel("Interface IPv4 address").fill(address);
    await page.getByLabel("Enable IPv4 routing", { exact: true }).check();
    await button(page, "Apply configuration").click();
    await button(page, "IPv6").click();
    await expect(
      page.getByLabel("IPv6 interface").getByRole("option"),
    ).toHaveText(["Port-channel1"]);
    await page
      .getByLabel("Interface IPv6 address")
      .fill(address.endsWith("1") ? "2001:db8:45::1" : "2001:db8:45::2");
    await button(page, "Apply IPv6 configuration").click();
  }
  await ping(page, "Channel-West", "192.0.2.2");
  const pdus = page.getByRole("region", { name: "User-created PDUs" });
  await pdus.locator("summary").first().click();
  await pdus
    .getByRole("combobox", { name: "PDU destination", exact: true })
    .selectOption({ label: "Channel-East" });
  await expect(
    pdus
      .getByRole("combobox", { name: "Destination interface", exact: true })
      .getByRole("option"),
  ).toHaveText([/Port-channel1/]);
  const baseline = await saved(page);
  await button(page, "EtherChannel").click();
  await button(page, "Remove Port-channel1").click();
  await expect(
    channel(page).getByText("No Port-channels configured.", { exact: true }),
  ).toBeVisible();
  await button(page, "Apply EtherChannel").click();
  // Autosave runs in a React effect after the configuration commit.
  await expect
    .poll(async () => {
      const current = await saved(page);
      const east = current.devices.find((d) => d.name === "Channel-East");
      return east.ports.some(
        (p) => p.virtual?.kind === "portchannel" || p.channelGroup,
      );
    })
    .toBe(false);
  const next = await saved(page);
  expect(next.links).toEqual(baseline.links);
  const east = next.devices.find((d) => d.name === "Channel-East");
  expect(
    east.ports.some((p) => p.virtual?.kind === "portchannel" || p.channelGroup),
  ).toBe(false);
  expect(errors).toEqual([]);
});

for (const reload of ["device controls", "CLI"])
  test(`${reload} startup reload preserves deliberately mismatched member settings`, async ({
    page,
  }) => {
    await openLab(page);
    await button(page, "Config").click();
    await port(page, "p6");
    await page.getByLabel("Allowed VLANs", { exact: true }).fill("10");
    await button(page, "Apply configuration").click();
    await button(page, "Save startup").click();
    await port(page, "port-channel:1");
    await page.getByLabel("Allowed VLANs", { exact: true }).fill("10,20,30");
    await button(page, "Apply configuration").click();
    if (reload === "CLI") {
      await button(page, "CLI").click();
      for (const command of ["enable", "reload"]) {
        await page.getByLabel("CLI command", { exact: true }).fill(command);
        await button(page, "Run").click();
      }
      await expect(page.getByRole("log", { name: "CLI output" })).toContainText(
        /reload/i,
      );
    } else await button(page, "Reload device").click();
    const west = (await saved(page)).devices[0];
    expect(west.ports.find((p) => p.id === "p6").allowedVlans).toEqual([10]);
    expect(
      west.ports.find((p) => p.id === "port-channel:1").allowedVlans,
    ).toEqual([10, 20]);
    await button(page, "EtherChannel").click();
    await expect(state(page)).toContainText("suspended");
    await expect(state(page)).toContainText("1 bundled");
  });

test("mobile group creation and member editing remain reachable and survive reload", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/network-studio.html");
  await button(page, "Switch-1, Switch").click();
  await button(page, "EtherChannel").click();
  await page.getByLabel("New channel group").fill("3");
  await button(page, "Add Port-channel").click();
  for (const member of [6, 7])
    await page
      .getByLabel(`Channel group GigabitEthernet0/${member}`, { exact: true })
      .selectOption("3");
  await button(page, "Apply EtherChannel").click();
  await expect(button(page, "Apply EtherChannel")).toBeInViewport();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 2,
    ),
  ).toBe(true);
  await page
    .getByLabel("Device inspector")
    .screenshot({ path: testInfo.outputPath("etherchannel-mobile.png") });
  await page.reload();
  await button(page, "Switch-1, Switch").click();
  await button(page, "EtherChannel").click();
  await expect(
    page.getByLabel("Channel group GigabitEthernet0/6", { exact: true }),
  ).toHaveValue("3");
  await page
    .getByLabel("Channel group GigabitEthernet0/6", { exact: true })
    .selectOption("0");
  await button(page, "Apply EtherChannel").click();
  await expect(
    page.getByRole("article", { name: "Port-channel3 channel" }),
  ).toContainText("1 configured member");
});

test("simulation steps highlight only the physical channel member selected for each hop", async ({
  page,
}) => {
  await openLab(page);
  await button(page, "Simulation").click();
  const topology = await saved(page);
  const west = topology.devices.find((d) => d.name === "Channel-West");
  const east = topology.devices.find((d) => d.name === "Channel-East");
  const links = topology.links.filter(
    (l) =>
      [l.a.device, l.b.device].includes(west.id) &&
      [l.a.device, l.b.device].includes(east.id),
  );
  expect(links).toHaveLength(2);
  await page
    .getByLabel("Ping source", { exact: true })
    .selectOption({ label: "Student-West" });
  await page
    .getByLabel("Ping destination", { exact: true })
    .fill("192.168.10.11");
  const stepButton = page.getByRole("button", { name: "Step forward" });
  async function selectedLink() {
    await button(page, "Send ping").click();
    for (let step = 0; step < 30 && (await stepButton.isEnabled()); step++) {
      await stepButton.click();
      const row = page.locator(".ns-event-table tbody tr.active");
      const cells = (await row.locator("td").allTextContents()).map((text) =>
        text.trim(),
      );
      if (
        cells[1] === "ICMP" &&
        cells[2] === "Channel-West" &&
        cells[3] === "Channel-East"
      ) {
        const actual = await row.getAttribute("data-link-id");
        expect(links.map((l) => l.id)).toContain(actual);
        await expect(page.locator(".ns-cable.active")).toHaveCount(1);
        await expect(page.locator(".ns-cable.active")).toHaveAttribute(
          "data-link-id",
          actual,
        );
        return actual;
      }
    }
    throw Error("No West-to-East ICMP channel hop appeared in the simulation.");
  }
  const first = await selectedLink();
  const link = links.find((l) => l.id === first);
  const member = link.a.device === west.id ? link.a.port : link.b.port;
  await button(page, "Config").click();
  await port(page, member);
  await page.getByLabel("Interface enabled", { exact: true }).uncheck();
  await button(page, "Apply configuration").click();
  const second = await selectedLink();
  expect(second).not.toBe(first);
});
