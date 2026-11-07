-- Radiate's additions to mpv, loaded only when Radiate starts mpv.
--
-- On live TV: Up/Down and Page Up/Down change channel, digits type a channel
-- number, Backspace goes to the previous channel, R shows or hides the reactors. Tab shows
-- what's on, C records. Radiate opens the next channel in this same window, through its
-- relay, so it stays one connection. Films report where they are, so Radiate can remember it.
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
  bind("r", "radiate-reactors", function()
    send("reactors")
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

-- Multiview: up to four channels in this one window, side by side, with the sound of the
-- one in focus. Radiate loads the first as the file and the others as external files;
-- the picture is put together by a filter graph built from the tracks that arrived.
local CANVAS_W, CANVAS_H = 1920, 1080
local LAYOUTS = {
  ["2x2"] = { { 0, 0, 960, 540 }, { 960, 0, 960, 540 }, { 0, 540, 960, 540 }, { 960, 540, 960, 540 } },
  ["1+3"] = { { 0, 0, 1280, 1080 }, { 1280, 0, 640, 360 }, { 1280, 360, 640, 360 }, { 1280, 720, 640, 360 } },
}
local BACKDROP = "0x0B0E14"
local mv = nil -- { layout, focus (1-based), slots = { source index or 0 }, names = {} }
local mv_overlay = mp.create_osd_overlay("ass-events")
mv_overlay.z = -1
local mv_keys = {}

-- The first video and audio track of each source: 1 is the file, 2.. the external files in order.
local function mv_sources()
  local tracks = mp.get_property_native("track-list") or {}
  local ext = mp.get_property_native("external-files") or {}
  local index = {}
  for i, f in ipairs(ext) do
    index[f] = i + 1
  end
  local src = {}
  for _, t in ipairs(tracks) do
    local k
    if t.external then
      k = index[t["external-filename"] or ""]
    else
      k = 1
    end
    if k then
      src[k] = src[k] or {}
      if t.type == "video" and not t.albumart and not src[k].vid then
        src[k].vid = t.id
      elseif t.type == "audio" and not src[k].aid then
        src[k].aid = t.id
      end
    end
  end
  return src
end

local function mv_graph()
  local rects = LAYOUTS[mv.layout] or LAYOUTS["2x2"]
  local src = mv_sources()
  local parts, ins, at = {}, {}, {}
  for i, r in ipairs(rects) do
    local w, h = r[3], r[4]
    local s = src[mv.slots[i] or 0]
    if s and s.vid then
      table.insert(parts, string.format("[vid%d]scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2:color=%s,setsar=1,format=yuv420p[t%d]", s.vid, w, h, w, h, BACKDROP, i))
    else
      table.insert(parts, string.format("color=c=%s:s=%dx%d:r=25,format=yuv420p[t%d]", BACKDROP, w, h, i))
    end
    table.insert(ins, string.format("[t%d]", i))
    table.insert(at, string.format("%d_%d", r[1], r[2]))
  end
  table.insert(parts, string.format("%sxstack=inputs=%d:layout=%s[vo]", table.concat(ins), #ins, table.concat(at, "|")))
  local f = src[mv.slots[mv.focus] or 0]
  if f and f.aid then
    table.insert(parts, string.format("[aid%d]anull[ao]", f.aid))
  end
  return table.concat(parts, ";")
end

-- Where a place on the canvas is in the window.
local function mv_screen()
  local d = mp.get_property_native("osd-dimensions")
  if not d or not d.w or d.w <= 0 then
    return nil
  end
  local vw, vh = d.w - d.ml - d.mr, d.h - d.mt - d.mb
  return d, vw / CANVAS_W, vh / CANVAS_H
end

local function mv_draw()
  if not mv then
    mv_overlay.data = ""
    mv_overlay:update()
    return
  end
  local d, sx, sy = mv_screen()
  if not d then
    return
  end
  local rects = LAYOUTS[mv.layout] or LAYOUTS["2x2"]
  local a = assdraw.ass_new()
  local scale = math.max(0.7, math.min(d.h / 1080, 2))
  for i, r in ipairs(rects) do
    local x0, y0 = d.ml + r[1] * sx, d.mt + r[2] * sy
    local x1, y1 = x0 + r[3] * sx, y0 + r[4] * sy
    local name = mv.names[i] or ""
    if name ~= "" and (mv.slots[i] or 0) > 0 then
      a:new_event()
      a:append(string.format("{\\an7\\pos(%d,%d)\\bord0\\shad0\\fs%d\\b1\\1c&HFFFFFF&\\3c%s\\4c&H000000&\\4a&H60&\\shad2}%s", x0 + 14 * scale, y0 + 10 * scale, math.floor(20 * scale), INK, esc(name) .. (i == mv.focus and "  ♪" or "")))
    end
    if i == mv.focus then
      local t = math.max(3, 4 * scale)
      a:new_event()
      a:append(string.format("{\\an7\\pos(0,0)\\bord0\\shad0\\1c%s}", ACCENT))
      a:draw_start()
      a:rect_cw(x0, y0, x1, y0 + t)
      a:rect_cw(x0, y1 - t, x1, y1)
      a:rect_cw(x0, y0, x0 + t, y1)
      a:rect_cw(x1 - t, y0, x1, y1)
      a:draw_stop()
    end
  end
  mv_overlay.res_x = d.w
  mv_overlay.res_y = d.h
  mv_overlay.data = a.text
  mv_overlay:update()
end

local function mv_apply()
  if not mv then
    return
  end
  mp.set_property("lavfi-complex", mv_graph())
  mv_draw()
end

-- The tile under the pointer, 1-based.
local function mv_hit()
  local d, sx, sy = mv_screen()
  if not d then
    return nil
  end
  local mx, my = mp.get_mouse_pos()
  local cx, cy = (mx - d.ml) / sx, (my - d.mt) / sy
  for i, r in ipairs(LAYOUTS[mv.layout] or LAYOUTS["2x2"]) do
    if cx >= r[1] and cx < r[1] + r[3] and cy >= r[2] and cy < r[2] + r[4] then
      return i
    end
  end
  return nil
end

local function mv_bind(on)
  for _, name in ipairs(mv_keys) do
    mp.remove_key_binding(name)
  end
  mv_keys = {}
  if not on then
    return
  end
  local function b(key, name, fn)
    mp.add_forced_key_binding(key, name, fn)
    table.insert(mv_keys, name)
  end
  for _, k in ipairs({ "LEFT", "RIGHT", "UP", "DOWN" }) do
    b(k, "radiate-mv-" .. k, function()
      send("mv-move", k)
    end)
  end
  b("ENTER", "radiate-mv-enter", function()
    send("mv-promote", tostring(mv.focus - 1))
  end)
  b("MBTN_LEFT", "radiate-mv-click", function()
    local i = mv_hit()
    if i then
      send("mv-focus", tostring(i - 1))
    end
  end)
  b("MBTN_LEFT_DBL", "radiate-mv-dbl", function()
    local i = mv_hit()
    if i then
      send("mv-promote", tostring(i - 1))
    end
  end)
end

-- From Radiate: radiate-multiview <layout|off> <focus 0-based> <slots "1,2,0,3"> <name 1> .. <name 4>
mp.register_script_message("radiate-multiview", function(layout, focus, slots, n1, n2, n3, n4)
  if layout == "off" or not layout then
    if mv then
      mv = nil
      mv_bind(false)
      mp.set_property("lavfi-complex", "")
      mv_draw()
    end
    return
  end
  set_live(false)
  local list = {}
  for v in string.gmatch(slots or "", "[^,]+") do
    table.insert(list, tonumber(v) or 0)
  end
  local was = mv ~= nil
  mv = { layout = layout, focus = (tonumber(focus) or 0) + 1, slots = list, names = { n1 or "", n2 or "", n3 or "", n4 or "" } }
  if not was then
    mv_bind(true)
  end
  -- the graph is built when the files have loaded (file-loaded); a change of focus applies now
  if not mp.get_property_bool("idle-active") and mp.get_property("path") then
    mv_apply()
  end
end)

mp.register_script_message("radiate-mv-focus", function(focus)
  if not mv then
    return
  end
  mv.focus = (tonumber(focus) or 0) + 1
  mv_apply()
end)

-- Holding the match back to line up with a reactor who is behind the TV feed. Raising the
-- delay goes back through what mpv already has and only pauses for what that can't cover;
-- lowering it skips forward through what is there.
local delay_target = 0
local delay_applied = 0
local hold_until = 0
local hold_timer = nil
local hold_ticker = nil

local function holding()
  return hold_timer ~= nil
end

local function cached()
  local st = mp.get_property_native("demuxer-cache-state")
  local r = st and st["seekable-ranges"]
  if r and #r > 0 then
    return r[1]["start"], r[#r]["end"]
  end
  return nil, nil
end

local function stop_hold(resume)
  if hold_timer then
    hold_timer:kill()
  end
  if hold_ticker then
    hold_ticker:kill()
  end
  local was = hold_timer ~= nil
  hold_timer, hold_ticker, hold_until = nil, nil, 0
  if was and resume then
    mp.set_property_bool("pause", false)
    mp.osd_message("", 0)
  end
end

local function hold_left()
  return math.max(0, hold_until - mp.get_time())
end

local function schedule_hold()
  if hold_timer then
    hold_timer:kill()
  end
  hold_timer = mp.add_timeout(math.max(0.05, hold_left()), function()
    hold_timer = nil
    stop_hold(true)
  end)
  if not hold_ticker then
    hold_ticker = mp.add_periodic_timer(0.5, function()
      mp.osd_message(string.format("Holding the match · %d s", math.ceil(hold_left())), 0.8)
    end)
  end
  mp.osd_message(string.format("Holding the match · %d s", math.ceil(hold_left())), 0.8)
end

local function delay_apply()
  local diff = delay_target - delay_applied
  local pos = mp.get_property_number("time-pos")
  local first, last = cached()
  if diff > 0 then
    if pos and first then
      local back = math.min(diff, math.max(0, pos - first - 0.5))
      if back >= 0.25 then
        mp.commandv("seek", tostring(-back), "relative+exact")
        delay_applied = delay_applied + back
        diff = diff - back
      end
    end
    if diff < 0.25 then
      delay_applied = delay_target
      return
    end
    hold_until = math.max(mp.get_time(), hold_until) + diff
    delay_applied = delay_target
    mp.set_property_bool("pause", true)
    schedule_hold()
  elseif diff < 0 then
    local skip = -diff
    if hold_timer then
      local cut = math.min(hold_left(), skip)
      hold_until = hold_until - cut
      skip = skip - cut
      delay_applied = delay_applied - cut
      if hold_left() <= 0 then
        stop_hold(true)
      else
        schedule_hold()
      end
    end
    if skip > 0 and pos and last then
      local step = math.min(skip, math.max(0, last - pos - 0.5))
      if step > 0 then
        mp.commandv("seek", tostring(step), "relative+exact")
      end
      delay_applied = delay_applied - step
    end
  end
end

-- A new channel starts at the live edge: the delay is built up again.
local function delay_restart()
  stop_hold(false)
  delay_applied = 0
  if delay_target > 0 then
    mp.add_timeout(0.5, delay_apply)
  end
end

mp.register_script_message("radiate-delay", function(seconds)
  delay_target = math.max(0, tonumber(seconds) or 0)
  delay_apply()
end)

mp.register_event("file-loaded", function()
  -- a resume point is for the film it was set for, not the next channel
  mp.set_property("start", "none")
  if info and pending then
    show(pending)
  end
  pending = nil
  delay_restart()
  if mv then
    mv_apply()
  end
end)

-- To Radiate: where a film is (to remember it), and when it has ended.
mp.add_periodic_timer(2, function()
  local dur = mp.get_property_number("duration")
  local pos = mp.get_property_number("time-pos")
  if dur and dur > 0 and pos and not mp.get_property_bool("idle-active") then
    send("time", string.format("%.2f %.2f", pos, dur))
  end
end)
mp.observe_property("eof-reached", "bool", function(_, eof)
  if eof then
    send("ended")
  end
end)
mp.observe_property("pause", "bool", function(_, p)
  if p ~= nil and not holding() then
    send("pause", p and "1" or "0")
  end
end)

-- A short message in the middle, e.g. when a channel can't be opened.
mp.register_script_message("radiate-message", function(text)
  mp.osd_message(text or "", 4)
end)

mp.observe_property("osd-dimensions", "native", function()
  if hide_timer then
    draw()
  end
  if mv then
    mv_draw()
  end
end)

-- Radiate asks until this script is loaded, then sends what it has queued.
mp.register_script_message("radiate-hello", function()
  send("ready")
end)
