# Writing the tour

The tour is a short screen recording, narrated, that walks a viewer through the change, or through the
feature the user asked for. The viewer has not opened the app. Each scene plays one recording up to a checkpoint, zooms in, shows the caption,
marks what changed, and holds while the caption is read aloud.

## Choosing scenes

- Show the checkpoints that tell the story, in the order a demo would: where the user starts, what
  they do, and what is different now (or, for a tour of the app, what they get).
- Lead with what the change did, or with what the user asked to see. Leave out checkpoints that add nothing.
- At most 12 scenes; 4 to 8 is typical.

## Captions

- One or two plain sentences, spoken to the viewer: what they are looking at and why it matters.
  "The notice is now a blue callout, and the dismiss button moved to its right."
- Present tense. No marketing words. Under 280 characters.
- Quote on-screen text in "double quotes", and only text that is on that checkpoint, exactly.

## Focus, zoom and markers

- `focus` is the element or section the caption is about. Most scenes have one.
- `zoom` is `1`, `1.5` or `2`: `2` for a small control, `1.5` for a section or a field or two of a
  form, `1` for a whole dialog or when the caption is about the page (then `focus: null`, or the
  dialog as focus, framed but not magnified). The focus must fit magnified with a margin: `tour
  check` warns when it will not.
- `markers`: up to four, the exact things the caption names, each with a `tone`: `added`, `removed`,
  `changed` for what a change did, `note` for anything else worth pointing at (every mark, in a tour
  of the app with no change). Give a short
  `label` when there are two or more; otherwise `null`.
- Boxes are viewport pixels at the checkpoint. Give the recorder's `node` id when you have it: the
  player then measures that node in the replay.

## The file

```jsonc
{
  "version": 1,
  "title": "Cart groups items by supplier",       // a few words
  "summary": "Two sentences a viewer reads before pressing play.",
  "scenes": [
    {
      "id": "s1-cart",
      "label": "S1",
      "events": "recordings/head/cart/events.json", // rrweb events, relative to tour.json
      "viewport": { "width": 1280, "height": 800 },
      "startMs": 0, "endMs": 9000, "atMs": 6200,    // the window and the checkpoint, in recording ms
      "shotMs": 6350,                               // when the checkpoint's screenshot was taken, if known
      "caption": "The cart now groups items under each supplier, with its own subtotal.",
      "focus": { "box": { "x": 320, "y": 180, "width": 640, "height": 420 }, "node": 412 },
      "zoom": 1.5,
      "markers": [
        { "box": { "x": 340, "y": 200, "width": 600, "height": 40 }, "node": 418, "label": "Supplier header", "tone": "added" }
      ]
    }
  ]
}
```

`pr2video tour draft` writes all of this from the head's recordings; you edit captions, order and
zoom. Focus and marks come from `scenes.json`: change them there, since drafting again (after
re-recording) keeps what you wrote in the tour but takes focus and marks fresh. `pr2video narrate` fills in each scene's `audio` and `audioMs` and the tour's `voice`; do not write
them yourself. Drafting again keeps the narration of every caption it keeps, and leaves out a scene you deleted
from the tour (`--fresh` brings everything back).
`pr2video tour check` also checks every recording and clip it names still exists: after
re-recording, draft again rather than keeping old timings.

## What the replay cannot show

The tour replays what rrweb recorded of the page, not a video. Check stills (`render --frame`) for:

- **Browser-drawn pages**: the JSON viewer, PDF viewer and error pages are not part of the page, so
  they replay unstyled. Film a screen of the app instead.
- **Canvas** (charts, maps) is recorded as a picture twice a second, so a chart shows but an
  animation is choppy. **Video** content is not recorded.
- **Images from other sites** (favicons, avatars, CDN pictures) load in the replay only if the viewer
  is online; otherwise they are left out (no broken-image icon). Fonts served by the app are inlined; fonts from other sites are not.
- **Zoom** applies only when the focus fits magnified with a margin: `tour check` warns when a zoom
  will show smaller than asked. Focus a smaller element, or ask for less zoom.
