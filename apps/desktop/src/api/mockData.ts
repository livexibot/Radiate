// Invented demo content for the in-browser mock backend. Nothing here is real.

export interface ChannelDef {
  name: string;
  group: string;
  favorite?: boolean;
  noGuide?: boolean;
  offline?: boolean;
}

export const HOME_CHANNELS: ChannelDef[] = [
  { name: "Northwind News", group: "News", favorite: true },
  { name: "Harbor One", group: "News" },
  { name: "Meridian 24", group: "News" },
  { name: "Capital Report", group: "News" },
  { name: "Atlas World", group: "News" },
  { name: "Northwind Business", group: "News" },
  { name: "Arena Sports 1", group: "Sports", favorite: true },
  { name: "Arena Sports 2", group: "Sports" },
  { name: "Arena Sports 3", group: "Sports" },
  { name: "Arena Extra", group: "Sports" },
  { name: "Velo TV", group: "Sports" },
  { name: "Courtside", group: "Sports" },
  { name: "Terra Documentary", group: "Docs", favorite: true },
  { name: "Deep Blue", group: "Docs" },
  { name: "History Vault", group: "Docs" },
  { name: "Wild Frontier", group: "Docs" },
  { name: "Cosmos HD", group: "Docs", noGuide: true },
  { name: "Cinemax Gold", group: "Movies", favorite: true },
  { name: "Cinemax Action", group: "Movies" },
  { name: "Reel Classics", group: "Movies" },
  { name: "Midnight Screen", group: "Movies" },
  { name: "Indie Lane", group: "Movies" },
  { name: "Spark Kids", group: "Kids", favorite: true },
  { name: "Little Owl", group: "Kids" },
  { name: "Toon Harbor", group: "Kids" },
  { name: "Spark Junior", group: "Kids" },
  { name: "Pulse Music", group: "Music" },
  { name: "Vinyl FM", group: "Music" },
  { name: "Stage Live", group: "Music" },
  { name: "Echo Hits", group: "Music" },
  { name: "Nordic One", group: "World" },
  { name: "Sol Latino", group: "World" },
  { name: "Kanal Euro", group: "World", noGuide: true, offline: true },
];

export const SPORTS_BACKUP_CHANNELS: ChannelDef[] = [
  { name: "Pitchside 1", group: "Sports" },
  { name: "Pitchside 2", group: "Sports" },
  { name: "Ringside", group: "Sports" },
  { name: "Fairway Golf", group: "Sports" },
  { name: "Rally TV", group: "Sports", noGuide: true },
  { name: "Northwind News HD", group: "News" },
  { name: "Harbor One HD", group: "News" },
];

export const PUBLIC_CHANNEL_NAMES = [
  ["Public One", "General"],
  ["Public Two", "General"],
  ["City Channel", "General"],
  ["Parliament Live", "News"],
  ["Open News 24", "News"],
  ["Coastal Radio TV", "Music"],
  ["Folk Stage", "Music"],
  ["Learning Kids", "Kids"],
  ["Science Open", "Docs"],
  ["Heritage TV", "Docs"],
  ["Weather Now", "News"],
  ["Faith & Life", "General"],
] as const;

export { COUNTRIES } from "../lib/countries";

interface Pool {
  titles: string[];
  minutes: number[];
  category: string;
}

export const PROGRAMME_POOLS: Record<string, Pool> = {
  News: {
    titles: ["Morning Brief", "Midday Report", "Evening Brief", "Weather Desk", "Late Edition", "World Tonight", "Business Hour", "The Briefing", "Harbor Strike: Special Report"],
    minutes: [30, 30, 60],
    category: "News",
  },
  Sports: {
    titles: ["Harbor FC v Kestrel", "Pro Darts: Final", "Rally Highlights", "Goals Tonight", "Full-time Reaction", "Night Fight", "Tennis: Quarter-final", "Cycling: Stage 14", "Ridge v Pellmar", "Matchday Live", "Harbor FC: Post-match"],
    minutes: [60, 90, 120],
    category: "Sports",
  },
  Docs: {
    titles: ["Rivers of Ice", "Deep Hours", "Night Sky Live", "The Salt Road", "Wild Coasts", "Engines of Empire", "Cities Below", "Ocean Giants"],
    minutes: [55, 60, 45],
    category: "Documentary",
  },
  Movies: {
    titles: ["The Long Field", "Night Shift", "Paper Lanterns", "Glass Harbor", "The Quiet Ones", "Last Ferry Home", "Copper Sky", "Northern Line"],
    minutes: [95, 110, 125],
    category: "Movie",
  },
  Kids: {
    titles: ["Moon Patrol", "Bedtime Tales", "Little Owl Club", "Robo Friends", "Puzzle Park", "Sky Pirates"],
    minutes: [25, 30],
    category: "Kids",
  },
  Music: {
    titles: ["Top 40 Countdown", "Live at Stage", "Vinyl Hour", "Acoustic Sessions", "Night Mix", "Throwback Hits"],
    minutes: [60, 30],
    category: "Music",
  },
  World: {
    titles: ["Noticias", "Kultur Abend", "Nordic Nights", "Telejornal", "Cocina Viva"],
    minutes: [30, 60],
    category: "General",
  },
  General: {
    titles: ["Morning Show", "Local Matters", "Open Studio", "Community Hour", "Evening Report"],
    minutes: [30, 60],
    category: "General",
  },
};

export const DESCRIPTIONS = [
  "Glaciers carved the north. A crew follows the melt season.",
  "The day's headlines, with analysis from correspondents across the region.",
  "League football, second half underway.",
  "A farmer and his estranged son rebuild after a flood.",
  "A crew of young astronauts keeps the moon base tidy.",
  "Live from the stage, with the night's best sets.",
  "A look at the forces shaping markets this week.",
  null,
  null,
];

/** Programmes pinned around "now" so the demo always shows something recognisable. */
export const FEATURED: Record<string, { title: string; startOffsetMin: number; minutes: number; description: string }> = {
  "Arena Sports 1": { title: "Harbor FC v Kestrel", startOffsetMin: -67, minutes: 115, description: "League · second half. Kestrel pushing for an equaliser." },
  "Northwind News": { title: "Evening Brief", startOffsetMin: -24, minutes: 60, description: "The day's headlines, with analysis from correspondents across the region." },
  "Terra Documentary": { title: "Rivers of Ice", startOffsetMin: -24, minutes: 55, description: "Glaciers carved the north. A crew follows the melt season." },
  "Cinemax Gold": { title: "The Long Field", startOffsetMin: -74, minutes: 115, description: "A farmer and his estranged son rebuild after a flood." },
  "Arena Sports 2": { title: "Pro Darts: Final", startOffsetMin: -10, minutes: 90, description: "The final, live." },
  "Spark Kids": { title: "Moon Patrol", startOffsetMin: -9, minutes: 25, description: "A crew of young astronauts keeps the moon base tidy." },
};

export const MOVIES: { name: string; group: string; year: number; rating: number; plot: string }[] = [
  { name: "The Long Field", group: "Drama", year: 2019, rating: 7.4, plot: "A farmer and his estranged son rebuild after a flood." },
  { name: "Glass Harbor", group: "Thriller", year: 2023, rating: 6.9, plot: "A harbour pilot sees something she shouldn't on the night shift." },
  { name: "Copper Sky", group: "Drama", year: 2021, rating: 7.8, plot: "Three sisters return to the mining town they left as children." },
  { name: "Last Ferry Home", group: "Comedy", year: 2022, rating: 6.6, plot: "Strangers stranded on an island for one very long weekend." },
  { name: "Northern Line", group: "Thriller", year: 2020, rating: 7.1, plot: "A transit cop follows a pickpocket into something much bigger." },
  { name: "Paper Lanterns", group: "Family", year: 2018, rating: 7.3, plot: "A grandmother teaches her grandson the old festival crafts." },
  { name: "The Quiet Ones", group: "Drama", year: 2024, rating: 7.0, plot: "A deaf chess prodigy and her coach on the road to the nationals." },
  { name: "Night Shift", group: "Action", year: 2017, rating: 6.4, plot: "A security guard, a museum, and a crew who picked the wrong night." },
  { name: "Signal Fire", group: "Action", year: 2022, rating: 6.8, plot: "A mountain rescue team races a storm." },
  { name: "Undertow", group: "Thriller", year: 2025, rating: 7.2, plot: "A diver finds a car at the bottom of the reservoir." },
  { name: "Small Hours", group: "Drama", year: 2016, rating: 7.6, plot: "A night radio host and the caller who never gives a name." },
  { name: "Orchard Road", group: "Comedy", year: 2019, rating: 6.2, plot: "Two rival cider makers forced to share a stall." },
  { name: "The Cartographer", group: "Drama", year: 2021, rating: 7.9, plot: "Mapping a coastline that keeps changing." },
  { name: "Static", group: "Thriller", year: 2023, rating: 6.5, plot: "A TV repairman hears voices in the noise." },
  { name: "Moonbase Kids", group: "Family", year: 2024, rating: 6.9, plot: "The Moon Patrol crew's first feature adventure." },
  { name: "Iron Coast", group: "Action", year: 2020, rating: 6.1, plot: "Smugglers, a lighthouse, and one stubborn keeper." },
  { name: "Wild Frontier: The Film", group: "Documentary", year: 2022, rating: 8.0, plot: "A year on the edge of the tundra." },
  { name: "Ocean Giants", group: "Documentary", year: 2019, rating: 8.2, plot: "Following the migration of the blue whale." },
  { name: "Brass Band", group: "Comedy", year: 2018, rating: 7.0, plot: "A failing colliery band gets one more competition." },
  { name: "Halfway House", group: "Drama", year: 2025, rating: 7.1, plot: "A boarding house and the people passing through it." },
  { name: "Seven Bridges", group: "Thriller", year: 2017, rating: 6.7, plot: "A courier has one night to cross the city." },
  { name: "Snowbound", group: "Family", year: 2021, rating: 6.8, plot: "A family cabin trip goes beautifully wrong." },
  { name: "Afterglow", group: "Drama", year: 2022, rating: 7.3, plot: "Two old friends restore a cinema." },
  { name: "Redline", group: "Action", year: 2024, rating: 6.0, plot: "A rally driver's last season." },
  { name: "Cities Below", group: "Documentary", year: 2020, rating: 7.7, plot: "The tunnels, rivers and ruins under our cities." },
  { name: "The Understudy", group: "Comedy", year: 2023, rating: 6.9, plot: "Opening night, and the lead has vanished." },
  { name: "Blue Hour", group: "Drama", year: 2018, rating: 7.4, plot: "A photographer's last assignment." },
  { name: "Crosswind", group: "Action", year: 2019, rating: 6.3, plot: "An air traffic controller and a plane that won't answer." },
  { name: "Puzzle Park", group: "Family", year: 2025, rating: 6.5, plot: "The whole town is a puzzle, and the clock is ticking." },
  { name: "Nightjar", group: "Thriller", year: 2021, rating: 7.0, plot: "A birdwatcher records a murder." },
];

export const SERIES: { name: string; group: string; year: number; rating: number; plot: string; seasons: number[] }[] = [
  { name: "Black Harbor", group: "Crime", year: 2022, rating: 8.1, plot: "A dock inspector in a fading port town is pulled into the smuggling ring her late father kept secret.", seasons: [6, 8, 6] },
  { name: "Salt & Iron", group: "Drama", year: 2020, rating: 7.6, plot: "Two families, one shipyard, and a contract that could save or sink the town.", seasons: [8, 8] },
  { name: "The Lantern Club", group: "Comedy", year: 2023, rating: 7.2, plot: "A late-night supper club and the regulars who keep it open.", seasons: [10] },
  { name: "Northbound", group: "Drama", year: 2019, rating: 7.9, plot: "A long-haul train, a different stranger each episode.", seasons: [6, 6, 6, 4] },
  { name: "Glass City", group: "Crime", year: 2024, rating: 7.4, plot: "A detective in a city where everyone is watching.", seasons: [8] },
  { name: "Kestrel Bay", group: "Drama", year: 2021, rating: 7.0, plot: "A coastal hospital through one long summer.", seasons: [10, 10] },
  { name: "Midnight Ledger", group: "Crime", year: 2025, rating: 7.8, plot: "An accountant finds a second set of books.", seasons: [6] },
  { name: "Little Owl Adventures", group: "Kids", year: 2022, rating: 7.1, plot: "Little Owl and friends explore the forest.", seasons: [12, 12] },
];

export const EPISODE_WORDS = ["The Manifest", "Low Tide", "Salt", "The Pilot Boat", "Fog Bank", "Dry Dock", "Undercurrent", "Breakwater", "Night Watch", "The Ledger", "Ballast", "Landfall", "Riptide", "The Crossing"];

export { hashString, rng, pick } from "../lib/hash";
