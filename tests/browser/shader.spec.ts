import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

/**
 * The shader advances its `time` uniform by a fixed step per animation frame,
 * so queueing the frames instead of running them makes the wave's phase a
 * number this file chooses rather than a race. Installed before any script on
 * the page, so the component's very first frame is caught too.
 */
const FREEZE_FRAMES = `
  window.__frames = [];
  window.requestAnimationFrame = (callback) => window.__frames.push(callback);
  window.cancelAnimationFrame = () => {};
  window.__advance = (count) => {
    for (let frame = 0; frame < count; frame++) {
      for (const callback of window.__frames.splice(0)) callback(0);
    }
  };
`;

/**
 * The phase to measure at, in frames. The shader steps 0.01 per frame from
 * zero, so this is time = PI - the phase where the visible span of the sine is
 * centred on a zero crossing and the wave is drawing its full amplitude.
 */
const PHASE_FRAMES = 313;

/**
 * The wave's lit band, as a share of the canvas height.
 *
 * A WebGL canvas without `preserveDrawingBuffer` reads back as cleared, so the
 * pixels come from a screenshot of the element, handed to a 2D canvas in the
 * page to be measured. An element screenshot is the whole page clipped to that
 * element's box, and the canvas is the whole viewport, so the sign-in card
 * over it has to be hidden or its own mint and white pixels count as wave.
 */
async function waveBand(page: Page, width: number, height: number): Promise<number> {
  await page.addInitScript(FREEZE_FRAMES);
  await page.setViewportSize({ width, height });
  await page.goto("/");
  // The sign-in card is the app's settled state: waiting for it means the
  // booting screen is not still on its way out mid-measurement.
  await page.getByRole("heading", { name: "Sign in" }).waitFor();
  await page.addStyleTag({ content: ".shell > *:not(canvas.shader-bg) { visibility: hidden !important; }" });
  await page.waitForSelector("canvas.shader-bg");
  await page.evaluate((frames) => (window as unknown as { __advance: (n: number) => void }).__advance(frames), PHASE_FRAMES);
  const shot = (await page.locator("canvas.shader-bg").screenshot()).toString("base64");
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let top = -1;
    let bottom = -1;
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4;
        if ((pixels[i] ?? 0) + (pixels[i + 1] ?? 0) + (pixels[i + 2] ?? 0) > 150) {
          if (top < 0) top = y;
          bottom = y;
          break;
        }
      }
    }
    return top < 0 ? 0 : (bottom - top + 1) / canvas.height;
  }, shot);
}

test.describe("the WebGL background", () => {
  test("keeps the wave's shape when the window is portrait", async ({ page }) => {
    // The app's own window is 520x920 and never narrower than 400x600, and a
    // wave normalised to whichever axis is shorter stretches until only a
    // fraction of a period fits across a portrait one - bands sweeping the
    // viewport as straight streaks rather than a wave behind the card. The
    // band is the amplitude made visible, so it holding steady across two very
    // different aspects is the property that regressed.
    const portrait = await waveBand(page, 520, 920);
    const landscape = await waveBand(page, 1440, 900);

    expect(portrait).toBeGreaterThan(0.4);
    expect(Math.abs(portrait - landscape) / landscape).toBeLessThan(0.1);
  });

  test("sizes its drawing buffer to its own box at the device pixel ratio", async ({ browser }) => {
    for (const deviceScaleFactor of [1, 1.5, 2]) {
      const context = await browser.newContext({ viewport: { width: 900, height: 700 }, deviceScaleFactor });
      const page = await context.newPage();
      await page.goto("/");
      await page.waitForSelector("canvas.shader-bg");
      await page.waitForTimeout(400);

      const measured = await page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>("canvas.shader-bg")!;
        const box = canvas.getBoundingClientRect();
        const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl")!;
        return {
          ratio: Math.min(window.devicePixelRatio, 2),
          box: [box.width, box.height] as [number, number],
          buffer: [canvas.width, canvas.height] as [number, number],
          viewport: [...gl.getParameter(gl.VIEWPORT)],
        };
      });

      // The buffer, the GL viewport and the box are one measurement: a buffer
      // that disagrees with the box the shader is told about is what renders
      // the wave at the wrong scale.
      const expected = [Math.floor(measured.box[0] * measured.ratio), Math.floor(measured.box[1] * measured.ratio)];
      expect(measured.buffer, `buffer at dpr ${deviceScaleFactor}`).toEqual(expected);
      expect(measured.viewport.slice(2), `GL viewport at dpr ${deviceScaleFactor}`).toEqual(expected);
      await context.close();
    }
  });

  test("keeps no per-app copy of the shader", () => {
    // The wave used to be byte-identical hand-synced copies in each app, and a
    // background fix landed in one and not the other twice. It lives in
    // `@siqshift/shared/webgl-shader` now, and a copy coming back to either
    // app's own src is the regression this catches.
    //
    // What this suite covers, plainly: the web app's shader is covered
    // behaviourally by the two tests above, which load the built web bundle
    // and measure the wave it actually draws. The desktop app is served by no
    // spec here, so its shader is covered only by there being one shader
    // module and no copy beside it. Proving the desktop bundle imports the
    // shared module would mean building it for this suite, which is a second
    // vite build the suite does not otherwise need.
    for (const app of ["desktop", "web"]) {
      expect(existsSync(fileURLToPath(new URL(`../../apps/${app}/src/WebGLShader.tsx`, import.meta.url)))).toBe(false);
    }
  });
});
