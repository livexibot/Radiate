/** User agents providers commonly let through. Empty means Radiate's own. */
export const USER_AGENTS: { label: string; value: string }[] = [
  { label: "VLC", value: "VLC/3.0.21 LibVLC/3.0.21" },
  { label: "IPTV Smarters", value: "IPTVSmartersPlayer" },
  { label: "TiviMate", value: "TiviMate/5.1.6 (Android 12)" },
  { label: "Kodi", value: "Kodi/21.0 (Windows NT 10.0; Win64; x64) App_Bitness/64 Version/21.0" },
  { label: "mpv", value: "libmpv" },
  { label: "Fred TV (open-tv)", value: "Fred TV" },
  { label: "Chrome", value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36" },
];
