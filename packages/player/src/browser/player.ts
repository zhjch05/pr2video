/**
 * The tour player. One clock over every scene, cutting between recordings,
 * paced like a demo (`@pr2video/tour`'s timeline): each scene plays the drive
 * up to its checkpoint, then stops there - zooms in, shows its caption and
 * starts its narration, marks what changed, and holds until the explanation
 * is done - then eases out to the next.
 *
 * Two modes over one drawing (`draw`):
 * - interactive: the clock runs on requestAnimationFrame, with controls and narration;
 * - render: no controls and no clock of its own. `seek(t)` draws the frame at
 *   tour time `t` and resolves once it is painted, for a renderer to capture.
 *
 * Marks are found live: by the recorder's node id when one was read (the
 * replay's mirror has that very node), else at the stored box. A scene with no
 * focus zooms towards its marks; no zoom ever cuts its target off.
 */
import {
  type Box,
  fittedZoom,
  type Target,
  type TourScene,
  type TourTimeline,
  tourTimeline,
  unionBox,
  zoomTransform,
} from "@pr2video/tour"
import { Replayer } from "rrweb"

import type { PlayerData } from "../data.ts"
import { captionSide, easeTransform, type FrameState, frameAt, labelSpot } from "../frame.ts"
import { letAnimationsFinish, loaded, painted, pinRemovals, rescroll } from "./replay.ts"

type Events = Array<{ timestamp: number; type?: number; data?: never }>
type Mode = "interactive" | "render"

/** How far a playing recording may drift from the clock before it is put back. */
const DRIFT_MS = 500

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  parent?: HTMLElement,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  parent?.append(node)
  return node
}

async function gunzipBase64(base64: string): Promise<string> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))
  return new Response(stream).text()
}

function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
}

/**
 * A recorded canvas picture (a chart) reaches its canvas through
 * createImageBitmap, which rrweb awaits after a seek has returned: count the
 * ones in flight, so a rendered frame waits for its charts instead of
 * catching them blank.
 */
let picturesInFlight = 0
const createBitmap = globalThis.createImageBitmap?.bind(globalThis)
if (createBitmap)
  globalThis.createImageBitmap = ((...args: Parameters<typeof createImageBitmap>) => {
    picturesInFlight++
    return createBitmap(...args).finally(() => {
      picturesInFlight--
    })
  }) as typeof createImageBitmap

async function canvasPicturesDrawn(): Promise<void> {
  for (let i = 0; i < 200 && picturesInFlight > 0; i++)
    await new Promise((done) => setTimeout(done, 5))
}

export class TourPlayer {
  readonly timeline: TourTimeline
  private readonly scenes: ReadonlyArray<TourScene>
  private readonly events = new Map<string, Promise<Events>>()
  private readonly audio = new Map<string, HTMLAudioElement>()

  private readonly root: HTMLElement
  private readonly stage: HTMLElement
  private readonly zoomLayer: HTMLElement
  private readonly host: HTMLElement
  private readonly marksLayer: HTMLElement
  private readonly caption: HTMLElement
  private readonly captionWrap: HTMLElement
  private readonly loading: HTMLElement
  private controls: {
    play: HTMLButtonElement
    time: HTMLElement
    bar: HTMLElement
    fill: HTMLElement
    mute: HTMLButtonElement | null
    captions: HTMLButtonElement
    speeds: Array<HTMLButtonElement>
    list: Array<HTMLElement>
  } | null = null

  private current: {
    events: string | null
    replayer: Replayer | null
    recorded: Events
    scale: number
    left: number
  } = { events: null, replayer: null, recorded: [], scale: 1, left: 0 }
  private entering: Promise<void> | null = null
  private driven: { mode: "play" | "hold" | null; speed: number; atMs: number } = {
    mode: null,
    speed: 1,
    atMs: -1,
  }

  private clock = 0
  private playing = false
  private speed = 1
  private muted = false
  private captionsOn = true
  private lastIndex = -1

  private readonly data: PlayerData
  private readonly mode: Mode

  constructor(mount: HTMLElement, data: PlayerData, mode: Mode) {
    this.data = data
    this.mode = mode
    this.scenes = data.tour.scenes
    this.timeline = tourTimeline(this.scenes, new Map(Object.entries(data.shots)))
    this.root = el("div", `p2v-player p2v-${mode}`, mount)
    if (mode === "interactive") {
      const head = el("header", "p2v-head", this.root)
      el("h1", "p2v-title", head).textContent = data.tour.title
      if (data.tour.summary) el("p", "p2v-summary", head).textContent = data.tour.summary
    }
    const frame = el("div", "p2v-frame", this.root)
    this.stage = el("div", "p2v-stage", frame)
    this.zoomLayer = el("div", "p2v-zoom", this.stage)
    this.host = el("div", "p2v-host", this.zoomLayer)
    this.marksLayer = el("div", "p2v-marks", this.zoomLayer)
    this.marksLayer.setAttribute("aria-hidden", "true")
    this.captionWrap = el("div", "p2v-caption-wrap", this.stage)
    this.caption = el("p", "p2v-caption", this.captionWrap)
    this.caption.setAttribute("aria-live", "polite")
    this.loading = el("div", "p2v-loading", this.stage)
    this.loading.textContent = "Loading the recording…"
    for (const scene of this.scenes)
      if (scene.audio && data.audio[scene.audio] && mode === "interactive") {
        const element = new Audio(data.audio[scene.audio])
        element.preload = "auto"
        this.audio.set(scene.id, element)
      }
    if (mode === "interactive") this.buildControls()
    new ResizeObserver(() => this.layout()).observe(frame)
  }

  /** Loads one recording's events once. */
  private recording(path: string): Promise<Events> {
    const known = this.events.get(path)
    if (known) return known
    const encoded = this.data.events[path]
    const loading = (async () => {
      if (!encoded) throw new Error(`the tour has no recording ${path}`)
      const parsed = JSON.parse(await gunzipBase64(encoded)) as Events
      if (!Array.isArray(parsed) || !parsed.length) throw new Error(`recording ${path} is empty`)
      return pinRemovals(parsed)
    })()
    this.events.set(path, loading)
    return loading
  }

  /** Builds the Replayer for scene `index`'s recording, when it is not the one showing. */
  private async enter(index: number): Promise<void> {
    const scene = this.scenes[index]
    if (!scene || this.current.events === scene.events) return
    this.loading.hidden = false
    const recorded = await this.recording(scene.events)
    try {
      this.current.replayer?.destroy()
    } catch {
      // already gone
    }
    this.host.replaceChildren()
    const replayer = new Replayer(recorded as never, {
      root: this.host,
      speed: this.speed,
      skipInactive: false,
      // The tail is drawn on the wall clock, which a rendered frame does not follow.
      mouseTail:
        this.mode === "render" ? false : { strokeStyle: "rgba(239,68,68,0.8)", lineWidth: 2 },
      // A seek through rrweb 2.1.6's virtual DOM loses the changes after a navigation's full snapshot.
      useVirtualDom: false,
      triggerFocus: false,
    })
    // Draw recorded canvas pictures (charts). rrweb gates this behind
    // UNSAFE_replayCanvas, which as a constructor option also lets scripts run
    // in the replay's iframe; set afterwards, the iframe stays script-free and
    // only the gate opens: the pictures are drawn from this page.
    ;(
      replayer as unknown as { config: { UNSAFE_replayCanvas: boolean } }
    ).config.UNSAFE_replayCanvas = true
    const dirty = () => {
      this.canvasesChangedAt = performance.now()
    }
    replayer.on("fullsnapshot-rebuilded", dirty)
    replayer.on("event-cast", (event) => {
      const e = event as { type?: number; data?: { source?: number } }
      if (e.type === 3 && e.data?.source === 9) dirty()
    })
    this.current = { events: scene.events, replayer, recorded, scale: 1, left: 0 }
    this.driven = { mode: null, speed: 1, atMs: -1 }
    this.layout()
    this.loading.hidden = true
    const next = this.scenes[index + 1]
    if (next) void this.recording(next.events).catch(() => undefined)
  }

  /** Fits the recording to the stage: scaled by width and height, centred. */
  private layout() {
    const replayer = this.current.replayer
    const scene = this.scenes[Math.max(0, this.lastIndex)] ?? this.scenes[0]
    if (!scene) return
    const { width, height } = scene.viewport
    const frame = this.stage.parentElement as HTMLElement
    const available = {
      width: frame.clientWidth,
      height: frame.clientHeight || Number.POSITIVE_INFINITY,
    }
    const scale = Math.min(available.width / width, available.height / height)
    if (!Number.isFinite(scale) || scale <= 0) return
    this.stage.style.width = `${Math.round(width * scale)}px`
    this.stage.style.height = `${Math.round(height * scale)}px`
    this.current.scale = scale
    this.current.left = 0
    // What was measured in stage pixels is measured again at the new size.
    this.controlsCache = null
    this.textCache = null
    this.labelSpots.clear()
    if (replayer) {
      const wrapper = replayer.wrapper
      wrapper.style.position = "absolute"
      wrapper.style.top = "0"
      wrapper.style.left = "0"
      wrapper.style.transformOrigin = "0 0"
      wrapper.style.transform = `scale(${scale})`
    }
  }

  /** Brings the recording to where the frame says: playing at the approach's speed, or held. */
  private async drive(state: FrameState, exact: boolean): Promise<void> {
    const replayer = this.current.replayer
    if (!replayer) return
    const { moment } = state
    const speed = moment.speed * this.speed
    if (!exact && this.playing && moment.moving) {
      const drift = Math.abs(replayer.getCurrentTime() - moment.recordingMs)
      if (this.driven.mode === "play" && this.driven.speed === speed && drift < DRIFT_MS) return
      replayer.pause()
      replayer.setConfig({ speed })
      replayer.play(moment.recordingMs)
      this.driven = { mode: "play", speed, atMs: moment.recordingMs }
      return
    }
    if (this.driven.mode === "hold" && Math.abs(this.driven.atMs - moment.recordingMs) < 1) return
    const rebuilt = this.driven.mode === null
    this.driven = { mode: "hold", speed, atMs: moment.recordingMs }
    replayer.pause(moment.recordingMs)
    letAnimationsFinish(replayer)
    if (exact || rebuilt) {
      await loaded(replayer)
      rescroll(replayer, this.current.recorded)
    }
  }

  private controlsCache: { index: number; boxes: Array<Box> } | null = null

  /**
   * The buttons, fields and links on top at the checkpoint (not behind a
   * dialog), in stage pixels: a caption over them hides what the viewer
   * would look for. Measured once per scene, when its caption first shows.
   */
  private controlsOnShow(index: number): Array<Box> {
    if (this.controlsCache?.index === index) return this.controlsCache.boxes
    const boxes: Array<Box> = []
    const doc = this.current.replayer?.iframe.contentDocument
    if (doc) {
      const { scale, left } = this.current
      const view = doc.defaultView
      const found = doc.querySelectorAll(
        "button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=tab], [role=switch], [role=checkbox], [role=combobox]",
      )
      for (const element of Array.from(found).slice(0, 400)) {
        const rect = element.getBoundingClientRect()
        if (rect.width < 2 || rect.height < 2) continue
        if (view && (rect.bottom < 0 || rect.top > view.innerHeight)) continue
        const hit = doc.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        if (!hit || !(hit === element || element.contains(hit) || hit.contains(element))) continue
        boxes.push({
          x: left + rect.x * scale,
          y: rect.y * scale,
          width: rect.width * scale,
          height: rect.height * scale,
        })
      }
    }
    this.controlsCache = { index, boxes }
    return boxes
  }

  private textCache: { index: number; boxes: Array<Box> } | null = null

  /**
   * The lines of text on top at the checkpoint, in stage pixels: what a mark's
   * label must not cover. Measured once per scene, when its marks first show.
   */
  private textOnShow(index: number): Array<Box> {
    if (this.textCache?.index === index) return this.textCache.boxes
    const boxes: Array<Box> = []
    const doc = this.current.replayer?.iframe.contentDocument
    if (doc?.body) {
      const { scale, left } = this.current
      const view = doc.defaultView
      const walker = doc.createTreeWalker(doc.body, 4 /* NodeFilter.SHOW_TEXT */)
      const range = doc.createRange()
      for (let n = 0, node = walker.nextNode(); node && n < 3000; n++, node = walker.nextNode()) {
        if (!node.textContent?.trim()) continue
        const parent = node.parentElement
        if (!parent) continue
        range.selectNodeContents(node)
        for (const rect of Array.from(range.getClientRects())) {
          if (rect.width < 2 || rect.height < 2) continue
          if (view && (rect.bottom < 0 || rect.top > view.innerHeight)) continue
          const hit = doc.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
          if (!hit || !(hit === parent || parent.contains(hit) || hit.contains(parent))) continue
          boxes.push({
            x: left + rect.x * scale,
            y: rect.y * scale,
            width: rect.width * scale,
            height: rect.height * scale,
          })
        }
      }
    }
    this.textCache = { index, boxes }
    return boxes
  }

  /** Each label's spot by scene and mark, chosen once so it does not move while the scene plays. */
  private labelSpots = new Map<string, { x: number; y: number }>()

  /** Where a target is on the stage now, in stage pixels; null when its node has left the page. */
  private locate(target: Target): Box | null {
    const replayer = this.current.replayer
    const { scale, left } = this.current
    const stage = (box: Box): Box => ({
      x: left + box.x * scale,
      y: box.y * scale,
      width: box.width * scale,
      height: box.height * scale,
    })
    if (target.node && replayer) {
      // The iframe's own realm: `instanceof Element` is false across it.
      const node = replayer.getMirror().getNode(target.node)
      if (!node || !("getBoundingClientRect" in node) || !node.isConnected) return null
      const rect = (node as Element).getBoundingClientRect()
      return rect.width && rect.height ? stage(rect) : null
    }
    return stage(target.box)
  }

  /** Zoom, marks and caption for `state`. */
  private overlay(state: FrameState) {
    const { scene } = state.entry
    const width = this.stage.clientWidth
    const height = this.stage.clientHeight
    const markBoxes = scene.markers.map((marker) => this.locate(marker))
    const focusBox =
      (scene.focus ? this.locate(scene.focus) : null) ?? unionBox(markBoxes.flatMap((b) => b ?? []))
    const scale = focusBox ? fittedZoom({ width, height }, focusBox, scene.zoom) : 1
    const target =
      focusBox && scale > 1
        ? zoomTransform({ width, height }, focusBox, scale)
        : { x: 0, y: 0, scale: 1 }
    const zoom = easeTransform(target, state.zoom)
    this.zoomLayer.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`

    this.marksLayer.replaceChildren()
    if (state.moment.marked) {
      const outlines = markBoxes.map((box) =>
        box ? { x: box.x - 4, y: box.y - 4, width: box.width + 8, height: box.height + 8 } : null,
      )
      // A label covers neither text nor a control, nor another mark or label, where it can help it.
      const placed: Array<Box & { weight: number }> = outlines.flatMap((o) =>
        o ? [{ ...o, weight: 4 }] : [],
      )
      for (const [i, marker] of scene.markers.entries()) {
        const outline = outlines[i]
        if (!outline) continue
        const mark = el("div", `p2v-mark p2v-tone-${marker.tone}`, this.marksLayer)
        mark.style.left = `${outline.x}px`
        mark.style.top = `${outline.y}px`
        mark.style.width = `${outline.width}px`
        mark.style.height = `${outline.height}px`
        if (!marker.label) continue
        const pill = el("span", "p2v-pill", mark)
        pill.textContent = marker.label
        const key = `${scene.id} ${i}`
        let spot = this.labelSpots.get(key)
        if (!spot) {
          const size = { width: pill.offsetWidth, height: pill.offsetHeight }
          const others = placed.filter((box) => box.x !== outline.x || box.y !== outline.y)
          spot = labelSpot(
            outline,
            size,
            [...this.textOnShow(state.index), ...this.controlsOnShow(state.index), ...others],
            { width, height },
          )
          this.labelSpots.set(key, spot)
        }
        pill.style.left = `${spot.x}px`
        pill.style.top = `${spot.y}px`
        placed.push({
          x: outline.x + spot.x,
          y: outline.y + spot.y,
          width: pill.offsetWidth,
          height: pill.offsetHeight,
          weight: 4,
        })
      }
    }

    const showCaption = this.captionsOn && state.moment.captioned
    this.caption.hidden = !showCaption
    if (showCaption && this.caption.textContent !== scene.caption)
      this.caption.textContent = scene.caption
    if (showCaption) {
      // Placed by where the zoom ends, so it does not move while zooming:
      // off the focus and marks above all, then off the controls on show.
      const boxes = [
        ...[focusBox, ...markBoxes].flatMap((b) => (b ? [{ ...b, weight: 20 }] : [])),
        ...this.controlsOnShow(state.index),
      ]
      const side = captionSide({ width, height }, target, boxes, this.caption.offsetHeight)
      this.captionWrap.classList.toggle("p2v-caption-top", side === "top")
    }
  }

  /** The scene's narration, from its focus on: placed and played with the clock, silent before. */
  private narrate(state: FrameState, force: boolean) {
    for (const [id, element] of this.audio) {
      const at =
        id === state.entry.scene.id && state.moment.narrationMs !== null
          ? state.moment.narrationMs / 1_000
          : null
      const ended = at !== null && Number.isFinite(element.duration) && at >= element.duration
      if (at === null || ended) {
        if (!element.paused) element.pause()
        if (at === null && element.currentTime !== 0) element.currentTime = 0
        continue
      }
      element.playbackRate = this.speed
      element.muted = this.muted
      if (force || Math.abs(element.currentTime - at) > 0.3) element.currentTime = at
      if (this.playing && element.paused) void element.play().catch(() => undefined)
      else if (!this.playing && !element.paused) element.pause()
    }
  }

  /** Draws tour time `t`. Resolves once the recording is where it should be. */
  private async draw(t: number, exact: boolean): Promise<FrameState | null> {
    const state = frameAt(this.timeline, t)
    if (!state) return null
    if (state.index !== this.lastIndex || this.current.events !== state.entry.scene.events) {
      this.lastIndex = state.index
      this.entering ??= this.enter(state.index).finally(() => {
        this.entering = null
      })
      await this.entering
      if (this.current.events !== state.entry.scene.events) return this.draw(t, exact)
    }
    await this.drive(state, exact)
    this.overlay(state)
    this.showCanvases()
    this.tidyImages()
    return state
  }

  /**
   * Images from other sites in the replay: without a CORS header a
   * \`crossorigin\` image never loads, so it is dropped and the image loads like
   * any other when the viewer is online; one that still fails (offline, gone)
   * is hidden rather than drawn as a broken-image icon.
   */
  private tidyImages() {
    const doc = this.current.replayer?.iframe.contentDocument
    for (const img of Array.from(doc?.images ?? [])) {
      if (img.hasAttribute("crossorigin") && !img.src.startsWith("data:")) {
        const src = img.src
        img.removeAttribute("crossorigin")
        img.src = src
      }
      const broken = img.complete && img.naturalWidth === 0 && Boolean(img.getAttribute("src"))
      if (broken !== (img.style.visibility === "hidden"))
        img.style.visibility = broken ? "hidden" : ""
    }
  }

  /** When the replay last drew into a canvas; null once it has been shown. */
  private canvasesChangedAt: number | null = null
  private canvasShown = new WeakMap<HTMLCanvasElement, string>()

  /**
   * The replay's iframe runs no scripts, and a canvas in a document without
   * scripting shows its fallback content, not its drawing (HTML spec). So
   * each recorded canvas picture is shown as the canvas's own background.
   */
  private showCanvases() {
    if (this.canvasesChangedAt === null || picturesInFlight > 0) return
    const doc = this.current.replayer?.iframe.contentDocument
    for (const canvas of Array.from(doc?.querySelectorAll("canvas") ?? [])) {
      let url: string
      try {
        url = canvas.toDataURL()
      } catch {
        continue
      }
      if (this.canvasShown.get(canvas) === url) continue
      this.canvasShown.set(canvas, url)
      canvas.style.backgroundImage = `url("${url}")`
      canvas.style.backgroundSize = "100% 100%"
      canvas.style.backgroundRepeat = "no-repeat"
    }
    // A picture drawn from an image arrives a moment after its event: keep looking briefly.
    if (performance.now() - this.canvasesChangedAt > 1_000) this.canvasesChangedAt = null
  }

  /** Render mode: draw the frame at `t` and resolve once it is painted. */
  async seek(t: number): Promise<void> {
    await this.draw(t, true)
    await canvasPicturesDrawn()
    // The picture is drawn just after its bitmap resolves: then show it.
    await new Promise((done) => setTimeout(done, 0))
    this.showCanvases()
    await painted()
  }

  /** Interactive mode: start the clock. */
  start() {
    let last = performance.now()
    let busy = false
    const tick = (now: number) => {
      if (this.playing && !busy && !this.entering) {
        this.clock = Math.min(this.timeline.totalMs, this.clock + (now - last) * this.speed)
        if (this.clock >= this.timeline.totalMs) this.setPlaying(false)
      }
      last = now
      if (!busy) {
        busy = true
        void this.draw(this.clock, false)
          .then((state) => {
            if (state) {
              this.narrate(state, false)
              this.updateControls(state.index)
            }
          })
          .catch((error: unknown) => this.fail(error))
          .finally(() => {
            busy = false
          })
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }

  private fail(error: unknown) {
    this.setPlaying(false)
    this.loading.hidden = false
    this.loading.textContent = `Could not play the tour: ${error instanceof Error ? error.message : String(error)}`
  }

  private setPlaying(playing: boolean) {
    this.playing = playing
    if (!playing) {
      this.current.replayer?.pause()
      this.driven = { ...this.driven, mode: null }
      for (const element of this.audio.values()) element.pause()
    }
    if (this.controls) {
      this.controls.play.textContent = playing ? "Pause" : "Play"
      this.controls.play.setAttribute("aria-label", playing ? "Pause the tour" : "Play the tour")
    }
  }

  private jump(ms: number) {
    this.clock = Math.min(Math.max(0, ms), this.timeline.totalMs)
    this.driven = { ...this.driven, mode: null }
  }

  private buildControls() {
    const bar = el("div", "p2v-controls", this.root)
    const play = el("button", "p2v-button", bar)
    play.type = "button"
    play.textContent = "Play"
    play.addEventListener("click", () => {
      if (this.clock >= this.timeline.totalMs) this.jump(0)
      this.setPlaying(!this.playing)
    })
    const restart = el("button", "p2v-button", bar)
    restart.type = "button"
    restart.textContent = "Restart"
    restart.addEventListener("click", () => {
      this.jump(0)
      this.setPlaying(true)
    })
    const time = el("span", "p2v-time", bar)
    const track = el("div", "p2v-track", bar)
    track.setAttribute("role", "slider")
    track.setAttribute("aria-label", "Seek the tour")
    track.tabIndex = 0
    const fill = el("div", "p2v-fill", track)
    for (const entry of this.timeline.scenes.slice(1)) {
      const tick = el("div", "p2v-tick", track)
      tick.style.left = `${(entry.offsetMs / this.timeline.totalMs) * 100}%`
    }
    const seekTo = (event: PointerEvent) => {
      const rect = track.getBoundingClientRect()
      this.jump(((event.clientX - rect.left) / rect.width) * this.timeline.totalMs)
    }
    track.addEventListener("pointerdown", (event) => {
      track.setPointerCapture(event.pointerId)
      seekTo(event)
      const move = (e: PointerEvent) => seekTo(e)
      track.addEventListener("pointermove", move)
      track.addEventListener("pointerup", () => track.removeEventListener("pointermove", move), {
        once: true,
      })
    })
    track.addEventListener("keydown", (event) => {
      if (event.key === "ArrowRight") this.jump(this.clock + 5_000)
      if (event.key === "ArrowLeft") this.jump(this.clock - 5_000)
    })
    const speedGroup = el("div", "p2v-speeds", bar)
    const speeds = [1, 1.5, 2].map((option) => {
      const button = el("button", "p2v-speed", speedGroup)
      button.type = "button"
      button.textContent = `${option}x`
      button.addEventListener("click", () => {
        this.speed = option
        this.driven = { ...this.driven, mode: null }
        for (const b of speeds) b.setAttribute("aria-pressed", String(b === button))
      })
      button.setAttribute("aria-pressed", String(option === 1))
      return button
    })
    let mute: HTMLButtonElement | null = null
    if (this.audio.size) {
      mute = el("button", "p2v-button", bar)
      mute.type = "button"
      mute.textContent = "Mute"
      mute.addEventListener("click", () => {
        this.muted = !this.muted
        if (mute) mute.textContent = this.muted ? "Unmute" : "Mute"
      })
    }
    const captions = el("button", "p2v-button", bar)
    captions.type = "button"
    captions.textContent = "Captions"
    captions.setAttribute("aria-pressed", "true")
    captions.addEventListener("click", () => {
      this.captionsOn = !this.captionsOn
      captions.setAttribute("aria-pressed", String(this.captionsOn))
    })
    const list = el("ol", "p2v-scenes", this.root)
    const items = this.timeline.scenes.map((entry) => {
      const item = el("li", "p2v-scene", list)
      const button = el("button", "", item)
      button.type = "button"
      el("span", "p2v-scene-time", button).textContent = formatTime(entry.offsetMs)
      el("span", "p2v-scene-label", button).textContent = entry.scene.label
      el("span", "p2v-scene-caption", button).textContent = entry.scene.caption
      button.addEventListener("click", () => {
        this.jump(entry.offsetMs)
        this.setPlaying(true)
      })
      return item
    })
    document.addEventListener("keydown", (event) => {
      if (event.key !== " " || (event.target as HTMLElement | null)?.tagName === "BUTTON") return
      event.preventDefault()
      this.setPlaying(!this.playing)
    })
    this.controls = { play, time, bar: track, fill, mute, captions, speeds, list: items }
  }

  private updateControls(index: number) {
    if (!this.controls) return
    const { time, fill, bar, list } = this.controls
    time.textContent = `${formatTime(this.clock)} / ${formatTime(this.timeline.totalMs)}`
    fill.style.width = `${(this.clock / this.timeline.totalMs) * 100}%`
    bar.setAttribute("aria-valuenow", String(Math.round(this.clock)))
    for (const [i, item] of list.entries()) {
      const isCurrent = i === index
      if ((item.getAttribute("aria-current") === "true") !== isCurrent)
        item.setAttribute("aria-current", String(isCurrent))
    }
  }
}
