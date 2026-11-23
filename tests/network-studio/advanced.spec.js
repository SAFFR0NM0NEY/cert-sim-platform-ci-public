import { test, expect } from "@playwright/test";
test.beforeEach(async ({ page }) => {
  await page.goto("/network-studio.html");
  await page
    .getByRole("heading", { name: "Your network, explained." })
    .waitFor();
});
async function services(page) {
  await page
    .getByRole("button", { name: "DHCP / DNS / HTTP", exact: true })
    .click();
  await page.getByRole("button", { name: "Realtime", exact: true }).click();
}
async function routed(page) {
  await page
    .getByRole("button", { name: "Routed campus / OSPF", exact: true })
    .click();
  await page.getByRole("button", { name: "Realtime", exact: true }).click();
}
test("DHCP configures a real client, DNS resolves aliases and HTTP shows the configured page", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await services(page);
  await page
    .getByRole("button", { name: "Request lease", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("DHCP ACK");
  await expect(page.getByLabel("Interface IPv4 address")).toHaveValue(
    "192.168.10.50",
  );
  await expect(page.getByLabel("DNS server", { exact: true })).toHaveValue(
    "192.168.10.100",
  );
  await page.getByLabel("Application", { exact: true }).selectOption("dns");
  await page.getByLabel("DNS query", { exact: true }).fill("www.certsim.lab");
  await page.getByRole("button", { name: "Resolve name" }).click();
  await expect(page.getByRole("status")).toContainText("192.168.10.100");
  await page.getByLabel("Application", { exact: true }).selectOption("http");
  await page.getByRole("button", { name: "Browse lab site" }).click();
  await expect(page.getByLabel("HTTP response body")).toContainText(
    "Your DHCP, DNS and HTTP services are working.",
  );
  await expect(page.getByRole("status")).toContainText("HTTP 200");
  await page.reload();
  await expect(page.getByLabel("Interface IPv4 address")).toHaveValue(
    "192.168.10.50",
  );
  expect(errors).toEqual([]);
});
test("server service edits affect traffic and page content stays inert", async ({
  page,
}) => {
  await services(page);
  await page
    .getByRole("button", { name: "Server-1, Server", exact: true })
    .click();
  await page.getByRole("button", { name: "Services", exact: true }).click();
  await page.getByRole("checkbox", { name: "Enable HTTP service" }).uncheck();
  await page
    .getByRole("button", { name: "Apply services", exact: true })
    .click();
  await page.getByLabel("Application", { exact: true }).selectOption("http");
  await page.getByRole("button", { name: "Browse lab site" }).click();
  await expect(page.getByRole("status")).toContainText(
    "no enabled HTTP service",
  );
  await page.getByRole("checkbox", { name: "Enable HTTP service" }).check();
  const payload =
    '<script>window.__studioInjected=1</script><img src="https://invalid.example/tracker">';
  await page.getByLabel("Page body", { exact: true }).first().fill(payload);
  await page
    .getByRole("button", { name: "Apply services", exact: true })
    .click();
  const external = [];
  page.on("request", (r) => {
    if (!r.url().startsWith("http://127.0.0.1:4189")) external.push(r.url());
  });
  await page.getByRole("button", { name: "Browse lab site" }).click();
  await expect(page.getByLabel("HTTP response body")).toHaveText(payload);
  expect(await page.evaluate(() => window.__studioInjected)).toBeUndefined();
  expect(external).toEqual([]);
});
test("a router helper delivers DHCP leases from a remote server", async ({
  page,
}) => {
  await routed(page);
  await page
    .getByRole("button", { name: "Router-1, Router", exact: true })
    .click();
  await page.getByLabel("DHCP helper addresses").fill("10.2.0.100");
  await page.getByRole("button", { name: "Apply configuration" }).click();
  await page
    .getByRole("button", { name: "Server-1, Server", exact: true })
    .click();
  await page.getByRole("button", { name: "Services", exact: true }).click();
  await page.getByLabel("Enable DHCP service").check();
  await page.getByRole("button", { name: "+ Add DHCP pool" }).click();
  await page.getByLabel("Starting address").fill("10.1.0.50");
  await page.getByLabel("Offered gateway").fill("10.1.0.1");
  await page.getByRole("button", { name: "Apply services" }).click();
  await page
    .getByLabel("Application client")
    .selectOption({ label: "Workstation-1" });
  await page
    .getByRole("button", { name: "Request lease", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "leased 10.1.0.50/24 from Server-1",
  );
  await page.reload();
  await page
    .getByRole("button", { name: "Router-1, Router", exact: true })
    .click();
  await expect(page.getByLabel("DHCP helper addresses")).toHaveValue(
    "10.2.0.100",
  );
});

test("DHCP relay example renews and expires a client's lease on the simulation clock", async ({
  page,
}) => {
  await page.getByRole("button", { name: "DHCP relay", exact: true }).click();
  await page.getByRole("button", { name: "Realtime", exact: true }).click();
  await page
    .getByRole("button", { name: "Server-1, Server", exact: true })
    .click();
  await page.getByRole("button", { name: "Services", exact: true }).click();
  await expect(page.getByLabel("Lease duration (seconds)")).toHaveValue("120");
  await page.getByLabel("Lease duration (seconds)").fill("80");
  await page.getByRole("button", { name: "Apply services" }).click();
  await page
    .getByRole("button", { name: "Workstation-1, Workstation", exact: true })
    .click();
  await page.getByRole("button", { name: "Request DHCP on interface" }).click();
  await expect(page.getByLabel("DHCP lease state")).toContainText(
    "80s remaining",
  );
  await page.getByRole("button", { name: "Advance 60s" }).click();
  await page.reload();
  await expect(page.getByLabel("DHCP lease state")).toContainText(
    "bound · 60s remaining",
  );
  await expect(
    page.getByRole("heading", { name: "Simulation clock · 60s" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Server-1, Server", exact: true })
    .click();
  await page.getByRole("button", { name: "Services", exact: true }).click();
  await page.getByLabel("Enable DHCP service").uncheck();
  await page.getByRole("button", { name: "Apply services" }).click();
  await page.getByRole("button", { name: "Advance 60s" }).click();
  await page
    .getByRole("button", { name: "Workstation-1, Workstation", exact: true })
    .click();
  await expect(page.getByLabel("Interface IPv4 address")).toHaveValue("");
  await expect(page.getByLabel("DHCP discovery")).toContainText("retry in 60s");
  await page.reload();
  await page
    .getByRole("button", { name: "Server-1, Server", exact: true })
    .click();
  await page.getByRole("button", { name: "Services", exact: true }).click();
  await page.getByLabel("Enable DHCP service").check();
  await page.getByRole("button", { name: "Apply services" }).click();
  await page.getByRole("button", { name: "Advance 60s" }).click();
  await page
    .getByRole("button", { name: "Workstation-1, Workstation", exact: true })
    .click();
  await expect(page.getByLabel("Interface IPv4 address")).toHaveValue(
    "10.1.0.50",
  );
  await expect(page.getByLabel("DHCP lease state")).toContainText(
    "bound · 80s remaining",
  );
});

test("routing panel withdraws/restores routes and affects routed HTTP and pings", async ({
  page,
}) => {
  await routed(page);
  await page.getByRole("button", { name: "Send ping", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "echo request and reply delivered",
  );
  await page
    .getByRole("button", { name: "Router-2, Router", exact: true })
    .click();
  await page.getByRole("button", { name: "Routing", exact: true }).click();
  await expect(page.getByLabel("Learned routing state")).toContainText(
    "10.1.0.0/24",
  );
  await page.getByLabel("Protocol", { exact: true }).selectOption("none");
  await page
    .getByRole("button", { name: "Apply routing", exact: true })
    .click();
  await page.getByRole("button", { name: "Send ping", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("No usable route");
  await page.getByLabel("Protocol", { exact: true }).selectOption("ospf");
  await page
    .getByRole("button", { name: "Apply routing", exact: true })
    .click();
  await page.getByLabel("Application", { exact: true }).selectOption("http");
  await page.getByRole("button", { name: "Browse lab site" }).click();
  await expect(page.getByRole("status")).toContainText("HTTP 200");
});
test("policy UI enforces implicit deny, first-match order and protocol-specific forwarding", async ({
  page,
}) => {
  await routed(page);
  await page
    .getByRole("button", { name: "Router-1, Router", exact: true })
    .click();
  await page.getByRole("button", { name: "Policy", exact: true }).click();
  await page
    .getByRole("button", { name: "+ Add access list", exact: true })
    .click();
  await page
    .getByLabel("Inbound ACL", { exact: true })
    .first()
    .selectOption("policy-1");
  await page.getByRole("button", { name: "Apply policy", exact: true }).click();
  await page.getByRole("button", { name: "Send ping", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("implicit deny");
  await page.getByRole("button", { name: "+ Add rule", exact: true }).click();
  await page.getByLabel("Action", { exact: true }).first().selectOption("deny");
  await page
    .getByLabel("Match protocol", { exact: true })
    .first()
    .selectOption("icmp");
  await page.getByRole("button", { name: "+ Add rule", exact: true }).click();
  await page.getByRole("button", { name: "Apply policy", exact: true }).click();
  await page.getByRole("button", { name: "Send ping", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("deny ICMP");
  await page.getByLabel("Application", { exact: true }).selectOption("http");
  await page.getByRole("button", { name: "Browse lab site" }).click();
  await expect(page.getByRole("status")).toContainText("HTTP 200");
  await page
    .getByRole("button", { name: "Move rule 2 up", exact: true })
    .click();
  await page.getByRole("button", { name: "Apply policy", exact: true }).click();
  await page.getByRole("button", { name: "Send ping", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "echo request and reply delivered",
  );
});
test("mobile services panels stay usable and invalid settings do not commit", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await services(page);
  await page
    .getByRole("button", { name: "Server-1, Server", exact: true })
    .click();
  await page.getByRole("button", { name: "Services", exact: true }).click();
  await page
    .getByLabel("Record value", { exact: true })
    .first()
    .fill("not-an-address");
  await page
    .getByRole("button", { name: "Apply services", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Invalid DNS record value",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.reload();
  await page
    .getByRole("button", { name: "Server-1, Server", exact: true })
    .click();
  await page.getByRole("button", { name: "Services", exact: true }).click();
  await expect(
    page.getByLabel("Record value", { exact: true }).first(),
  ).toHaveValue("192.168.10.100");
});

test("a wireless laptop joins a protected AP, receives DHCP and browses the wired server", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Wireless office", exact: true })
    .click();
  await page.getByRole("button", { name: "Realtime", exact: true }).click();
  await page.getByRole("button", { name: "Wireless", exact: true }).click();
  const radio = page.getByRole("region", { name: "Wireless radio" });
  await expect(radio.getByLabel("Association status")).toContainText(
    "Associated with Access point-1",
  );
  await radio.getByLabel("Practice passphrase").fill("wrong-password");
  await radio.getByRole("button", { name: "Apply wireless settings" }).click();
  await expect(radio.getByLabel("Association status")).toContainText(
    "Disconnected",
  );
  await page
    .getByRole("button", { name: "Request lease", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "No eligible DHCP server",
  );
  await radio.getByText("Nearby networks", { exact: true }).click();
  await radio.getByRole("button", { name: /CertSim Office · channel/ }).click();
  await radio.getByLabel("Practice passphrase").fill("practice-wifi");
  await radio.getByRole("button", { name: "Apply wireless settings" }).click();
  await page
    .getByRole("button", { name: "Request lease", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("DHCP ACK");
  await page.getByLabel("Application", { exact: true }).selectOption("http");
  await page.getByRole("button", { name: "Browse lab site" }).click();
  await expect(page.getByLabel("HTTP response body")).toContainText(
    "Your DHCP, DNS and HTTP services are working",
  );
  await page
    .getByRole("button", { name: "Access point-1, Access point", exact: true })
    .click();
  await page.getByRole("button", { name: "Wireless", exact: true }).click();
  await expect(radio.getByLabel("Associated stations")).toContainText(
    "Laptop-1",
  );
  await radio.getByLabel("Radio range (canvas units)").fill("100");
  await radio.getByRole("button", { name: "Apply wireless settings" }).click();
  await expect(radio.getByLabel("Associated stations")).toContainText(
    "0 associated",
  );
  await page.reload();
  await page.getByRole("button", { name: "Wireless", exact: true }).click();
  await expect(radio.getByLabel("Association status")).toContainText(
    "Disconnected",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("a laptop can rejoin a 5 GHz access point after correcting its adapter band", async ({
  page,
}) => {
  const button = (name) => page.getByRole("button", { name, exact: true });
  await button("Wireless office").click();
  await button("Access point-1, Access point").click();
  await button("Wireless").click();
  const radio = page.getByRole("region", { name: "Wireless radio" });
  const band = radio.getByLabel("Radio band"),
    mode = radio.getByLabel("Radio mode");
  await band.selectOption("5");
  await mode.selectOption("ac");
  await radio.getByLabel("Radio channel").selectOption("44");
  await button("Apply wireless settings").click();
  await expect(radio.getByLabel("Associated stations")).toContainText(
    "Laptop-1",
  );
  await button("Laptop-1, Laptop").click();
  await button("Wireless").click();
  await band.selectOption("2.4");
  await mode.selectOption("g");
  await button("Apply wireless settings").click();
  await expect(radio.getByLabel("Association status")).toHaveText(
    "Disconnected",
  );
  await radio.getByText("Nearby networks", { exact: true }).click();
  await expect(radio.getByText("No visible networks in range.")).toBeVisible();
  await band.selectOption("5");
  await mode.selectOption("ac");
  await button("Apply wireless settings").click();
  await expect(radio.getByLabel("Association status")).toContainText(
    "channel 44",
  );
  await page.reload();
  await button("Wireless").click();
  await expect(band).toHaveValue("5");
  await expect(mode).toHaveValue("ac");
  await button("Realtime").click();
  await button("Send ping").click();
  await expect(page.getByRole("status")).toContainText(
    "echo request and reply delivered",
  );
});

test("wireless repair activity can be completed, exported, reset, reopened and edited", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const button = (name) => page.getByRole("button", { name, exact: true });
  const open = () => button("Practice activity").click();
  await button("Wireless troubleshooting").click();
  const dialog = page.getByRole("dialog", { name: "Practice activity" });
  await expect(
    dialog.getByText("Restore the wireless link", { exact: true }),
  ).toBeVisible();
  await button("Check results").click();
  await expect(dialog.getByRole("status")).toHaveText("0 of 2 checks passed");
  await button("Close dialog").click();
  await button("Wireless").click();
  await page.getByLabel("Radio band", { exact: true }).selectOption("5");
  await page.getByLabel("Radio mode", { exact: true }).selectOption("ac");
  await button("Apply wireless settings").click();
  await open();
  await button("Check results").click();
  await expect(dialog.getByRole("status")).toHaveText("2 of 2 checks passed");
  await button("Close dialog").click();
  const download = page.waitForEvent("download");
  await button("Export network").click();
  const path = await (await download).path();
  await open();
  await button("Reset activity").click();
  await button("Check results").click();
  await expect(dialog.getByRole("status")).toHaveText("0 of 2 checks passed");
  await button("Close dialog").click();
  await page.locator("input[type=file]").setInputFiles(path);
  await open();
  await button("Check results").click();
  await expect(dialog.getByRole("status")).toHaveText("2 of 2 checks passed");
  await button("Edit activity").click();
  await dialog.getByLabel("Activity title").fill("Student wireless lab");
  await dialog
    .getByRole("textbox", { name: "Instructions", exact: true })
    .fill("Verify local connectivity.");
  await dialog
    .getByLabel("Interface setting", { exact: true })
    .selectOption("enabled");
  await button("Capture expected setting · up").click();
  await button("Save practice activity").click();
  await expect(
    dialog.getByText("Student wireless lab", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.reload();
  await open();
  await button("Check results").click();
  await expect(
    dialog.getByText("Student wireless lab", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole("status")).toHaveText("3 of 3 checks passed");
});
