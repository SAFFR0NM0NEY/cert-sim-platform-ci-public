import { test, expect } from "@playwright/test";
test.beforeEach(async ({ page }) => {
  await page.goto("/network-studio.html");
  await page.getByRole("button", { name: "Physical", exact: true }).click();
});
async function location(page, name) {
  await page.getByLabel("New location name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Add location", exact: true }).click();
}
test("navigate a campus, place devices, reject occupied rack units and preserve the layout", async ({
  page,
}) => {
  await location(page, "Johannesburg");
  await location(page, "Main campus");
  await location(page, "Lab A");
  await page.getByLabel("Rack unit", { exact: true }).fill("1");
  await page.getByRole("button", { name: "Place device", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Inspect Workstation-1", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Place device", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("already occupied");
  await page.getByLabel("Rack unit", { exact: true }).fill("0");
  await page.getByRole("button", { name: "Place device", exact: true }).click();
  await page
    .getByRole("button", { name: "Inspect Switch-1", exact: true })
    .click();
  await expect(
    page
      .getByLabel("Device inspector")
      .getByRole("heading", { name: "Switch-1", exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Physical", exact: true }).click();
  for (const name of ["Johannesburg", "Main campus", "Lab A"])
    await page
      .getByRole("button", { name: `Open ${name}`, exact: true })
      .click();
  await expect(
    page.getByRole("button", { name: "Inspect Workstation-1", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Remove location", exact: true }),
  ).toBeDisabled();
});
test("measured cable length changes connectivity and can be repaired at the media boundary", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Realtime", exact: true }).click();
  await page.locator(".ns-physical-cables > summary").click();
  const cable = page.getByRole("form", {
    name: "Cable length Workstation-1 to Switch-1",
    exact: true,
  });
  await cable.getByLabel("Cable length (metres)", { exact: true }).fill("101");
  await cable
    .getByRole("button", { name: "Apply length", exact: true })
    .click();
  await expect(cable).toContainText("exceeds");
  await page.getByRole("button", { name: "Send ping", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("No usable route");
  await cable.getByLabel("Cable length (metres)", { exact: true }).fill("100");
  await cable
    .getByRole("button", { name: "Apply length", exact: true })
    .click();
  await page.getByRole("button", { name: "Send ping", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "echo request and reply delivered",
  );
  await page.getByRole("button", { name: "Logical", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "Workstation-1, Workstation",
      exact: true,
    }),
  ).toBeVisible();
});
test("mobile physical placement and logical deletion leave no dangling placement on reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await location(page, "City");
  await location(page, "Building");
  await location(page, "Closet");
  await page.getByRole("button", { name: "Place device", exact: true }).click();
  await page
    .getByRole("button", { name: "Inspect Workstation-1", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Remove device", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Inspect Workstation-1", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.reload();
  await expect(
    page.getByRole("button", {
      name: "Workstation-1, Workstation",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveCount(0);
});
