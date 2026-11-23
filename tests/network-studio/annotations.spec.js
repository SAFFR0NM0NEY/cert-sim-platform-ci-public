import { test, expect } from "@playwright/test";
test.beforeEach(async ({ page }) => {
  await page.goto("/network-studio.html");
  await page.getByRole("button", { name: "Draw", exact: true }).click();
});
const controls = (page) =>
  page.getByRole("region", { name: "Drawing controls" });
async function add(page, kind) {
  await controls(page).getByRole("button", { name: kind, exact: true }).click();
  await controls(page)
    .getByRole("button", { name: `Add ${kind.toLowerCase()}`, exact: true })
    .click();
}
async function saved(page) {
  return page.evaluate(() =>
    JSON.parse(localStorage.getItem("certsim.network-studio.practice.v1")),
  );
}
test("notes render inert multiline text and survive undo/redo, export and reload", async ({
  page,
}) => {
  await add(page, "Note");
  const text = "<img src=x onerror=alert(1)>\nAccess VLAN 10";
  await page.getByLabel("Note text", { exact: true }).fill(text);
  await page
    .getByRole("button", { name: "Apply annotation", exact: true })
    .click();
  await expect(page.locator(".ns-annotation-layer text")).toContainText(
    "Access VLAN 10",
  );
  await expect(page.locator(".ns-annotation-layer img")).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByLabel("Note text", { exact: true })).toHaveValue(
    "New note",
  );
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(page.getByLabel("Note text", { exact: true })).toHaveValue(text);
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export network", exact: false })
    .click();
  expect((await download).suggestedFilename()).toMatch(/\.json$/);
  await page.reload();
  await expect(page.locator(".ns-annotation-layer text")).toContainText(
    "Access VLAN 10",
  );
  await page.getByRole("button", { name: "Draw", exact: true }).click();
  await page
    .getByLabel("Selected annotation", { exact: true })
    .selectOption({ index: 1 });
  await expect(page.getByLabel("Note text", { exact: true })).toHaveValue(text);
});
test("all shape tools edit geometry/styles and ordering, remove and undo without editing device state", async ({
  page,
}) => {
  for (const kind of ["Rectangle", "Ellipse", "Line"]) await add(page, kind);
  const before = await saved(page);
  expect(before.annotations).toHaveLength(3);
  await page
    .getByLabel("Selected annotation", { exact: true })
    .selectOption({ index: 1 });
  await page.getByLabel("Annotation x", { exact: true }).fill("700");
  await page.getByLabel("Annotation x2", { exact: true }).fill("900");
  await page.getByRole("checkbox", { name: "Fill", exact: true }).check();
  await page
    .getByRole("button", { name: "Apply annotation", exact: true })
    .click();
  await expect(
    page.locator(".ns-annotation-layer rect.ns-annotation-shape"),
  ).toHaveAttribute("fill", "#172b46");
  await page
    .getByRole("button", { name: "Bring to front", exact: true })
    .click();
  expect((await saved(page)).annotations.at(-1).kind).toBe("rectangle");
  await page
    .getByRole("button", { name: "Remove annotation", exact: true })
    .click();
  expect((await saved(page)).annotations).toHaveLength(2);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  const after = await saved(page);
  expect(after.annotations).toHaveLength(3);
  expect(after.devices).toEqual(before.devices);
  expect(after.links).toEqual(before.links);
});
test("zoomed pointer drawing, moving and keyboard movement use logical coordinates", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  await controls(page)
    .getByRole("button", { name: "Rectangle", exact: true })
    .click();
  const layer = page.getByLabel("Canvas annotations", { exact: true });
  await layer.scrollIntoViewIfNeeded();
  let box = await layer.boundingBox();
  let sx = box.width / 1120,
    sy = box.height / 710;
  await page.mouse.move(box.x + 100 * sx, box.y + 100 * sy);
  await page.mouse.down();
  await page.mouse.move(box.x + 320 * sx, box.y + 230 * sy, { steps: 5 });
  await page.mouse.up();
  let a = (await saved(page)).annotations[0];
  expect(a.x).toBeCloseTo(100, 0);
  expect(a.x2).toBeCloseTo(320, 0);
  await layer.scrollIntoViewIfNeeded();
  box = await layer.boundingBox();
  sx = box.width / 1120;
  sy = box.height / 710;
  await page.mouse.move(box.x + 150 * sx, box.y + 150 * sy);
  await page.mouse.down();
  await page.mouse.move(box.x + 200 * sx, box.y + 180 * sy, { steps: 5 });
  await page.mouse.up();
  a = (await saved(page)).annotations[0];
  expect(a.x).toBeCloseTo(150, 0);
  expect(a.y).toBeCloseTo(130, 0);
  const node = page.getByRole("button", {
    name: "Annotation 1: rectangle",
    exact: true,
  });
  await node.focus();
  await page.keyboard.press("ArrowRight");
  expect((await saved(page)).annotations[0].x).toBe(a.x + 10);
});
test("mobile form editing stays within viewport and invalid imports leave annotations intact", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await add(page, "Note");
  await page.getByLabel("Note text", { exact: true }).fill("Branch office");
  await page
    .getByRole("button", { name: "Apply annotation", exact: true })
    .click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const original = await saved(page),
    bad = structuredClone(original);
  bad.annotations[0].color = "url(https://example.invalid)";
  await page.locator("input[type=file]").setInputFiles({
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(bad)),
  });
  await expect(page.getByRole("status")).toContainText("Annotation colors");
  expect((await saved(page)).annotations).toEqual(original.annotations);
});
