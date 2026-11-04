---
name: لوحة المتجر (بوت المتجر)
description: "Arabic RTL operations board for an online shop owner, on the phone and the PC equally: white cards and deep green."
colors:
  green: "#0b6b3c"
  green-hover: "#0a6036"
  green-bright: "#16a160"
  green-soft: "#7fcca2"
  green-50: "#e8f4ed"
  green-100: "#d3eadc"
  ink: "#121a16"
  ink-2: "#1f2a24"
  muted: "#66706a"
  line: "#e6e9e7"
  track: "#eff2f0"
  canvas: "#f4f6f5"
  surface: "#ffffff"
  red: "#c8412e"
  red-50: "#fcebe8"
  amber: "#9a5b00"
  amber-50: "#fcf1dc"
  blue: "#2b54b5"
  blue-50: "#e9eefb"
typography:
  display:
    fontFamily: "IBM Plex Sans Arabic, system-ui, sans-serif"
    fontSize: "2.1rem"
    fontWeight: 700
    lineHeight: 1.25
  headline:
    fontFamily: "IBM Plex Sans Arabic, system-ui, sans-serif"
    fontSize: "1.65rem"
    fontWeight: 700
    lineHeight: 1.3
  title:
    fontFamily: "IBM Plex Sans Arabic, system-ui, sans-serif"
    fontSize: "1.12rem"
    fontWeight: 700
    lineHeight: 1.4
  body:
    fontFamily: "IBM Plex Sans Arabic, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "IBM Plex Sans Arabic, system-ui, sans-serif"
    fontSize: "0.88rem"
    fontWeight: 500
    lineHeight: 1.45
rounded:
  sm: "10px"
  md: "12px"
  card: "18px"
  full: "9999px"
spacing:
  phone-gutter: "16px"
  phone-gap: "14px"
  pc-gutter: "32px"
  pc-gap: "22px"
components:
  card:
    backgroundColor: "{colors.surface}"
    border: "1px solid {colors.line}"
    rounded: "{rounded.card}"
    padding: "18px phone / 24px PC"
  card-now:
    backgroundColor: "{colors.green}"
    textColor: "{colors.surface}"
    rounded: "{rounded.card}"
  button-primary:
    backgroundColor: "{colors.green}"
    textColor: "{colors.surface}"
    rounded: "{rounded.md}"
    height: "44px"
  button:
    backgroundColor: "{colors.surface}"
    border: "1px solid {colors.line}"
    rounded: "{rounded.md}"
    height: "44px (38px small)"
  nav-item-active:
    backgroundColor: "{colors.green-50}"
    textColor: "{colors.green}"
    rounded: "{rounded.md}"
  pill:
    rounded: "{rounded.full}"
    pairs: "ok green-50/green, warn amber-50/amber, info blue-50/blue, fail red-50/red, plain canvas/muted"
---

# Design System: لوحة المتجر

White cards on a pale canvas, deep green, IBM Plex Sans Arabic, one filled green card for "now". Keep palette, font and the one-green-card rule unless the shop owner asks for a new look; for any restyle, get his reference first, show one screen, then build the rest.

## Rules
- **Surface:** the shop owner's dashboard (`public/index.html`, phone and PC equally). Zero dependencies: CSS custom properties, IBM Plex Sans Arabic from Google Fonts, inline SVG line icons (lucide shapes, 1.8px stroke).
- **Frame:** PC = white sidebar (260px, right) with the shop name, four sections and logout at its foot; a white top bar with the page title and date. Phone = brand header, white tab bar at the bottom with a label under every icon. Active section = pale green pill.
- **One page per section** (#home, #chats, #orders, #stock), never one long scroll. The orders page opens on tabs by what the owner does next: تنتظر الشحن / في الطريق / انتهت, each with its count.
- **One green card per screen:** the filled deep-green figure card is the thing to do now (waiting chats first, then shipping). Every other card is white with a 1px line border and a soft shadow.
- **Figure cards:** round icon on canvas, muted label, big bold number, one small sub line that is itself real data (never a decorative delta).
- **Chart:** thick bars on grey full-height tracks, four even steps with room above the tallest bar, today in the bright green with its count in a dark tooltip.
- **Ring:** order statuses of the chosen period in greens + ink + grey, the percent printed on segments of 9% or more, the total in the middle.
- **Rows, not tables:** orders are grids per row without a header; on the phone each order is a card with inline labels.
- **Numbers:** Western digits, `en-US` grouping (41,200) so a number never splits in right-to-left text; time phrases keep non-breaking spaces; money in دج.
- **Hit targets:** 38px minimum (small buttons, chips, switches, tabs); primary buttons 44–50px.
- **Nothing invented on screen:** real data only, empty states when empty. Customer numbers are masked in the chat list; the orders list shows the full number (the owner phones the customer and hands it to the delivery company).
