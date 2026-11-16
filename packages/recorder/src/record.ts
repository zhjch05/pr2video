/**
 * The recorder: runs INSIDE the sandbox under plain node, with Playwright and
 * rrweb from /opt/pr2video. For each scene it opens a fresh browser context
 * (signed in as the scene's role), starts rrweb on the app's origin, performs
 * the steps at a person's pace, and at each checkpoint centres the focus,
 * reads where the focus and marks are (box and rrweb node id), and takes a
 * screenshot. A step that fails ends the scene there: what was recorded is
 * kept, and the result says where and why.
 *
 *   node record.mjs --scenes scenes.json --side head --out <dir> [--only <id>] [--rrweb <umd>]
 */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { parseArgs } from "node:util"

import { type Browser, type BrowserContext, chromium, type Locator, type Page } from "playwright"

import type { RecordedCheckpoint, SceneResult } from "./result.ts"
import {
  type Action,
  type Checkpoint,
  isCheckpoint,
  type Locator as LocatorSpec,
  type Scene,
  type ScenesFile,
  scenesFileSchema,
} from "./scenes.ts"

/** A beat between steps, so the recording reads as a person using the app. */
const STEP_PAUSE_MS = 500
/** How long a step waits for its element before the scene stops. */
const STEP_TIMEOUT_MS = 10_000
/** The recording keeps going this long after a checkpoint's screenshot. */
const AFTER_SHOT_MS = 700
const SETTLE_MS = 5_000

const { values } = parseArgs({
  options: {
    scenes: { type: "string" },
    side: { type: "string", default: "head" },
    out: { type: "string" },
    only: { type: "string" },
    rrweb: { type: "string" },
  },
})
if (!values.scenes || !values.out) throw new Error("usage: record --scenes <file> --out <dir>")
const side = values.side === "base" ? "base" : "head"
const out = values.out
const rrwebPath =
  values.rrweb ??
  join(dirname(createRequire(import.meta.url).resolve("rrweb")), "rrweb.umd.min.cjs")

const file: ScenesFile = scenesFileSchema.parse(JSON.parse(await readFile(values.scenes, "utf8")))
const origin = new URL(file.baseUrl).origin

function log(line: string) {
  console.log(`[record ${side}] ${line}`)
}

/** Starts rrweb on the app's origin and streams events out. Self-contained: it runs in the page. */
function startRecording(appOrigin: string): void {
  if (location.origin !== appOrigin) return
  const w = window as unknown as {
    __rrwebStarted?: boolean
    __rrwebFlushNow?: () => void
    __rrwebPush?: (batch: Array<unknown>) => void
    rrweb?: { record: (options: Record<string, unknown>) => void }
  }
  if (w.__rrwebStarted || !w.rrweb) return
  w.__rrwebStarted = true
  const buffer: Array<unknown> = []
  w.__rrwebFlushNow = () => {
    if (buffer.length) w.__rrwebPush?.(buffer.splice(0, buffer.length))
  }
  w.rrweb.record({
    emit: (event: unknown) => buffer.push(event),
    inlineStylesheet: true,
    inlineImages: true,
    collectFonts: true,
    recordCanvas: false,
    maskInputOptions: { password: true },
    sampling: { mousemove: 40, scroll: 120, input: "last" },
  })
  setInterval(() => w.__rrwebFlushNow?.(), 250)
  addEventListener("pagehide", () => w.__rrwebFlushNow?.(), true)
}

function describe(spec: LocatorSpec): string {
  const [key, value] = Object.entries(spec).find(
    ([k]) => !["exact", "nth", "name"].includes(k),
  ) ?? ["?", "?"]
  return `${key}=${JSON.stringify(value)}${spec.name ? ` name=${JSON.stringify(spec.name)}` : ""}${spec.nth !== undefined ? ` nth=${spec.nth}` : ""}`
}

function locate(page: Page, spec: LocatorSpec): Locator {
  const exact = spec.exact
  let found: Locator
  if (spec.role)
    found = page.getByRole(spec.role as Parameters<Page["getByRole"]>[0], {
      ...(spec.name !== undefined ? { name: spec.name } : {}),
      ...(exact !== undefined ? { exact } : {}),
    })
  else if (spec.label !== undefined)
    found = page.getByLabel(spec.label, exact !== undefined ? { exact } : {})
  else if (spec.text !== undefined)
    found = page.getByText(spec.text, exact !== undefined ? { exact } : {})
  else if (spec.placeholder !== undefined)
    found = page.getByPlaceholder(spec.placeholder, exact !== undefined ? { exact } : {})
  else if (spec.testId !== undefined) found = page.getByTestId(spec.testId)
  else found = page.locator(spec.css ?? "html")
  return spec.nth !== undefined ? found.nth(spec.nth) : found.first()
}

async function settle(page: Page) {
  await page.waitForLoadState("networkidle", { timeout: SETTLE_MS }).catch(() => undefined)
}

function absolute(url: string): string {
  return new URL(url, file.baseUrl).href
}

async function perform(page: Page, action: Action) {
  const timeout = STEP_TIMEOUT_MS
  if ("goto" in action) {
    await page.goto(absolute(action.goto), { waitUntil: "load", timeout: 30_000 })
    await settle(page)
  } else if ("click" in action) {
    await locate(page, action.click).click({ timeout })
    await settle(page)
  } else if ("hover" in action) await locate(page, action.hover).hover({ timeout })
  else if ("fill" in action) {
    const field = locate(page, action.fill)
    await field.click({ timeout })
    await field.fill("", { timeout })
    // Typed, not pasted: the recording shows the text arrive.
    await field.pressSequentially(action.value, {
      delay: 35,
      timeout: timeout + action.value.length * 50,
    })
  } else if ("select" in action)
    await locate(page, action.select).selectOption(action.value, { timeout })
  else if ("check" in action) await locate(page, action.check).check({ timeout })
  else if ("uncheck" in action) await locate(page, action.uncheck).uncheck({ timeout })
  else if ("press" in action) {
    if (action.on) await locate(page, action.on).press(action.press, { timeout })
    else await page.keyboard.press(action.press)
    await settle(page)
  } else if ("waitFor" in action)
    await locate(page, action.waitFor).waitFor({ state: "visible", timeout })
  else if ("wait" in action) await page.waitForTimeout(action.wait)
  else if ("scrollTo" in action) await centre(locate(page, action.scrollTo))
}

async function centre(target: Locator) {
  await target.waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS })
  await target.evaluate((el) =>
    el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }),
  )
}

/** Where `target` is now: its box in viewport pixels and its rrweb node id. */
async function measure(target: Locator) {
  return target.evaluate((el) => {
    const rect = el.getBoundingClientRect()
    const mirror = (
      window as unknown as { rrweb?: { record?: { mirror?: { getId(n: Node): number } } } }
    ).rrweb?.record?.mirror
    const id = mirror?.getId(el) ?? -1
    return {
      box: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      node: id > 0 ? id : null,
    }
  })
}

async function signIn(browser: Browser, role: string): Promise<string> {
  const steps = file.roles[role]?.steps ?? []
  const context = await browser.newContext({ viewport: file.viewport })
  const page = await context.newPage()
  try {
    await page.goto(file.baseUrl, { waitUntil: "load", timeout: 30_000 })
    for (const [i, step] of steps.entries()) {
      try {
        await perform(page, step)
      } catch (error) {
        throw new Error(
          `signing in as ${role} failed at step ${i + 1}: ${(error as Error).message.split("\n")[0]}`,
        )
      }
    }
    await settle(page)
    const path = join(out, `.auth-${role}.json`)
    await context.storageState({ path })
    return path
  } finally {
    await context.close()
  }
}

async function recordScene(
  browser: Browser,
  scene: Scene,
  auth: Map<string, string>,
): Promise<SceneResult> {
  const dir = join(out, scene.id)
  await mkdir(dir, { recursive: true })
  const storageState = scene.role ? auth.get(scene.role) : undefined
  const context: BrowserContext = await browser.newContext({
    viewport: file.viewport,
    ...(storageState ? { storageState } : {}),
  })
  const events: Array<{ timestamp: number }> = []
  await context.exposeBinding("__rrwebPush", (_source, batch: Array<{ timestamp: number }>) => {
    events.push(...batch)
  })
  await context.addInitScript({ path: rrwebPath })
  await context.addInitScript(startRecording, origin)
  const page = await context.newPage()
  const flush = () =>
    page
      .evaluate(() => (window as unknown as { __rrwebFlushNow?: () => void }).__rrwebFlushNow?.())
      .catch(() => undefined)
  const raw: Array<Omit<RecordedCheckpoint, "atMs" | "shotMs"> & { at: number; shot: number }> = []
  let error: SceneResult["error"] = null
  const total = scene.steps.filter(isCheckpoint).length

  try {
    await page.goto(absolute(scene.url), { waitUntil: "load", timeout: 30_000 })
    await settle(page)
    await page.waitForTimeout(STEP_PAUSE_MS)
    for (const [i, step] of scene.steps.entries()) {
      try {
        if (isCheckpoint(step)) raw.push(await checkpoint(page, scene, step, flush))
        else {
          await perform(page, step)
          await page.waitForTimeout(STEP_PAUSE_MS)
        }
      } catch (cause) {
        const shot = join(dir, "stopped.png")
        const saved = await page
          .screenshot({ path: shot })
          .then(() => "stopped.png")
          .catch(() => null)
        error = {
          step: i,
          message: (cause as Error).message.split("\n")[0] ?? "failed",
          url: page.url(),
          screenshot: saved,
        }
        log(`${scene.id}: stopped at step ${i + 1}: ${error.message}`)
        break
      }
    }
    await page.waitForTimeout(AFTER_SHOT_MS)
  } catch (cause) {
    error = {
      step: -1,
      message: (cause as Error).message.split("\n")[0] ?? "failed",
      url: page.url(),
      screenshot: null,
    }
    log(`${scene.id}: could not open ${scene.url}: ${error.message}`)
  }
  await flush()
  await context.close()

  const start = events[0]?.timestamp ?? Date.now()
  const end = events.at(-1)?.timestamp ?? start
  await writeFile(join(dir, "events.json"), JSON.stringify(events))
  const checkpoints = raw.map(({ at, shot, ...rest }) => ({
    ...rest,
    atMs: Math.max(0, at - start),
    shotMs: Math.max(0, shot - start),
  }))
  const result: SceneResult = {
    scene: scene.id,
    side,
    status: checkpoints.length === total ? "shown" : checkpoints.length ? "partly" : "not-reached",
    viewport: file.viewport,
    durationMs: end - start,
    checkpoints,
    error,
    events: "events.json",
  }
  await writeFile(join(dir, "result.json"), `${JSON.stringify(result, null, 2)}\n`)
  log(
    `${scene.id}: ${result.status} (${checkpoints.length}/${total} checkpoints, ${(result.durationMs / 1000).toFixed(1)}s)`,
  )
  return result
}

async function checkpoint(
  page: Page,
  scene: Scene,
  step: Checkpoint,
  flush: () => Promise<unknown>,
) {
  await settle(page)
  const missing: Array<string> = []
  let focus: RecordedCheckpoint["focus"] = null
  if (step.focus) {
    const target = locate(page, step.focus)
    try {
      await centre(target)
      await page.waitForTimeout(300)
      focus = await measure(target)
    } catch {
      // On the head the focus must be there: the scene missed its page.
      if (side === "head")
        throw new Error(
          `checkpoint ${step.checkpoint}: focus ${describe(step.focus)} is not on the page`,
        )
      missing.push(describe(step.focus))
    }
  }
  const at = Date.now()
  const marks: RecordedCheckpoint["marks"] = []
  for (const mark of step.marks) {
    const target = locate(page, mark.locator)
    if (!(await target.isVisible().catch(() => false))) {
      missing.push(describe(mark.locator))
      continue
    }
    marks.push({ ...(await measure(target)), tone: mark.tone, label: mark.label })
  }
  await flush()
  const shot = Date.now()
  const screenshot = `${step.checkpoint}.png`
  await page.screenshot({ path: join(out, scene.id, screenshot) })
  await page.waitForTimeout(AFTER_SHOT_MS)
  return {
    checkpoint: step.checkpoint,
    at,
    shot,
    url: page.url(),
    focus,
    marks,
    missing,
    screenshot,
  }
}

const browser = await chromium.launch()
try {
  await mkdir(out, { recursive: true })
  const scenes = file.scenes.filter((s) => !values.only || s.id === values.only)
  const auth = new Map<string, string>()
  for (const role of new Set(scenes.flatMap((s) => (s.role ? [s.role] : []))))
    auth.set(role, await signIn(browser, role))
  const results: Array<SceneResult> = []
  for (const scene of scenes) results.push(await recordScene(browser, scene, auth))
  await writeFile(
    join(out, "summary.json"),
    `${JSON.stringify({ side, scenes: results.map((r) => ({ scene: r.scene, status: r.status, error: r.error })) }, null, 2)}\n`,
  )
} finally {
  await browser.close()
}
