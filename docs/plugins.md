# Themes and layouts

Radiate's look and the way its screens are arranged come from two kinds of
plugin: **themes** and **layouts**. Radiate's own look is the built-in
theme and layout called Radiate; Stadium, Floodlight and Matchday (themes)
and Couch, Guide first and Desk (layouts) ship with it too. You can make
your own as a single JSON file and install it from Settings › Appearance ›
From file.

Themes and layouts are data, never code. They can't run anything, read
anything or reach the network, and anything Radiate doesn't know in one is
left out. Playback, the live bar, the relay and the provider's connection
limit are never part of a plugin.

## A theme

```json
{
  "id": "harbor-fc",
  "name": "Harbor FC",
  "version": "1.0.0",
  "radiate": "^1",
  "kind": "theme",
  "scheme": "dark",
  "author": "A fan",
  "tokens": {
    "c-bg": "#0a1020",
    "c-surface-1": "#121a30",
    "c-accent": "#e63946",
    "c-accent-ink": "#ffffff"
  }
}
```

| Field | |
|---|---|
| `id` | 2 to 40 lowercase letters, digits or dashes. Installing a file with the same id and kind replaces the old one. The built-in ids are taken. |
| `name` | Up to 40 characters, shown in Settings. |
| `version` | `major.minor.patch`. |
| `radiate` | The plugin API it was made for: `"1"`, `"^1"`, `"1.x"` or `">=1"`. This build reads API 1. |
| `kind` | `"theme"` |
| `scheme` | `"dark"` (default) or `"light"`. The player and multiview stay dark under a light theme and take only its accent. |
| `tokens` | Design tokens to set; the table below. A token you leave out keeps Radiate's value. |
| `scale` | Optional, 0.8 to 1.4: makes everything bigger or smaller. Multiplied by the layout's scale and the user's Size. |
| `css` | Optional extra CSS, up to 32 KB. It may not contain `url(`, `@import`, `@font-face`, `image(` or `image-set(`: a theme never loads anything. Target the `data-ui` hooks below, not class names, which change between versions. |

### Tokens

Write them without the leading `--`. Values are checked: colours are
`#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()`, `hsl()`, `hsla()` or
`transparent`; lengths are `px`, `rem` or `em`; shadows are lengths,
colours and `inset`; fonts are family names already on the computer.

| Token | What it colours |
|---|---|
| `c-bg` | The window. `c-bg-rgb` (three numbers, "9 12 18") follows it unless set. |
| `c-surface-1` … `c-surface-4` | Cards, panels and raised controls, lowest to highest. |
| `c-line`, `c-line-strong` | Hairlines and outlines. |
| `c-text`, `c-text-2`, `c-text-3` | Text, from strongest to quietest. |
| `c-accent`, `c-accent-hover`, `c-accent-ink`, `c-accent-soft`, `c-accent-line` | Values you picked, progress, focus marks; ink is text on the accent. The user's Accent choice replaces all five. |
| `c-live`, `c-live-fill`, `c-live-soft`, `c-live-glow` | Live markers. |
| `c-good`, `c-good-soft`, `c-danger`, `c-danger-line` | Healthy and failing states. |
| `c-pri`, `c-pri-ink`, `c-pri-hover`, `c-pri-glow` | The main button (Watch). |
| `c-focus` | The keyboard focus ring. |
| `c-tint`, `c-tint-2`, `c-track`, `c-halo`, `c-shade`, `c-glow` | Faint lifts, chips, empty progress, the halo round a focused card, shadow colour, the light at the top of the window. |
| `c-scrim`, `c-glass` | Shades over pictures and the player's panels. |
| `font`, `mono` | Type families. |
| `r-xs`, `r-sm`, `r-md`, `r-lg`, `r-xl`, `focus-w` | Corner radii and the focus ring's width. |
| `e-1`, `e-2`, `e-3`, `e-lift`, `shadow-text` | Elevations and the shadow under text on pictures. |

### Hooks for extra CSS

`data-ui` values that stay put across versions: `nav`, `hero`, `row`,
`channel-card`, `event-card`, `vod-card`, `poster`, `channel-row`,
`guide-details`, `guide-grid`, `programme`, `settings-card`. The root
element carries `data-scheme` (`dark` or `light`) and `data-nav` (`top` or
`rail`).

```css
[data-ui="channel-card"] { border-radius: 0; }
[data-ui="programme"] { box-shadow: none; }
```

## A layout

```json
{
  "id": "big-screen",
  "name": "Big screen",
  "version": "1.0.0",
  "radiate": "^1",
  "kind": "layout",
  "nav": "rail",
  "start": "guide",
  "scale": 1.2,
  "home": { "hero": true, "rows": ["live-sports", "favorites", "starting-soon"], "cards": "lg" },
  "guide": { "density": "roomy", "details": true }
}
```

| Field | Values | Default |
|---|---|---|
| `nav` | `"top"` (the bar across the top) or `"rail"` (down the left edge) | `"top"` |
| `start` | The screen Radiate opens on: `"home"`, `"live"`, `"guide"`, `"favorites"` | `"home"` |
| `scale` | 0.8 to 1.4 | 1 |
| `home.hero` | The big "on now" panel at the top of Home | `true` |
| `home.rows` | Which rows Home shows, in order: `"live-sports"`, `"favorites"`, `"starting-soon"`, `"on-now"`, `"library"` | all five |
| `home.cards` | `"md"` or `"lg"` | `"md"` |
| `guide.density` | `"compact"`, `"normal"`, `"roomy"`: row height and minutes per inch | `"normal"` |
| `guide.details` | The panel above the guide with the selected programme | `true` |

## When something goes wrong

- A value Radiate doesn't know is left out; installing says which.
- A file that can't be read at all is refused with the reason.
- An installed file that stops being readable (after an update of
  Radiate's API) is listed under Plugins as "Can't be read" and Radiate's
  own look is used instead.
- Hold Shift while Radiate opens to start with themes and layouts off for
  that run. Settings › Appearance › Reset goes back to Radiate's look.

## What plugins will never do

These hold for every kind of plugin Radiate adds later (widgets, sources):
no plugin opens a stream on its own, sees a stream's address or a
provider's login, or changes how many connections Radiate opens to a
provider.
