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
const device = (network, name) => network.devices.find((d) => d.name === name);
const state = (page) =>
  page.getByLabel("Learned routing state", { exact: true });
const route = (page) =>
  state(page).locator("p").filter({ hasText: "EIGRP 10.20.20.0/24" });

async function inspect(page, name, tab) {
  await button(page, name + ", Router").click();
  await button(page, tab).click();
}

async function setAs(page, value) {
  await inspect(page, "EIGRP-East", "Routing");
  await page
    .getByLabel("Autonomous system (AS)", { exact: true })
    .fill(String(value));
  await button(page, "Apply routing").click();
  await expect(state(page)).toContainText("Applied EIGRP AS: " + value);
  await expect
    .poll(async () => device(await saved(page), "EIGRP-East").routing.processId)
    .toBe(value);
}

async function selectAddress(page, address) {
  const network = await saved(page);
  const p = device(network, "EIGRP-West").ports.find(
    (entry) => entry.ip === address,
  );
  expect(p, "Mapped interface for " + address).toBeTruthy();
  await page.getByLabel("Interface", { exact: true }).selectOption(p.id);
}

async function ping(page, success = true) {
  await page
    .getByLabel("Ping source", { exact: true })
    .selectOption({ label: "Student-West" });
  await page
    .getByLabel("Ping destination", { exact: true })
    .fill("10.20.20.10");
  await button(page, "Send ping").click();
  await expect(page.locator(".ns-ping-result")).toContainText(
    success ? "echo request and reply delivered" : "No usable route",
  );
}

async function selectedRoute(page, nextHop) {
  await inspect(page, "EIGRP-West", "Routing");
  await expect(route(page)).toContainText("via " + nextHop);
  const text = await route(page).innerText();
  const metric = /metric (\d+)/.exec(text);
  const bandwidth = /Minimum bandwidth: (\d+) Kbit\/s/.exec(text);
  const delay = /Total delay: (\d+)/.exec(text);
  expect(metric).toBeTruthy();
  expect(bandwidth).toBeTruthy();
  expect(delay).toBeTruthy();
  return {
    nextHop,
    metric: Number(metric[1]),
    bandwidth: Number(bandwidth[1]),
    delay: Number(delay[1]),
  };
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
  await page
    .locator("input[type=file]")
    .setInputFiles({ name, mimeType: "application/octet-stream", buffer });
  await expect(page.locator("input[type=file]")).toHaveValue("");
  await expect(
    page.getByRole("status").filter({ hasText: "Opened “" }),
  ).toBeVisible();
  await expect
    .poll(async () => (await saved(page))?.nativeFile?.name)
    .toBe(name.replace(/\.(pkt|pka|pkz)$/, ""));
  await button(page, "Realtime").click();
}

function links(network) {
  const endpoint = (end) => {
    const d = network.devices.find((entry) => entry.id === end.device);
    const p = d.ports.find((entry) => entry.id === end.port);
    return d.name + ":" + p.ip + ":" + p.media;
  };
  return network.links
    .map((link) => ({
      cable: link.cable,
      endpoints: [endpoint(link.a), endpoint(link.b)].sort(),
    }))
    .sort((a, b) => a.endpoints.join().localeCompare(b.endpoints.join()));
}

function expectMappedLab(original, imported) {
  expect(imported.devices.map((d) => d.name).sort()).toEqual(
    original.devices.map((d) => d.name).sort(),
  );
  expect(imported.links).toHaveLength(6);
  expect(imported.links.filter((link) => link.cable === "fiber")).toHaveLength(
    2,
  );
  expect(links(imported)).toEqual(links(original));
  for (const source of original.devices) {
    const mapped = device(imported, source.name);
    expect(mapped.kind).toBe(source.kind);
    if (source.kind === "pc") expect(mapped.gateway).toBe(source.gateway);
    for (const port of source.ports.filter((p) => p.ip)) {
      const actual = mapped.ports.find((p) => p.ip === port.ip);
      expect(actual, source.name + " " + port.ip).toBeTruthy();
      expect(actual.media).toBe(port.media);
      expect(actual.prefix).toBe(port.prefix);
      expect(actual.enabled).toBe(port.enabled);
      // Native chassis may materialize an inherited metric to preserve the
      // generic interface's effective value. Explicit overrides must survive.
      for (const field of ["bandwidth", "delay"])
        if (port[field] !== undefined) expect(actual[field]).toBe(port[field]);
    }
    if (!source.routing) continue;
    const passiveAddresses = (d) =>
      d.routing.passivePorts
        .map((id) => d.ports.find((p) => p.id === id).ip)
        .sort();
    expect(mapped.routing.protocol).toBe("eigrp");
    expect(mapped.routing.processId).toBe(source.routing.processId);
    expect(mapped.routing.routerId).toBe(source.routing.routerId);
    expect(mapped.routing.networks).toEqual(source.routing.networks);
    expect(passiveAddresses(mapped)).toEqual(passiveAddresses(source));
  }
}

for (const format of ["pkt", "pka", "pkz"])
  test(
    "EIGRP fiber lab saves, repairs and fails over through native ." + format,
    async ({ page }) => {
      test.setTimeout(120000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/network-studio.html");
      await button(page, "Repair EIGRP").click();
      await button(page, "Realtime").click();
      await expect
        .poll(async () => (await saved(page))?.devices?.length)
        .toBe(6);
      const initial = await saved(page);

      // Establish the generic lab's route vector before choosing a native chassis.
      await setAs(page, 10);
      await ping(page);
      const baseline = await selectedRoute(page, "192.0.2.2");
      await setAs(page, 99);
      const original = await saveNative(page, format);
      await openNative(page, "eigrp-original." + format, original);
      expectMappedLab(initial, await saved(page));
      await ping(page, false);
      assertSameBytes(
        await saveNative(page, format),
        original,
        "Initial EIGRP " + format,
      );

      await setAs(page, 10);
      await ping(page);
      expect(await selectedRoute(page, "192.0.2.2")).toEqual(baseline);
      await inspect(page, "EIGRP-West", "Config");
      await selectAddress(page, "192.0.2.1");
      await page
        .getByLabel("Delay (10 µs units)", { exact: true })
        .fill("1000");
      await button(page, "Apply configuration").click();
      const lowerPath = await selectedRoute(page, "192.0.2.10");
      await ping(page);
      const edited = await saveNative(page, format);
      expect(edited.equals(original)).toBe(false);
      await openNative(page, "eigrp-edited." + format, edited);
      expect(device(await saved(page), "EIGRP-East").routing.processId).toBe(
        10,
      );
      expect(await selectedRoute(page, "192.0.2.10")).toEqual(lowerPath);
      await ping(page);

      // Applying imported values must preserve the original native document.
      await inspect(page, "EIGRP-West", "Config");
      await selectAddress(page, "192.0.2.1");
      await expect(
        page.getByLabel("Delay (10 µs units)", { exact: true }),
      ).toHaveValue("1000");
      await button(page, "Apply configuration").click();
      await button(page, "Routing").click();
      await button(page, "Apply routing").click();
      assertSameBytes(
        await saveNative(page, format),
        edited,
        "EIGRP Config/Routing no-op " + format,
      );

      await inspect(page, "EIGRP-West", "Config");
      await selectAddress(page, "192.0.2.9");
      await page.getByLabel("Interface enabled", { exact: true }).uncheck();
      await button(page, "Apply configuration").click();
      const failover = await selectedRoute(page, "192.0.2.2");
      await ping(page);
      const changed = await saveNative(page, format);
      await openNative(page, "eigrp-failover." + format, changed);
      expect(
        device(await saved(page), "EIGRP-West").ports.find(
          (p) => p.ip === "192.0.2.9",
        ).enabled,
      ).toBe(false);
      expect(await selectedRoute(page, "192.0.2.2")).toEqual(failover);
      await ping(page);
      expect(errors).toEqual([]);
    },
  );
