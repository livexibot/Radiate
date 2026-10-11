// Which groups, channels and programmes count as sports.
import type { Channel, Programme } from "../api/types";

/** The user's own choices, by group id. An exclusion always wins. */
export interface SportsOverrides {
  include: string[];
  exclude: string[];
}

export const NO_OVERRIDES: SportsOverrides = { include: [], exclude: [] };

// Matched against lowercased, accent-free text. Letters may not touch a
// keyword on either side, digits may ("Sport1", "ESPN2", "F1").
const KEYWORDS = [
  "sports?",
  "sportv",
  "sportsnet",
  "supersport",
  "deportes?",
  "esportes?",
  "football",
  "soccer",
  "futbol",
  "futebol",
  "fussball",
  "calcio",
  "nfl",
  "nba",
  "nhl",
  "mlb",
  "mls",
  "ncaa",
  "wnba",
  "ufc",
  "mma",
  "wwe",
  "boxing",
  "fight night",
  "ppv",
  "pay per view",
  "pay-per-view",
  "f1",
  "formula ?1",
  "formula",
  "motorsports?",
  "moto ?gp",
  "nascar",
  "indycar",
  "racing",
  "rally",
  "tennis",
  "golf",
  "cricket",
  "rugby",
  "darts",
  "snooker",
  "cycling",
  "olympics?",
  "basketball",
  "baseball",
  "hockey",
  "volleyball",
  "handball",
  "athletics",
  "epl",
  "premier league",
  "la liga",
  "laliga",
  "serie a",
  "bundesliga",
  "ligue 1",
  "eredivisie",
  "champions league",
  "europa league",
  "world cup",
  "dazn",
  "espn",
  "bein",
  "eurosport",
  "arena",
  "match",
  "matchday",
  "game(?! ?shows?)",
  "gameday",
  "events?",
];

const SPORTS_RE = new RegExp(`(?<![a-z])(?:${KEYWORDS.join("|")})(?![a-z])`);

// "Harbor FC v Kestrel", "Wolves vs. Ironclads", "Gulls @ Red Rocks"
const FIXTURE_RE = /\S\s+(?:v|vs\.?|@)\s+\S/i;

// Programmes on sports channels that are not the event itself.
const FILLER_RE = /(?<![a-z])(?:highlights|reaction|review|preview|magazine|classics?|replay|post-match|pre-match|countdown|build-up|weigh-in|tonight|draw|news|talk|studio|show)(?![a-z])/;

export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[_|:/\\[\]()]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when a group or channel name looks like sport. */
export function isSportsName(name: string | null | undefined): boolean {
  if (!name) return false;
  return SPORTS_RE.test(normalize(name));
}

/** True when a programme's guide category is sport. */
export function isSportsCategory(category: string | null | undefined): boolean {
  return isSportsName(category);
}

/** True when a programme title reads like a fixture: "A v B", "A vs B", "A @ B". */
export function looksLikeFixture(title: string): boolean {
  return FIXTURE_RE.test(title);
}

/** True for the build-up, highlights and studio shows around an event. */
export function isFiller(title: string): boolean {
  return FILLER_RE.test(normalize(title));
}

export function isSportsProgramme(p: Programme | null | undefined): boolean {
  if (!p) return false;
  return isSportsCategory(p.category) || looksLikeFixture(p.title);
}

export function isSportsGroup(group: { id: string; name: string }, overrides: SportsOverrides = NO_OVERRIDES): boolean {
  if (overrides.exclude.includes(group.id)) return false;
  if (overrides.include.includes(group.id)) return true;
  return isSportsName(group.name);
}

/** A channel is sport when its group is, its name is, or what it is showing now is. */
export function isSportsChannel(channel: Channel, now: Programme | null | undefined = null, overrides: SportsOverrides = NO_OVERRIDES): boolean {
  if (overrides.exclude.includes(channel.groupId)) return false;
  if (isSportsGroup({ id: channel.groupId, name: channel.groupName }, overrides)) return true;
  if (isSportsName(channel.name)) return true;
  return now ? isSportsCategory(now.category) : false;
}

/** Sports groups first, each part keeping its order. */
export function sportsFirst<G extends { id: string; name: string }>(groups: G[], overrides: SportsOverrides = NO_OVERRIDES): { sports: G[]; rest: G[] } {
  const sports: G[] = [];
  const rest: G[] = [];
  for (const g of groups) (isSportsGroup(g, overrides) ? sports : rest).push(g);
  return { sports, rest };
}

/** Flip one group, returning the new overrides. Only differences from what the name says are stored. */
export function toggleSportsGroup(overrides: SportsOverrides, group: { id: string; name: string }): SportsOverrides {
  const include = overrides.include.filter((x) => x !== group.id);
  const exclude = overrides.exclude.filter((x) => x !== group.id);
  const now = isSportsGroup(group, overrides);
  const detected = isSportsName(group.name);
  if (now) {
    if (detected) exclude.push(group.id);
  } else if (!detected) {
    include.push(group.id);
  }
  return { include, exclude };
}

export function readOverrides(prefs: { sportsGroups?: Partial<SportsOverrides> | null } | null | undefined): SportsOverrides {
  const s = prefs?.sportsGroups;
  if (!s) return NO_OVERRIDES;
  return { include: Array.isArray(s.include) ? s.include : [], exclude: Array.isArray(s.exclude) ? s.exclude : [] };
}

/** "Sports | Football" -> "Football", for lists already headed Sports. */
export function shortSportsName(name: string): string {
  const short = name.replace(/^\s*[|[(]?\s*sports?\s*[\])]?\s*[|:\-–/]\s*/i, "").trim();
  return short || name;
}
