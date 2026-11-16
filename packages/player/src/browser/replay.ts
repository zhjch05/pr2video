/**
 * What every rrweb replay in the player needs to show the recorded frame
 * faithfully. Each works around a behaviour of rrweb 2.1.6.
 */
import type { Replayer } from "rrweb"

type RecordedEvent = {
  type?: number
  timestamp: number
  data?: { source?: number; id?: number; x?: number; y?: number; initialOffset?: unknown }
}

/**
 * rrweb pauses CSS animations with the replay (`html.rrweb-paused`), so a
 * popover held on mid fade-in stays at its first, invisible frame. A hold lets
 * them finish: the frame shown is the one the checkpoint's screenshot saw.
 */
export function letAnimationsFinish(replayer: Replayer) {
  const iframe = replayer.iframe as HTMLIFrameElement | undefined
  iframe?.contentDocument?.documentElement.classList.remove("rrweb-paused")
}

/**
 * Keep rrweb from rewriting the recording. rrweb 2.1.6 applies a mutation by
 * first filtering its own `removes` IN PLACE to the nodes it can find - and a
 * forward seek re-applies events it already applied, finds them gone, and
 * deletes them from the event for good. Every later seek past that event then
 * keeps what it removed (a closed dialog still showing). Each mutation's
 * `removes` is pinned, so the filter's write goes nowhere.
 */
export function pinRemovals<T>(events: T): T {
  if (!Array.isArray(events)) return events
  for (const event of events) {
    const data = (event as { type?: number; data?: { source?: number; removes?: unknown } }).data
    // IncrementalSnapshot, Mutation.
    if ((event as { type?: number }).type !== 3 || data?.source !== 0) continue
    const removes = data.removes
    if (!Array.isArray(removes)) continue
    Object.defineProperty(data, "removes", {
      get: () => removes,
      set: () => undefined,
      enumerable: true,
      configurable: true,
    })
  }
  return events
}

/**
 * Put the page back where the recording had it scrolled. The recorder inlines
 * images as data URLs, and the browser decodes one only after rrweb has set
 * it, so the first rebuild of a page applies its scrolls to a page with no
 * image heights yet - too short, so the scroll is cut short. Re-applies, per
 * scrolled node, the last scroll at or before the current time since the last
 * full snapshot.
 */
export function rescroll(replayer: Replayer, events: ReadonlyArray<RecordedEvent>) {
  const iframe = replayer.iframe as HTMLIFrameElement | undefined
  const view = iframe?.contentWindow
  if (!view) return
  const start = events[0]?.timestamp ?? 0
  const now = start + replayer.getCurrentTime()
  let snapshot = -1
  for (const [i, event] of events.entries()) {
    if (event.timestamp > now) break
    if (event.type === 2) snapshot = i
  }
  if (snapshot < 0) return
  const offset = events[snapshot]?.data?.initialOffset as
    | { left?: number; top?: number }
    | undefined
  if (offset) view.scrollTo({ left: offset.left ?? 0, top: offset.top ?? 0, behavior: "instant" })
  const last = new Map<number, { x: number; y: number }>()
  for (const event of events.slice(snapshot + 1)) {
    if (event.timestamp > now) break
    const data = event.data
    // IncrementalSnapshot, Scroll.
    if (event.type !== 3 || data?.source !== 3 || data.id === undefined) continue
    last.set(data.id, { x: data.x ?? 0, y: data.y ?? 0 })
  }
  const mirror = replayer.getMirror()
  for (const [id, { x, y }] of last) {
    const node = mirror.getNode(id)
    const target = node === iframe?.contentDocument ? view : (node as Element | null)
    try {
      target?.scrollTo({ left: x, top: y, behavior: "instant" })
    } catch {
      // not scrollable
    }
  }
}

/** Resolves once the replay's images have decoded and its fonts loaded, or after `maxMs`. */
export async function loaded(replayer: Replayer, maxMs = 3_000): Promise<void> {
  const doc = (replayer.iframe as HTMLIFrameElement | undefined)?.contentDocument
  if (!doc) return
  const pending = [...doc.images].filter((image) => !image.complete)
  const all = Promise.all([
    ...pending.map(
      (image) =>
        new Promise<void>((resolve) => {
          image.addEventListener("load", () => resolve(), { once: true })
          image.addEventListener("error", () => resolve(), { once: true })
        }),
    ),
    doc.fonts?.ready.then(() => undefined) ?? Promise.resolve(),
  ])
  await Promise.race([all, new Promise((resolve) => setTimeout(resolve, maxMs))])
}

/** Two animation frames: long enough for the browser to lay out and paint what changed. */
export function painted(): Promise<void> {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )
}
