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
`exact: true` for an exact name or text, and `nth` to pick one of several. Without `exact`, `name`
and `text` match a part: `{ role: "button", name: "Avery Chen" }` also matches "Avery Chen's org",
and the first match on the page wins (`record` prints a note when a locator matched several). Prefer role and name, as
a person would describe it; read the component's code for the accessible name. Use `css` only when
nothing else names it: it is Playwright's selector engine, so `:has-text("Total")` and `:has(...)`
work as well as plain CSS.

- A component library decides the role, not the tag you see in its props: a `<Button>` that renders
  a link is often still `role: "button"`.
- Utility classes (Tailwind, UnoCSS) are not stable names, and UnoCSS's attributify mode puts them
  in attributes, not `class`: prefer role, text or `:has(...)` over a utility class.

**Check a locator on the live page before a scene depends on it.** `curl` sees only the empty shell
of a single-page app; `pr2video probe` opens the page in the recorder's browser, signed in as a role
from `scenes.json`, and records nothing:

```bash
pr2video probe /settings --role admin                       # the page's headings, controls and fields, with roles and names
pr2video probe /settings --role admin --find '{"role":"switch","name":"Dark mode"}' --find '{"css":".settings-row"}'
```

With `--find` it prints how many elements each locator matches, whether each is visible, its box
and its text; `probe.png` is the page as the recorder saw it. Before `scenes.json` exists, give a
full URL (`http://localhost:3000/settings`), with no role.

## Focus and marks

- `focus` is what the caption is about: the recorder scrolls it to the middle (no `scrollTo` step
  needed) and the tour zooms towards it. Focus the **row, card or section** that holds the change,
  so its label and context stay readable, and leave `zoom` out: the draft asks for 1.5 and the
  player zooms as far as the focus fits, so a wide card zooms a little and one that nearly fills
  the screen not at all (`tour check` warns about that). Set `zoom: 2` only for a control whose meaning
  is clear on its own, and `zoom: 1` to show the whole screen. A heading is a thin strip: to focus the panel under a heading, use the box
  that holds it, e.g. `{ "css": "div:has(> :text-is(\"Pages\"))" }`.
- No focus: the tour zooms towards the marks at the scene's `zoom` (the draft gives 2; set 1 in the
  tour to show the whole screen), and the recorder scrolls the first mark into view if it is
  off-screen. Something lower on the page that the caption is about wants a focus, so it is centred.
- After recording, read each checkpoint's `notes` in `result.json` (and the `note:` lines `record`
  prints): a locator that matched several elements (the first was used) or a box off-screen puts
  a focus or mark on the wrong thing. On the head, a checkpoint with marks, no focus and none of
  its marks on the page stops the scene: it is the wrong page.
- `marks` (up to 4) outline the exact things the caption names, each with a tone: `added`,
  `removed`, `changed`, or `note`. On the head the focus must be on the page, or the scene stops: it
  was the wrong page. A mark that is not there is listed under `missing` in `result.json`.
- A mark's `label` goes beside its outline, where it covers the least text: above, below, or to
  one side. Give one only when it says something the screen does not, and check it on a still.
- Captions are the tour's first draft: say what the viewer sees and why it matters, in one or two
  plain sentences (see tour.md).

## Menus, popovers and dialogs

The recorder waits up to 2s for opening animations to finish before it measures a checkpoint, so
an outline lands where the menu settled. A menu that animates for longer wants a `{ "wait": 600 }`
step before its checkpoint.

## Steps per scene

A scene holds at most 10 actions (each click, fill, `scrollTo` or `wait` counts; checkpoints do
not). A key pressed several times in a row is one action: `{ "press": "ArrowRight", "times": 8 }`.
`pr2video scenes --help` lists every step and locator. A longer flow is two scenes, the second starting where the first ended.

## Scenes that change data

A scene that creates or deletes something (adds a record, sends a form) changes what the next
scene, and the next recording of itself, finds. Keep the tour replayable:

- `sandbox replay` (either side) runs the setup again from scratch: data a scene created is gone
  afterwards. Re-record a scene that needs it after the scene that makes it, in one `record --only
  a,b` (scenes record in the scenes file's order). `--only` keeps every other scene's recording.
- Record a scene that creates data first, then the seeding that depends on it, as recorded setup
  steps, then the scenes that show the result (`record --only <ids>` records some scenes and keeps
  the others).
- Better still, let the seeding create what the later scenes need through the app's API, so the
  creating scene is the only one that depends on a fresh state; give what it creates a name the
  seed does not use, so recording it again does not collide.

## Signing in

Each role signs in once; its cookies and local storage carry into every scene of that role. A
first-run dialog dismissed during sign-in (a "Got it" that writes local storage) stays dismissed
in the scenes: add that click to the role's steps.

The last sign-in step should wait for something that shows on every signed-in page and never on
the sign-in page (a "Log out" button, the user's name), whatever else appears: a first-run welcome
dialog or a banner can cover the navigation. A sign-in that ends still on its first page fails, and
so does a head checkpoint that lands back on it: both mean the scene would be filmed signed out. If sign-in stops, the
recorder saves a screenshot of where it stopped (`recordings/<side>/.auth-<role>-stopped.png`).
