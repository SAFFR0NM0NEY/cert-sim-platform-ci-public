import { test, expect } from "@playwright/test";

const button = (page, name) => page.getByRole("button", { name, exact: true });
const selectInterface = (page, label) =>
  page.getByLabel("Interface", { exact: true }).selectOption({ label });

test("packet endpoints exclude Layer 2 switches and follow the final SVI configuration", async ({
  page,
}) => {
  await page.goto("/network-studio.html");
  const pdus = page.getByRole("region", { name: "User-created PDUs" });
  await pdus.getByText("User-created PDUs (0)", { exact: true }).click();
  const source = pdus.getByRole("combobox", {
    name: "PDU source",
    exact: true,
  });
  const destination = pdus.getByRole("combobox", {
    name: "PDU destination",
    exact: true,
  });
  await expect(
    source.getByRole("option", { name: "Switch-1", exact: true }),
  ).toHaveCount(0);
  await expect(
    destination.getByRole("option", { name: "Switch-1", exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .getByLabel("Ping source")
      .getByRole("option", { name: "Switch-1", exact: true }),
  ).toHaveCount(0);
  await pdus.getByRole("button", { name: "Add and send PDU" }).click();
  await expect(pdus).toContainText("Delivered");
  await button(page, "Switch-1, Switch").click();
  await page.getByText("Ethernet frame test", { exact: true }).click();
  await expect(
    page
      .getByLabel("Frame source", { exact: true })
      .getByRole("option")
      .filter({ hasText: "Switch-1" }),
  ).toHaveCount(0);

  await button(page, "Multilayer switch").click();
  await button(page, "Request lease").click();
  await source.selectOption({ label: "Switch-1" });
  await destination.selectOption({ label: "Server-1" });
  await pdus.getByRole("button", { name: "Add and send PDU" }).click();
  await expect(pdus).toContainText("Delivered");
  await source.selectOption({ label: "Workstation-1" });
  await destination.selectOption({ label: "Switch-1" });
  const targetPorts = pdus.getByRole("combobox", {
    name: "Destination interface",
    exact: true,
  });
  await expect(targetPorts.getByRole("option")).toHaveCount(3);
  await expect(
    targetPorts.getByRole("option").filter({ hasText: "GigabitEthernet" }),
  ).toHaveCount(0);
  await pdus.getByRole("button", { name: "Add and send PDU" }).click();
  await expect(
    pdus.locator("fieldset").filter({ hasText: "Delivered" }),
  ).toHaveCount(2);
  await source.selectOption({ label: "Switch-1" });
  await pdus
    .getByRole("combobox", { name: "PDU protocol", exact: true })
    .selectOption("icmpv6");
  await expect(
    pdus.getByLabel("IPv6 PDU source interface").getByRole("option"),
  ).toHaveCount(4);
  await expect(
    pdus
      .getByLabel("IPv6 PDU source interface")
      .getByRole("option")
      .filter({ hasText: "GigabitEthernet" }),
  ).toHaveCount(0);
  await page.getByLabel("Ping source").selectOption({ label: "Switch-1" });
  await page.getByLabel("Ping address family").selectOption("ipv6");
  await expect(
    page
      .getByLabel("IPv6 source interface", { exact: true })
      .getByRole("option"),
  ).toHaveCount(4);
  await button(page, "Switch-1, Switch").click();
  for (const vlan of [10, 20, 30]) {
    await selectInterface(page, "Vlan" + vlan + " · SVI");
    await button(page, "Remove interface").click();
  }
  await page.getByText("Add VLAN interface", { exact: true }).click();
  await page.getByLabel("SVI VLAN").fill("40");
  await button(page, "Add interface").click();
  await button(page, "Apply configuration").click();
  await expect(pdus).toContainText("User-created PDUs (1)");
  await button(page, "Remove interface").click();
  await button(page, "Apply configuration").click();
  await expect(pdus).toContainText("User-created PDUs (0)");
  await expect(
    source.getByRole("option", { name: "Switch-1", exact: true }),
  ).toHaveCount(0);
  await expect(
    destination.getByRole("option", { name: "Switch-1", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel("Network name")).toHaveValue(
    "Multilayer switch · VLAN routing",
  );
  await expect(pdus).toContainText("User-created PDUs (0)");
});

for (const [lab, gateway, iface] of [
  ["Router-on-a-stick", "Router-1, Router", "GigabitEthernet0/0.10"],
  ["Multilayer switch", "Switch-1, Switch", "Vlan10"],
]) {
  test(
    lab + " relays DHCP, routes between VLANs and applies the logical ACL",
    async ({ page }) => {
      await page.goto("/network-studio.html");
      await button(page, lab).click();
      await button(page, "Realtime").click();
      await button(page, "Request lease").click();
      await expect(page.getByRole("status")).toContainText("DHCP ACK");
      await expect(page.getByLabel("Interface IPv4 address")).toHaveValue(
        "192.168.10.50",
      );
      await page
        .getByLabel("Application", { exact: true })
        .selectOption("http");
      await button(page, "Browse lab site").click();
      await expect(page.getByRole("status")).toContainText("HTTP 200");
      await page.getByLabel("Ping destination").fill("192.168.20.20");
      await button(page, "Send ping").click();
      await expect(page.getByRole("status")).toContainText("deny ICMP");
      await button(page, gateway).click();
      await selectInterface(
        page,
        iface + (iface.startsWith("Vlan") ? " · SVI" : " · 802.1Q"),
      );
      await expect(page.getByLabel("Interface operational state")).toHaveText(
        "Operationally up",
      );
      await expect(page.getByLabel("DHCP helper addresses")).toHaveValue(
        "192.168.30.100",
      );
      await button(page, "Policy").click();
      await page
        .getByRole("group", { name: iface, exact: true })
        .getByLabel("Inbound ACL", { exact: true })
        .selectOption("");
      await button(page, "Apply policy").click();
      await button(page, "Send ping").click();
      await expect(page.getByRole("status")).toContainText(
        "echo request and reply delivered",
      );
      await page.reload();
      await button(page, gateway).click();
      await selectInterface(
        page,
        iface + (iface.startsWith("Vlan") ? " · SVI" : " · 802.1Q"),
      );
      await expect(page.getByLabel("DHCP helper addresses")).toHaveValue(
        "192.168.30.100",
      );
    },
  );
}

test("Config creates, edits and removes router subinterfaces without offering virtual cable ports", async ({
  page,
}) => {
  await page.goto("/network-studio.html");
  await button(page, "Router-on-a-stick").click();
  await button(page, "Router-1, Router").click();
  await page.getByText("Add subinterface", { exact: true }).click();
  await page.getByLabel("Parent interface", { exact: true }).selectOption("p1");
  await page.getByLabel("Subinterface number").fill("40");
  await page.getByLabel("Encapsulation VLAN").fill("40");
  await button(page, "Add interface").click();
  await page.getByLabel("Interface IPv4 address").fill("192.168.40.1");
  await button(page, "Apply configuration").click();
  await expect(page.getByLabel("Interface operational state")).toHaveText(
    "Operationally down",
  );
  await page.getByLabel("802.1Q VLAN", { exact: true }).fill("41");
  await page.getByLabel("Native VLAN", { exact: true }).check();
  await button(page, "Apply configuration").click();
  await page.reload();
  await button(page, "Router-1, Router").click();
  await selectInterface(page, "GigabitEthernet0/1.40 · 802.1Q");
  await expect(page.getByLabel("802.1Q VLAN", { exact: true })).toHaveValue(
    "41",
  );
  await expect(page.getByLabel("Native VLAN", { exact: true })).toBeChecked();
  await button(page, "Connect").click();
  await button(page, "Router-1, Router").click();
  await button(page, "Switch-1, Switch").click();
  await expect(
    page.getByLabel("Source port").locator("option"),
  ).not.toContainText(["GigabitEthernet0/1.40"]);
  await page.keyboard.press("Escape");
  await button(page, "Select").click();
  await button(page, "Router-1, Router").click();
  await selectInterface(page, "GigabitEthernet0/1.40 · 802.1Q");
  await button(page, "Remove interface").click();
  await button(page, "Apply configuration").click();
  await expect(
    page.getByLabel("Interface", { exact: true }).locator("option"),
  ).not.toContainText(["GigabitEthernet0/1.40"]);
});

test("SVI autostate follows live VLAN members and IPv4 routing can be toggled on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/network-studio.html");
  await button(page, "Multilayer switch").click();
  await button(page, "Realtime").click();
  await button(page, "Request lease").click();
  await button(page, "Switch-1, Switch").click();
  await selectInterface(page, "Vlan10 · SVI");
  await expect(page.getByLabel("Interface operational state")).toHaveText(
    "Operationally up",
  );
  await selectInterface(page, "GigabitEthernet0/0 · copper");
  await page.getByLabel("Interface enabled", { exact: true }).uncheck();
  await button(page, "Apply configuration").click();
  await selectInterface(page, "Vlan10 · SVI");
  await expect(page.getByLabel("Interface operational state")).toHaveText(
    "Operationally down",
  );
  await selectInterface(page, "GigabitEthernet0/0 · copper");
  await page.getByLabel("Interface enabled", { exact: true }).check();
  await button(page, "Apply configuration").click();
  await page.getByLabel("Enable IPv4 routing").uncheck();
  await button(page, "Apply configuration").click();
  await page.getByLabel("Ping destination").fill("192.168.30.100");
  await button(page, "Send ping").click();
  await expect(page.getByRole("status")).not.toContainText(
    "echo request and reply delivered",
  );
  await page.getByLabel("Enable IPv4 routing").check();
  await button(page, "Apply configuration").click();
  await button(page, "Send ping").click();
  await expect(page.getByRole("status")).toContainText(
    "echo request and reply delivered",
  );
  await page.getByText("Add VLAN interface", { exact: true }).click();
  await page.getByLabel("SVI VLAN").fill("40");
  await button(page, "Add interface").click();
  await page.getByLabel("Interface IPv4 address").fill("192.168.40.1");
  await button(page, "Apply configuration").click();
  await expect(page.getByLabel("Interface operational state")).toHaveText(
    "Operationally down",
  );
  await expect(page.getByLabel("Port mode", { exact: true })).toHaveCount(0);
  await expect(button(page, "Apply configuration")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 2,
    ),
  ).toBeTruthy();
  await button(page, "Remove interface").click();
  await button(page, "Apply configuration").click();
  await expect(
    page.getByLabel("Interface", { exact: true }).locator("option"),
  ).not.toContainText(["Vlan40"]);
});

test("device reload removes stale SVI packet definitions and undo restores them together", async ({
  page,
}) => {
  await page.goto("/network-studio.html");
  await button(page, "Multilayer switch").click();
  await button(page, "Request lease").click();
  const pdus = page.getByRole("region", { name: "User-created PDUs" });
  await pdus.getByText("User-created PDUs (0)", { exact: true }).click();
  const source = pdus.getByRole("combobox", {
    name: "PDU source",
    exact: true,
  });
  const destination = pdus.getByRole("combobox", {
    name: "PDU destination",
    exact: true,
  });
  await source.selectOption({ label: "Switch-1" });
  await destination.selectOption({ label: "Server-1" });
  await pdus.getByRole("button", { name: "Add and send PDU" }).click();
  await source.selectOption({ label: "Workstation-1" });
  await destination.selectOption({ label: "Switch-1" });
  await pdus.getByRole("button", { name: "Add and send PDU" }).click();
  await expect(pdus).toContainText("User-created PDUs (2)");
  await button(page, "Switch-1, Switch").click();
  await button(page, "Reload device").click();
  await expect(pdus).toContainText("User-created PDUs (0)");
  await expect(
    page
      .getByLabel("Interface", { exact: true })
      .getByRole("option")
      .filter({ hasText: "SVI" }),
  ).toHaveCount(0);
  await button(page, "Undo").click();
  await expect(pdus).toContainText("User-created PDUs (2)");
  await expect(
    page
      .getByLabel("Interface", { exact: true })
      .getByRole("option")
      .filter({ hasText: "SVI" }),
  ).toHaveCount(3);
  await button(page, "Reload device").click();
  await page.reload();
  await expect(page.getByLabel("Network name")).toHaveValue(
    "Multilayer switch · VLAN routing",
  );
  await expect(pdus).toContainText("User-created PDUs (0)");
});
