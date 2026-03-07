export type Stop = { name: string; coords: [number, number] };

export type Route = {
  id: string;
  name: string;
  shortName: string;
  color: string;
  textColor: string;
  type: "subway" | "streetcar" | "bus";
  description: string;
  frequency: string;
  stops: Stop[];
};

export type RouteStats = {
  cost: string;
  timeline: string;
  costedTimeline: string;
  minutesSaved: number;
  dollarsSaved: string;
  percentageChance: number;
  prNightmareScore: number;
};

export type GeneratedRoute = Route & { stats: RouteStats };

export type PopulationPoint = {
  coords: [number, number];
  weight: number; // 0–1
};

// ─── Population density data for Toronto ────────────────────────────────────

export const POPULATION_POINTS: PopulationPoint[] = [
  // Downtown core – very high density
  { coords: [-79.3806, 43.6453], weight: 1.0 },
  { coords: [-79.3792, 43.6487], weight: 0.97 },
  { coords: [-79.3789, 43.6519], weight: 0.95 },
  { coords: [-79.3850, 43.6500], weight: 0.93 },
  { coords: [-79.3770, 43.6465], weight: 0.90 },
  { coords: [-79.3900, 43.6510], weight: 0.88 },
  { coords: [-79.3750, 43.6540], weight: 0.86 },
  { coords: [-79.3830, 43.6560], weight: 0.87 },
  { coords: [-79.3910, 43.6480], weight: 0.84 },
  { coords: [-79.3860, 43.6430], weight: 0.82 },

  // Bloor / Yorkville / Annex
  { coords: [-79.3858, 43.6709], weight: 0.82 },
  { coords: [-79.3997, 43.6681], weight: 0.78 },
  { coords: [-79.3941, 43.6650], weight: 0.75 },
  { coords: [-79.3900, 43.6750], weight: 0.70 },
  { coords: [-79.4000, 43.6600], weight: 0.72 },
  { coords: [-79.4075, 43.6789], weight: 0.68 },
  { coords: [-79.4039, 43.6728], weight: 0.74 },

  // Midtown
  { coords: [-79.3994, 43.7072], weight: 0.75 },
  { coords: [-79.3969, 43.6989], weight: 0.72 },
  { coords: [-79.3931, 43.6883], weight: 0.68 },
  { coords: [-79.3836, 43.6786], weight: 0.65 },

  // North York Centre
  { coords: [-79.4103, 43.7617], weight: 0.73 },
  { coords: [-79.4103, 43.7769], weight: 0.70 },
  { coords: [-79.4125, 43.7953], weight: 0.58 },
  { coords: [-79.4003, 43.7233], weight: 0.62 },
  { coords: [-79.4028, 43.7453], weight: 0.60 },

  // West End
  { coords: [-79.4289, 43.6614], weight: 0.62 },
  { coords: [-79.4175, 43.6633], weight: 0.65 },
  { coords: [-79.4011, 43.6664], weight: 0.68 },
  { coords: [-79.4483, 43.6583], weight: 0.58 },
  { coords: [-79.4094, 43.6647], weight: 0.63 },
  { coords: [-79.4383, 43.6600], weight: 0.55 },
  { coords: [-79.4553, 43.6564], weight: 0.57 },

  // East End / Leslieville / Danforth
  { coords: [-79.3572, 43.6783], weight: 0.62 },
  { coords: [-79.3503, 43.6797], weight: 0.58 },
  { coords: [-79.3447, 43.6783], weight: 0.55 },
  { coords: [-79.3361, 43.6894], weight: 0.52 },
  { coords: [-79.3286, 43.6919], weight: 0.50 },
  { coords: [-79.3214, 43.6903], weight: 0.48 },
  { coords: [-79.3114, 43.6892], weight: 0.45 },
  { coords: [-79.3633, 43.6556], weight: 0.60 },

  // Etobicoke
  { coords: [-79.5368, 43.6375], weight: 0.52 },
  { coords: [-79.5228, 43.6414], weight: 0.50 },
  { coords: [-79.5097, 43.6458], weight: 0.47 },
  { coords: [-79.4872, 43.6519], weight: 0.50 },
  { coords: [-79.4658, 43.6553], weight: 0.53 },

  // Scarborough
  { coords: [-79.2731, 43.7061], weight: 0.55 },
  { coords: [-79.2553, 43.7181], weight: 0.60 },
  { coords: [-79.2992, 43.6917], weight: 0.48 },
  { coords: [-79.2869, 43.6981], weight: 0.50 },
  { coords: [-79.2400, 43.7400], weight: 0.42 },

  // Waterfront / Harbourfront
  { coords: [-79.3900, 43.6370], weight: 0.55 },
  { coords: [-79.4100, 43.6320], weight: 0.48 },
  { coords: [-79.4300, 43.6270], weight: 0.42 },
  { coords: [-79.3650, 43.6420], weight: 0.52 },
  { coords: [-79.4600, 43.6260], weight: 0.38 },
];

// ─── TTC Subway Lines (approximate real coordinates) ────────────────────────

export const ROUTES: Route[] = [
  {
    id: "line-1-yonge",
    name: "Line 1 – Yonge",
    shortName: "L1Y",
    color: "#FFCD00",
    textColor: "#1a1a1a",
    type: "subway",
    description: "Yonge branch of the Yonge–University line, running north from Union Station to Finch.",
    frequency: "Every 2–5 min",
    stops: [
      { name: "Union",          coords: [-79.3806, 43.6453] },
      { name: "King",           coords: [-79.3792, 43.6487] },
      { name: "Queen",          coords: [-79.3789, 43.6519] },
      { name: "Dundas",         coords: [-79.3803, 43.6543] },
      { name: "College",        coords: [-79.3841, 43.6572] },
      { name: "Wellesley",      coords: [-79.3858, 43.6630] },
      { name: "Bloor–Yonge",    coords: [-79.3858, 43.6709] },
      { name: "Rosedale",       coords: [-79.3836, 43.6786] },
      { name: "St Clair",       coords: [-79.3931, 43.6883] },
      { name: "Davisville",     coords: [-79.3969, 43.6989] },
      { name: "Eglinton",       coords: [-79.3994, 43.7072] },
      { name: "Lawrence",       coords: [-79.4003, 43.7233] },
      { name: "York Mills",     coords: [-79.4028, 43.7453] },
      { name: "Sheppard–Yonge", coords: [-79.4103, 43.7617] },
      { name: "North York Ctr", coords: [-79.4103, 43.7769] },
      { name: "Finch",          coords: [-79.4125, 43.7953] },
    ],
  },
  {
    id: "line-1-university",
    name: "Line 1 – University",
    shortName: "L1U",
    color: "#FFCD00",
    textColor: "#1a1a1a",
    type: "subway",
    description: "University branch running south from Sheppard West to Union, via Spadina.",
    frequency: "Every 2–5 min",
    stops: [
      { name: "Sheppard West", coords: [-79.4917, 43.7569] },
      { name: "Wilson",        coords: [-79.4717, 43.7483] },
      { name: "Yorkdale",      coords: [-79.4597, 43.7369] },
      { name: "Lawrence West", coords: [-79.4533, 43.7256] },
      { name: "Allen",         coords: [-79.4411, 43.7169] },
      { name: "Eglinton West", coords: [-79.4286, 43.7011] },
      { name: "St Clair West", coords: [-79.4178, 43.6889] },
      { name: "Dupont",        coords: [-79.4075, 43.6789] },
      { name: "Spadina",       coords: [-79.4039, 43.6728] },
      { name: "St George",     coords: [-79.3997, 43.6681] },
      { name: "Museum",        coords: [-79.3942, 43.6653] },
      { name: "Queen's Park",  coords: [-79.3928, 43.6597] },
      { name: "Osgoode",       coords: [-79.3892, 43.6508] },
      { name: "St Andrew",     coords: [-79.3864, 43.6470] },
      { name: "Union",         coords: [-79.3806, 43.6453] },
    ],
  },
  {
    id: "line-2",
    name: "Line 2 – Bloor–Danforth",
    shortName: "L2",
    color: "#00A650",
    textColor: "#ffffff",
    type: "subway",
    description: "East–west subway running from Kipling in the west to Kennedy in the east.",
    frequency: "Every 2–5 min",
    stops: [
      { name: "Kipling",       coords: [-79.5368, 43.6375] },
      { name: "Islington",     coords: [-79.5228, 43.6414] },
      { name: "Royal York",    coords: [-79.5097, 43.6458] },
      { name: "Old Mill",      coords: [-79.5003, 43.6492] },
      { name: "Jane",          coords: [-79.4872, 43.6519] },
      { name: "Runnymede",     coords: [-79.4761, 43.6536] },
      { name: "High Park",     coords: [-79.4658, 43.6553] },
      { name: "Keele",         coords: [-79.4553, 43.6564] },
      { name: "Dundas West",   coords: [-79.4483, 43.6583] },
      { name: "Lansdowne",     coords: [-79.4383, 43.6600] },
      { name: "Dufferin",      coords: [-79.4289, 43.6614] },
      { name: "Ossington",     coords: [-79.4175, 43.6633] },
      { name: "Christie",      coords: [-79.4094, 43.6647] },
      { name: "Bathurst",      coords: [-79.4011, 43.6664] },
      { name: "Spadina",       coords: [-79.4039, 43.6728] },
      { name: "St George",     coords: [-79.3997, 43.6681] },
      { name: "Bay",           coords: [-79.3919, 43.6700] },
      { name: "Bloor–Yonge",   coords: [-79.3858, 43.6709] },
      { name: "Sherbourne",    coords: [-79.3764, 43.6728] },
      { name: "Castle Frank",  coords: [-79.3697, 43.6783] },
      { name: "Broadview",     coords: [-79.3572, 43.6783] },
      { name: "Chester",       coords: [-79.3503, 43.6797] },
      { name: "Pape",          coords: [-79.3447, 43.6783] },
      { name: "Donlands",      coords: [-79.3361, 43.6894] },
      { name: "Greenwood",     coords: [-79.3286, 43.6919] },
      { name: "Coxwell",       coords: [-79.3214, 43.6903] },
      { name: "Woodbine",      coords: [-79.3114, 43.6892] },
      { name: "Main Street",   coords: [-79.2992, 43.6917] },
      { name: "Victoria Park", coords: [-79.2869, 43.6981] },
      { name: "Warden",        coords: [-79.2731, 43.7061] },
      { name: "Kennedy",       coords: [-79.2553, 43.7181] },
    ],
  },
  {
    id: "line-4",
    name: "Line 4 – Sheppard",
    shortName: "L4",
    color: "#B100CD",
    textColor: "#ffffff",
    type: "subway",
    description: "Short east–west line along Sheppard Ave, connecting to Line 1 at Sheppard–Yonge.",
    frequency: "Every 5–8 min",
    stops: [
      { name: "Sheppard–Yonge", coords: [-79.4103, 43.7617] },
      { name: "Bayview",        coords: [-79.3869, 43.7661] },
      { name: "Bessarion",      coords: [-79.3761, 43.7681] },
      { name: "Leslie",         coords: [-79.3631, 43.7703] },
      { name: "Don Mills",      coords: [-79.3294, 43.7758] },
    ],
  },
  {
    id: "streetcar-501",
    name: "501 Queen",
    shortName: "501",
    color: "#E4001B",
    textColor: "#ffffff",
    type: "streetcar",
    description: "Longest streetcar route in North America, running along Queen St from Long Branch to Neville Park.",
    frequency: "Every 4–10 min",
    stops: [
      { name: "Long Branch",  coords: [-79.5508, 43.5947] },
      { name: "Mimico",       coords: [-79.5106, 43.6028] },
      { name: "Roncesvalles", coords: [-79.4483, 43.6411] },
      { name: "Dufferin",     coords: [-79.4289, 43.6431] },
      { name: "Ossington",    coords: [-79.4147, 43.6433] },
      { name: "Bathurst",     coords: [-79.4014, 43.6447] },
      { name: "University",   coords: [-79.3900, 43.6519] },
      { name: "Yonge",        coords: [-79.3789, 43.6519] },
      { name: "Parliament",   coords: [-79.3633, 43.6556] },
      { name: "Broadview",    coords: [-79.3572, 43.6578] },
      { name: "Neville Park", coords: [-79.2919, 43.6736] },
    ],
  },
];

// ─── AI-Generated Route Suggestions ─────────────────────────────────────────

export const GENERATED_ROUTES: GeneratedRoute[] = [
  {
    id: "gen-relief-south",
    name: "Relief Line South",
    shortName: "RL",
    color: "#FF6B35",
    textColor: "#ffffff",
    type: "subway",
    description:
      "Downtown relief subway reducing overcrowding on Line 1. Runs from Pape to Osgoode via the King–Queen corridor, serving dense areas currently underserved.",
    frequency: "Every 3–6 min",
    stops: [
      { name: "Pape",       coords: [-79.3447, 43.6783] },
      { name: "Broadview",  coords: [-79.3572, 43.6650] },
      { name: "Parliament", coords: [-79.3633, 43.6556] },
      { name: "King East",  coords: [-79.3700, 43.6487] },
      { name: "Sherbourne", coords: [-79.3764, 43.6490] },
      { name: "Yonge–King", coords: [-79.3792, 43.6487] },
      { name: "Bay–King",   coords: [-79.3870, 43.6480] },
      { name: "University", coords: [-79.3900, 43.6510] },
      { name: "Osgoode",    coords: [-79.3892, 43.6508] },
    ],
    stats: {
      cost: "$4.8B",
      timeline: "7 years",
      costedTimeline: "11 years",
      minutesSaved: 18,
      dollarsSaved: "$820M/year",
      percentageChance: 62,
      prNightmareScore: 7.2,
    },
  },
  {
    id: "gen-waterfront",
    name: "Waterfront West LRT",
    shortName: "WF",
    color: "#0096C7",
    textColor: "#ffffff",
    type: "streetcar",
    description:
      "New LRT connecting Humber Bay to Union Station along the waterfront, serving rapidly growing condo developments and the Port Lands.",
    frequency: "Every 5–8 min",
    stops: [
      { name: "Humber Bay",            coords: [-79.4800, 43.6267] },
      { name: "Mimico GO",             coords: [-79.4550, 43.6247] },
      { name: "Sunnyside",             coords: [-79.4400, 43.6300] },
      { name: "Dufferin–Lakeshore",    coords: [-79.4289, 43.6331] },
      { name: "Strachan",              coords: [-79.4100, 43.6350] },
      { name: "Bathurst–Harbourfront", coords: [-79.4014, 43.6367] },
      { name: "Rees",                  coords: [-79.3900, 43.6383] },
      { name: "Union Station",         coords: [-79.3806, 43.6453] },
    ],
    stats: {
      cost: "$1.2B",
      timeline: "4 years",
      costedTimeline: "6 years",
      minutesSaved: 8,
      dollarsSaved: "$210M/year",
      percentageChance: 71,
      prNightmareScore: 4.1,
    },
  },
  {
    id: "gen-scarborough",
    name: "Scarborough Connector",
    shortName: "SC",
    color: "#7B2D8B",
    textColor: "#ffffff",
    type: "subway",
    description:
      "Extended rapid transit from Kennedy to Malvern, addressing the transit desert in northeast Scarborough and connecting high-density corridors.",
    frequency: "Every 5–10 min",
    stops: [
      { name: "Kennedy",       coords: [-79.2553, 43.7181] },
      { name: "Lawrence East", coords: [-79.2500, 43.7317] },
      { name: "Ellesmere",     coords: [-79.2422, 43.7508] },
      { name: "Midland",       coords: [-79.2350, 43.7636] },
      { name: "Scarborough TC",coords: [-79.2303, 43.7753] },
      { name: "McCowan",       coords: [-79.2175, 43.7814] },
      { name: "Bellamy",       coords: [-79.2050, 43.7872] },
      { name: "Malvern",       coords: [-79.1936, 43.7931] },
    ],
    stats: {
      cost: "$3.1B",
      timeline: "9 years",
      costedTimeline: "14 years",
      minutesSaved: 22,
      dollarsSaved: "$540M/year",
      percentageChance: 45,
      prNightmareScore: 8.8,
    },
  },
];
