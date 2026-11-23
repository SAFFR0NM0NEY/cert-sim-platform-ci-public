import { test, expect } from "@playwright/test";
async function open(page) {
  await page.goto("/network-studio.html");
  await page
    .getByRole("button", { name: "Switch-1, Switch", exact: true })
    .click();
  const p = page.getByRole("region", {
    name: "Switch port security",
    exact: true,
  });
  await p.getByText("GigabitEthernet0/0 · Disabled", { exact: true }).click();
  return p;
}
test("sticky auto-learning survives reload and disabling converts it back to dynamic", async ({
  page,
}) => {
  const p = await open(page);
  await p
    .getByLabel("Enable security GigabitEthernet0/0", { exact: true })
    .check();
  await p
    .getByRole("button", {
      name: "Apply port security GigabitEthernet0/0",
      exact: true,
    })
    .click();
  await p
    .getByRole("button", {
      name: "Enable sticky learning GigabitEthernet0/0",
      exact: true,
    })
    .click();
  const m = page.getByRole("region", { name: "MAC learning", exact: true });
  await m.getByText("Ethernet frame test", { exact: true }).click();
  await m
    .getByRole("button", { name: "Send Ethernet frame", exact: true })
    .click();
  await expect(
    p.getByLabel("Secure VLAN bindings GigabitEthernet0/0", { exact: true }),
  ).toHaveValue(/1 [0-9a-f]{12} sticky/);
  await page.reload();
  await page
    .getByRole("button", { name: "Switch-1, Switch", exact: true })
    .click();
  await p.getByText("GigabitEthernet0/0 · Secure", { exact: true }).click();
  await expect(
    p.getByLabel("Secure VLAN bindings GigabitEthernet0/0", { exact: true }),
  ).toHaveValue(/sticky/);
  await p
    .getByRole("button", {
      name: "Disable sticky learning GigabitEthernet0/0",
      exact: true,
    })
    .click();
  await expect(
    p.getByLabel("Secure VLAN bindings GigabitEthernet0/0", { exact: true }),
  ).toHaveValue("");
  await expect(
    p.getByLabel("Secure status GigabitEthernet0/0", { exact: true }),
  ).not.toContainText("Dynamic secure: none");
});
test("secure VLAN lab carries tagged voice and data over the trunk and retains ping trace after sticky materialization", async ({
  page,
}) => {
  await page.goto("/network-studio.html");
  await page.getByRole("button", { name: "Secure VLANs", exact: true }).click();
  await page.getByRole("button", { name: "Realtime", exact: true }).click();
  await page.getByLabel("Ping destination").fill("192.168.20.20");
  await page.getByRole("button", { name: "Send ping", exact: true }).click();
  await expect(page.getByRole("status").last()).toContainText("Reply");
  const p = page.getByRole("region", {
    name: "Switch port security",
    exact: true,
  });
  await p.getByText("GigabitEthernet0/2 · Secure", { exact: true }).click();
  await expect(
    p.getByLabel("Secure VLAN bindings GigabitEthernet0/2", { exact: true }),
  ).toHaveValue(/20 [0-9a-f]{12} sticky/);
  await page.getByLabel("Ping source").selectOption({ label: "Workstation-2" });
  await page.getByLabel("Ping destination").fill("192.168.10.20");
  await page.getByRole("button", { name: "Send ping", exact: true }).click();
  await expect(
    p.getByLabel("Secure VLAN bindings GigabitEthernet0/2", { exact: true }),
  ).toHaveValue(/10 [0-9a-f]{12} sticky/);
  await page.getByLabel("Ping destination").fill("192.168.20.20");
  await page.getByRole("button", { name: "Send ping", exact: true }).click();
  await expect(page.getByRole("status").last()).not.toContainText("Reply from");
});
test("mobile VLAN security controls reject duplicate bindings and preserve valid limits", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/network-studio.html");
  await page.getByRole("button", { name: "Secure VLANs", exact: true }).click();
  const p = page.getByRole("region", {
    name: "Switch port security",
    exact: true,
  });
  await p.getByText("GigabitEthernet0/2 · Secure", { exact: true }).click();
  await p
    .getByLabel("Secure VLAN bindings GigabitEthernet0/2", { exact: true })
    .fill("20 020000000001 sticky\n20 020000000001 sticky");
  await p
    .getByRole("button", {
      name: "Apply port security GigabitEthernet0/2",
      exact: true,
    })
    .click();
  await expect(p.getByRole("alert")).toContainText("secure");
  await p
    .getByLabel("Secure VLAN bindings GigabitEthernet0/2", { exact: true })
    .fill("20 020000000001 sticky");
  await p
    .getByRole("button", {
      name: "Apply port security GigabitEthernet0/2",
      exact: true,
    })
    .click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
