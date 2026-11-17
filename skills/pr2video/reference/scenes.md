# Writing the scenes

`scenes.json` says what to film. The recorder opens each scene's URL in Chromium inside the sandbox,
performs its steps at a person's pace while rrweb records, and stops on each checkpoint: it scrolls
the focus to the middle, measures it and the marks, and takes a screenshot.

## Choosing scenes

- One scene per place in the app where the change (or the feature) shows, in the order a demo would go. 1-6 scenes;
  2-4 is typical. A refactor with no visible change gets no scenes.
- Show the state that makes the change or feature visible: the list with items in it, the form with an error,
  the dialog open. If the app needs data first, create it in a setup step (`sandbox exec --record`).
- Up to 10 actions and 6 checkpoints per scene. Keep the drive short: it plays before every stop.

## The file

```jsonc
{
  "version": 1,
  "title": "Dark mode switch in Settings",       // the tour's title
  "summary": "Two sentences a viewer reads before pressing play.",
  "baseUrl": "http://localhost:3000",            // where the app answers INSIDE the sandbox
  "viewport": { "width": 1280, "height": 800 },  // optional
  "timeoutMs": 15000,                            // optional: how long a step waits for its element
  "warmup": true,                                // optional: visit each scene's page once, unrecorded, first
  "roles": {                                     // optional: how each role signs in, not recorded
    "admin": { "steps": [
      { "goto": "/login" },
      { "fill": { "label": "Email" }, "value": "admin@example.com" },
      { "fill": { "label": "Password" }, "value": "password" },
      { "click": { "role": "button", "name": "Sign in" } },
      { "waitFor": { "text": "Signed in as Admin" } } // something every signed-in page shows
    ] }
  },
  "scenes": [{
    "id": "dark-mode",                           // lowercase, digits, -
    "title": "Settings has a dark mode switch",
    "role": "admin",                             // optional, a key of roles
    "url": "/",                                  // relative to baseUrl
    "viewport": { "width": 375, "height": 812 },  // optional: this scene's size (a phone)
    "steps": [
      { "click": { "role": "link", "name": "Settings" } },
      { "checkpoint": "switch",
        "caption": "Settings now has a Dark mode switch, under Email notifications.",
        "focus": { "css": ".settings-row:has([role=switch])" },
        "zoom": 1.5,
        "marks": [{ "locator": { "role": "switch", "name": "Dark mode" }, "tone": "added", "label": null }] },
      { "click": { "role": "switch", "name": "Dark mode" } },
      { "checkpoint": "on", "caption": "Turning it on themes the page and confirms with a notice." }
    ]
  }]
}
```

## Slow pages

A dev server compiles a page on its first visit, which can take longer than a step waits. The
recorder visits every scene's page once, unrecorded, before recording (`warmup`), and the sign-in
gets two minutes for its first page. If steps still time out, raise `timeoutMs`, or serve a
production build. A failed sign-in leaves `recordings/<side>/.auth-<role>-stopped.png`.

## Actions

`goto`, `click`, `hover`, `fill` (+ `value`, typed visibly), `select` (+ `value`), `check`,
`uncheck`, `press` (a key, optionally `on` an element), `waitFor`, `wait` (ms, at most 10000),
`scrollTo`.

## Locators

Exactly one of: `role` (+ optional `name`), `label`, `text`, `placeholder`, `testId`, `css`. Add
`exact: true` for an exact name or text, and `nth` to pick one of several. Prefer role and name, as
a person would describe it; read the component's code for the accessible name. Use `css` only when
nothing else names it.

## Focus and marks

- `focus` is what the caption is about: zoomed towards in the tour. Focus the **row, card or section**
  that holds the change, with `zoom: 1.5`, so its label and context stay readable. Zoom 2 only for a
  control whose meaning is clear on its own. No focus: the tour zooms towards the marks.
- `marks` (up to 4) outline the exact things the caption names, each with a tone: `added`,
  `removed`, `changed`, or `note`. On the head the focus must be on the page, or the scene stops: it
  was the wrong page. A mark that is not there is listed under `missing` in `result.json`.
- Captions are the tour's first draft: say what the viewer sees and why it matters, in one or two
  plain sentences (see tour.md).

## Signing in

The last sign-in step should wait for something that shows on every signed-in page, whatever else
appears: a first-run welcome dialog or a banner can cover the navigation. If sign-in stops, the
recorder saves a screenshot of where it stopped (`recordings/<side>/.auth-<role>-stopped.png`).
