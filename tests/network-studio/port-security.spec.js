import { test, expect } from "@playwright/test";
async function open(page) {
  await page.goto("/network-studio.html");
  await page
    .getByRole("button", { name: "Switch-1, Switch", exact: true })
    .click();
  const panel = page.getByRole("region", {
    name: "Switch port security",
    exact: true,
  });
  await panel
    .getByText("GigabitEthernet0/0 · Disabled", { exact: true })
    .click();
  return panel;
}
test("secure learning, spoof rejection, shutdown and recovery share actual frame state", async ({
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
  const mac = page.getByRole("region", { name: "MAC learning", exact: true });
  await mac.getByText("Ethernet frame test", { exact: true }).click();
  await mac
    .getByRole("button", { name: "Send Ethernet frame", exact: true })
    .click();
  await expect(
    p.getByLabel("Secure status GigabitEthernet0/0", { exact: true }),
  ).not.toContainText("Dynamic secure: none");
  await mac.getByLabel("Frame source MAC override").fill("0200.0000.0001");
  await mac
    .getByRole("button", { name: "Send Ethernet frame", exact: true })
    .click();
  await expect(
    p.getByLabel("Secure status GigabitEthernet0/0", { exact: true }),
  ).toContainText("Security shutdown");
  await expect(
    p.getByLabel("Secure status GigabitEthernet0/0", { exact: true }),
  ).toContainText("Violations: 1");
  await mac
    .getByRole("button", { name: "Clear MAC table", exact: true })
    .click();
  await expect(
    p.getByLabel("Secure status GigabitEthernet0/0", { exact: true }),
  ).toContainText("Security shutdown");
  await p
    .getByRole("button", {
      name: "Recover security GigabitEthernet0/0",
      exact: true,
    })
    .click();
  await expect(
    p.getByLabel("Secure status GigabitEthernet0/0", { exact: true }),
  ).toContainText("No security shutdown");
  await mac.getByLabel("Frame source MAC override").fill("");
  await mac
    .getByRole("button", { name: "Send Ethernet frame", exact: true })
    .click();
  await expect(mac.getByRole("status")).toContainText("reached 2");
});
test("mobile configured secure MACs persist and malformed configuration is rejected", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const p = await open(page);
  await p
    .getByLabel("Enable security GigabitEthernet0/0", { exact: true })
    .check();
  await p
    .getByLabel("Secure addresses GigabitEthernet0/0", { exact: true })
    .fill("ffff.ffff.ffff");
  await p
    .getByRole("button", {
      name: "Apply port security GigabitEthernet0/0",
      exact: true,
    })
    .click();
  await expect(p.getByRole("alert")).toContainText("unique unicast");
  await p
    .getByLabel("Secure addresses GigabitEthernet0/0", { exact: true })
    .fill("0200.0000.0001");
  await p
    .getByLabel("Secure violation GigabitEthernet0/0", { exact: true })
    .selectOption("restrict");
  await p
    .getByRole("button", {
      name: "Apply port security GigabitEthernet0/0",
      exact: true,
    })
    .click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.reload();
  await page
    .getByRole("button", { name: "Switch-1, Switch", exact: true })
    .click();
  await p.getByText("GigabitEthernet0/0 · Secure", { exact: true }).click();
  await expect(
    p.getByLabel("Enable security GigabitEthernet0/0", { exact: true }),
  ).toBeChecked();
  await expect(
    p.getByLabel("Secure addresses GigabitEthernet0/0", { exact: true }),
  ).toHaveValue("020000000001");
  await expect(
    p.getByLabel("Secure status GigabitEthernet0/0", { exact: true }),
  ).toContainText("Violations: 0");
});
test("secure aging controls expire dynamic bindings on the shared clock and retain configured addresses", async ({
  page,
}) => {
  const p = await open(page);
  await p
    .getByLabel("Enable security GigabitEthernet0/0", { exact: true })
    .check();
  await p
    .getByLabel("Secure maximum GigabitEthernet0/0", { exact: true })
    .fill("2");
  await p
    .getByLabel("Secure addresses GigabitEthernet0/0", { exact: true })
    .fill("020000000001");
  await p
    .getByLabel("Secure aging minutes GigabitEthernet0/0", { exact: true })
    .fill("1");
  await p
    .getByLabel("Secure aging type GigabitEthernet0/0", { exact: true })
    .selectOption("inactivity");
  await p
    .getByRole("button", {
      name: "Apply port security GigabitEthernet0/0",
      exact: true,
    })
    .click();
  const mac = page.getByRole("region", { name: "MAC learning", exact: true });
  await mac.getByText("Ethernet frame test", { exact: true }).click();
  await mac
    .getByRole("button", { name: "Send Ethernet frame", exact: true })
    .click();
  const status = p.getByLabel("Secure status GigabitEthernet0/0", {
    exact: true,
  });
  await expect(status).not.toContainText("Dynamic secure: none");
  await page.getByRole("button", { name: "Advance 60s", exact: true }).click();
  await expect(status).toContainText("Dynamic secure: none");
  await expect(status).toContainText("Configured: 020000000001");
  await page.reload();
  await page
    .getByRole("button", { name: "Switch-1, Switch", exact: true })
    .click();
  await p.getByText("GigabitEthernet0/0 · Secure", { exact: true }).click();
  await expect(
    p.getByLabel("Secure aging minutes GigabitEthernet0/0", { exact: true }),
  ).toHaveValue("1");
  await expect(
    p.getByLabel("Secure aging type GigabitEthernet0/0", { exact: true }),
  ).toHaveValue("inactivity");
});
test("automatic security recovery counts down on the clock and retains its saved settings", async ({
  page,
}) => {
  const panel = await open(page);
  await panel
    .getByLabel("Enable security GigabitEthernet0/0", { exact: true })
    .check();
  await panel
    .getByRole("button", {
      name: "Apply port security GigabitEthernet0/0",
      exact: true,
    })
    .click();
  const recovery = panel.getByRole("form", {
    name: "Automatic security recovery",
  });
  await recovery.getByLabel("Recover security shutdowns automatically").check();
  await recovery.getByLabel("Recovery interval (seconds)").fill("120");
  await recovery
    .getByRole("button", { name: "Apply recovery settings" })
    .click();
  const mac = page.getByRole("region", { name: "MAC learning", exact: true });
  await mac.getByText("Ethernet frame test", { exact: true }).click();
  const send = mac.getByRole("button", {
    name: "Send Ethernet frame",
    exact: true,
  });
  await send.click();
  await mac.getByLabel("Frame source MAC override").fill("020000000001");
  await send.click();
  const status = panel.getByLabel("Secure status GigabitEthernet0/0", {
    exact: true,
  });
  await expect(status).toContainText("Automatic recovery in 120s");
  const clock = page.getByRole("button", { name: "Advance 60s", exact: true });
  await clock.click();
  await expect(status).toContainText("Automatic recovery in 60s");
  await clock.click();
  await expect(status).toContainText("No security shutdown");
  await page.reload();
  await page
    .getByRole("button", { name: "Switch-1, Switch", exact: true })
    .click();
  await expect(recovery.getByLabel("Recovery interval (seconds)")).toHaveValue(
    "120",
  );
  await expect(
    recovery.getByLabel("Recover security shutdowns automatically"),
  ).toBeChecked();
});

test("static secure aging removes an unused configured address from the saved workspace", async ({
  page,
}) => {
  const panel = await open(page),
    port = "GigabitEthernet0/0";
  const field = (name) => panel.getByLabel(name + " " + port, { exact: true });
  await field("Enable security").check();
  await field("Secure addresses").fill("020000000001");
  await field("Secure aging minutes").fill("1");
  await field("Age configured secure addresses").check();
  await panel
    .getByRole("button", { name: "Apply port security " + port, exact: true })
    .click();
  await expect(field("Secure status")).toContainText(
    "Configured: 020000000001",
  );
  await page.getByRole("button", { name: "Advance 60s", exact: true }).click();
  await expect(field("Secure addresses")).toHaveValue("");
  await expect(field("Secure status")).toContainText("Configured: none");
  await page.reload();
  await page
    .getByRole("button", { name: "Switch-1, Switch", exact: true })
    .click();
  await panel.getByText(port + " · Secure", { exact: true }).click();
  await expect(field("Age configured secure addresses")).toBeChecked();
  await expect(field("Secure addresses")).toHaveValue("");
});
