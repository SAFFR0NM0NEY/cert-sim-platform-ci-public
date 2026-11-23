import { test, expect } from "@playwright/test";
async function loadOffice(page) {
  await page.goto("/network-studio.html");
  await page
    .getByRole("button", { name: "Office phones", exact: true })
    .click();
}
async function selectDevice(page, name, kind) {
  await page
    .getByRole("button", { name: name + ", " + kind, exact: true })
    .click();
}
async function handset(page, index) {
  await selectDevice(page, "IP Phone-" + index, "IP Phone");
  await page.getByRole("button", { name: "Handset", exact: true }).click();
  return page.getByRole("region", { name: "IP phone handset" });
}
test("office call registers two extensions, rings, connects, sends a note and hangs up", async ({
  page,
}) => {
  await loadOffice(page);
  const first = await handset(page, 1);
  await first.getByRole("button", { name: "Register phone" }).click();
  await expect(
    first.getByRole("heading", { name: "Extension 1001" }),
  ).toBeVisible();
  const second = await handset(page, 2);
  await second.getByRole("button", { name: "Register phone" }).click();
  await handset(page, 1);
  const keys = first.getByRole("group", { name: "Phone keypad" });
  for (const digit of "10032")
    await keys.getByRole("button", { name: digit, exact: true }).click();
  await keys.getByRole("button", { name: "Delete last digit" }).click();
  await keys.getByRole("button", { name: "Delete last digit" }).click();
  await keys.getByRole("button", { name: "2", exact: true }).click();
  await expect(first.getByLabel("Dial extension")).toHaveValue("1002");
  await first.getByRole("button", { name: "Dial", exact: true }).click();
  await expect(first.getByLabel("Line status")).toHaveText("Calling 1002");
  await handset(page, 2);
  await expect(second.getByLabel("Line status")).toHaveText(
    "Incoming call from 1001",
  );
  await second.getByRole("button", { name: "Answer", exact: true }).click();
  await expect(second.getByLabel("Line status")).toHaveText(
    "Connected to 1001",
  );
  await second.getByRole("button", { name: "Send Re", exact: true }).click();
  await handset(page, 1);
  await expect(first.getByText("Received note · Re")).toBeVisible();
  await first.getByRole("button", { name: "Hang up" }).click();
  await handset(page, 2);
  await expect(second.getByLabel("Line status")).toHaveText("Line idle");
  await page.reload();
  await handset(page, 1);
  await expect(
    first.getByRole("heading", { name: "Unregistered phone" }),
  ).toBeVisible();
});
test("voice advertisements age while pass-through data still reaches its VLAN", async ({
  page,
}) => {
  await loadOffice(page);
  const openDiscovery = () =>
    page.getByRole("button", { name: "Discovery", exact: true }).click();
  await openDiscovery();
  const discovery = page.getByRole("region", { name: "Neighbor discovery" });
  await expect(discovery.getByText("Voice traffic: 20")).toBeVisible();
  await selectDevice(page, "Switch-1", "Switch");
  await openDiscovery();
  await discovery.getByLabel("CDP on interface").uncheck();
  await discovery.getByLabel("LLDP transmit").uncheck();
  await selectDevice(page, "IP Phone-1", "IP Phone");
  await openDiscovery();
  await expect(discovery.getByLabel("Learned neighbors")).toContainText(
    "Voice VLAN 20",
  );
  await page.getByRole("button", { name: "Advance 300s" }).click();
  await expect(discovery.getByText("Voice traffic: untagged")).toBeVisible();
  await page.getByRole("button", { name: "Realtime", exact: true }).click();
  await page.getByLabel("Ping source").selectOption({ label: "Workstation-1" });
  await page.getByLabel("Ping destination").fill("192.168.10.20");
  await page.getByRole("button", { name: "Send ping", exact: true }).click();
  await expect(page.getByRole("status").last()).toContainText(
    "Reply from 192.168.10.20",
  );
});
test("mobile call manager editing, DHCP provisioning and PC jack controls survive navigation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loadOffice(page);
  await selectDevice(page, "Router-1", "Router");
  await page.getByRole("button", { name: "Call manager", exact: true }).click();
  const manager = page.getByRole("form", { name: "Call manager" });
  await manager.getByLabel("Extension", { exact: true }).first().fill("2101");
  await manager.getByRole("button", { name: "Apply call manager" }).click();
  await selectDevice(page, "IP Phone-1", "IP Phone");
  const inspector = page.getByRole("complementary", {
    name: "Device inspector",
  });
  await inspector
    .getByRole("combobox", { name: "Interface", exact: true })
    .selectOption("p1");
  await expect(inspector.getByLabel("Interface IPv4 address")).toHaveCount(0);
  await expect(
    inspector.getByRole("button", { name: "Request DHCP on interface" }),
  ).toHaveCount(0);
  await inspector
    .getByRole("combobox", { name: "Interface", exact: true })
    .selectOption("p0");
  await inspector
    .getByRole("button", { name: "Request DHCP on interface" })
    .click();
  await inspector.getByRole("button", { name: "Handset", exact: true }).click();
  const phone = page.getByRole("region", { name: "IP phone handset" });
  await phone.getByLabel("Call manager address").fill("");
  await phone.getByRole("button", { name: "Save manager address" }).click();
  await expect(phone.getByText("Manager · 192.168.20.1")).toBeVisible();
  await phone.getByRole("button", { name: "Register phone" }).click();
  await expect(
    phone.getByRole("heading", { name: "Extension 2101" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("advancing the workspace clock automatically registers the lab and schedules keepalives", async ({
  page,
}) => {
  await loadOffice(page);
  const phone = await handset(page, 1);
  await expect(
    phone.getByRole("heading", { name: "Unregistered phone" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Advance 10s", exact: true }).click();
  await expect(
    phone.getByRole("heading", { name: "Extension 1001" }),
  ).toBeVisible();
  await expect(phone.getByLabel("Provisioning status")).toContainText(
    "Next check in 30s",
  );
  await page.getByRole("button", { name: "Advance 60s", exact: true }).click();
  await expect(phone.getByLabel("Provisioning status")).toContainText(
    "Call manager reachable",
  );
  await selectDevice(page, "Router-1", "Router");
  await page.getByRole("button", { name: "Call manager", exact: true }).click();
  const manager = page.getByRole("form", { name: "Call manager" });
  await expect(manager.getByText(/1001 · IP Phone-1/)).toBeVisible();
  await expect(manager.getByText(/1002 · IP Phone-2/)).toBeVisible();
});
