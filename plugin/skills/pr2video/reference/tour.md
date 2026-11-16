# Writing the tour

The tour is a short screen recording, narrated, that walks a reviewer through the change. The reviewer
has not opened the app. Each scene plays one recording up to a checkpoint, zooms in, shows the caption,
marks what changed, and holds while the caption is read aloud.

## Choosing scenes

- Show the checkpoints that tell the story of the change, in the order a demo would: where the user
  starts, what they do, what is different now.
- Lead with what the pull request changed. Leave out checkpoints that add nothing.
- At most 12 scenes; 4 to 8 is typical.

## Captions

- One or two plain sentences, spoken to the reviewer: what they are looking at and why it matters.
  "The notice is now a blue callout, and the dismiss button moved to its right."
- Present tense. No marketing words. Under 280 characters.
- Quote on-screen text in "double quotes", and only text that is on that checkpoint, exactly.

## Focus, zoom and markers

- `focus` is the element or section the caption is about. Most scenes have one.
- `zoom`: `1.5` for a section or a dialog, `2` for a small control, `1` (with `focus: null`) only
  when the caption is about the whole page.
- `markers`: up to four, the exact things the caption names, each with a `tone`: `added`, `removed`,
  `changed` for what the pull request did, `note` for anything else worth pointing at. Give a short
  `label` when there are two or more; otherwise `null`.
- Boxes are viewport pixels at the checkpoint. Give the recorder's `node` id when you have it: the
  player then measures that node in the replay.

## The file

```jsonc
{
  "version": 1,
  "title": "Cart groups items by supplier",       // a few words
  "summary": "Two sentences a reviewer reads before pressing play.",
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
marks. `pr2video narrate` fills in `audio`, `audioMs` and `voice`; do not write them yourself.
`pr2video tour check` also checks every recording and clip it names still exists: after
re-recording, draft again rather than keeping old timings.
