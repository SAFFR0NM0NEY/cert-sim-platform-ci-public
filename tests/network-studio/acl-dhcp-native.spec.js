import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { assertSameBytes } from "../../scripts/network-studio-test-support.cjs";

test.skip(
  !process.env.CERTSIM_NATIVE_TESTS,
  "Local native file helper required",
);

const button = (page, name) => page.getByRole("button", { name, exact: true });
const saved = (page) =>
  page.evaluate(() =>
    JSON.parse(localStorage.getItem("certsim.network-studio.practice.v1")),
  );
const named = (network, name) => network.devices.find((d) => d.name === name);
const client = (network) => named(network, "Lease-Client");
const router = (network) => named(network, "Policy-Router");
const server = (network) => named(network, "DHCP-Server");
const pool = (network) =>
  server(network).services.dhcp.pools.find((p) => p.name === "Clients");

async function inspect(page, name, kind, tab) {
  await button(page, name + ", " + kind).click();
  await button(page, tab).click();
}

async function openFile(page, name, buffer) {
  await page.locator("input[type=file]").setInputFiles({
    name,
    mimeType: "application/octet-stream",
    buffer,
  });
  await expect(page.locator("input[type=file]")).toHaveValue("");
  await expect(
    page.getByRole("status").filter({ hasText: "Opened “" }),
  ).toBeVisible();
  await expect
    .poll(async () => (await saved(page))?.nativeFile?.name)
    .toBe(name.replace(/\.(pkt|pka|pkz)$/, ""));
  await button(page, "Realtime").click();
}

async function saveNative(page, format) {
  await button(page, "Packet Tracer files").click();
  const pending = page.waitForEvent("download");
  await button(page, "Save ." + format).click();
  const download = await pending;
  expect(download.suggestedFilename()).toMatch(
    new RegExp("\\." + format + "$"),
  );
  return readFile(await download.path());
}

async function requestLease(page, address) {
  await page
    .getByLabel("Application client", { exact: true })
    .selectOption({ label: "Lease-Client" });
  await page.getByLabel("Application", { exact: true }).selectOption("dhcp");
  await button(page, "Request lease").click();
  await expect(page.getByRole("status")).toContainText(
    "leased " + address + "/24 from DHCP-Server",
  );
  await expect
    .poll(async () => client(await saved(page)).ports[0].ip)
    .toBe(address);
  const network = await saved(page);
  expect(client(network).gateway).toBe("10.1.0.1");
  expect(client(network).ports[0].addressMode).toBe("dhcp");
  expect(server(network).services.dhcp.leases).toHaveLength(1);
}

async function ping(page, permitted) {
  await page
    .getByLabel("Ping source", { exact: true })
    .selectOption({ label: "Lease-Client" });
  await page
    .getByLabel("Ping destination", { exact: true })
    .fill("10.2.0.100");
  await button(page, "Send ping").click();
  await expect(page.locator(".ns-ping-result")).toContainText(
    permitted ? "echo request and reply delivered" : "deny ICMP",
  );
}

function expectMapped(network, start, expectedRules, reordered = false) {
  expect(network.devices).toHaveLength(3);
  expect(network.links).toHaveLength(2);
  const actual = router(network);
  expect(actual.ports.find((p) => p.ip === "10.1.0.1")).toMatchObject({
    inboundAcl: "CLIENT-POLICY",
    helperAddresses: ["10.2.0.100"],
  });
  expect(actual.ports.find((p) => p.ip === "10.2.0.1")).toMatchObject({
    outboundAcl: "CLIENT-POLICY",
  });
  expect(actual.accessLists).toEqual([
    {
      name: "CLIENT-POLICY",
      rules: reordered ? [...expectedRules].reverse() : expectedRules,
    },
  ]);
  expect(server(network).services.dhcp.enabled).toBe(true);
  expect(pool(network)).toMatchObject({
    name: "Clients",
    start,
    prefix: 24,
    count: 8,
    gateway: "10.1.0.1",
    dns: "",
  });
}

for (const format of ["pkt", "pka", "pkz"])
  test(
    "ACL policy and DHCP service survive native ." + format + " edits",
    async ({ page }) => {
      test.setTimeout(120000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/network-studio.html");
      await button(page, "DHCP and ACL").click();
      await button(page, "Realtime").click();
      await expect
        .poll(async () => (await saved(page))?.name)
        .toBe("DHCP and ACL · native file practice");
      const expectedRules = router(await saved(page)).accessLists[0].rules;
      await ping(page, false);
      await requestLease(page, "10.1.0.50");

      // Saving a live lease must retain configuration without serializing
      // CertSim's transient timers and reservation identities into native XML.
      const original = await saveNative(page, format);
      await openFile(page, "acl-dhcp-original." + format, original);
      expectMapped(await saved(page), "10.1.0.50", expectedRules);
      expect(server(await saved(page)).services.dhcp.leases).toEqual([]);
      assertSameBytes(
        await saveNative(page, format),
        original,
        "ACL/DHCP unchanged " + format,
      );
      await requestLease(page, "10.1.0.50");
      await ping(page, false);

      await inspect(page, "Policy-Router", "Router", "Policy");
      await button(page, "Move rule 2 up").click();
      await button(page, "Apply policy").click();
      await ping(page, true);
      await inspect(page, "DHCP-Server", "Server", "Services");
      const clients = page
        .getByRole("group")
        .filter({ has: page.getByLabel("Pool name", { exact: true }) })
        .filter({ has: page.locator('input[value="Clients"]') });
      await clients.getByLabel("Starting address", { exact: true }).fill("10.1.0.60");
      await button(page, "Apply services").click();
      await expect
        .poll(async () => pool(await saved(page)).start)
        .toBe("10.1.0.60");

      const edited = await saveNative(page, format);
      expect(edited.equals(original)).toBe(false);
      await openFile(page, "acl-dhcp-edited." + format, edited);
      expectMapped(await saved(page), "10.1.0.60", expectedRules, true);

      // Applying the imported values leaves the entire native container intact.
      await inspect(page, "Policy-Router", "Router", "Policy");
      await button(page, "Apply policy").click();
      await inspect(page, "DHCP-Server", "Server", "Services");
      await button(page, "Apply services").click();
      assertSameBytes(
        await saveNative(page, format),
        edited,
        "ACL/DHCP Policy/Services no-op " + format,
      );
      await requestLease(page, "10.1.0.60");
      await ping(page, true);
      expect(errors).toEqual([]);
    },
  );
