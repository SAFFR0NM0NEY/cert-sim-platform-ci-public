import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { assertSameBytes } from "../../scripts/network-studio-test-support.cjs";

test.skip(
  !process.env.CERTSIM_NATIVE_TESTS,
  "Local native file helper required",
);

async function download(page, action, filename) {
  const pending = page.waitForEvent("download");
  await action();
  const result = await pending;
  if (filename) expect(result.suggestedFilename()).toBe(filename);
  return readFile(await result.path());
}

function packageFiles(pkg) {
  // Read exported resources independently of the native helper.
  const script = [
    "import base64, io, json, sys, zipfile",
    "with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as package:",
    "  print(json.dumps({name: base64.b64encode(package.read(name)).decode() for name in package.namelist() if not name.lower().endswith(('.pkt', '.pka')) and not name.endswith('/')}))",
  ].join("\n");
  return JSON.parse(execFileSync("python", ["-c", script], { input: pkg }));
}

async function saveNative(page, format) {
  await page
    .getByRole("button", { name: "Packet Tracer files", exact: true })
    .click();
  return download(page, () =>
    page.getByRole("button", { name: "Save ." + format, exact: true }).click(),
  );
}

async function openFile(page, name, buffer) {
  await page
    .locator("input[type=file]")
    .setInputFiles({ name, mimeType: "application/octet-stream", buffer });
  await expect(page.locator("input[type=file]")).toHaveValue("");
  await expect(
    page.getByRole("status").filter({ hasText: "Opened “" }),
  ).toBeVisible();
}

function addressingActivity(initial, ip) {
  const pc = initial.devices.find((d) => d.kind === "pc");
  const peer = initial.devices.find((d) => d.kind === "pc" && d.id !== pc.id);
  return {
    ...initial,
    activity: {
      title: "Repair addressing",
      instructions: "Set the workstation IPv4 address to " + ip + ".",
      initial,
      checks: [
        {
          deliver: true,
          probe: {
            id: "test-ping",
            source: pc.id,
            target: peer.id,
            port: peer.ports[0].id,
            protocol: "icmp",
          },
        },
      ],
      interfaceChecks: [
        {
          device: pc.id,
          port: pc.ports[0].id,
          field: "ipv4",
          expected: ip + "/24",
        },
      ],
    },
  };
}

test("native network and graded activity survive browser editing and reopening", async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.goto("/network-studio.html");
  const json = await download(page, () =>
    page.getByRole("button", { name: "Export network" }).click(),
  );
  const initial = JSON.parse(json.toString());
  const pkt = await saveNative(page, "pkt");
  await openFile(page, "example.pkt", pkt);
  assertSameBytes(await saveNative(page, "pkt"), pkt);
  await page
    .getByLabel("Device palette")
    .getByRole("button", { name: /Workstation/ })
    .click();
  await page.getByLabel("Device name", { exact: true }).fill("Bench-PC");
  await page.getByLabel("Interface IPv4 address").fill("192.168.10.45");
  await page.getByRole("button", { name: "Apply configuration" }).click();
  await openFile(page, "expanded.pkt", await saveNative(page, "pkt"));
  await page
    .getByRole("button", { name: "Bench-PC, Workstation", exact: true })
    .click();
  await expect(page.getByLabel("Interface IPv4 address")).toHaveValue(
    "192.168.10.45",
  );
  await page
    .getByRole("button", { name: "Remove device", exact: true })
    .click();
  await openFile(page, "reduced.pkt", await saveNative(page, "pkt"));
  await expect(
    page.getByRole("button", { name: "Bench-PC, Workstation", exact: true }),
  ).toHaveCount(0);
  const ip = "192.168.10.42";
  const activity = addressingActivity(initial, ip);
  await openFile(page, "activity.json", Buffer.from(JSON.stringify(activity)));
  const pka = await saveNative(page, "pka");
  await openFile(page, "repair.pka", pka);
  await page.getByText("Activity instructions", { exact: true }).click();
  await expect(
    page
      .getByText("Set the workstation IPv4 address", { exact: false })
      .first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Check native activity" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Earned 2 of 3" }),
  ).toBeVisible();
  await page.reload();
  assertSameBytes(await saveNative(page, "pka"), pka);
  await page.getByLabel("Interface IPv4 address").fill(ip);
  await page.getByRole("button", { name: "Apply configuration" }).click();
  const corrected = await saveNative(page, "pka");
  expect(corrected.equals(pka)).toBeFalsy();
  await openFile(page, "corrected.pka", corrected);
  await expect(page.getByLabel("Interface IPv4 address")).toHaveValue(ip);
  await page.getByText("Activity instructions", { exact: true }).click();
  await page.getByRole("button", { name: "Check native activity" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Earned 3 of 3" }),
  ).toBeVisible();
  const original = await page.getByLabel("Network name").inputValue();
  await page.locator("input[type=file]").setInputFiles({
    name: "broken.pkt",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("invalid file"),
  });
  await expect(
    page.getByRole("status").filter({ hasText: "Import failed" }),
  ).toBeVisible();
  await expect(page.getByLabel("Network name")).toHaveValue(original);
});

test("PKZ packages retain files, edits and the saved original across reloads", async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.goto("/network-studio.html");
  const filesButton = page.getByRole("button", {
    name: "Packet Tracer files",
    exact: true,
  });
  const dialog = page.getByRole("dialog", { name: "Packet Tracer files" });
  const addFiles = dialog.getByLabel("Add package files");
  const save = dialog.getByRole("button", { name: "Save .pkz", exact: true });
  await filesButton.click();
  await addFiles.setInputFiles([
    {
      name: "bench notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Test the workstation connection."),
    },
    {
      name: "topology.png",
      mimeType: "image/png",
      buffer: Buffer.from([0, 42, 127, 128, 255]),
    },
  ]);
  await expect(
    dialog.getByText("Package file changes are pending."),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Save .pkt", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.reload();
  await filesButton.click();
  await expect(
    dialog.getByRole("button", { name: "Download topology.png" }),
  ).toBeVisible();
  assertSameBytes(
    await download(
      page,
      () =>
        dialog.getByRole("button", { name: "Download topology.png" }).click(),
      "topology.png",
    ),
    Buffer.from([0, 42, 127, 128, 255]),
  );
  await page.route(
    "**/native/save",
    (route) =>
      route.fulfill({
        status: 422,
        json: { error: "Temporary package write error." },
        headers: { "Access-Control-Allow-Origin": "http://127.0.0.1:4189" },
      }),
    { times: 1 },
  );
  await save.click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Temporary package write error.",
  );
  await expect(dialog.getByText("bench notes.txt")).toBeVisible();
  await page.route(
    "**/native/save",
    (route) =>
      route.fulfill({
        status: 409,
        json: { error: "Another native file is being processed." },
        headers: { "Access-Control-Allow-Origin": "http://127.0.0.1:4189" },
      }),
    { times: 1 },
  );
  const pkg = await download(page, () => save.click());
  expect(packageFiles(pkg)).toEqual({
    "bench notes.txt": Buffer.from("Test the workstation connection.").toString(
      "base64",
    ),
    "topology.png": Buffer.from([0, 42, 127, 128, 255]).toString("base64"),
  });
  await expect(dialog).toHaveCount(0);
  await page.reload();
  assertSameBytes(await saveNative(page, "pkz"), pkg);
  await openFile(page, "Shared Network.PKZ", pkg);
  await expect(
    page.getByText("Activity instructions", { exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("Interface IPv4 address").fill("192.168.10.47");
  await page.getByRole("button", { name: "Apply configuration" }).click();
  await filesButton.click();
  await dialog.getByRole("button", { name: "Remove topology.png" }).click();
  await expect(dialog.getByText("topology.png")).toHaveCount(0);
  const edited = await download(page, () => save.click());
  expect(edited.equals(pkg)).toBeFalsy();
  expect(packageFiles(edited)).toEqual({
    "bench notes.txt": Buffer.from("Test the workstation connection.").toString(
      "base64",
    ),
  });
  await openFile(page, "Updated Network.pkz", edited);
  await expect(page.getByLabel("Interface IPv4 address")).toHaveValue(
    "192.168.10.47",
  );
  await filesButton.click();
  await expect(dialog.getByText("bench notes.txt")).toBeVisible();
  await expect(dialog.getByText("topology.png")).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Save .pkt", exact: true }),
  ).toHaveCount(0);
  assertSameBytes(await download(page, () => save.click()), edited);
});

test("new and imported activities retain grading in a PKZ package", async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.goto("/network-studio.html");
  const initial = JSON.parse(
    await download(page, () =>
      page.getByRole("button", { name: "Export network" }).click(),
    ),
  );
  const ip = "192.168.10.42";
  const activity = Buffer.from(JSON.stringify(addressingActivity(initial, ip)));
  await openFile(page, "practice.json", activity);
  const pka = await saveNative(page, "pka");
  await page
    .getByRole("button", { name: "Packet Tracer files", exact: true })
    .click();
  await page.getByLabel("Add package files").setInputFiles({
    name: "handout.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Addressing exercise"),
  });
  await expect(
    page.getByText("Package file changes are pending."),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Practice activity", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Reset activity", exact: true })
    .click();
  await page.keyboard.press("Escape");
  const newPackage = await saveNative(page, "pkz");
  expect(packageFiles(newPackage)).toEqual({
    "handout.txt": Buffer.from("Addressing exercise").toString("base64"),
  });
  await openFile(page, "New practice.pkz", newPackage);
  await expect(
    page.getByText("Activity instructions", { exact: true }),
  ).toBeVisible();
  await openFile(page, "Original activity.pka", pka);
  const wrapped = await saveNative(page, "pkz");
  await openFile(page, "Packaged practice.pkz", wrapped);
  await page.getByText("Activity instructions", { exact: true }).click();
  await expect(
    page
      .getByText("Set the workstation IPv4 address", { exact: false })
      .first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Check native activity" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Earned 2 of 3" }),
  ).toBeVisible();
  await page.getByLabel("Interface IPv4 address").fill(ip);
  await page.getByRole("button", { name: "Apply configuration" }).click();
  const corrected = await saveNative(page, "pkz");
  await openFile(page, "Corrected package.pkz", corrected);
  await page.reload();
  await page.getByText("Activity instructions", { exact: true }).click();
  await page.getByRole("button", { name: "Check native activity" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Earned 3 of 3" }),
  ).toBeVisible();
  assertSameBytes(await saveNative(page, "pkz"), corrected);
  const before = await page.getByLabel("Network name").inputValue();
  await page.locator("input[type=file]").setInputFiles({
    name: "broken.pkz",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("Invalid package"),
  });
  await expect(
    page.getByRole("status").filter({ hasText: "Import failed" }),
  ).toBeVisible();
  await expect(page.getByLabel("Network name")).toHaveValue(before);
});

test("a packaged native network retains existing resource paths and bytes", async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.goto("/network-studio.html");
  const pkt = await saveNative(page, "pkt");
  await openFile(page, "Source network.pkt", pkt);
  const wrapped = await saveNative(page, "pkz");
  const extractNetwork = [
    "import io, sys, zipfile",
    "with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as package:",
    "  sys.stdout.buffer.write(package.read(next(n for n in package.namelist() if n.lower().endswith('.pkt'))))",
  ].join("\n");
  assertSameBytes(
    execFileSync("python", ["-c", extractNetwork], { input: wrapped }),
    pkt,
  );
  const create = [
    "import io, sys, zipfile",
    "out = io.BytesIO()",
    "with zipfile.ZipFile(out, 'w', compression=zipfile.ZIP_DEFLATED) as package:",
    "  package.writestr('original.pkt', sys.stdin.buffer.read())",
    "  package.writestr('diagrams/site A/topology.bin', bytes(range(8)))",
    "sys.stdout.buffer.write(out.getvalue())",
  ].join("\n");
  const pkg = execFileSync("python", ["-c", create], { input: pkt });
  await openFile(page, "External package.pkz", pkg);
  assertSameBytes(await saveNative(page, "pkz"), pkg);
  await page.getByLabel("Network name").fill("Updated campus");
  const edited = await saveNative(page, "pkz");
  expect(packageFiles(edited)).toEqual({
    "diagrams/site A/topology.bin": Buffer.from([
      0, 1, 2, 3, 4, 5, 6, 7,
    ]).toString("base64"),
  });
  await openFile(page, "Edited package.pkz", edited);
  await expect(page.getByLabel("Network name")).toHaveValue("Updated campus");
  await page
    .getByRole("button", { name: "Packet Tracer files", exact: true })
    .click();
  assertSameBytes(
    await download(
      page,
      () =>
        page
          .getByRole("button", {
            name: "Download diagrams/site A/topology.bin",
          })
          .click(),
      "topology.bin",
    ),
    Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]),
  );
  const replacement = Buffer.from([255, 0, 222]);
  await page.getByLabel("Replace diagrams/site A/topology.bin").setInputFiles({
    name: "revised.bin",
    mimeType: "application/octet-stream",
    buffer: replacement,
  });
  await expect(
    page.getByText("Package file changes are pending."),
  ).toBeVisible();
  const replaced = await download(page, () =>
    page.getByRole("button", { name: "Save .pkz" }).click(),
  );
  expect(packageFiles(replaced)).toEqual({
    "diagrams/site A/topology.bin": replacement.toString("base64"),
  });
});

test("logical package backgrounds render local raster images and retain placement", async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.goto("/network-studio.html");
  const pkt = await saveNative(page, "pkt");
  const rasters = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 8;
    const context = canvas.getContext("2d");
    context.fillStyle = "#4a77bc";
    context.fillRect(0, 0, 16, 8);
    return ["image/png", "image/jpeg"].map(
      (type) => canvas.toDataURL(type).split(",")[1],
    );
  });
  const openPanel = () =>
    page
      .getByRole("button", { name: "Packet Tracer files", exact: true })
      .click();
  const dialog = page.getByRole("dialog", { name: "Packet Tracer files" });
  const picker = dialog.getByLabel("Logical background image");
  const layer = page.getByRole("img", {
    name: "Logical background floor.png",
    exact: true,
  });
  const uri = () =>
    layer.evaluate((el) => getComputedStyle(el).backgroundImage);
  let imageRequests = 0;
  page.on("request", (request) => {
    if (
      request.url().endsWith("/native/resource") &&
      request.method() === "POST"
    )
      imageRequests++;
  });
  await openPanel();
  await dialog.getByLabel("Add package files").setInputFiles([
    {
      name: "floor.png",
      mimeType: "image/png",
      buffer: Buffer.from(rasters[0], "base64"),
    },
    {
      name: "single.jpg",
      mimeType: "image/jpeg",
      buffer: Buffer.from(rasters[1], "base64"),
    },
    {
      name: "invalid.png",
      mimeType: "image/png",
      buffer: Buffer.from("<svg/>"),
    },
    {
      name: "vector.svg",
      mimeType: "image/svg+xml",
      buffer: Buffer.from("<svg/>"),
    },
  ]);
  await expect(picker.locator("option[value='vector.svg']")).toHaveCount(0);
  await picker.selectOption("invalid.png");
  await expect(dialog.getByRole("alert")).toContainText("readable PNG or JPEG");
  await expect(picker).toHaveValue("");
  await picker.selectOption("single.jpg");
  await expect(
    page.getByRole("img", { name: "Logical background single.jpg" }),
  ).toHaveCSS("background-repeat", "no-repeat");
  await picker.selectOption("floor.png");
  await expect(layer).toHaveCSS("background-repeat", "no-repeat");
  await dialog.getByLabel("Tile image").check();
  await expect(layer).toHaveCSS("background-repeat", "repeat");
  expect(imageRequests).toBe(0);
  const pkg = await download(page, () =>
    dialog.getByRole("button", { name: "Save .pkz" }).click(),
  );
  await openFile(page, "Campus.pkz", pkg);
  await page.reload();
  await expect(layer).toHaveCSS("background-repeat", "repeat");
  const initialUrl = await uri();
  expect(initialUrl).toContain("blob:");
  const visits = imageRequests;
  await page.getByLabel("Network name").fill("Campus floor plan");
  await page
    .getByRole("button", { name: /, Workstation$/, exact: false })
    .first()
    .press("ArrowRight");
  expect(await uri()).toEqual(initialUrl);
  expect(imageRequests).toBe(visits);
  await openPanel();
  await expect(picker).toHaveValue("floor.png");
  await expect(dialog.getByLabel("Tile image")).toBeChecked();
  await dialog.getByLabel("Replace floor.png").setInputFiles({
    name: "renamed.png",
    mimeType: "image/png",
    buffer: Buffer.from("<svg/>"),
  });
  await expect(dialog.getByRole("alert")).toContainText("readable PNG or JPEG");
  await expect(layer).toHaveCSS("background-repeat", "repeat");
  expect(await uri()).toEqual(initialUrl);
  await dialog.getByRole("button", { name: "Remove floor.png" }).click();
  await expect(layer).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(layer).toHaveCSS("background-repeat", "repeat");
  await openPanel();
  await picker.selectOption("");
  await expect(layer).toHaveCount(0);
  const cleared = await download(page, () =>
    dialog.getByRole("button", { name: "Save .pkz" }).click(),
  );
  await openFile(page, "Cleared.pkz", cleared);
  await expect(layer).toHaveCount(0);
  await openPanel();
  await expect(picker).toHaveValue("");
  await expect(
    dialog.getByText("floor.png", { exact: true }).first(),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await openFile(page, "Plain network.pkt", pkt);
  await expect(page.locator(".ns-package-background")).toHaveCount(0);
});

test("a package with many handouts can be saved from a narrow screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 600 });
  await page.goto("/network-studio.html");
  await page
    .getByRole("button", { name: "Packet Tracer files", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Packet Tracer files" });
  const files = Array.from({ length: 12 }, (_, i) => ({
    name: "Campus handout " + (i + 1) + ".txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Worksheet " + (i + 1)),
  }));
  await dialog.getByLabel("Add package files").setInputFiles(files);
  await expect(dialog.getByRole("listitem")).toHaveCount(files.length);
  const last = dialog.getByRole("button", {
    name: "Download Campus handout 12.txt",
  });
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  const save = dialog.getByRole("button", { name: "Save .pkz" });
  await save.scrollIntoViewIfNeeded();
  await expect(save).toBeInViewport();
  expect(
    await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBeTruthy();
  const pkg = await download(page, () => save.click());
  expect(Object.keys(packageFiles(pkg))).toHaveLength(files.length);
  await page
    .getByRole("button", { name: "Packet Tracer files", exact: true })
    .click();
  await expect(
    dialog.getByText("Save .pkz to bundle", { exact: false }),
  ).toHaveCount(0);
});

for (const format of ["pka", "pkz"]) {
  test(
    "restricted " + format + " keeps the original available for download",
    async ({ page }) => {
      await page.goto("/network-studio.html");
      const before = await page.getByLabel("Network name").inputValue();
      await page.route("**/native/open/" + format, (route) =>
        route.fulfill({
          json: {
            readOnly: true,
            pages: ["Follow the instructor's directions."],
          },
          headers: { "Access-Control-Allow-Origin": "http://127.0.0.1:4189" },
        }),
      );
      const bytes = Buffer.from("restricted-activity-test");
      await page.locator("input[type=file]").setInputFiles({
        name: "Timed practice." + format,
        mimeType: "application/octet-stream",
        buffer: bytes,
      });
      const preview = page.getByRole("dialog", {
        name: "Timed practice." + format,
      });
      await expect(
        preview.getByText("Follow the instructor's directions."),
      ).toBeVisible();
      assertSameBytes(
        await download(page, () =>
          preview
            .getByRole("button", { name: "Save original ." + format })
            .click(),
        ),
        bytes,
      );
      await page.keyboard.press("Escape");
      await expect(page.getByLabel("Network name")).toHaveValue(before);
    },
  );
}

test("native VLAN databases, VTP and routed physical ports survive browser edits in PKT, PKA and PKZ", async ({
  page,
}) => {
  test.setTimeout(120000);
  const script = [
    "import base64,json,sys",
    "sys.path.insert(0,'scripts/network-studio-native')",
    "from test_switching import switching_lab",
    "from serve import export_native",
    "print(json.dumps({fmt:base64.b64encode(export_native(dict(network=switching_lab(),format=fmt))).decode() for fmt in ('pkt','pka','pkz')}))",
  ].join("\n");
  const fixtures = JSON.parse(execFileSync("python", ["-B", "-c", script]));
  const button = (name) => page.getByRole("button", { name, exact: true });
  for (const format of ["pkt", "pka", "pkz"]) {
    await page.goto("/network-studio.html");
    const original = Buffer.from(fixtures[format], "base64");
    await openFile(page, "switching." + format, original);
    assertSameBytes(await saveNative(page, format), original);
    const nativeSwitch = await page.evaluate(
      () =>
        JSON.parse(
          localStorage.getItem("certsim.network-studio.practice.v1"),
        ).devices.find((d) => d.kind === "switch").name,
    );
    await button(nativeSwitch + ", Switch").click();
    await button("VLANs").click();
    await expect(page.getByLabel("VTP mode")).toHaveValue("server");
    await expect(page.getByLabel("VTP domain")).toHaveValue("lab");
    await expect(page.getByLabel("VLAN 10 name", { exact: true })).toHaveValue(
      "Students",
    );
    await page.getByLabel("VLAN 10 name", { exact: true }).fill("BrowserEdit");
    await button("Apply VLANs").click();
    await button("Config").click();
    await page.getByLabel("Interface", { exact: true }).selectOption("p2");
    await expect(page.getByLabel("Routed port", { exact: true })).toBeChecked();
    await expect(page.getByLabel("Interface IPv4 address")).toHaveValue(
      "198.51.100.1",
    );
    await page.getByLabel("Interface IPv4 address").fill("198.51.100.2");
    await button("Apply configuration").click();
    await openFile(page, "updated." + format, await saveNative(page, format));
    await button(nativeSwitch + ", Switch").click();
    await button("VLANs").click();
    await expect(page.getByLabel("VLAN 10 name", { exact: true })).toHaveValue(
      "BrowserEdit",
    );
    await button("Config").click();
    await page.getByLabel("Interface", { exact: true }).selectOption("p2");
    await expect(page.getByLabel("Interface IPv4 address")).toHaveValue(
      "198.51.100.2",
    );
    await expect(page.getByLabel("DHCP helper addresses")).toHaveValue(
      "198.51.100.10",
    );
  }
});

test("native PortFast and BPDU Guard panel edits preserve untouched fields and reopen in all formats", async ({
  page,
}) => {
  test.setTimeout(120000);
  const script = [
    "import base64,json,sys",
    "sys.path.insert(0,'scripts/network-studio-native')",
    "from test_edgeprotection import edge_lab",
    "from serve import export_native",
    "print(json.dumps({fmt:base64.b64encode(export_native(dict(network=edge_lab(),format=fmt))).decode() for fmt in ('pkt','pka','pkz')}))",
  ].join("\n");
  const fixtures = JSON.parse(execFileSync("python", ["-B", "-c", script]));
  const button = (name) => page.getByRole("button", { name, exact: true });
  const stp = page.getByRole("region", { name: "Spanning tree", exact: true });
  for (const format of ["pkt", "pka", "pkz"]) {
    await page.goto("/network-studio.html");
    const original = Buffer.from(fixtures[format], "base64");
    await openFile(page, "protected." + format, original);
    const before = await page.evaluate(() =>
      JSON.parse(
        localStorage.getItem("certsim.network-studio.practice.v1"),
      ).devices.find((d) => d.kind === "switch"),
    );
    await button(before.name + ", Switch").click();
    await button("Apply spanning tree").click();
    await button("Apply BPDU Guard recovery").click();
    const unchanged = await page.evaluate(() =>
      JSON.parse(
        localStorage.getItem("certsim.network-studio.practice.v1"),
      ).devices.find((d) => d.kind === "switch"),
    );
    expect(unchanged.spanningTree).toEqual(before.spanningTree);
    expect(unchanged.ports).toEqual(before.ports);
    expect(unchanged.bpduGuardRecovery).toEqual(before.bpduGuardRecovery);
    expect(unchanged.securityRecovery).toEqual(before.securityRecovery);
    assertSameBytes(await saveNative(page, format), original);
    const first = before.ports[0].name;
    await stp.getByLabel("PortFast by default on access ports").uncheck();
    await stp
      .locator("details.ns-stp-protection")
      .filter({ has: page.getByLabel("PortFast " + first, { exact: true }) })
      .locator("summary")
      .click();
    await page
      .getByLabel("PortFast " + first, { exact: true })
      .selectOption("trunk");
    await page
      .getByLabel("BPDU Guard " + first, { exact: true })
      .selectOption("default");
    await button("Apply spanning tree").click();
    const edited = await page.evaluate(() =>
      JSON.parse(
        localStorage.getItem("certsim.network-studio.practice.v1"),
      ).devices.find((d) => d.kind === "switch"),
    );
    expect(edited.ports.every((p) => p.spanningTreeCost === undefined)).toBe(
      true,
    );
    await openFile(
      page,
      "protected-edited." + format,
      await saveNative(page, format),
    );
    await button(before.name + ", Switch").click();
    await expect(
      stp.getByLabel("PortFast by default on access ports"),
    ).not.toBeChecked();
    await expect(
      stp.getByLabel("BPDU Guard by default on PortFast ports"),
    ).toBeChecked();
    await expect(
      page.getByLabel("PortFast " + first, { exact: true }),
    ).toHaveValue("trunk");
    await expect(
      page.getByLabel("BPDU Guard " + first, { exact: true }),
    ).toHaveValue("default");
    await expect(
      page.getByLabel("PortFast " + before.ports[1].name, { exact: true }),
    ).toHaveValue("disable");
  }
});

test("native EtherChannel panel no-ops preserve original bytes and membership edits reopen in all formats", async ({
  page,
}) => {
  test.setTimeout(120000);
  const button = (name) => page.getByRole("button", { name, exact: true });
  const west = () =>
    page.evaluate(() =>
      JSON.parse(
        localStorage.getItem("certsim.network-studio.practice.v1"),
      ).devices.find((d) => d.name === "Channel-West"),
    );
  for (const format of ["pkt", "pka", "pkz"]) {
    await page.goto("/network-studio.html");
    await button("LACP EtherChannel").click();
    // A nondefault hash requests the 3560 authoring profile; 2960 files do not retain it.
    for (const name of ["Channel-West", "Channel-East"]) {
      await button(name + ", Switch").click();
      await button("EtherChannel").click();
      await page
        .getByLabel("EtherChannel load balancing", { exact: true })
        .selectOption("src-dst-mac");
      await button("Apply EtherChannel").click();
    }
    const original = await saveNative(page, format);
    await openFile(page, "channel." + format, original);
    const before = await west();
    expect(before.etherChannelLoadBalance).toBe("src-dst-mac");
    const members = before.ports.filter((p) => p.channelGroup?.id === 1);
    expect(members).toHaveLength(2);
    expect(
      before.ports.some(
        (p) => p.virtual?.kind === "portchannel" && p.virtual.group === 1,
      ),
    ).toBe(true);
    await button("Channel-West, Switch").click();
    await button("Apply spanning tree").click();
    await button("EtherChannel").click();
    await button("Apply EtherChannel").click();
    expect(await west()).toEqual(before);
    assertSameBytes(await saveNative(page, format), original);
    await page
      .getByLabel("Channel group " + members[0].name, { exact: true })
      .selectOption("0");
    await page
      .getByLabel("Channel mode " + members[1].name, { exact: true })
      .selectOption("passive");
    await page
      .getByLabel("EtherChannel load balancing", { exact: true })
      .selectOption("dst-mac");
    await button("Apply EtherChannel").click();
    const edited = await saveNative(page, format);
    await openFile(page, "channel-edited." + format, edited);
    const reopened = await west();
    expect(reopened.etherChannelLoadBalance).toBe("dst-mac");
    expect(
      reopened.ports.find((p) => p.name === members[0].name).channelGroup,
    ).toBeUndefined();
    expect(
      reopened.ports.find((p) => p.name === members[1].name).channelGroup,
    ).toEqual({ id: 1, mode: "passive" });
    await button("Channel-West, Switch").click();
    await button("EtherChannel").click();
    await expect(page.getByLabel("EtherChannel load balancing")).toHaveValue(
      "dst-mac",
    );
    await expect(
      page.getByLabel("Channel group " + members[0].name, { exact: true }),
    ).toHaveValue("0");
    await button("Apply EtherChannel").click();
    assertSameBytes(await saveNative(page, format), edited);
  }
});
