import { describe, expect, it } from "vitest";
import type { Channel, NowNext, Programme } from "../api/types";
import { favoritesView } from "../lib/home";

const MIN = 60_000;
const NOW = 1_800_000_000_000;

let n = 0;
const ch = (name: string, groupName = "General"): Channel => ({
  id: name,
  sourceId: "s",
  number: ++n,
  name,
  logo: null,
  groupId: groupName,
  groupName,
  tvgId: null,
  epgChannelId: null,
  favorite: true,
  hidden: false,
  catchupDays: null,
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

const news = ch("Northwind News", "News");
const studio = ch("Arena 1", "Sports | Football");
const match = ch("Arena 2", "Sports | Football");
const docs = ch("Terra Docs", "Docs");
const later = ch("Harbor One", "General");
const noGuide = ch("Mystery TV", "General");

describe("favorites view", () => {
  const nn = nnOf([
    prog("Northwind News", "Evening Brief", -20, 60, "News"),
    prog("Arena 1", "Goals Tonight", -10, 60, "Sports"),
    prog("Arena 2", "Harbor FC v Kestrel", -30, 120, "Football"),
    prog("Terra Docs", "Rivers of Ice", -5, 50, "Documentary"),
    prog("Harbor One", "Open Studio", 15, 60),
  ]);

  it("puts live sport first, best event on top", () => {
    const v = favoritesView([news, studio, match, docs, later, noGuide], nn, NOW);
    expect(v.sports.map((x) => x.channel.id)).toEqual(["Arena 2", "Arena 1"]);
  });

  it("keeps the user's order for everything else on air", () => {
    const v = favoritesView([docs, news, studio, match], nn, NOW);
    expect(v.onNow.map((x) => x.channel.id)).toEqual(["Terra Docs", "Northwind News"]);
  });

  it("lists channels with nothing on air last, and every channel once", () => {
    const v = favoritesView([news, later, noGuide, news, match], nn, NOW);
    expect(v.other.map((x) => x.channel.id)).toEqual(["Harbor One", "Mystery TV"]);
    const all = [...v.sports, ...v.onNow, ...v.other].map((x) => x.channel.id);
    expect(all.sort()).toEqual(["Arena 2", "Harbor One", "Mystery TV", "Northwind News"]);
  });

  it("is empty without favorites", () => {
    expect(favoritesView([], nn, NOW)).toEqual({ sports: [], onNow: [], other: [] });
  });
});
