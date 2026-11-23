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
const server = (network) => network.devices.find((d) => d.name === "Server-1");
const client = (network) =>
  network.devices.find((d) => d.name === "Workstation-1");
const result = (page) => page.locator(".ns-ping-result");
const editedBody =
  "Edited CertSim page — DNS & HTTP <b>remain inert text</b> after native save.";

async function inspectServices(page) {
  await button(page, "Server-1, Server").click();
  await button(page, "Services").click();
}

function recordEditor(page, name) {
  return page
    .getByRole("group")
    .filter({ has: page.getByLabel("Record name", { exact: true }) })
    .filter({ has: page.locator(`input[value="${name}"]`) });
}

function pageEditor(page, path) {
  return page
    .getByRole("group")
    .filter({ has: page.getByLabel("Page path", { exact: true }) })
    .filter({ has: page.locator(`input[value="${path}"]`) });
}

async function requestLease(page) {
  await page
    .getByLabel("Application client", { exact: true })
    .selectOption({ label: "Workstation-1" });
  await page.getByLabel("Application", { exact: true }).selectOption("dhcp");
  await button(page, "Request lease").click();
  await expect(result(page)).toContainText("DHCP ACK");
  await expect
    .poll(async () => client(await saved(page)).ports[0].ip)
    .toBe("192.168.10.50");
  expect(client(await saved(page)).dns).toBe("192.168.10.100");
}

async function lookup(page, hostname) {
  await page
    .getByLabel("Application client", { exact: true })
    .selectOption({ label: "Workstation-1" });
  await page.getByLabel("Application", { exact: true }).selectOption("dns");
  await page.getByLabel("Query type", { exact: true }).selectOption("A");
  await page.getByLabel("DNS query", { exact: true }).fill(hostname);
  await button(page, "Resolve name").click();
  await expect(result(page)).toContainText("192.168.10.100");
  await expect(result(page)).toHaveClass(/success/);
}

async function browse(page, url, body) {
  await page
    .getByLabel("Application client", { exact: true })
    .selectOption({ label: "Workstation-1" });
  await page.getByLabel("Application", { exact: true }).selectOption("http");
  await page.getByLabel("Lab URL", { exact: true }).fill(url);
  await button(page, "Browse lab site").click();
  await expect(result(page)).toContainText("HTTP 200");
  await expect(page.getByLabel("HTTP response body", { exact: true })).toHaveText(
    body,
  );
  // Page bodies must stay literal after the native file path as well.
  await expect(page.getByLabel("HTTP response body").locator("b")).toHaveCount(0);
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

async function openNative(page, name, buffer) {
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

function expectMapped(network, rootBody, statusBody, alias, ttl = 300) {
  expect(network.devices).toHaveLength(4);
  expect(network.links).toHaveLength(3);
  const services = server(network).services;
  expect(services.dhcp.enabled).toBe(true);
  expect(services.dhcp.pools.find((p) => p.name === "LAN clients")).toMatchObject({
    start: "192.168.10.50",
    prefix: 24,
    count: 32,
    dns: "192.168.10.100",
  });
  expect(services.dns.enabled).toBe(true);
  expect(services.dns.records).toHaveLength(2);
  expect(services.dns.records.find((r) => r.name === "certsim.lab")).toMatchObject({
    type: "A",
    value: "192.168.10.100",
  });
  const cname = services.dns.records.find((r) => r.name === alias);
  expect(cname).toMatchObject({ type: "CNAME", value: "certsim.lab" });
  expect(cname.ttl ?? 300).toBe(ttl);
  expect(services.http.enabled).toBe(true);
  expect(services.http.pages.find((p) => p.path === "/")?.body).toBe(rootBody);
  expect(services.http.pages.find((p) => p.path === "/status")?.body).toBe(
    statusBody,
  );
}

for (const format of ["pkt", "pka", "pkz"])
  test(
    "DHCP, DNS and HTTP service edits survive native ." + format,
    async ({ page }) => {
      test.setTimeout(120000);
      const errors = [];
      const externalRequests = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (
          ["http:", "https:"].includes(url.protocol) &&
          !["127.0.0.1", "localhost"].includes(url.hostname)
        )
          externalRequests.push(url.href);
      });
      await page.goto("/network-studio.html");
      await button(page, "DHCP / DNS / HTTP").click();
      await button(page, "Realtime").click();
      await expect
        .poll(async () => (await saved(page))?.name)
        .toBe("Services · DHCP, DNS and HTTP");
      const initial = server(await saved(page)).services;
      const rootBody = initial.http.pages.find((p) => p.path === "/").body;
      const statusBody = initial.http.pages.find((p) => p.path === "/status").body;
      await requestLease(page);
      await lookup(page, "certsim.lab");
      await lookup(page, "www.certsim.lab");
      await browse(page, "http://certsim.lab/", rootBody);
      await browse(page, "http://www.certsim.lab/status", statusBody);

      const original = await saveNative(page, format);
      await openNative(page, "services-original." + format, original);
      expectMapped(await saved(page), rootBody, statusBody, "www.certsim.lab");
      expect(server(await saved(page)).services.dhcp.leases).toEqual([]);
      await inspectServices(page);
      await button(page, "Apply services").click();
      assertSameBytes(
        await saveNative(page, format),
        original,
        "Native services initial no-op " + format,
      );
      await requestLease(page);
      await lookup(page, "www.certsim.lab");
      await browse(page, "http://certsim.lab/status", statusBody);

      await inspectServices(page);
      await recordEditor(page, "www.certsim.lab")
        .getByLabel("Record name", { exact: true })
        .fill("portal.certsim.lab");
      await recordEditor(page, "portal.certsim.lab")
        .getByLabel("TTL (seconds)", { exact: true })
        .fill("90");
      await pageEditor(page, "/")
        .getByLabel("Page body", { exact: true })
        .fill(editedBody);
      await button(page, "Apply services").click();
      await expect
        .poll(async () =>
          server(await saved(page)).services.http.pages.find((p) => p.path === "/")
            ?.body,
        )
        .toBe(editedBody);
      await lookup(page, "portal.certsim.lab");
      await browse(page, "http://portal.certsim.lab/", editedBody);

      const edited = await saveNative(page, format);
      expect(edited.equals(original)).toBe(false);
      await openNative(page, "services-edited." + format, edited);
      expectMapped(
        await saved(page),
        editedBody,
        statusBody,
        "portal.certsim.lab",
        90,
      );
      expect(
        server(await saved(page)).services.dns.records.some(
          (r) => r.name === "www.certsim.lab",
        ),
      ).toBe(false);
      await inspectServices(page);
      await button(page, "Apply services").click();
      assertSameBytes(
        await saveNative(page, format),
        edited,
        "Native services edited no-op " + format,
      );
      await requestLease(page);
      await lookup(page, "portal.certsim.lab");
      await browse(page, "http://portal.certsim.lab/", editedBody);
      await browse(page, "http://certsim.lab/status", statusBody);
      expect(errors).toEqual([]);
      expect(externalRequests).toEqual([]);
    },
  );
