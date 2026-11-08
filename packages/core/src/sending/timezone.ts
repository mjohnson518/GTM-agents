// GTM-agents: the recipient's time zone, for the recipient-local send window.
//
// In order:
//   1. the contact's own `timezone`, when it is a valid IANA name;
//   2. its free-text `location`:
//      a. a location that names the United States, Canada or Australia goes to that country's
//         regional rules (states, provinces, large cities), with the business capital's zone when
//         no region matches;
//      b. any other named country maps to one representative zone (multi-zone countries use the
//         zone of their main business city);
//      c. with no country named, US cities and states, then well-known international cities;
//   3. the default (America/New_York unless the deployment passes another).
// Matching is on whole words after case and accent folding, so "Zurich" and "Zürich" agree and
// "Indiana" never reads as India. Ambiguous names are left out on purpose: "Georgia" is far more
// often the US state than the country, and "Mexico" never matches "New Mexico". The window only
// needs the hour, so a representative zone per region is enough.

export const DEFAULT_TIMEZONE = "America/New_York";

export type TimezoneSource = "contact" | "country" | "region" | "city" | "default";

const validity = new Map<string, boolean>();

/** True when `tz` is an IANA time zone the runtime knows. */
export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  const known = validity.get(tz);
  if (known !== undefined) return known;
  let ok: boolean;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    ok = true;
  } catch {
    ok = false;
  }
  validity.set(tz, ok);
  return ok;
}

type Rule = readonly [names: readonly string[], timezone: string];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
const compile = (rules: readonly Rule[]): ReadonlyArray<readonly [RegExp, string]> =>
  rules.map(([names, tz]) => [new RegExp(`(?:^|[^a-z0-9])(?:${names.map(escape).join("|")})(?:$|[^a-z0-9])`), tz] as const);

/** Countries with one zone, or one zone that most of their business runs on. */
const COUNTRIES = compile([
  [["united kingdom", "uk", "u.k.", "great britain", "britain", "england", "scotland", "wales", "northern ireland"], "Europe/London"],
  [["ireland", "eire"], "Europe/Dublin"],
  [["portugal"], "Europe/Lisbon"],
  [["spain", "espana"], "Europe/Madrid"],
  [["france"], "Europe/Paris"],
  [["belgium", "belgique", "belgie"], "Europe/Brussels"],
  [["netherlands", "the netherlands", "holland", "nederland"], "Europe/Amsterdam"],
  [["luxembourg"], "Europe/Luxembourg"],
  [["germany", "deutschland"], "Europe/Berlin"],
  [["switzerland", "schweiz", "suisse"], "Europe/Zurich"],
  [["austria", "osterreich"], "Europe/Vienna"],
  [["italy", "italia"], "Europe/Rome"],
  [["malta"], "Europe/Malta"],
  [["denmark", "danmark"], "Europe/Copenhagen"],
  [["norway", "norge"], "Europe/Oslo"],
  [["sweden", "sverige"], "Europe/Stockholm"],
  [["finland", "suomi"], "Europe/Helsinki"],
  [["iceland"], "Atlantic/Reykjavik"],
  [["estonia"], "Europe/Tallinn"],
  [["latvia"], "Europe/Riga"],
  [["lithuania"], "Europe/Vilnius"],
  [["poland", "polska"], "Europe/Warsaw"],
  [["czech republic", "czechia"], "Europe/Prague"],
  [["slovakia"], "Europe/Bratislava"],
  [["hungary"], "Europe/Budapest"],
  [["slovenia"], "Europe/Ljubljana"],
  [["croatia"], "Europe/Zagreb"],
  [["serbia"], "Europe/Belgrade"],
  [["bosnia"], "Europe/Sarajevo"],
  [["romania"], "Europe/Bucharest"],
  [["bulgaria"], "Europe/Sofia"],
  [["greece"], "Europe/Athens"],
  [["cyprus"], "Asia/Nicosia"],
  [["ukraine"], "Europe/Kyiv"],
  [["moldova"], "Europe/Chisinau"],
  [["turkey", "turkiye"], "Europe/Istanbul"],
  [["russia", "russian federation"], "Europe/Moscow"],
  [["israel"], "Asia/Jerusalem"],
  [["lebanon"], "Asia/Beirut"],
  [["jordan"], "Asia/Amman"],
  [["saudi arabia", "ksa"], "Asia/Riyadh"],
  [["united arab emirates", "uae", "u.a.e."], "Asia/Dubai"],
  [["qatar"], "Asia/Qatar"],
  [["bahrain"], "Asia/Bahrain"],
  [["kuwait"], "Asia/Kuwait"],
  [["oman"], "Asia/Muscat"],
  [["egypt"], "Africa/Cairo"],
  [["morocco"], "Africa/Casablanca"],
  [["tunisia"], "Africa/Tunis"],
  [["nigeria"], "Africa/Lagos"],
  [["ghana"], "Africa/Accra"],
  [["senegal"], "Africa/Dakar"],
  [["kenya"], "Africa/Nairobi"],
  [["ethiopia"], "Africa/Addis_Ababa"],
  [["rwanda"], "Africa/Kigali"],
  [["uganda"], "Africa/Kampala"],
  [["tanzania"], "Africa/Dar_es_Salaam"],
  [["south africa"], "Africa/Johannesburg"],
  [["mauritius"], "Indian/Mauritius"],
  [["india"], "Asia/Kolkata"],
  [["pakistan"], "Asia/Karachi"],
  [["bangladesh"], "Asia/Dhaka"],
  [["sri lanka"], "Asia/Colombo"],
  [["nepal"], "Asia/Kathmandu"],
  [["china", "prc", "people's republic of china"], "Asia/Shanghai"],
  [["hong kong", "hk sar"], "Asia/Hong_Kong"],
  [["taiwan"], "Asia/Taipei"],
  [["japan"], "Asia/Tokyo"],
  [["south korea", "korea", "republic of korea"], "Asia/Seoul"],
  [["singapore"], "Asia/Singapore"],
  [["malaysia"], "Asia/Kuala_Lumpur"],
  [["indonesia"], "Asia/Jakarta"],
  [["philippines"], "Asia/Manila"],
  [["thailand"], "Asia/Bangkok"],
  [["vietnam", "viet nam"], "Asia/Ho_Chi_Minh"],
  [["new zealand", "aotearoa"], "Pacific/Auckland"],
  [["brazil", "brasil"], "America/Sao_Paulo"],
  [["argentina"], "America/Argentina/Buenos_Aires"],
  [["chile"], "America/Santiago"],
  [["uruguay"], "America/Montevideo"],
  [["paraguay"], "America/Asuncion"],
  [["peru"], "America/Lima"],
  [["colombia"], "America/Bogota"],
  [["ecuador"], "America/Guayaquil"],
  [["venezuela"], "America/Caracas"],
  [["costa rica"], "America/Costa_Rica"],
  [["panama"], "America/Panama"],
  [["guatemala"], "America/Guatemala"],
  [["dominican republic"], "America/Santo_Domingo"],
  [["puerto rico"], "America/Puerto_Rico"],
  [["jamaica"], "America/Jamaica"],
  [["cayman islands"], "America/Cayman"],
  [["bermuda"], "Atlantic/Bermuda"],
]);

const MEXICO = /(?:^|[^a-z0-9])(?:mexico|cdmx)(?:$|[^a-z0-9])/;
const NEW_MEXICO = /(?:^|[^a-z0-9])new\s+mexico(?:$|[^a-z0-9])/;
const SAYS_US = /(?:^|[^a-z0-9])(?:united states(?: of america)?|usa|u\.s\.a?\.?|us)(?:$|[^a-z0-9])/;
const SAYS_CANADA = /(?:^|[^a-z0-9])canada(?:$|[^a-z0-9])/;
const SAYS_AUSTRALIA = /(?:^|[^a-z0-9])australia(?:$|[^a-z0-9])/;

/** US cities first (more specific), then state names, then two-letter state codes after a comma. */
const US_CITIES = compile([
  [["san francisco", "sf bay area", "bay area", "silicon valley", "palo alto", "mountain view", "menlo park", "sunnyvale", "san jose", "oakland", "berkeley", "los angeles", "santa monica", "san diego", "irvine", "sacramento", "seattle", "bellevue", "redmond", "las vegas"], "America/Los_Angeles"],
  [["phoenix", "scottsdale", "tempe", "tucson"], "America/Phoenix"],
  [["denver", "boulder", "salt lake city", "provo", "albuquerque", "boise"], "America/Denver"],
  [["chicago", "austin", "dallas", "houston", "san antonio", "minneapolis", "st. louis", "saint louis", "kansas city", "nashville", "new orleans", "milwaukee", "madison", "oklahoma city", "omaha"], "America/Chicago"],
  [["new york", "new york city", "nyc", "brooklyn", "manhattan", "boston", "washington dc", "washington, dc", "washington d.c.", "philadelphia", "pittsburgh", "baltimore", "atlanta", "miami", "tampa", "orlando", "charlotte", "raleigh", "durham", "detroit", "columbus", "cleveland", "indianapolis"], "America/New_York"],
  [["anchorage"], "America/Anchorage"],
  [["honolulu"], "Pacific/Honolulu"],
]);

const US_STATES = compile([
  [["california", "washington state", "oregon", "nevada"], "America/Los_Angeles"],
  [["arizona"], "America/Phoenix"],
  [["colorado", "utah", "new mexico", "montana", "wyoming", "idaho"], "America/Denver"],
  [["texas", "illinois", "minnesota", "missouri", "wisconsin", "iowa", "tennessee", "alabama", "louisiana", "arkansas", "oklahoma", "kansas", "nebraska", "mississippi", "north dakota", "south dakota"], "America/Chicago"],
  [["new york state", "massachusetts", "connecticut", "new jersey", "pennsylvania", "virginia", "west virginia", "maryland", "delaware", "north carolina", "south carolina", "florida", "ohio", "michigan", "indiana", "kentucky", "maine", "new hampshire", "vermont", "rhode island", "district of columbia"], "America/New_York"],
  [["alaska"], "America/Anchorage"],
  [["hawaii"], "Pacific/Honolulu"],
]);

const US_CODES: ReadonlyArray<readonly [RegExp, string]> = [
  [/,\s*(?:ca|wa|or|nv)\b/, "America/Los_Angeles"],
  [/,\s*az\b/, "America/Phoenix"],
  [/,\s*(?:co|ut|nm|mt|wy|id)\b/, "America/Denver"],
  [/,\s*(?:tx|il|mn|mo|wi|ia|tn|al|la|ar|ok|ks|ne|ms|nd|sd)\b/, "America/Chicago"],
  [/,\s*(?:ny|ma|ct|nj|pa|va|wv|md|de|nc|sc|ga|fl|oh|mi|in|ky|me|nh|vt|ri|dc)\b/, "America/New_York"],
  [/,\s*ak\b/, "America/Anchorage"],
  [/,\s*hi\b/, "Pacific/Honolulu"],
];

const CANADA = compile([
  [["vancouver", "victoria", "british columbia"], "America/Vancouver"],
  [["calgary", "edmonton", "alberta"], "America/Edmonton"],
  [["saskatoon", "regina", "saskatchewan"], "America/Regina"],
  [["winnipeg", "manitoba"], "America/Winnipeg"],
  [["halifax", "nova scotia", "new brunswick", "prince edward island"], "America/Halifax"],
  [["st. john's", "newfoundland"], "America/St_Johns"],
]);

const AUSTRALIA = compile([
  [["perth", "western australia"], "Australia/Perth"],
  [["adelaide", "south australia"], "Australia/Adelaide"],
  [["darwin", "northern territory"], "Australia/Darwin"],
  [["brisbane", "gold coast", "queensland"], "Australia/Brisbane"],
  [["melbourne", "victoria"], "Australia/Melbourne"],
  [["hobart", "tasmania"], "Australia/Hobart"],
]);

/** Well-known cities, for a location that names a city and no country. */
const CITIES = compile([
  [["london", "manchester", "edinburgh", "glasgow", "bristol", "leeds", "oxford"], "Europe/London"],
  [["dublin", "cork"], "Europe/Dublin"],
  [["lisbon", "lisboa", "porto"], "Europe/Lisbon"],
  [["madrid", "barcelona", "valencia", "seville"], "Europe/Madrid"],
  [["paris", "lyon", "marseille", "toulouse"], "Europe/Paris"],
  [["brussels", "antwerp", "ghent"], "Europe/Brussels"],
  [["amsterdam", "rotterdam", "utrecht", "eindhoven", "the hague"], "Europe/Amsterdam"],
  [["berlin", "munich", "munchen", "hamburg", "frankfurt", "cologne", "koln", "stuttgart", "dusseldorf"], "Europe/Berlin"],
  [["zurich", "geneva", "basel", "lausanne", "zug"], "Europe/Zurich"],
  [["vienna", "wien"], "Europe/Vienna"],
  [["milan", "milano", "rome", "roma", "turin", "torino"], "Europe/Rome"],
  [["copenhagen"], "Europe/Copenhagen"],
  [["oslo"], "Europe/Oslo"],
  [["stockholm", "gothenburg"], "Europe/Stockholm"],
  [["helsinki"], "Europe/Helsinki"],
  [["tallinn"], "Europe/Tallinn"],
  [["warsaw", "warszawa", "krakow"], "Europe/Warsaw"],
  [["prague"], "Europe/Prague"],
  [["budapest"], "Europe/Budapest"],
  [["bucharest"], "Europe/Bucharest"],
  [["athens"], "Europe/Athens"],
  [["kyiv", "kiev"], "Europe/Kyiv"],
  [["istanbul", "ankara"], "Europe/Istanbul"],
  [["moscow", "saint petersburg"], "Europe/Moscow"],
  [["tel aviv", "jerusalem", "haifa"], "Asia/Jerusalem"],
  [["dubai", "abu dhabi"], "Asia/Dubai"],
  [["riyadh", "jeddah"], "Asia/Riyadh"],
  [["doha"], "Asia/Qatar"],
  [["cairo"], "Africa/Cairo"],
  [["lagos", "abuja"], "Africa/Lagos"],
  [["nairobi"], "Africa/Nairobi"],
  [["cape town", "johannesburg"], "Africa/Johannesburg"],
  [["mumbai", "bombay", "bangalore", "bengaluru", "delhi", "new delhi", "gurgaon", "gurugram", "noida", "hyderabad", "chennai", "pune", "kolkata"], "Asia/Kolkata"],
  [["karachi", "lahore"], "Asia/Karachi"],
  [["beijing", "shanghai", "shenzhen", "hangzhou", "guangzhou"], "Asia/Shanghai"],
  [["taipei"], "Asia/Taipei"],
  [["tokyo", "osaka", "kyoto"], "Asia/Tokyo"],
  [["seoul"], "Asia/Seoul"],
  [["kuala lumpur"], "Asia/Kuala_Lumpur"],
  [["jakarta"], "Asia/Jakarta"],
  [["manila", "makati"], "Asia/Manila"],
  [["bangkok"], "Asia/Bangkok"],
  [["ho chi minh city", "saigon", "hanoi"], "Asia/Ho_Chi_Minh"],
  [["sydney"], "Australia/Sydney"],
  [["auckland", "wellington"], "Pacific/Auckland"],
  [["toronto", "ottawa", "montreal", "waterloo"], "America/Toronto"],
  [["mexico city", "guadalajara", "monterrey"], "America/Mexico_City"],
  [["sao paulo", "rio de janeiro"], "America/Sao_Paulo"],
  [["buenos aires"], "America/Argentina/Buenos_Aires"],
  [["santiago de chile"], "America/Santiago"],
  [["bogota", "medellin"], "America/Bogota"],
  [["lima"], "America/Lima"],
]);

/** Lowercase, accents folded, whitespace collapsed. */
function fold(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

const firstMatch = (rules: ReadonlyArray<readonly [RegExp, string]>, text: string): string | undefined => rules.find(([re]) => re.test(text))?.[1];

/** The zone a free-text location points at, or null when nothing in it is recognized. */
export function timezoneFromLocation(location: string | null | undefined): { timezone: string; source: Exclude<TimezoneSource, "contact" | "default"> } | null {
  if (typeof location !== "string") return null;
  const text = fold(location.slice(0, 200));
  if (text.length === 0) return null;
  if (SAYS_US.test(text)) {
    const tz = firstMatch(US_CITIES, text) ?? firstMatch(US_STATES, text) ?? firstMatch(US_CODES, text);
    return tz ? { timezone: tz, source: "region" } : { timezone: "America/New_York", source: "country" };
  }
  if (SAYS_CANADA.test(text)) {
    const tz = firstMatch(CANADA, text);
    return tz ? { timezone: tz, source: "region" } : { timezone: "America/Toronto", source: "country" };
  }
  if (SAYS_AUSTRALIA.test(text)) {
    const tz = firstMatch(AUSTRALIA, text);
    return tz ? { timezone: tz, source: "region" } : { timezone: "Australia/Sydney", source: "country" };
  }
  if (MEXICO.test(text) && !NEW_MEXICO.test(text)) return { timezone: "America/Mexico_City", source: "country" };
  const country = firstMatch(COUNTRIES, text);
  if (country) return { timezone: country, source: "country" };
  const us = firstMatch(US_CITIES, text) ?? firstMatch(US_STATES, text) ?? firstMatch(US_CODES, text);
  if (us) return { timezone: us, source: "region" };
  const city = firstMatch(CITIES, text);
  return city ? { timezone: city, source: "city" } : null;
}

/** The recipient's zone: the contact's own, else inferred from its location, else the default. */
export function recipientTimezone(
  contact: { timezone?: string | null; location?: string | null } | null | undefined,
  fallback: string = DEFAULT_TIMEZONE,
): { timezone: string; source: TimezoneSource } {
  const own = contact?.timezone?.trim();
  if (own && isValidTimezone(own)) return { timezone: own, source: "contact" };
  const inferred = timezoneFromLocation(contact?.location);
  if (inferred && isValidTimezone(inferred.timezone)) return inferred;
  return { timezone: isValidTimezone(fallback) ? fallback : DEFAULT_TIMEZONE, source: "default" };
}
