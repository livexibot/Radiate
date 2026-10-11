import { describe, expect, it } from "vitest";
import type { Channel, NowNext, Programme } from "../api/types";
import { eventScore, liveSports, onNow, pickHero, startingSoon, startsIn, uniqueChannels } from "../lib/home";

const MIN = 60_000;
const NOW = 1_800_000_000_000;

let n = 0;
const ch = (name: string, p: Partial<Channel> = {}): Channel => ({
  id: name,
  sourceId: "s",
  number: ++n,
  name,
  logo: null,
  groupId: p.groupName ?? "General",
  groupName: "General",
  tvgId: null,
  epgChannelId: null,
  favorite: false,
  hidden: false,
  catchupDays: null,
  ...p,
});
const prog = (channelId: string, title: string, startMin: number, minutes: number, category: string | null = null): Programme => ({
  channelId,
  start: NOW + startMin * MIN,
  stop: NOW + (startMin + minutes) * MIN,
  title,
  description: null,
  category,
});
const nnOf = (list: Programme[]): Record<string, NowNext> => Object.fromEntries(list.map((p) => [p.channelId, { now: p, next: null }]));

const s1 = ch("Arena 1", { groupName: "Sports | Football" });
const s2 = ch("Arena 2", { groupName: "Sports | Football" });
const s3 = ch("Arena 3", { groupName: "Sports | Football", favorite: true });
const news = ch("Northwind News", { groupName: "News", favorite: true });
const general = ch("Harbor One", { groupName: "General" });

describe("live sports and the hero", () => {
  const nn = nnOf([
    prog("Arena 1", "Goals Tonight", -10, 60, "Sports"),
    prog("Arena 2", "Harbor FC v Kestrel", -30, 120, "Football"),
    prog("Arena 3", "Ridgeway v Pellmar", -5, 120, "Football"),
    prog("Northwind News", "Evening Brief", -20, 60, "News"),
    prog("Harbor One", "Cup Final: Ashby v Larkfield", -15, 120, "Sports"),
  ]);

  it("ranks favorites first, then real events over studio shows", () => {
    const list = liveSports([s1, s2, s3, news, general], nn, NOW);
    expect(list.map((x) => x.channel.id)).toEqual(["Arena 3", "Arena 2", "Harbor One", "Arena 1"]);
  });

  it("leaves out channels with nothing on air", () => {
    const list = liveSports([s1, s2], { "Arena 1": { now: prog("Arena 1", "Later", 30, 60, "Sports"), next: null } }, NOW);
    expect(list).toEqual([]);
  });

  it("scores filler below fixtures", () => {
    expect(eventScore({ channel: s2, now: nn["Arena 2"]!.now, next: null }, NOW)).toBeGreaterThan(eventScore({ channel: s1, now: nn["Arena 1"]!.now, next: null }, NOW));
  });

  it("picks the best live event as the hero", () => {
    const sports = liveSports([s1, s2, s3], nn, NOW);
    expect(pickHero(sports, [news], [general], nn, NOW)?.channel.id).toBe("Arena 3");
  });

  it("falls back to a live favorite, then the last channel, then anything on air", () => {
    expect(pickHero([], [news], [general], nn, NOW)?.channel.id).toBe("Northwind News");
    expect(pickHero([], [], [general], {}, NOW, s1)?.channel.id).toBe("Arena 1");
    expect(pickHero([], [], [general], nn, NOW)?.channel.id).toBe("Harbor One");
    expect(pickHero([], [], [], {}, NOW)).toBeNull();
  });
});

describe("starting soon", () => {
  const epg = {
    "Arena 1": [prog("Arena 1", "Goals Tonight", -10, 60, "Sports"), prog("Arena 1", "Northport v Dunmore", 50, 120, "Football"), prog("Arena 1", "Late game v Late", 7 * 60, 120, "Football")],
    "Arena 2": [prog("Arena 2", "Northport v Dunmore", 50, 120, "Football"), prog("Arena 2", "Full-time Reaction", 20, 30, "Sports")],
    "Arena 3": [prog("Arena 3", "Grand Prix: Qualifying", 30, 60, "Motorsport")],
    "Northwind News": [prog("Northwind News", "Late Edition", 40, 30, "News")],
  };
  it("lists sports events in the next six hours, soonest first, once each", () => {
    const list = startingSoon(epg, [s1, s2, s3, news], NOW);
    expect(list.map((x) => `${x.channel.id}|${x.programme.title}`)).toEqual(["Arena 3|Grand Prix: Qualifying", "Arena 1|Northport v Dunmore"]);
  });
  it("prefers a favorite channel for a repeated event", () => {
    const fav = { ...s2, favorite: true };
    const list = startingSoon(epg, [s1, fav, s3], NOW);
    expect(list.find((x) => x.programme.title === "Northport v Dunmore")?.channel.id).toBe("Arena 2");
  });
  it("respects the limit", () => {
    expect(startingSoon(epg, [s1, s2, s3], NOW, 6 * 60 * MIN, 1)).toHaveLength(1);
  });
});

describe("on now", () => {
  it("lists what's on air without channels shown elsewhere", () => {
    const nn = nnOf([prog("Northwind News", "Evening Brief", -20, 60), prog("Harbor One", "Open Studio", 10, 60)]);
    expect(onNow([news, general, news], nn, NOW, new Set()).map((x) => x.channel.id)).toEqual(["Northwind News"]);
    expect(onNow([news], nn, NOW, new Set(["Northwind News"]))).toEqual([]);
  });
});

describe("helpers", () => {
  it("dedupes channels", () => {
    expect(uniqueChannels([s1, s2, s1]).map((c) => c.id)).toEqual(["Arena 1", "Arena 2"]);
  });
  it("says when things start", () => {
    expect(startsIn(NOW + 25 * MIN, NOW)).toBe("in 25 min");
    expect(startsIn(NOW + 120 * MIN, NOW)).toBe("in 2 h");
    expect(startsIn(NOW + 130 * MIN, NOW)).toBe("in 2 h 10 min");
    expect(startsIn(NOW, NOW)).toBe("now");
  });
});
