-- Radiate's additions to mpv, loaded only when Radiate starts mpv.
--
-- On live TV: Up/Down and Page Up/Down change channel, digits type a channel
-- number, Backspace goes to the previous channel. Tab shows what's on, C records. Radiate opens the next channel
-- in this same window, through its relay, so it stays one connection.
-- A banner with the channel and programme shows for a few seconds when a
-- channel starts.

local mp = require("mp")
local assdraw = require("mp.assdraw")

-- Radiate's accent, in ASS colour order (BGR).
local ACCENT = "&H24A5F5&"
local INK = "&H140E0B&"

local overlay = mp.create_osd_overlay("ass-events")
local hide_timer = nil
local info = nil -- { number, name, title, time, next, progress, live }
local digits = ""
local digit_timer = nil
local live = false
local pending = nil -- seconds to show the banner for once the channel plays

local function send(action, value)
  mp.commandv("script-message", "radiate", action, value or "")
end

local function esc(s)
  s = tostring(s or "")
  s = s:gsub("\\", "\\\\"):gsub("{", "\\{"):gsub("}", "\\}"):gsub("\n", " ")
  return s
end

local function clear()
  overlay.data = ""
  overlay:update()
end

local function draw()
  local w, h = mp.get_osd_size()
  if not w or w <= 0 then
    return
  end
  local scale = math.max(0.75, math.min(h / 1080, 2)) * 1.0
  local pad = math.floor(36 * scale)
  local bw = math.floor(math.min(w - 2 * pad, 720 * scale))
  local lines = 0
  local ass = assdraw.ass_new()

  local function text(x, y, size, colour, bold, s)
    ass:new_event()
    ass:append(string.format("{\\an7\\pos(%d,%d)\\bord0\\shad0\\fs%d\\1c%s\\b%d\\q2}%s", x, y, math.floor(size * scale), colour, bold and 1 or 0, s))
  end

  if info then
    local bh = math.floor((info.next ~= "" and 168 or 132) * scale)
    -- the card
    ass:new_event()
    ass:append(string.format("{\\an7\\pos(0,0)\\bord0\\shad0\\1c%s\\1a&H28&}", INK))
    ass:draw_start()
    ass:round_rect_cw(pad, pad, pad + bw, pad + bh, 18 * scale)
    ass:draw_stop()
    -- accent edge
    ass:new_event()
    ass:append(string.format("{\\an7\\pos(0,0)\\bord0\\shad0\\1c%s}", ACCENT))
    ass:draw_start()
    ass:round_rect_cw(pad, pad + 18 * scale, pad + 5 * scale, pad + bh - 18 * scale, 2 * scale)
    ass:draw_stop()

    local x = pad + math.floor(28 * scale)
    local y = pad + math.floor(20 * scale)
    local head = esc(info.name)
    if info.number ~= "" then
      head = string.format("{\\1c%s}%s{\\1c&HFFFFFF&}   %s", ACCENT, esc(info.number), head)
    end
    if info.live then
      head = head .. string.format("   {\\fs%d\\1c&H4444EF&}● LIVE", math.floor(18 * scale))
    end
    text(x, y, 24, "&HFFFFFF&", true, head)
    text(x, y + math.floor(36 * scale), 34, "&HFFFFFF&", true, esc(info.title ~= "" and info.title or info.name))
    local ty = y + math.floor(82 * scale)
    if info.time ~= "" then
      text(x, ty, 20, "&HC8C0B8&", false, esc(info.time))
      -- progress through the programme
      if info.progress >= 0 then
        local px = x + math.floor(150 * scale)
        local pw = bw - (px - pad) - math.floor(28 * scale)
        local py = ty + math.floor(11 * scale)
        ass:new_event()
        ass:append("{\\an7\\pos(0,0)\\bord0\\shad0\\1c&HFFFFFF&\\1a&HC0&}")
        ass:draw_start()
        ass:round_rect_cw(px, py, px + pw, py + 4 * scale, 2 * scale)
        ass:draw_stop()
        ass:new_event()
        ass:append(string.format("{\\an7\\pos(0,0)\\bord0\\shad0\\1c%s}", ACCENT))
        ass:draw_start()
        ass:round_rect_cw(px, py, px + math.max(4 * scale, pw * info.progress), py + 4 * scale, 2 * scale)
        ass:draw_stop()
      end
    end
    if info.next ~= "" then
      text(x, ty + math.floor(34 * scale), 20, "&HA09890&", false, "{\\b1}Next{\\b0}  " .. esc(info.next))
    end
    lines = bh
  end

  if digits ~= "" then
    local size = math.floor(64 * scale)
    ass:new_event()
    ass:append(string.format("{\\an9\\pos(%d,%d)\\bord0\\shad1\\fs%d\\b1\\1c%s}%s", w - pad, pad, size, ACCENT, esc(digits)))
  end

  overlay.res_x = w
  overlay.res_y = h
  overlay.data = ass.text
  overlay:update()
  return lines
end

local function show(seconds)
  if hide_timer then
    hide_timer:kill()
  end
  draw()
  hide_timer = mp.add_timeout(seconds or 5, function()
    hide_timer = nil
    if digits == "" then
      clear()
    else
      local keep = info
      info = nil
      draw()
      info = keep
    end
  end)
end

local function zap(delta)
  return function()
    send("zap", tostring(delta))
  end
end

local function digit(d)
  return function()
    if #digits >= 4 then
      digits = ""
    end
    digits = digits .. d
    if digit_timer then
      digit_timer:kill()
    end
    show(2)
    digit_timer = mp.add_timeout(1.5, function()
      digit_timer = nil
      local n = digits
      digits = ""
      clear()
      send("number", n)
    end)
  end
end

local live_keys = {}
local function bind(key, name, fn, flags)
  mp.add_forced_key_binding(key, name, fn, flags)
  table.insert(live_keys, name)
end

local function set_live(on)
  if on == live then
    return
  end
  live = on
  for _, name in ipairs(live_keys) do
    mp.remove_key_binding(name)
  end
  live_keys = {}
  if not on then
    return
  end
  bind("UP", "radiate-up", zap(-1), { repeatable = false })
  bind("DOWN", "radiate-down", zap(1), { repeatable = false })
  bind("PGUP", "radiate-pgup", zap(-1), { repeatable = false })
  bind("PGDWN", "radiate-pgdn", zap(1), { repeatable = false })
  bind("BS", "radiate-previous", function()
    send("previous")
  end)
  for d = 0, 9 do
    bind(tostring(d), "radiate-digit-" .. d, digit(tostring(d)))
    bind("KP" .. d, "radiate-kp-" .. d, digit(tostring(d)))
  end
end

mp.add_forced_key_binding("TAB", "radiate-info", function()
  if info then
    show(5)
  end
end)
mp.add_forced_key_binding("c", "radiate-record", function()
  send("record")
end)

-- From Radiate: what's playing.
-- radiate-info <live|vod> <number> <name> <title> <time> <next> <progress 0..1 or -1> <show seconds>
mp.register_script_message("radiate-info", function(kind, number, name, title, time, nxt, progress, secs)
  set_live(kind == "live")
  info = {
    live = kind == "live",
    number = number or "",
    name = name or "",
    title = title or "",
    time = time or "",
    next = nxt or "",
    progress = tonumber(progress) or -1,
  }
  local s = tonumber(secs) or 0
  if s > 0 then
    -- shown now, while the channel opens, and again for as long once its picture is up
    pending = s
    show(s)
  elseif hide_timer then
    draw()
  end
end)

mp.register_event("file-loaded", function()
  if info and pending then
    show(pending)
  end
  pending = nil
end)

-- A short message in the middle, e.g. when a channel can't be opened.
mp.register_script_message("radiate-message", function(text)
  mp.osd_message(text or "", 4)
end)

mp.observe_property("osd-dimensions", "native", function()
  if hide_timer then
    draw()
  end
end)
