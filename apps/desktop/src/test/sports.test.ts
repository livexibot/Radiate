import { describe, expect, it } from "vitest";
import type { Channel, Programme } from "../api/types";
import {
  isFiller,
  isSportsCategory,
  isSportsChannel,
  isSportsGroup,
  isSportsName,
  isSportsProgramme,
  looksLikeFixture,
  readOverrides,
  shortSportsName,
  sportsFirst,
  toggleSportsGroup,
} from "../lib/sports";

const ch = (p: Partial<Channel>): Channel => ({
  id: "c1",
  sourceId: "s",
  number: 1,
  name: "Channel",
  logo: null,
  groupId: "g1",
  groupName: "General",
  tvgId: null,
  epgChannelId: null,
  favorite: false,
  hidden: false,
  catchupDays: null,
  ...p,
});

const prog = (p: Partial<Programme>): Programme => ({ channelId: "c1", start: 0, stop: 1, title: "Show", description: null, category: null, ...p });

describe("isSportsName", () => {
  it.each([
    "Sports",
    "UK | SPORTS",
    "|US| NFL",
    "Sport1",
    "ESPN2 HD",
    "beIN Sports 3",
    "Sky Sports Main Event",
    "TNT Sports 1",
    "Eurosport 2",
    "DAZN 1",
    "Arena Sport 4",
    "Fox Sports 1",
    "NBC Sports",
    "Premier League TV",
    "LaLiga TV",
    "La Liga",
    "Serie A",
    "Bundesliga 2",
    "Ligue 1 Pass",
    "Champions League",
    "F1 TV",
    "Formula 1",
    "MotoGP",
    "Motorsport",
    "UFC Fight Pass",
    "MMA",
    "Boxing",
    "PPV Events",
    "Pay Per View",
    "Tennis Channel",
    "Golf",
    "Cricket",
    "Rugby",
    "Darts",
    "Snooker",
    "Cycling",
    "Olympics",
    "Fútbol",
    "Football",
    "Soccer",
    "NBA League Pass",
    "NHL",
    "MLB",
    "MLS Season Pass",
    "EPL",
    "Match TV",
    "Game Day",
    "Live Event 03",
    "Racing",
    "Deportes",
  ])("treats %s as sport", (name) => {
    expect(isSportsName(name)).toBe(true);
  });

  it.each(["Sportsman's Kitchen", "News", "Movies", "Kids", "Transport Live", "Passport Travel", "Game Show Network", "Nirvana", "Formulary", "Mafia", "Golfe Persique TV", "Cinema", "Documentary", "Matchmakers", "Gamer TV", ""])(
    "does not treat %s as sport",
    (name) => {
      expect(isSportsName(name)).toBe(false);
    },
  );

  it("handles null and odd separators", () => {
    expect(isSportsName(null)).toBe(false);
    expect(isSportsName("VIP:SPORTS/HD")).toBe(true);
    expect(isSportsName("[NFL] Sunday")).toBe(true);
  });
});

describe("programmes", () => {
  it("reads categories", () => {
    expect(isSportsCategory("Sports")).toBe(true);
    expect(isSportsCategory("Football")).toBe(true);
    expect(isSportsCategory("Sports event")).toBe(true);
    expect(isSportsCategory("News")).toBe(false);
    expect(isSportsCategory(null)).toBe(false);
  });
  it("spots fixtures", () => {
    expect(looksLikeFixture("Harbor FC v Kestrel")).toBe(true);
    expect(looksLikeFixture("Wolves vs. Ironclads")).toBe(true);
    expect(looksLikeFixture("Gulls @ Red Rocks")).toBe(true);
    expect(looksLikeFixture("Evening Brief")).toBe(false);
    expect(looksLikeFixture("Love Island")).toBe(false);
  });
  it("spots filler around events", () => {
    expect(isFiller("Full-time Reaction")).toBe(true);
    expect(isFiller("Rally Highlights")).toBe(true);
    expect(isFiller("Harbor FC: Post-match")).toBe(true);
    expect(isFiller("Harbor FC v Kestrel")).toBe(false);
  });
  it("combines category and title", () => {
    expect(isSportsProgramme(prog({ category: "Sports" }))).toBe(true);
    expect(isSportsProgramme(prog({ title: "A v B" }))).toBe(true);
    expect(isSportsProgramme(prog({ title: "Evening Brief", category: "News" }))).toBe(false);
    expect(isSportsProgramme(null)).toBe(false);
  });
});

describe("groups and channels", () => {
  const football = { id: "g-f", name: "Sports | Football" };
  const general = { id: "g-g", name: "General" };

  it("detects groups by name and honours the user's choices", () => {
    expect(isSportsGroup(football)).toBe(true);
    expect(isSportsGroup(general)).toBe(false);
    expect(isSportsGroup(general, { include: ["g-g"], exclude: [] })).toBe(true);
    expect(isSportsGroup(football, { include: [], exclude: ["g-f"] })).toBe(false);
    expect(isSportsGroup(football, { include: ["g-f"], exclude: ["g-f"] })).toBe(false);
  });

  it("detects channels by group, name or what is on", () => {
    expect(isSportsChannel(ch({ groupId: "g-f", groupName: "Sports | Football" }))).toBe(true);
    expect(isSportsChannel(ch({ name: "ESPN" }))).toBe(true);
    expect(isSportsChannel(ch({ name: "Harbor One" }), prog({ category: "Sports" }))).toBe(true);
    expect(isSportsChannel(ch({ name: "Harbor One" }), prog({ category: "News" }))).toBe(false);
    expect(isSportsChannel(ch({ name: "ESPN", groupId: "g-x" }), null, { include: [], exclude: ["g-x"] })).toBe(false);
  });

  it("puts sports groups first, keeping order", () => {
    const gs = [general, football, { id: "g-n", name: "News" }, { id: "g-u", name: "US: NFL" }];
    const { sports, rest } = sportsFirst(gs);
    expect(sports.map((g) => g.id)).toEqual(["g-f", "g-u"]);
    expect(rest.map((g) => g.id)).toEqual(["g-g", "g-n"]);
  });

  it("toggles groups storing only differences from the name", () => {
    let o = { include: [], exclude: [] } as { include: string[]; exclude: string[] };
    o = toggleSportsGroup(o, general);
    expect(o).toEqual({ include: ["g-g"], exclude: [] });
    o = toggleSportsGroup(o, general);
    expect(o).toEqual({ include: [], exclude: [] });
    o = toggleSportsGroup(o, football);
    expect(o).toEqual({ include: [], exclude: ["g-f"] });
    o = toggleSportsGroup(o, football);
    expect(o).toEqual({ include: [], exclude: [] });
  });

  it("reads overrides from prefs defensively", () => {
    expect(readOverrides(null)).toEqual({ include: [], exclude: [] });
    expect(readOverrides({ sportsGroups: { include: ["a"] } })).toEqual({ include: ["a"], exclude: [] });
  });
});

describe("shortSportsName", () => {
  it("drops a leading Sports prefix", () => {
    expect(shortSportsName("Sports | Football")).toBe("Football");
    expect(shortSportsName("SPORTS: NFL")).toBe("NFL");
    expect(shortSportsName("Sport - Tennis")).toBe("Tennis");
    expect(shortSportsName("[Sports] | Golf")).toBe("Golf");
  });
  it("leaves other names alone", () => {
    expect(shortSportsName("PPV Events")).toBe("PPV Events");
    expect(shortSportsName("Sports")).toBe("Sports");
    expect(shortSportsName("Sky Sports | Main")).toBe("Sky Sports | Main");
  });
});
