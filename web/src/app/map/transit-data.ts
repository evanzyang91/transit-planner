import { withPositionalStopIds } from "./stop-identity";
import GENERATED_ROUTES_DATA from "./generated-routes.json";

export type Stop = {
  /**
   * Stable identity for this stop. Every stop that reaches component state has
   * one — built-in stops are stamped at module load, user-created stops get a
   * uuid, and anything imported is backfilled via withStopIds(). Optional only
   * so external data (GTFS/JSON) can be parsed before normalisation.
   *
   * Address stops by this, never by `name`: names are duplicated across and
   * within routes, so name lookups hit the wrong stop.
   */
  id?: string;
  name: string;
  coords: [number, number]
};

export type ServicePattern = {
  headwayMinutes: number;
  startHour: number;
  endHour: number;
  days: ("monday"|"tuesday"|"wednesday"|"thursday"|"friday"|"saturday"|"sunday")[];
};

export type Route = {
  id: string;
  name: string;
  shortName: string;
  color: string;
  textColor: string;
  type: "subway" | "lrt" | "streetcar" | "bus" | "go_train";
  description: string;
  frequency: string;
  servicePattern?: ServicePattern; // add — used for GTFS export
  stops: Stop[];
  /** Full line geometry including intermediate curve waypoints [lng, lat]. When present, used for rendering instead of deriving coords from stops. */
  shape?: [number, number][];
  /** Portal markers that toggle underground rendering on/off along the route. */
  portals?: Array<{ coords: [number, number] }>;
  /** GTFS variant ID used to match shape geometry from go-rail-shapes.geojson */
  _variantId?: string;
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

export type NeighbourhoodData = {
  trafficLevel: "Low" | "Moderate" | "High" | "Very High";
  employmentDensity: "Low" | "Moderate" | "High" | "Very High";
  populationDensity: number; // people per km²
  connectivityScore: number; // 1–10
  transitLines: string[]; // route IDs
};

// ─── TTC Subway Lines (verified against TTC GTFS data) ──────────────────────
// Coordinates averaged from northbound+southbound (or eastbound+westbound)
// platform pairs in subwaycoordinates.txt.
// `shape` adds intermediate waypoints where the track curves between stations.

// The literals below are stamped with stop ids on export (see end of file), so
// every stop in the app carries an identity independent of its name.
const RAW_ROUTES: Route[] = [
  {
    id: "line-1",
    name: "Yonge–University",
    shortName: "1",
    color: "#FFCD00",
    textColor: "#1a1a1a",
    type: "subway",
    description: "U-shaped line running from Vaughan Metropolitan Centre south along the University/Spadina corridor to Union, then north along Yonge to Finch.",
    frequency: "Every 2–5 min",
    servicePattern: {
      headwayMinutes: 3,
      startHour: 5,
      endHour: 1,
      days: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
    },
    stops: [
      // University/Spadina branch: Vaughan MC → Union
      { name: "Vaughan MC",      coords: [-79.5279, 43.7940] },
      { name: "Highway 407",     coords: [-79.5235, 43.7834] },
      { name: "Pioneer Village", coords: [-79.5093, 43.7768] },
      { name: "York University", coords: [-79.4999, 43.7741] },
      { name: "Finch West",      coords: [-79.4911, 43.7649] },
      { name: "Downsview Park",  coords: [-79.4787, 43.7533] },
      { name: "Sheppard West",   coords: [-79.4624, 43.7497] },
      { name: "Wilson",          coords: [-79.4500, 43.7345] },
      { name: "Yorkdale",        coords: [-79.4475, 43.7246] },
      { name: "Lawrence West",   coords: [-79.4439, 43.7153] },
      { name: "Glencairn",       coords: [-79.4405, 43.7086] },
      { name: "Cedarvale",        coords: [-79.435639, 43.698930] },
      { name: "St Clair West",   coords: [-79.4156, 43.6845] },
      { name: "Dupont",          coords: [-79.4069, 43.6743] },
      { name: "Spadina",         coords: [-79.4050, 43.6697] },
      { name: "St George",       coords: [-79.3988, 43.6684] },
      { name: "Museum",          coords: [-79.3932, 43.6666] },
      { name: "Queen's Park",    coords: [-79.3905, 43.6599] },
      { name: "St Patrick",      coords: [-79.3882, 43.6547] },
      { name: "Osgoode",         coords: [-79.3867, 43.6511] },
      { name: "St Andrew",       coords: [-79.3848, 43.6477] },
      { name: "Union",           coords: [-79.3806, 43.6456] },
      // Yonge branch: Union → Finch (Union shared, not duplicated)
      { name: "King",            coords: [-79.3779, 43.6491] },
      { name: "Queen",           coords: [-79.3794, 43.6527] },
      { name: "Dundas",          coords: [-79.3810, 43.6566] },
      { name: "College",         coords: [-79.3829, 43.6608] },
      { name: "Wellesley",       coords: [-79.3836, 43.6656] },
      { name: "Bloor–Yonge",     coords: [-79.3856, 43.6706] },
      { name: "Rosedale",        coords: [-79.3883, 43.6766] },
      { name: "Summerhill",      coords: [-79.3910, 43.6827] },
      { name: "St Clair",        coords: [-79.3933, 43.6881] },
      { name: "Davisville",      coords: [-79.3971, 43.6977] },
      { name: "Eglinton",        coords: [-79.398765, 43.706380] },
      { name: "Lawrence",        coords: [-79.4024, 43.7259] },
      { name: "York Mills",      coords: [-79.4061, 43.7438] },
      { name: "Sheppard–Yonge",  coords: [-79.4108, 43.7610] },
      { name: "North York Ctr",  coords: [-79.4125, 43.7679] },
      { name: "Finch",           coords: [-79.4155, 43.7805] },
    ],
    shape: [
      // University/Spadina branch south to Union
      [-79.5279, 43.7940], // Vaughan MC
      [-79.5235, 43.7834], // Highway 407
      [-79.5093, 43.7768], // Pioneer Village
      [-79.4999, 43.7741], // York University
      [-79.4911, 43.7649], // Finch West
      [-79.4787, 43.7533], // Downsview Park
      [-79.4706, 43.7514], // curve — slight west before Sheppard West
      [-79.4624, 43.7497], // Sheppard West
      [-79.4500, 43.7345], // Wilson
      [-79.4475, 43.7246], // Yorkdale
      [-79.4439, 43.7153], // Lawrence West
      [-79.4405, 43.7086], // Glencairn
      [-79.435639, 43.698930], // Cedarvale
      [-79.4260, 43.6922], // curve — Allen corridor sweeps east
      [-79.4156, 43.6845], // St Clair West
      [-79.4069, 43.6743], // Dupont
      [-79.4050, 43.6697], // Spadina
      [-79.3988, 43.6684], // St George
      [-79.3932, 43.6666], // Museum
      [-79.3905, 43.6599], // Queen's Park
      [-79.3882, 43.6547], // St Patrick
      [-79.3867, 43.6511], // Osgoode
      [-79.3848, 43.6477], // St Andrew
      [-79.3806, 43.6456], // Union (shared bottom of U)
      // Yonge branch north from Union
      [-79.3786, 43.6474], // curve — jog east onto Yonge
      [-79.3779, 43.6491], // King
      [-79.3794, 43.6527], // Queen
      [-79.3810, 43.6566], // Dundas
      [-79.3829, 43.6608], // College
      [-79.3836, 43.6656], // Wellesley
      [-79.3856, 43.6706], // Bloor–Yonge
      [-79.3883, 43.6766], // Rosedale
      [-79.3910, 43.6827], // Summerhill
      [-79.3933, 43.6881], // St Clair
      [-79.3971, 43.6977], // Davisville
      [-79.398765, 43.706380], // Eglinton
      [-79.4024, 43.7259], // Lawrence
      [-79.4061, 43.7438], // York Mills
      [-79.4108, 43.7610], // Sheppard–Yonge
      [-79.4125, 43.7679], // North York Centre
      [-79.4155, 43.7805], // Finch
    ],
  },
  {
    id: "line-2",
    name: "Bloor–Danforth",
    shortName: "2",
    color: "#00A650",
    textColor: "#ffffff",
    type: "subway",
    description: "East–west subway running from Kipling in the west to Kennedy in the east.",
    frequency: "Every 2–5 min",
    servicePattern: {
      headwayMinutes: 4,
      startHour: 5,
      endHour: 1,
      days: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
    },
    stops: [
      // Ordered west → east
      { name: "Kipling",        coords: [-79.5358, 43.6375] },
      { name: "Islington",      coords: [-79.5241, 43.6454] },
      { name: "Royal York",     coords: [-79.5096, 43.6485] },
      { name: "Old Mill",       coords: [-79.4941, 43.6498] },
      { name: "Jane",           coords: [-79.4837, 43.6500] },
      { name: "Runnymede",      coords: [-79.4758, 43.6519] },
      { name: "High Park",      coords: [-79.4678, 43.6537] },
      { name: "Keele",          coords: [-79.4595, 43.6555] },
      { name: "Dundas West",    coords: [-79.4519, 43.6573] },
      { name: "Lansdowne",      coords: [-79.4425, 43.6593] },
      { name: "Dufferin",       coords: [-79.4347, 43.6607] },
      { name: "Ossington",      coords: [-79.4270, 43.6622] },
      { name: "Christie",       coords: [-79.4181, 43.6643] },
      { name: "Bathurst",       coords: [-79.4114, 43.6658] },
      { name: "Spadina",        coords: [-79.4048, 43.6671] },
      { name: "St George",      coords: [-79.3988, 43.6684] },
      { name: "Bay",            coords: [-79.3909, 43.6700] },
      { name: "Bloor–Yonge",    coords: [-79.3856, 43.6706] },
      { name: "Sherbourne",     coords: [-79.3762, 43.6721] },
      { name: "Castle Frank",   coords: [-79.3689, 43.6738] },
      { name: "Broadview",      coords: [-79.3588, 43.6767] },
      { name: "Chester",        coords: [-79.3525, 43.6783] },
      { name: "Pape",           coords: [-79.3449, 43.6798] },
      { name: "Donlands",       coords: [-79.3383, 43.6811] },
      { name: "Greenwood",      coords: [-79.3308, 43.6827] },
      { name: "Coxwell",        coords: [-79.3228, 43.6844] },
      { name: "Woodbine",       coords: [-79.3131, 43.6865] },
      { name: "Main Street",    coords: [-79.3015, 43.6891] },
      { name: "Victoria Park",  coords: [-79.2887, 43.6949] },
      { name: "Warden",         coords: [-79.2789, 43.7115] },
      { name: "Kennedy",        coords: [-79.264480, 43.732791] },
    ],
    // Curves: Victoria Park → Warden → Kennedy bend northeast then north
    shape: [
      [-79.5358, 43.6375], // Kipling
      [-79.5241, 43.6454], // Islington
      [-79.5096, 43.6485], // Royal York
      [-79.4941, 43.6498], // Old Mill
      [-79.4837, 43.6500], // Jane
      [-79.4758, 43.6519], // Runnymede
      [-79.4678, 43.6537], // High Park
      [-79.4595, 43.6555], // Keele
      [-79.4519, 43.6573], // Dundas West
      [-79.4425, 43.6593], // Lansdowne
      [-79.4347, 43.6607], // Dufferin
      [-79.4270, 43.6622], // Ossington
      [-79.4181, 43.6643], // Christie
      [-79.4114, 43.6658], // Bathurst
      [-79.4048, 43.6671], // Spadina
      [-79.3988, 43.6684], // St George
      [-79.3909, 43.6700], // Bay
      [-79.3856, 43.6706], // Bloor–Yonge
      [-79.3762, 43.6721], // Sherbourne
      [-79.3689, 43.6738], // Castle Frank
      [-79.3588, 43.6767], // Broadview
      [-79.3525, 43.6783], // Chester
      [-79.3449, 43.6798], // Pape
      [-79.3383, 43.6811], // Donlands
      [-79.3308, 43.6827], // Greenwood
      [-79.3228, 43.6844], // Coxwell
      [-79.3131, 43.6865], // Woodbine
      [-79.3015, 43.6891], // Main Street
      [-79.2887, 43.6949], // Victoria Park
      [-79.2836, 43.7032], // curve — bends northeast toward Warden
      [-79.2789, 43.7115], // Warden
      [-79.2716, 43.7219], // curve — continues northeast toward Kennedy
      [-79.264480, 43.732791], // Kennedy
    ],
  },
  {
    id: "line-4",
    name: "Sheppard",
    shortName: "4",
    color: "#B100CD",
    textColor: "#ffffff",
    type: "subway",
    description: "Short east–west line along Sheppard Ave, connecting to Line 1 at Sheppard–Yonge.",
    frequency: "Every 5–8 min",
    servicePattern: {
      headwayMinutes: 6,
      startHour: 5,
      endHour: 1,
      days: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
    },
    stops: [
      // Ordered west → east
      { name: "Sheppard–Yonge", coords: [-79.4108, 43.7610] },
      { name: "Bayview",        coords: [-79.3867, 43.7669] },
      { name: "Bessarion",      coords: [-79.3763, 43.7692] },
      { name: "Leslie",         coords: [-79.3659, 43.7713] },
      { name: "Don Mills",      coords: [-79.3464, 43.7754] },
    ],
  },

  {
    id: "line-5",
    name: "Eglinton",
    shortName: "5",
    color: "#FF8000",
    textColor: "#ffffff",
    type: "lrt",
    description: "LRT line along Eglinton Ave from Mount Dennis to Kennedy, with underground stations in the central section.",
    frequency: "Every 5–8 min",
    servicePattern: {
      headwayMinutes: 6,
      startHour: 5,
      endHour: 11,
      days: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
    },
    stops: [
      // Ordered west → east (from GTFS data)
      { name: "Mount Dennis",          coords: [-79.485789, 43.688025] },
      { name: "Keelesdale",            coords: [-79.474533, 43.690413] },
      { name: "Caledonia",             coords: [-79.465079, 43.692324] },
      { name: "Fairbank",              coords: [-79.449260, 43.695744] },
      { name: "Oakwood",               coords: [-79.442726, 43.697429] },
      { name: "Cedarvale",             coords: [-79.435639, 43.698930] },
      { name: "Forest Hill",           coords: [-79.425086, 43.701136] },
      { name: "Chaplin",               coords: [-79.417098, 43.702913] },
      { name: "Avenue",                coords: [-79.408728, 43.704723] },
      { name: "Eglinton",              coords: [-79.398765, 43.706380] },
      { name: "Mount Pleasant",        coords: [-79.390329, 43.708503] },
      { name: "Leaside",               coords: [-79.376475, 43.710767] },
      { name: "Laird",                 coords: [-79.364733, 43.713199] },
      { name: "Sunnybrook Park",       coords: [-79.348720, 43.717392] },
      { name: "Don Valley",            coords: [-79.338946, 43.719956] },
      { name: "Aga Khan Park & Museum",coords: [-79.332284, 43.722496] },
      { name: "Wynford",               coords: [-79.326236, 43.724139] },
      { name: "Sloane",                coords: [-79.312252, 43.725837] },
      { name: "O'Connor",              coords: [-79.301367, 43.724820] },
      { name: "Pharmacy",              coords: [-79.296325, 43.725881] },
      { name: "Hakimi Lebovic",        coords: [-79.290298, 43.727226] },
      { name: "Golden Mile",           coords: [-79.286352, 43.728100] },
      { name: "Birchmount",            coords: [-79.276636, 43.730223] },
      { name: "Ionview",               coords: [-79.271673, 43.731366] },
      { name: "Kennedy",               coords: [-79.264480, 43.732791] },
    ],
  },
  {
    id: "line-6",
    name: "Finch West",
    shortName: "6",
    color: "#808080",
    textColor: "#ffffff",
    type: "lrt",
    description: "LRT line along Finch Ave West from Humber College to Finch West Station, where it transfers to Line 1 (Yonge–University) subway.",
    frequency: "Every 5–10 min",
    servicePattern: {
      headwayMinutes: 7,
      startHour: 5,
      endHour: 1,
      days: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
    },
    stops: [
      // Ordered west → east (from GTFS data)
      { name: "Humber College",      coords: [-79.601445, 43.729905] },
      { name: "Westmore",            coords: [-79.600710, 43.734701] },
      { name: "Martin Grove",        coords: [-79.591916, 43.736708] },
      { name: "Albion",              coords: [-79.589034, 43.741404] },
      { name: "Stevenson",           coords: [-79.586943, 43.743185] },
      { name: "Mount Olive",         coords: [-79.581770, 43.743270] },
      { name: "Rowntree Mills",      coords: [-79.568298, 43.746365] },
      { name: "Pearldale",           coords: [-79.562493, 43.747724] },
      { name: "Duncanwoods",         coords: [-79.557338, 43.748853] },
      { name: "Milvan Rumike",       coords: [-79.552029, 43.749999] },
      { name: "Emery",               coords: [-79.542106, 43.752088] },
      { name: "Signet Arrow",        coords: [-79.535930, 43.753302] },
      { name: "Norfinch Oakdale",    coords: [-79.524004, 43.755953] },
      { name: "Jane and Finch",      coords: [-79.517421, 43.757205] },
      { name: "Driftwood",           coords: [-79.513160, 43.758068] },
      { name: "Tobermory",           coords: [-79.507742, 43.759309] },
      { name: "Sentinel",            coords: [-79.499846, 43.761085] },
      { name: "Finch West",          coords: [-79.4911, 43.7649] },
    ],
  },

  // ─── TTC Streetcar Routes (from GTFS data, longest direction-0 trip per route) ──
  {
    id: "streetcar-501",
    name: "Queen",
    shortName: "501",
    color: "#ED1C24",
    textColor: "#FFFFFF",
    type: "streetcar",
    description: "Streetcar along Queen St from Long Branch GO to Neville Park Blvd.",
    frequency: "Every 5–10 min",
    stops: [
      { name: "Long Branch Loop - Long Branch GO Station", coords: [-79.544124, 43.591811] },
      { name: "Lake Shore Blvd West / Thirty Seventh St", coords: [-79.538348, 43.593334] },
      { name: "Lake Shore Blvd West / Long Branch Ave", coords: [-79.534130, 43.594303] },
      { name: "Lake Shore Blvd West / Thirty First St", coords: [-79.530407, 43.595155] },
      { name: "Lake Shore Blvd West / Twenty Eighth St", coords: [-79.527699, 43.595685] },
      { name: "Lake Shore Blvd West / Twenty Seventh St", coords: [-79.525043, 43.596328] },
      { name: "Lake Shore Blvd West / Twenty Second St", coords: [-79.521413, 43.597116] },
      { name: "Lake Shore Blvd West / Colonel Samuel Smith Park Dr", coords: [-79.517179, 43.598047] },
      { name: "Lake Shore Blvd West / Thirteenth St", coords: [-79.511960, 43.599214] },
      { name: "Lake Shore Blvd West / Tenth St", coords: [-79.508796, 43.599877] },
      { name: "Lake Shore Blvd West / Seventh St", coords: [-79.505392, 43.600638] },
      { name: "Lake Shore Blvd West / Fifth St", coords: [-79.503113, 43.601151] },
      { name: "Lake Shore Blvd West / Third St", coords: [-79.500866, 43.601653] },
      { name: "Lake Shore Blvd West / First St", coords: [-79.498592, 43.602140] },
      { name: "Lake Shore Blvd West / Royal York Rd", coords: [-79.493189, 43.603544] },
      { name: "Lake Shore Blvd West / Miles Rd", coords: [-79.490239, 43.608194] },
      { name: "Lake Shore Blvd West / Norris Cres", coords: [-79.489952, 43.610819] },
      { name: "Lake Shore Blvd West / Mimico Ave", coords: [-79.489314, 43.613542] },
      { name: "Lake Shore Blvd West / Superior Ave", coords: [-79.488619, 43.614817] },
      { name: "Lake Shore Blvd West / Burlington St", coords: [-79.487284, 43.617151] },
      { name: "Lake Shore Blvd West / Louisa St", coords: [-79.486469, 43.618786] },
      { name: "Lake Shore Blvd West / Legion Rd", coords: [-79.483407, 43.620372] },
      { name: "Lake Shore Blvd West / Park Lawn Rd", coords: [-79.481308, 43.622780] },
      { name: "2155 Lake Shore Blvd West", coords: [-79.479741, 43.625705] },
      { name: "2111 Lake Shore Blvd West", coords: [-79.478151, 43.629066] },
      { name: "Humber Loop / The Queensway", coords: [-79.478730, 43.631002] },
      { name: "The Queensway / South Kingsway", coords: [-79.473052, 43.635819] },
      { name: "The Queensway / Windermere Ave", coords: [-79.469205, 43.637256] },
      { name: "The Queensway / Ellis Ave", coords: [-79.465682, 43.637929] },
      { name: "The Queensway / Colborne Lodge Dr", coords: [-79.458635, 43.639566] },
      { name: "The Queensway / Parkside Dr", coords: [-79.453923, 43.639665] },
      { name: "The Queensway / Glendale Ave - St Joseph's Health Centre", coords: [-79.450773, 43.639168] },
      { name: "Queen St West / Roncesvalles Ave", coords: [-79.445427, 43.638812] },
      { name: "Queen St West / Triller Ave", coords: [-79.443874, 43.639092] },
      { name: "Queen St West / Beaty Ave", coords: [-79.441272, 43.639599] },
      { name: "Queen St West / Jameson Ave", coords: [-79.437517, 43.640390] },
      { name: "Queen St West / Dunn Ave", coords: [-79.434664, 43.640919] },
      { name: "Queen St West / Brock Ave", coords: [-79.432411, 43.641387] },
      { name: "Queen St West / Dufferin St", coords: [-79.428787, 43.642115] },
      { name: "Queen St West / Sudbury St", coords: [-79.427345, 43.642398] },
      { name: "Queen St West / Abell St", coords: [-79.424466, 43.642976] },
      { name: "Queen St West / Dovercourt Rd", coords: [-79.422528, 43.643394] },
      { name: "Queen St West / Ossington Ave", coords: [-79.418976, 43.644060] },
      { name: "Queen St West / Shaw St", coords: [-79.416511, 43.644560] },
      { name: "Queen St West / Strachan Ave", coords: [-79.413308, 43.645241] },
      { name: "Queen St West / Niagara St", coords: [-79.410006, 43.645898] },
      { name: "Queen St West / Tecumseth St", coords: [-79.406716, 43.646569] },
      { name: "Queen St West / Bathurst St", coords: [-79.404180, 43.647084] },
      { name: "Queen St West / Augusta Ave", coords: [-79.399869, 43.647951] },
      { name: "Queen St West / Spadina Ave", coords: [-79.397609, 43.648381] },
      { name: "Queen St West / Peter St", coords: [-79.393771, 43.649220] },
      { name: "Queen St West / John St", coords: [-79.391191, 43.649759] },
      { name: "Queen St West / University Ave - Osgoode Station", coords: [-79.386931, 43.650683] },
      { name: "York St / Adelaide St West", coords: [-79.384314, 43.649422] },
      { name: "Adelaide St West / Yonge St - King Station", coords: [-79.378551, 43.650274] },
      { name: "Church St / Queen St East", coords: [-79.375613, 43.653061] },
      { name: "Queen St East / Jarvis St", coords: [-79.373383, 43.653602] },
      { name: "Queen St East / Sherbourne St", coords: [-79.369555, 43.654424] },
      { name: "Queen St East / Ontario St", coords: [-79.367262, 43.654914] },
      { name: "Queen St East / Parliament St", coords: [-79.364679, 43.655473] },
      { name: "Parliament St / Shuter St", coords: [-79.364855, 43.656843] },
      { name: "Parliament St / Dundas St East", coords: [-79.365861, 43.659350] },
      { name: "Dundas St East / Regent Park Blvd", coords: [-79.361966, 43.660247] },
      { name: "Dundas St East / River St", coords: [-79.358286, 43.661093] },
      { name: "Dundas St East / Broadview Ave", coords: [-79.351814, 43.662249] },
      { name: "Queen St East / Saulter St", coords: [-79.347097, 43.659402] },
      { name: "Queen St East / Empire Ave", coords: [-79.344501, 43.659991] },
      { name: "Queen St East / Logan Ave", coords: [-79.342681, 43.660394] },
      { name: "Queen St East / Carlaw Ave", coords: [-79.340208, 43.660953] },
      { name: "Queen St East / Pape Ave", coords: [-79.338074, 43.661429] },
      { name: "Queen St East / Caroline Ave", coords: [-79.335437, 43.662018] },
      { name: "Queen St East / Jones Ave", coords: [-79.332925, 43.662578] },
      { name: "Queen St East / Leslie St", coords: [-79.330376, 43.663143] },
      { name: "Queen St East / Alton Ave", coords: [-79.328109, 43.663648] },
      { name: "Queen St East / Greenwood Ave", coords: [-79.325493, 43.664281] },
      { name: "Queen St East / Woodfield Rd", coords: [-79.321530, 43.665141] },
      { name: "Queen St East / Emdaabiimok Ave", coords: [-79.316789, 43.666193] },
      { name: "Queen St East / Kingston Rd", coords: [-79.312948, 43.667029] },
      { name: "Queen St East / Sarah Ashbridge Ave", coords: [-79.309305, 43.667893] },
      { name: "Queen St East / Woodbine Ave", coords: [-79.305945, 43.668635] },
      { name: "Queen St East / Elmer Ave", coords: [-79.303645, 43.669159] },
      { name: "Queen St East / Bellefair Ave", coords: [-79.299922, 43.669987] },
      { name: "Queen St East / Wineva Ave", coords: [-79.295031, 43.671048] },
      { name: "Queen St East / Glen Manor Dr", coords: [-79.292818, 43.671493] },
      { name: "Queen St East / Beech Ave", coords: [-79.287687, 43.672555] },
      { name: "Queen St East / Silver Birch Ave", coords: [-79.285343, 43.673035] },
      { name: "Queen St East / Neville Park Blvd", coords: [-79.282531, 43.673616] },
    ],
  },
  {
    id: "streetcar-503",
    name: "Kingston Rd",
    shortName: "503",
    color: "#ED1C24",
    textColor: "#FFFFFF",
    type: "streetcar",
    description: "Streetcar along Kingston Rd between Queen St East and Bingham Loop.",
    frequency: "Every 5–10 min",
    stops: [
      { name: "York St / King St West", coords: [-79.383573, 43.648231] },
      { name: "University Ave / Adelaide St West", coords: [-79.385738, 43.648966] },
      { name: "King St West / York St - St Andrew Station", coords: [-79.383692, 43.647809] },
      { name: "King St West / Bay St", coords: [-79.379621, 43.648724] },
      { name: "King St West / Yonge St - King Station", coords: [-79.377256, 43.649232] },
      { name: "King St East / Church St", coords: [-79.373826, 43.649982] },
      { name: "King St West / Jarvis St", coords: [-79.371287, 43.650541] },
      { name: "King St East / Sherbourne St", coords: [-79.368367, 43.651169] },
      { name: "King St East / Ontario St", coords: [-79.366167, 43.651647] },
      { name: "Parliament St / Richmond St East", coords: [-79.363856, 43.654450] },
      { name: "Parliament St / Queen St East", coords: [-79.364271, 43.655432] },
      { name: "Queen St East / Sackville St", coords: [-79.361873, 43.656101] },
      { name: "Queen St East / Sumach St", coords: [-79.359007, 43.656738] },
      { name: "Queen St East / River St", coords: [-79.356674, 43.657255] },
      { name: "Queen St East / Broadview Ave", coords: [-79.350060, 43.658746] },
      { name: "Queen St East / Saulter St", coords: [-79.347097, 43.659402] },
      { name: "Queen St East / Empire Ave", coords: [-79.344501, 43.659991] },
      { name: "Queen St East / Logan Ave", coords: [-79.342681, 43.660394] },
      { name: "Queen St East / Carlaw Ave", coords: [-79.340208, 43.660953] },
      { name: "Queen St East / Pape Ave", coords: [-79.338074, 43.661429] },
      { name: "Queen St East / Caroline Ave", coords: [-79.335437, 43.662018] },
      { name: "Queen St East / Jones Ave", coords: [-79.332925, 43.662578] },
      { name: "Queen St East / Leslie St", coords: [-79.330376, 43.663143] },
      { name: "Queen St East / Alton Ave", coords: [-79.328109, 43.663648] },
      { name: "Queen St East / Greenwood Ave", coords: [-79.325493, 43.664281] },
      { name: "Queen St East / Woodfield Rd", coords: [-79.321530, 43.665141] },
      { name: "Queen St East / Emdaabiimok Ave", coords: [-79.316789, 43.666193] },
      { name: "Queen St East / Kingston Rd", coords: [-79.312948, 43.667029] },
      { name: "Kingston Rd / Dixon Ave", coords: [-79.311175, 43.669775] },
      { name: "Kingston Rd / Columbine Ave", coords: [-79.310310, 43.671380] },
      { name: "Kingston Rd / Woodbine Ave", coords: [-79.308088, 43.673673] },
      { name: "Kingston Rd / Elmer Ave", coords: [-79.306008, 43.675537] },
      { name: "Kingston Rd / Waverley Rd", coords: [-79.304185, 43.676824] },
      { name: "Kingston Rd / Lee Ave", coords: [-79.301308, 43.678012] },
      { name: "Kingston Rd / Southwood Dr", coords: [-79.298363, 43.678753] },
      { name: "Kingston Rd / Glen Manor Dr", coords: [-79.294644, 43.679631] },
      { name: "Kingston Rd / Beech Ave", coords: [-79.290892, 43.680164] },
      { name: "Kingston Rd / Scarborough Rd", coords: [-79.287193, 43.680468] },
      { name: "Kingston Rd / Victoria Park Ave", coords: [-79.284309, 43.680713] },
      { name: "Bingham Loop", coords: [-79.285000, 43.681460] },
    ],
  },
  {
    id: "streetcar-504",
    name: "King",
    shortName: "504",
    color: "#ED1C24",
    textColor: "#FFFFFF",
    type: "streetcar",
    description: "Streetcar along King St between Dundas West Loop and Distillery Loop.",
    frequency: "Every 5–10 min",
    stops: [
      { name: "Dundas West Station", coords: [-79.453463, 43.656821] },
      { name: "Edna Ave / Dundas St West", coords: [-79.453027, 43.657134] },
      { name: "Dundas St West / Bloor St West", coords: [-79.452572, 43.656442] },
      { name: "Roncesvalles Ave / Boustead Ave", coords: [-79.451670, 43.653079] },
      { name: "Roncesvalles Ave / Howard Park Ave", coords: [-79.450927, 43.650939] },
      { name: "Roncesvalles Ave / Grenadier Rd", coords: [-79.450121, 43.648885] },
      { name: "Roncesvalles Ave / High Park Blvd", coords: [-79.448985, 43.645921] },
      { name: "Roncesvalles Ave / Galley Ave", coords: [-79.447845, 43.642982] },
      { name: "Roncesvalles Ave / Marion St", coords: [-79.446945, 43.640654] },
      { name: "Roncesvalles Ave / Queen St West", coords: [-79.446287, 43.638925] },
      { name: "King St West / Wilson Park Rd", coords: [-79.442453, 43.636938] },
      { name: "King St West / Dowling Ave", coords: [-79.438719, 43.636552] },
      { name: "King St West / Jameson Ave", coords: [-79.436215, 43.637078] },
      { name: "King St West / Dunn Ave", coords: [-79.433376, 43.637647] },
      { name: "King St West / Spencer Ave", coords: [-79.430997, 43.638134] },
      { name: "King St West / Dufferin St", coords: [-79.427487, 43.638819] },
      { name: "King St West / Joe Shuster Way", coords: [-79.423721, 43.639591] },
      { name: "King St West / Atlantic Ave", coords: [-79.421415, 43.640051] },
      { name: "King St West / Sudbury St", coords: [-79.417479, 43.640853] },
      { name: "King St West / Shaw St", coords: [-79.415217, 43.641309] },
      { name: "King St West / Strachan Ave", coords: [-79.412095, 43.641936] },
      { name: "King St West / Niagara St", coords: [-79.407760, 43.642809] },
      { name: "King St West / Tecumseth St", coords: [-79.405362, 43.643296] },
      { name: "King St West / Bathurst St", coords: [-79.401815, 43.643990] },
      { name: "King St West / Portland St", coords: [-79.399504, 43.644458] },
      { name: "King St West / Spadina Ave", coords: [-79.394296, 43.645507] },
      { name: "King St West / Blue Jays Way", coords: [-79.391644, 43.646101] },
      { name: "King St West / John St", coords: [-79.389267, 43.646614] },
      { name: "King St West / York St - St Andrew Station", coords: [-79.383692, 43.647809] },
      { name: "King St West / Bay St", coords: [-79.379621, 43.648724] },
      { name: "King St West / Yonge St - King Station", coords: [-79.377256, 43.649232] },
      { name: "King St East / Church St", coords: [-79.373826, 43.649982] },
      { name: "King St West / Jarvis St", coords: [-79.371287, 43.650541] },
      { name: "King St East / Sherbourne St", coords: [-79.368367, 43.651169] },
      { name: "King St East / Ontario St", coords: [-79.366167, 43.651647] },
      { name: "King St East / Parliament St", coords: [-79.363371, 43.652556] },
      { name: "King St East / Sackville St", coords: [-79.360379, 43.654300] },
      { name: "King St East / Sumach St", coords: [-79.358705, 43.655280] },
      { name: "Cherry St / Front St East", coords: [-79.358092, 43.652840] },
      { name: "Distillery Loop", coords: [-79.356822, 43.650856] },
    ],
  },
  {
    id: "streetcar-505",
    name: "Dundas",
    shortName: "505",
    color: "#ED1C24",
    textColor: "#FFFFFF",
    type: "streetcar",
    description: "Streetcar along Dundas St West from Dundas West Loop to Broadview Station.",
    frequency: "Every 5–10 min",
    stops: [
      { name: "Dundas West Station", coords: [-79.453463, 43.656821] },
      { name: "Edna Ave / Dundas St West", coords: [-79.453027, 43.657134] },
      { name: "Dundas St West / Roncesvalles Ave", coords: [-79.451258, 43.653480] },
      { name: "Dundas St West / Howard Park Ave", coords: [-79.448522, 43.652232] },
      { name: "Dundas St West / Sorauren Ave", coords: [-79.445756, 43.651247] },
      { name: "Dundas St West / Sterling Rd", coords: [-79.443251, 43.650631] },
      { name: "Dundas St West / Lansdowne Ave", coords: [-79.440135, 43.650111] },
      { name: "Dundas St West / Brock Ave", coords: [-79.435721, 43.649826] },
      { name: "Dundas St West / Sheridan Ave", coords: [-79.433841, 43.649721] },
      { name: "Dundas St West / Dufferin St", coords: [-79.431565, 43.649587] },
      { name: "Dundas St West / Gladstone Ave", coords: [-79.429975, 43.649516] },
      { name: "Dundas St West / Lisgar St", coords: [-79.426882, 43.649434] },
      { name: "Dundas St West / Dovercourt Rd", coords: [-79.424889, 43.649365] },
      { name: "Dundas St West / Ossington Ave", coords: [-79.420944, 43.649270] },
      { name: "Dundas St West / Shaw St", coords: [-79.418489, 43.649703] },
      { name: "Dundas St West / Grace St", coords: [-79.414220, 43.650581] },
      { name: "Dundas St West / Manning Ave", coords: [-79.411029, 43.651197] },
      { name: "Dundas St West / Bathurst St - Toronto Western Hospital", coords: [-79.406259, 43.652163] },
      { name: "Dundas St West / Denison Ave", coords: [-79.402360, 43.651939] },
      { name: "Dundas St West / Spadina Ave", coords: [-79.398341, 43.652776] },
      { name: "Dundas St West / Beverley St", coords: [-79.393961, 43.653710] },
      { name: "Dundas St West / McCaul St", coords: [-79.391552, 43.654219] },
      { name: "Dundas St West / University Ave - St Patrick Station", coords: [-79.388742, 43.654679] },
      { name: "Dundas St West / Chestnut St", coords: [-79.386129, 43.655136] },
      { name: "Dundas St West / Bay St", coords: [-79.384014, 43.655582] },
      { name: "Dundas St West / Yonge St - TMU Station", coords: [-79.381190, 43.656190] },
      { name: "Dundas St East / Church St", coords: [-79.377358, 43.656371] },
      { name: "Dundas St East / Jarvis St", coords: [-79.374706, 43.656947] },
      { name: "Dundas St East / Sherbourne St", coords: [-79.371303, 43.658220] },
      { name: "Dundas St East / Ontario St", coords: [-79.368653, 43.658752] },
      { name: "Dundas St East / Parliament St", coords: [-79.366291, 43.659283] },
      { name: "Dundas St East / Regent Park Blvd", coords: [-79.361966, 43.660247] },
      { name: "Dundas St East / River St", coords: [-79.358286, 43.661093] },
      { name: "Dundas St East / Broadview Ave", coords: [-79.351814, 43.662249] },
      { name: "Broadview Ave / Mountstephen St", coords: [-79.351870, 43.663942] },
      { name: "Broadview Ave / Gerrard St East", coords: [-79.352444, 43.665274] },
      { name: "Broadview Ave / Langley Ave-Hennick Bridgepoint Hospital", coords: [-79.353308, 43.667664] },
      { name: "Broadview Ave / Withrow Ave", coords: [-79.353030, 43.669638] },
      { name: "Broadview Ave / Millbrook Cres", coords: [-79.354734, 43.671897] },
      { name: "Broadview Ave / Wolfrey Ave", coords: [-79.356904, 43.674192] },
      { name: "Broadview Ave / Danforth Ave", coords: [-79.358601, 43.676051] },
      { name: "Broadview",         coords: [-79.3588, 43.6767] },
    ],
  },
  {
    id: "streetcar-506",
    name: "Carlton",
    shortName: "506",
    color: "#ED1C24",
    textColor: "#FFFFFF",
    type: "streetcar",
    description: "Streetcar along Carlton/College St from High Park Loop to Main Street Station.",
    frequency: "Every 5–10 min",
    stops: [
      { name: "High Park Loop", coords: [-79.458045, 43.647681] },
      { name: "Howard Park Ave / Parkside Dr", coords: [-79.457394, 43.649054] },
      { name: "Howard Park Ave / Indian Rd", coords: [-79.455063, 43.650555] },
      { name: "Howard Park Ave / Roncesvalles Ave", coords: [-79.451176, 43.651426] },
      { name: "Howard Park Ave / Dundas St West", coords: [-79.448329, 43.651965] },
      { name: "Dundas St West / Sorauren Ave", coords: [-79.445756, 43.651247] },
      { name: "Dundas St West / Sterling Rd", coords: [-79.443251, 43.650631] },
      { name: "College St / Lansdowne Ave", coords: [-79.440227, 43.650681] },
      { name: "College St / Brock Ave", coords: [-79.436456, 43.651699] },
      { name: "College St / Dufferin St", coords: [-79.432660, 43.652456] },
      { name: "College St / Rusholme Park Cres", coords: [-79.429769, 43.652817] },
      { name: "College St / Dovercourt Rd", coords: [-79.426497, 43.653509] },
      { name: "College St / Ossington Ave", coords: [-79.422940, 43.654255] },
      { name: "College St / Crawford St", coords: [-79.419148, 43.655048] },
      { name: "College St / Grace St", coords: [-79.415821, 43.654902] },
      { name: "College St / Euclid Ave", coords: [-79.411450, 43.655597] },
      { name: "College St / Bathurst St", coords: [-79.407836, 43.656336] },
      { name: "College St / Borden St", coords: [-79.405276, 43.656855] },
      { name: "College St / Augusta Ave", coords: [-79.403252, 43.657240] },
      { name: "College St / Spadina Ave", coords: [-79.400435, 43.657863] },
      { name: "College St / Beverley St", coords: [-79.396368, 43.658547] },
      { name: "College St / McCaul St", coords: [-79.393721, 43.659061] },
      { name: "Dundas St West / University Ave - St Patrick Station", coords: [-79.388742, 43.654679] },
      { name: "Dundas St West / Bay St", coords: [-79.384014, 43.655582] },
      { name: "Dundas St West / Yonge St - TMU Station", coords: [-79.381190, 43.656190] },
      { name: "Dundas St East / Church St", coords: [-79.377358, 43.656371] },
      { name: "Dundas St East / Jarvis St", coords: [-79.374706, 43.656947] },
      { name: "Dundas St East / Sherbourne St", coords: [-79.371303, 43.658220] },
      { name: "Dundas St East / Ontario St", coords: [-79.368653, 43.658752] },
      { name: "Dundas St East / Parliament St", coords: [-79.366291, 43.659283] },
      { name: "Parliament St / Oak St", coords: [-79.366381, 43.660599] },
      { name: "Parliament St / Gerrard St East", coords: [-79.366812, 43.661708] },
      { name: "Gerrard St East / Sackville St", coords: [-79.364115, 43.662508] },
      { name: "Gerrard St East / Sumach St", coords: [-79.361596, 43.663061] },
      { name: "Gerrard St East / River St", coords: [-79.359334, 43.663559] },
      { name: "Gerrard St East / Blackburn St", coords: [-79.355383, 43.664667] },
      { name: "Gerrard St East / Broadview Ave", coords: [-79.352906, 43.665376] },
      { name: "Gerrard St East / De Grassi St", coords: [-79.348755, 43.666207] },
      { name: "Gerrard St East / Logan Ave", coords: [-79.345317, 43.666983] },
      { name: "Gerrard St East / Carlaw Ave", coords: [-79.342998, 43.667491] },
      { name: "Gerrard St East / Pape Ave", coords: [-79.340492, 43.668045] },
      { name: "Gerrard St East / Marjory Ave", coords: [-79.337632, 43.668684] },
      { name: "Gerrard St East / Jones Ave", coords: [-79.335780, 43.669085] },
      { name: "Gerrard St East / Leslie St", coords: [-79.333264, 43.669663] },
      { name: "Gerrard St East / Alton Ave", coords: [-79.330793, 43.670216] },
      { name: "Gerrard St East / Greenwood Ave", coords: [-79.328156, 43.670802] },
      { name: "Gerrard St East / Woodfield Rd", coords: [-79.324168, 43.671677] },
      { name: "Gerrard St East / Coxwell Ave", coords: [-79.319529, 43.672761] },
      { name: "Coxwell Ave / Gerrard St East", coords: [-79.320091, 43.675096] },
      { name: "Gerrard St East / Beaton Ave", coords: [-79.317086, 43.676047] },
      { name: "Gerrard St East / Bowmore Rd", coords: [-79.315075, 43.677874] },
      { name: "Gerrard St East / Kingsmount Park Rd", coords: [-79.312986, 43.679449] },
      { name: "Gerrard St East / Woodbine Ave", coords: [-79.310829, 43.680644] },
      { name: "Gerrard St East / Golfview Ave", coords: [-79.308860, 43.681652] },
      { name: "Gerrard St East / Glenmount Park Rd", coords: [-79.306185, 43.682547] },
      { name: "Gerrard St East / Norwood Rd", coords: [-79.303202, 43.683235] },
      { name: "Gerrard St East / Main St", coords: [-79.300386, 43.683838] },
      { name: "Main St / Danforth Ave - Danforth GO Station", coords: [-79.301635, 43.688037] },
      { name: "Main Street",         coords: [-79.3015, 43.6891] },
    ],
  },
  {
    id: "streetcar-507",
    name: "Long Branch",
    shortName: "507",
    color: "#ED1C24",
    textColor: "#FFFFFF",
    type: "streetcar",
    description: "Lakeshore streetcar from Long Branch GO Station to Humber Loop.",
    frequency: "Every 5–10 min",
    stops: [
      { name: "Long Branch Loop - Long Branch GO Station", coords: [-79.544124, 43.591811] },
      { name: "Lake Shore Blvd West / Thirty Seventh St", coords: [-79.538348, 43.593334] },
      { name: "Lake Shore Blvd West / Long Branch Ave", coords: [-79.534130, 43.594303] },
      { name: "Lake Shore Blvd West / Thirty First St", coords: [-79.530407, 43.595155] },
      { name: "Lake Shore Blvd West / Twenty Eighth St", coords: [-79.527699, 43.595685] },
      { name: "Lake Shore Blvd West / Twenty Seventh St", coords: [-79.525043, 43.596328] },
      { name: "Lake Shore Blvd West / Twenty Second St", coords: [-79.521413, 43.597116] },
      { name: "Lake Shore Blvd West / Colonel Samuel Smith Park Dr", coords: [-79.517179, 43.598047] },
      { name: "Lake Shore Blvd West / Thirteenth St", coords: [-79.511960, 43.599214] },
      { name: "Lake Shore Blvd West / Tenth St", coords: [-79.508796, 43.599877] },
      { name: "Lake Shore Blvd West / Seventh St", coords: [-79.505392, 43.600638] },
      { name: "Lake Shore Blvd West / Fifth St", coords: [-79.503113, 43.601151] },
      { name: "Lake Shore Blvd West / Third St", coords: [-79.500866, 43.601653] },
      { name: "Lake Shore Blvd West / First St", coords: [-79.498592, 43.602140] },
      { name: "Lake Shore Blvd West / Royal York Rd", coords: [-79.493189, 43.603544] },
      { name: "Lake Shore Blvd West / Miles Rd", coords: [-79.490239, 43.608194] },
      { name: "Lake Shore Blvd West / Norris Cres", coords: [-79.489952, 43.610819] },
      { name: "Lake Shore Blvd West / Mimico Ave", coords: [-79.489314, 43.613542] },
      { name: "Lake Shore Blvd West / Superior Ave", coords: [-79.488619, 43.614817] },
      { name: "Lake Shore Blvd West / Burlington St", coords: [-79.487284, 43.617151] },
      { name: "Lake Shore Blvd West / Louisa St", coords: [-79.486469, 43.618786] },
      { name: "Lake Shore Blvd West / Legion Rd", coords: [-79.483407, 43.620372] },
      { name: "Lake Shore Blvd West / Park Lawn Rd", coords: [-79.481308, 43.622780] },
      { name: "2155 Lake Shore Blvd West", coords: [-79.479741, 43.625705] },
      { name: "2111 Lake Shore Blvd West", coords: [-79.478151, 43.629066] },
      { name: "Humber Loop / The Queensway", coords: [-79.479051, 43.631050] },
    ],
  },
  {
    id: "streetcar-508",
    name: "Lake Shore",
    shortName: "508",
    color: "#ED1C24",
    textColor: "#FFFFFF",
    type: "streetcar",
    description: "Lakeshore express from Long Branch GO to Distillery Loop via King St.",
    frequency: "Every 5–10 min",
    stops: [
      { name: "Long Branch Loop - Long Branch GO Station", coords: [-79.544124, 43.591811] },
      { name: "Lake Shore Blvd West / Thirty Seventh St", coords: [-79.538348, 43.593334] },
      { name: "Lake Shore Blvd West / Long Branch Ave", coords: [-79.534130, 43.594303] },
      { name: "Lake Shore Blvd West / Thirty First St", coords: [-79.530407, 43.595155] },
      { name: "Lake Shore Blvd West / Twenty Eighth St", coords: [-79.527699, 43.595685] },
      { name: "Lake Shore Blvd West / Twenty Seventh St", coords: [-79.525043, 43.596328] },
      { name: "Lake Shore Blvd West / Twenty Second St", coords: [-79.521413, 43.597116] },
      { name: "Lake Shore Blvd West / Colonel Samuel Smith Park Dr", coords: [-79.517179, 43.598047] },
      { name: "Lake Shore Blvd West / Thirteenth St", coords: [-79.511960, 43.599214] },
      { name: "Lake Shore Blvd West / Tenth St", coords: [-79.508796, 43.599877] },
      { name: "Lake Shore Blvd West / Seventh St", coords: [-79.505392, 43.600638] },
      { name: "Lake Shore Blvd West / Fifth St", coords: [-79.503113, 43.601151] },
      { name: "Lake Shore Blvd West / Third St", coords: [-79.500866, 43.601653] },
      { name: "Lake Shore Blvd West / First St", coords: [-79.498592, 43.602140] },
      { name: "Lake Shore Blvd West / Royal York Rd", coords: [-79.493189, 43.603544] },
      { name: "Lake Shore Blvd West / Miles Rd", coords: [-79.490239, 43.608194] },
      { name: "Lake Shore Blvd West / Norris Cres", coords: [-79.489952, 43.610819] },
      { name: "Lake Shore Blvd West / Mimico Ave", coords: [-79.489314, 43.613542] },
      { name: "Lake Shore Blvd West / Superior Ave", coords: [-79.488619, 43.614817] },
      { name: "Lake Shore Blvd West / Burlington St", coords: [-79.487284, 43.617151] },
      { name: "Lake Shore Blvd West / Louisa St", coords: [-79.486469, 43.618786] },
      { name: "Lake Shore Blvd West / Legion Rd", coords: [-79.483407, 43.620372] },
      { name: "Lake Shore Blvd West / Park Lawn Rd", coords: [-79.481308, 43.622780] },
      { name: "2155 Lake Shore Blvd West", coords: [-79.479741, 43.625705] },
      { name: "2111 Lake Shore Blvd West", coords: [-79.478151, 43.629066] },
      { name: "Humber Loop / The Queensway", coords: [-79.478505, 43.631194] },
      { name: "The Queensway / South Kingsway", coords: [-79.473052, 43.635819] },
      { name: "The Queensway / Windermere Ave", coords: [-79.469205, 43.637256] },
      { name: "The Queensway / Ellis Ave", coords: [-79.465682, 43.637929] },
      { name: "The Queensway / Colborne Lodge Dr", coords: [-79.458635, 43.639566] },
      { name: "The Queensway / Parkside Dr", coords: [-79.453923, 43.639665] },
      { name: "The Queensway / Glendale Ave - St Joseph's Health Centre", coords: [-79.450773, 43.639168] },
      { name: "King St West / The Queensway", coords: [-79.445925, 43.638355] },
      { name: "King St West / Wilson Park Rd", coords: [-79.442453, 43.636938] },
      { name: "King St West / Dowling Ave", coords: [-79.438719, 43.636552] },
      { name: "King St West / Jameson Ave", coords: [-79.436215, 43.637078] },
      { name: "King St West / Dunn Ave", coords: [-79.433376, 43.637647] },
      { name: "King St West / Spencer Ave", coords: [-79.430997, 43.638134] },
      { name: "King St West / Dufferin St", coords: [-79.427487, 43.638819] },
      { name: "King St West / Joe Shuster Way", coords: [-79.423721, 43.639591] },
      { name: "King St West / Atlantic Ave", coords: [-79.421415, 43.640051] },
      { name: "King St West / Sudbury St", coords: [-79.417479, 43.640853] },
      { name: "King St West / Shaw St", coords: [-79.415217, 43.641309] },
      { name: "King St West / Strachan Ave", coords: [-79.412095, 43.641936] },
      { name: "King St West / Niagara St", coords: [-79.407760, 43.642809] },
      { name: "King St West / Tecumseth St", coords: [-79.405362, 43.643296] },
      { name: "King St West / Bathurst St", coords: [-79.401815, 43.643990] },
      { name: "King St West / Portland St", coords: [-79.399504, 43.644458] },
      { name: "King St West / Spadina Ave", coords: [-79.394296, 43.645507] },
      { name: "King St West / Blue Jays Way", coords: [-79.391644, 43.646101] },
      { name: "King St West / John St", coords: [-79.389267, 43.646614] },
      { name: "King St West / York St - St Andrew Station", coords: [-79.383692, 43.647809] },
      { name: "King St West / Bay St", coords: [-79.379621, 43.648724] },
      { name: "King St West / Yonge St - King Station", coords: [-79.377256, 43.649232] },
      { name: "King St East / Church St", coords: [-79.373826, 43.649982] },
      { name: "King St West / Jarvis St", coords: [-79.371287, 43.650541] },
      { name: "King St East / Sherbourne St", coords: [-79.368367, 43.651169] },
      { name: "King St East / Ontario St", coords: [-79.366167, 43.651647] },
      { name: "King St East / Parliament St", coords: [-79.363371, 43.652556] },
      { name: "King St East / Sackville St", coords: [-79.360379, 43.654300] },
      { name: "King St East / Sumach St", coords: [-79.358705, 43.655280] },
      { name: "Cherry St / Front St East", coords: [-79.358092, 43.652840] },
      { name: "Distillery Loop", coords: [-79.356822, 43.650856] },
    ],
  },
  {
    id: "streetcar-509",
    name: "Harbourfront",
    shortName: "509",
    color: "#ED1C24",
    textColor: "#FFFFFF",
    type: "streetcar",
    description: "Harbourfront streetcar from Exhibition Place to Union Station.",
    frequency: "Every 5–10 min",
    stops: [
      { name: "Exhibition Loop / Manitoba Dr", coords: [-79.414710, 43.636511] },
      { name: "Manitoba Dr / Strachan Ave", coords: [-79.410145, 43.636172] },
      { name: "Fleet St / Fort York Blvd", coords: [-79.406278, 43.636256] },
      { name: "Fleet St / Bastion St", coords: [-79.403771, 43.635850] },
      { name: "Fleet St / Bathurst St", coords: [-79.400131, 43.636470] },
      { name: "Queens Quay West / Bathurst St Billy Bishop Airport", coords: [-79.397767, 43.636048] },
      { name: "Queens Quay West / Dan Leckie Way", coords: [-79.396172, 43.636798] },
      { name: "Queens Quay West / Lower Spadina Ave", coords: [-79.391176, 43.637757] },
      { name: "Queens Quay West / Rees St", coords: [-79.386798, 43.638746] },
      { name: "Queens Quay West / Harbourfront Centre", coords: [-79.381765, 43.639613] },
      { name: "Queens Quay / Ferry Docks Station", coords: [-79.377186, 43.641806] },
      { name: "Union Station", coords: [-79.379210, 43.645652] },
    ],
  },
  {
    id: "streetcar-510",
    name: "Spadina",
    shortName: "510",
    color: "#ED1C24",
    textColor: "#FFFFFF",
    type: "streetcar",
    description: "Spadina streetcar from Spadina Station south to Union Station via the waterfront.",
    frequency: "Every 5–10 min",
    stops: [
      { name: "Spadina Station", coords: [-79.403665, 43.667221] },
      { name: "Spadina Ave / Sussex Ave", coords: [-79.402616, 43.664224] },
      { name: "Spadina Ave / Harbord St", coords: [-79.401984, 43.662648] },
      { name: "Spadina Ave / Willcocks St", coords: [-79.401512, 43.661450] },
      { name: "Spadina Ave / College St", coords: [-79.399868, 43.657372] },
      { name: "Spadina Ave / Nassau St", coords: [-79.399077, 43.655393] },
      { name: "Spadina Ave / Dundas St West", coords: [-79.397924, 43.652480] },
      { name: "Spadina Ave / Sullivan St", coords: [-79.397338, 43.651021] },
      { name: "Spadina Ave / Queen St West", coords: [-79.396223, 43.648220] },
      { name: "Spadina Ave / King St West", coords: [-79.395169, 43.645671] },
      { name: "Spadina Ave / Front St West", coords: [-79.394028, 43.642934] },
      { name: "Spadina Ave / Bremner Blvd", coords: [-79.393172, 43.640814] },
      { name: "Queens Quay West / Lower Spadina Ave", coords: [-79.391176, 43.637757] },
      { name: "Queens Quay West / Rees St", coords: [-79.386798, 43.638746] },
      { name: "Queens Quay West / Harbourfront Centre", coords: [-79.381765, 43.639613] },
      { name: "Queens Quay / Ferry Docks Station", coords: [-79.377186, 43.641806] },
      { name: "Union Station", coords: [-79.379210, 43.645652] },
    ],
  },
  {
    id: "streetcar-511",
    name: "Bathurst",
    shortName: "511",
    color: "#ED1C24",
    textColor: "#FFFFFF",
    type: "streetcar",
    description: "Bathurst streetcar from Bathurst Station south to Exhibition Place.",
    frequency: "Every 5–10 min",
    stops: [
      { name: "Bathurst",         coords: [-79.4114, 43.6658] },
      { name: "Bathurst St / Bloor St West", coords: [-79.411347, 43.665235] },
      { name: "Bathurst St / Lennox St", coords: [-79.410809, 43.663902] },
      { name: "Bathurst St / Harbord St", coords: [-79.409887, 43.661614] },
      { name: "Bathurst St / Ulster St", coords: [-79.409188, 43.659869] },
      { name: "Bathurst St / College St", coords: [-79.407861, 43.656632] },
      { name: "Bathurst St / Nassau St - Toronto Western Hospital", coords: [-79.406946, 43.654353] },
      { name: "Bathurst St / Dundas St West - Toronto Western Hospital", coords: [-79.406185, 43.652475] },
      { name: "Bathurst St / Robinson St", coords: [-79.404830, 43.649099] },
      { name: "Bathurst St / Queen St West", coords: [-79.404131, 43.647375] },
      { name: "Bathurst St / King St West", coords: [-79.402833, 43.644139] },
      { name: "Bathurst St / Niagara St", coords: [-79.401977, 43.642032] },
      { name: "Bathurst St / Fort York Blvd", coords: [-79.400771, 43.638947] },
      { name: "Fleet St / Bathurst St", coords: [-79.400545, 43.636420] },
      { name: "Fleet St / Bastion St", coords: [-79.404148, 43.635968] },
      { name: "Fleet St / Fort York Blvd", coords: [-79.407397, 43.636422] },
      { name: "Manitoba Dr / Strachan Ave", coords: [-79.410411, 43.636300] },
      { name: "Exhibition Loop", coords: [-79.415373, 43.636331] },
    ],
  },
  {
    id: "streetcar-512",
    name: "St Clair",
    shortName: "512",
    color: "#ED1C24",
    textColor: "#FFFFFF",
    type: "streetcar",
    description: "St Clair streetcar from Gunns Loop west to St Clair Station.",
    frequency: "Every 5–10 min",
    stops: [
      { name: "Gunns Loop / St Clair Ave West", coords: [-79.471837, 43.671912] },
      { name: "St Clair Ave West / Old Stock Yards Rd", coords: [-79.470488, 43.671859] },
      { name: "St Clair Ave West / Keele St / Weston Rd", coords: [-79.467842, 43.672451] },
      { name: "St Clair Ave West / Old Weston Rd", coords: [-79.462439, 43.673599] },
      { name: "St Clair Ave West / Hounslow Heath Rd", coords: [-79.459436, 43.674274] },
      { name: "St Clair Ave West / Laughton Ave", coords: [-79.457079, 43.674790] },
      { name: "St Clair Ave West / Caledonia Rd", coords: [-79.454201, 43.675437] },
      { name: "St Clair Ave West / Lansdowne Ave", coords: [-79.450021, 43.676353] },
      { name: "St Clair Ave West / Earlscourt Ave", coords: [-79.446847, 43.677045] },
      { name: "St Clair Ave West / Dufferin St", coords: [-79.442476, 43.678011] },
      { name: "St Clair Ave West / Northcliffe Blvd", coords: [-79.440298, 43.678485] },
      { name: "St Clair Ave West / Glenholme Ave", coords: [-79.438072, 43.678985] },
      { name: "St Clair Ave West / Oakwood Ave", coords: [-79.435070, 43.679661] },
      { name: "St Clair Ave West / Winona Dr", coords: [-79.431948, 43.680326] },
      { name: "St Clair Ave West / Arlington Ave", coords: [-79.428315, 43.681096] },
      { name: "St Clair Ave West / Christie St", coords: [-79.425152, 43.681758] },
      { name: "St Clair Ave West / Wychwood Ave", coords: [-79.422895, 43.682189] },
      { name: "St Clair Ave West / Vaughan Rd", coords: [-79.419348, 43.682875] },
      { name: "St Clair Ave West / Bathurst St", coords: [-79.417671, 43.683213] },
      { name: "St Clair West",         coords: [-79.4156, 43.6845] },
      { name: "St Clair Ave West / Tweedsmuir Ave", coords: [-79.413336, 43.684084] },
      { name: "St Clair Ave West / Spadina Rd", coords: [-79.410569, 43.684699] },
      { name: "St Clair Ave West / Russell Hill Rd", coords: [-79.407321, 43.685403] },
      { name: "St Clair Ave West / Dunvegan Rd", coords: [-79.404757, 43.685922] },
      { name: "St Clair Ave West / Avenue Rd", coords: [-79.400882, 43.686666] },
      { name: "St Clair Ave West / Deer Park Cres", coords: [-79.397451, 43.687341] },
      { name: "St Clair",         coords: [-79.3933, 43.6881] },
    ],
  },
];

// ─── AI-Generated Route Suggestions ─────────────────────────────────────────

// The 211 generated routes now live in generated-routes.json rather than in
// this module.
//
// 📖 Learn: a .json import compiles to a JSON.parse() call, which engines parse
// substantially faster than an equivalent JavaScript object literal — and
// TypeScript stops typechecking 10,000 lines of data on every build. Needs
// "resolveJsonModule" in tsconfig (already on).
//
// The array is deliberately MIXED: 3 fully-specified GeneratedRoutes (which
// carry `stats`) plus 208 plain bus Routes (which don't). It used to be
// annotated GeneratedRoute[], and since that type requires `stats`, all 208 bus
// entries failed it — the single cause of this file's 208 typecheck errors.
// Route[] is the honest common shape; the 3 richer entries still satisfy it.
const RAW_GENERATED_ROUTES = GENERATED_ROUTES_DATA as unknown as Route[];

// Stamp stop ids once, at module load. Everything below/outside consumes the
// id'd versions — the RAW_* literals are never exported.
export const ROUTES: Route[] = withPositionalStopIds(RAW_ROUTES);
export const GENERATED_ROUTES: Route[] = withPositionalStopIds(RAW_GENERATED_ROUTES);

// Bus routes were added to GENERATED_ROUTES but should be treated as regular routes
export const BUS_ROUTES: Route[] = GENERATED_ROUTES.filter((r) => r.type === "bus");

// ─── GO Train Lines (Metrolinx / GO Transit) ─────────────────────────────────
// Station coordinates from GTFS variant_stops.json (GO Transit GTFS feed).
// Shape geometry loaded at runtime from /gotransit/go-rail-shapes.geojson via _variantId.

const RAW_GO_TRAIN_ROUTES: Route[] = [
  {
    id: "go-barrie",
    name: "Barrie",
    shortName: "BR",
    color: "#00853F",
    textColor: "#ffffff",
    type: "go_train",
    description: "Allandale Waterfront (Barrie) to Union Station",
    frequency: "See schedule",
    _variantId: "BRA",
    stops: [
      { name: "Union", coords: [-79.3806, 43.645195] },
      { name: "Downsview Park", coords: [-79.47835, 43.7536333] },
      { name: "Rutherford", coords: [-79.498819, 43.838487] },
      { name: "Maple", coords: [-79.506984, 43.859481] },
      { name: "King City", coords: [-79.526886, 43.920037] },
      { name: "Aurora", coords: [-79.459725, 44.000758] },
      { name: "Newmarket", coords: [-79.459289, 44.060426] },
      { name: "East Gwillimbury", coords: [-79.455776, 44.077996] },
      { name: "Bradford", coords: [-79.555394, 44.116513] },
      { name: "Barrie South", coords: [-79.627441, 44.35112] },
      { name: "Allandale Waterfront", coords: [-79.687858, 44.374139] },
    ],
  },
  {
    id: "go-kitchener",
    name: "Kitchener",
    shortName: "KI",
    color: "#00853F",
    textColor: "#ffffff",
    type: "go_train",
    description: "Kitchener to Union Station via Guelph, Georgetown and Brampton",
    frequency: "See schedule",
    _variantId: "KIH",
    stops: [
      { name: "Union", coords: [-79.3806, 43.645195] },
      { name: "Bloor", coords: [-79.450192, 43.656928] },
      { name: "Mount Dennis", coords: [-79.48703, 43.68749] },
      { name: "Weston", coords: [-79.514671, 43.70022] },
      { name: "Etobicoke North", coords: [-79.563506, 43.706172] },
      { name: "Malton", coords: [-79.63823, 43.705153] },
      { name: "Bramalea", coords: [-79.6887512, 43.7022591] },
      { name: "Brampton Innovation District", coords: [-79.7628632, 43.6869087] },
      { name: "Mount Pleasant", coords: [-79.8221817, 43.6749763] },
      { name: "Georgetown", coords: [-79.919054, 43.655373] },
      { name: "Acton", coords: [-80.034111, 43.6338043] },
      { name: "Guelph Central", coords: [-80.246917, 43.544353] },
      { name: "Kitchener", coords: [-80.49313, 43.455686] },
    ],
  },
  {
    id: "go-lakeshore-east",
    name: "Lakeshore East",
    shortName: "LE",
    color: "#00853F",
    textColor: "#ffffff",
    type: "go_train",
    description: "Oshawa to Union Station via Whitby, Ajax and Pickering",
    frequency: "See schedule",
    _variantId: "LEA",
    stops: [
      { name: "Union", coords: [-79.3806, 43.645195] },
      { name: "Danforth", coords: [-79.300358, 43.686462] },
      { name: "Scarborough", coords: [-79.254722, 43.716945] },
      { name: "Eglinton", coords: [-79.23231, 43.739621] },
      { name: "Guildwood", coords: [-79.198252, 43.755272] },
      { name: "Rouge Hill", coords: [-79.130646, 43.780375] },
      { name: "Pickering", coords: [-79.084594, 43.831576] },
      { name: "Ajax", coords: [-79.041372, 43.847766] },
      { name: "Whitby", coords: [-78.93818, 43.86484] },
      { name: "Durham College Oshawa", coords: [-78.884807, 43.871004] },
    ],
  },
  {
    id: "go-lakeshore-west",
    name: "Lakeshore West",
    shortName: "LW",
    color: "#00853F",
    textColor: "#ffffff",
    type: "go_train",
    description: "West Harbour (Hamilton) to Union Station via Burlington and Oakville",
    frequency: "See schedule",
    _variantId: "LWC",
    stops: [
      { name: "Union", coords: [-79.3806, 43.645195] },
      { name: "Exhibition", coords: [-79.418927, 43.635549] },
      { name: "Mimico", coords: [-79.497762, 43.616411] },
      { name: "Long Branch", coords: [-79.546149, 43.591317] },
      { name: "Port Credit", coords: [-79.586881, 43.555999] },
      { name: "Clarkson", coords: [-79.633206, 43.513127] },
      { name: "Oakville", coords: [-79.682242, 43.455594] },
      { name: "Bronte", coords: [-79.722294, 43.416774] },
      { name: "Appleby", coords: [-79.760991, 43.379429] },
      { name: "Burlington", coords: [-79.809141, 43.341265] },
      { name: "Aldershot", coords: [-79.855659, 43.313385] },
      { name: "West Harbour", coords: [-79.866222, 43.266775] },
    ],
  },
  {
    id: "go-milton",
    name: "Milton",
    shortName: "MI",
    color: "#00853F",
    textColor: "#ffffff",
    type: "go_train",
    description: "Milton to Union Station via Mississauga",
    frequency: "See schedule",
    _variantId: "MIA",
    stops: [
      { name: "Union", coords: [-79.3806, 43.645195] },
      { name: "Kipling", coords: [-79.536287, 43.636955] },
      { name: "Dixie", coords: [-79.577762, 43.608022] },
      { name: "Cooksville", coords: [-79.623695, 43.582973] },
      { name: "Erindale", coords: [-79.668506, 43.567235] },
      { name: "Streetsville", coords: [-79.70882, 43.575584] },
      { name: "Meadowvale", coords: [-79.754328, 43.597566] },
      { name: "Lisgar", coords: [-79.788539, 43.590791] },
      { name: "Milton", coords: [-79.867172, 43.52364] },
    ],
  },
  {
    id: "go-richmond-hill",
    name: "Richmond Hill",
    shortName: "RH",
    color: "#00853F",
    textColor: "#ffffff",
    type: "go_train",
    description: "Bloomington to Union Station via Richmond Hill",
    frequency: "See schedule",
    _variantId: "RHA",
    stops: [
      { name: "Union", coords: [-79.3806, 43.645195] },
      { name: "Oriole", coords: [-79.364275, 43.765518] },
      { name: "Old Cummer", coords: [-79.371403, 43.793703] },
      { name: "Langstaff", coords: [-79.423139, 43.838546] },
      { name: "Richmond Hill", coords: [-79.426167, 43.874307] },
      { name: "Gormley", coords: [-79.399033, 43.941617] },
      { name: "Bloomington", coords: [-79.397258, 43.975949] },
    ],
  },
  {
    id: "go-stouffville",
    name: "Stouffville",
    shortName: "ST",
    color: "#00853F",
    textColor: "#ffffff",
    type: "go_train",
    description: "Old Elm to Union Station via Stouffville and Markham",
    frequency: "See schedule",
    _variantId: "STC",
    stops: [
      { name: "Union", coords: [-79.3806, 43.645195] },
      { name: "Kennedy", coords: [-79.262706, 43.733045] },
      { name: "Agincourt", coords: [-79.284385, 43.78611] },
      { name: "Milliken", coords: [-79.301785, 43.823227] },
      { name: "Unionville", coords: [-79.314332, 43.851689] },
      { name: "Centennial", coords: [-79.289211, 43.873601] },
      { name: "Markham", coords: [-79.262469, 43.882691] },
      { name: "Mount Joy", coords: [-79.26313, 43.900521] },
      { name: "Stouffville", coords: [-79.249989, 43.970924] },
      { name: "Old Elm", coords: [-79.237098, 43.990395] },
    ],
  },
];

export const GO_TRAIN_ROUTES: Route[] = withPositionalStopIds(RAW_GO_TRAIN_ROUTES);

// ─── Pedestrian Connections ───────────────────────────────────────────────────
// Pairs of stops on different routes that are physically the same station
// but tracked as separate nodes, connected by an in-station walkway.

export type PedestrianConnection = {
  routeAId: string;
  stopAName: string;
  routeBId: string;
  stopBName: string;
};

export const PEDESTRIAN_CONNECTIONS: PedestrianConnection[] = [
  { routeAId: "line-1", stopAName: "Spadina", routeBId: "line-2", stopBName: "Spadina" },
  { routeAId: "streetcar-510", stopAName: "Spadina Station", routeBId: "line-2", stopBName: "Spadina" },
];
