// Invented demo content for the in-browser mock backend. Nothing here is real.

export interface ChannelDef {
  name: string;
  group: string;
  /** programme pool; defaults to the group name without a trailing number */
  pool?: string;
  favorite?: boolean;
  noGuide?: boolean;
  offline?: boolean;
}

const FOOTBALL = "Sports | Football";
const US = "Sports | US";
const MOTOR = "Sports | Motorsport";
const FIGHT = "Sports | Fight";
const RACKET = "Sports | Tennis & Golf";
const MORE = "Sports | More";
const PPV = "PPV Events";

export const HOME_CHANNELS: ChannelDef[] = [
  { name: "Arena Sports 1", group: FOOTBALL, pool: "Football", favorite: true },
  { name: "Arena Sports 2", group: FOOTBALL, pool: "Football" },
  { name: "Arena Sports 3", group: FOOTBALL, pool: "Football" },
  { name: "Pitch One", group: FOOTBALL, pool: "Football", favorite: true },
  { name: "Pitch Two", group: FOOTBALL, pool: "Football" },
  { name: "Goal Zone", group: FOOTBALL, pool: "Football" },
  { name: "Terrace TV", group: FOOTBALL, pool: "Football" },
  { name: "Gridiron Network", group: US, pool: "US", favorite: true },
  { name: "Hoops 24", group: US, pool: "US" },
  { name: "Puck Central", group: US, pool: "US" },
  { name: "Diamond TV", group: US, pool: "US" },
  { name: "Courtside", group: US, pool: "US" },
  { name: "Apex Motorsport", group: MOTOR, pool: "Motor" },
  { name: "Pit Lane", group: MOTOR, pool: "Motor" },
  { name: "Ringside 1", group: FIGHT, pool: "Fight" },
  { name: "Octagon One", group: FIGHT, pool: "Fight" },
  { name: "Baseline TV", group: RACKET, pool: "Racket" },
  { name: "Green Fairway", group: RACKET, pool: "Racket" },
  { name: "Velo TV", group: MORE, pool: "More" },
  { name: "Oche Darts", group: MORE, pool: "More" },
  { name: "Arena Extra", group: MORE, pool: "More" },
  { name: "PPV Event 1", group: PPV, pool: "PPV" },
  { name: "PPV Event 2", group: PPV, pool: "PPV" },
  { name: "PPV Event 3", group: PPV, pool: "PPV", noGuide: true },
  { name: "Northwind News", group: "News", favorite: true },
  { name: "Harbor One", group: "News" },
  { name: "Meridian 24", group: "News" },
  { name: "Capital Report", group: "News" },
  { name: "Terra Documentary", group: "Docs" },
  { name: "Deep Blue", group: "Docs" },
  { name: "History Vault", group: "Docs" },
  { name: "Cosmos HD", group: "Docs", noGuide: true },
  { name: "Lantern Cinema", group: "Movies" },
  { name: "Reel Classics", group: "Movies" },
  { name: "Midnight Screen", group: "Movies" },
  { name: "Spark Kids", group: "Kids" },
  { name: "Little Owl", group: "Kids" },
  { name: "Pulse Music", group: "Music" },
  { name: "Vinyl FM", group: "Music" },
  { name: "Nordic One", group: "World" },
  { name: "Sol Latino", group: "World" },
  { name: "Kanal Euro", group: "World", noGuide: true, offline: true },
];

export const SPORTS_BACKUP_CHANNELS: ChannelDef[] = [
  { name: "Pitchside 1", group: FOOTBALL, pool: "Football" },
  { name: "Pitchside 2", group: FOOTBALL, pool: "Football" },
  { name: "Ringside 2", group: FIGHT, pool: "Fight" },
  { name: "Fairway Golf", group: RACKET, pool: "Racket" },
  { name: "Rally TV", group: MOTOR, pool: "Motor", noGuide: true },
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
  /** fixtures are made up from these, so channels rarely show the same match */
  fixtures?: { teams: string[]; sep: string; prefixes: string[]; share: number };
}

export const PROGRAMME_POOLS: Record<string, Pool> = {
  Football: {
    titles: ["Matchday Live", "Goals Tonight", "Full-time Reaction", "The Football Show"],
    minutes: [90, 120, 120, 60],
    category: "Football",
    fixtures: {
      teams: ["Harbor FC", "Kestrel United", "Ridgeway", "Pellmar Athletic", "Northport City", "Dunmore", "Castlebrook", "Wexley Town", "Saltmarsh Rovers", "Glenhaven", "Ashby", "Larkfield", "Brackwater", "Fenwick Albion", "Hollin Park", "Stavely"],
      sep: " v ",
      prefixes: ["", "", "", "", "", "", "Cup: ", "Women's League: "],
      share: 0.75,
    },
  },
  US: {
    titles: ["Gridiron Tonight", "Hoops Highlights", "Puck Talk"],
    minutes: [150, 180, 120],
    category: "Sports",
    fixtures: {
      teams: ["Wolves", "Ironclads", "Harbor Kings", "Summit", "Bay Hawks", "Granite", "Coastal Gulls", "Red Rocks", "Prairie Storm", "Lakers of Ash", "Copper Miners", "Night Owls"],
      sep: " vs ",
      prefixes: ["", "Hoops: ", "Puck Drop: ", "College: "],
      share: 0.75,
    },
  },
  Motor: {
    titles: ["Grand Prix of Valmont: Race", "Grand Prix of Valmont: Qualifying", "Rally of the Pines: Stage 6", "Endurance Hour", "Pit Lane Preview"],
    minutes: [90, 120, 60],
    category: "Motorsport",
  },
  Fight: {
    titles: ["Fight Night: Okafor v Brandt", "Fight Night: Prelims", "Boxing: Reyes v Tamm", "Ringside Classics", "Weigh-in Live"],
    minutes: [120, 180, 60],
    category: "Boxing",
  },
  Racket: {
    titles: ["Tennis: Quarter-final, Lind v Moreau", "Tennis: Doubles Semi-final", "Golf: Coastal Open, Final Round", "Golf: Coastal Open, Round 3", "Tennis Tonight"],
    minutes: [120, 180, 90],
    category: "Sports",
  },
  More: {
    titles: ["Cycling: Stage 14", "Pro Darts: Final", "Snooker: Masters Semi-final", "Rugby: Harbour v Westmoor", "Cricket: Day 3"],
    minutes: [120, 180, 90],
    category: "Sports",
  },
  PPV: {
    titles: ["Main Event: Okafor v Brandt", "Undercard: Vale v Ito", "Event build-up", "Main Event: Castillo v Grant"],
    minutes: [180, 120],
    category: "Sports",
  },
  News: {
    titles: ["Morning Brief", "Midday Report", "Evening Brief", "Weather Desk", "Late Edition", "World Tonight", "Business Hour", "The Briefing", "Harbor Strike: Special Report"],
    minutes: [30, 30, 60],
    category: "News",
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
  "Arena Sports 1": { title: "Harbor FC v Kestrel United", startOffsetMin: -67, minutes: 115, description: "League · second half. Kestrel pushing for an equaliser." },
  "Gridiron Network": { title: "Wolves vs Ironclads", startOffsetMin: -48, minutes: 190, description: "Second quarter from the Ironworks." },
  "Arena Sports 2": { title: "Ridgeway v Pellmar Athletic", startOffsetMin: -22, minutes: 115, description: "League · first half." },
  "Oche Darts": { title: "Pro Darts: Final", startOffsetMin: -10, minutes: 90, description: "The final, live." },
  "Pitch One": { title: "Northport City v Dunmore", startOffsetMin: 35, minutes: 115, description: "League · live from the Northport Stadium." },
  "Apex Motorsport": { title: "Grand Prix of Valmont: Qualifying", startOffsetMin: 80, minutes: 75, description: "Qualifying, live from Valmont." },
  "PPV Event 1": { title: "Main Event: Okafor v Brandt", startOffsetMin: 130, minutes: 180, description: "Heavyweight title, twelve rounds." },
  "Hoops 24": { title: "Hoops: Harbor Kings vs Summit", startOffsetMin: 185, minutes: 150, description: "Regular season." },
  "Baseline TV": { title: "Tennis: Quarter-final, Lind v Moreau", startOffsetMin: -35, minutes: 150, description: "Second set." },
  "Northwind News": { title: "Evening Brief", startOffsetMin: -24, minutes: 60, description: "The day's headlines, with analysis from correspondents across the region." },
  "Terra Documentary": { title: "Rivers of Ice", startOffsetMin: -24, minutes: 55, description: "Glaciers carved the north. A crew follows the melt season." },
  "Lantern Cinema": { title: "The Long Field", startOffsetMin: -74, minutes: 115, description: "A farmer and his estranged son rebuild after a flood." },
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
