/**
 * Go-live dates are handled as plain calendar dates ("2026-08-21"), never as
 * instants. A launch day is a day on a calendar, and treating it as a timestamp
 * is how you end up telling a client Thursday when the team meant Friday.
 *
 * The only place a timezone matters is resolving relative words ("tomorrow",
 * "Monday") and reading Trello date fields, which store a UTC instant. Both are
 * resolved against the *team's* timezone, because the team member setting the
 * card is the one who meant a particular day.
 */

const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

const WEEKDAY_ALIASES = new Map([
  ['sun', 0], ['sunday', 0],
  ['mon', 1], ['monday', 1],
  ['tue', 2], ['tues', 2], ['tuesday', 2],
  ['wed', 3], ['weds', 3], ['wednesday', 3],
  ['thu', 4], ['thur', 4], ['thurs', 4], ['thursday', 4],
  ['fri', 5], ['friday', 5],
  ['sat', 6], ['saturday', 6],
]);

const MONTHS = new Map([
  ['jan', 1], ['january', 1],
  ['feb', 2], ['february', 2],
  ['mar', 3], ['march', 3],
  ['apr', 4], ['april', 4],
  ['may', 5],
  ['jun', 6], ['june', 6],
  ['jul', 7], ['july', 7],
  ['aug', 8], ['august', 8],
  ['sep', 9], ['sept', 9], ['september', 9],
  ['oct', 10], ['october', 10],
  ['nov', 11], ['november', 11],
  ['dec', 12], ['december', 12],
]);

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The calendar date it currently is in `timezone`, as YYYY-MM-DD. */
export function todayInZone(timezone, now = new Date()) {
  // en-CA renders as YYYY-MM-DD, which is exactly the shape we want.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function toParts(ymd) {
  const match = YMD.exec(ymd);
  if (!match) throw new Error(`Not a calendar date: ${ymd}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function fromParts(year, month, day) {
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.toISOString().slice(0, 10);
}

export function addDays(ymd, days) {
  const { year, month, day } = toParts(ymd);
  return fromParts(year, month, day + days);
}

/** 0 = Sunday .. 6 = Saturday */
export function weekdayIndex(ymd) {
  const { year, month, day } = toParts(ymd);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function daysBetween(fromYmd, toYmd) {
  const a = toParts(fromYmd);
  const b = toParts(toYmd);
  const ms =
    Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day);
  return Math.round(ms / 86400000);
}

/** Next occurrence of `weekday` strictly after `fromYmd`. */
function nextWeekday(fromYmd, weekday) {
  const current = weekdayIndex(fromYmd);
  const delta = ((weekday - current + 7) % 7) || 7;
  return addDays(fromYmd, delta);
}

/**
 * Pick the year for a date written without one ("8/21", "Aug 21"). Anything
 * that would land more than a week in the past is assumed to mean next year.
 */
function resolveYearless(month, day, todayYmd) {
  const thisYear = toParts(todayYmd).year;
  const candidate = fromParts(thisYear, month, day);
  if (daysBetween(todayYmd, candidate) >= -7) return candidate;
  return fromParts(thisYear + 1, month, day);
}

/**
 * Parse whatever the Trello card (or a human) gave us into a calendar date.
 * Returns null for empty input; throws with a readable message otherwise.
 */
export function parseGoLive(input, { timezone, now = new Date() } = {}) {
  if (input === null || input === undefined) return null;
  const raw = String(input).trim();
  if (!raw) return null;

  const today = todayInZone(timezone, now);
  const text = raw.toLowerCase().replace(/\s+/g, ' ');

  // Already a plain calendar date.
  if (YMD.test(raw)) return raw;

  // Trello date custom fields and due dates arrive as full ISO instants.
  if (/^\d{4}-\d{2}-\d{2}t/i.test(raw)) {
    const instant = new Date(raw);
    if (Number.isNaN(instant.getTime())) {
      throw new Error(`Could not read "${raw}" as a date.`);
    }
    return todayInZone(timezone, instant);
  }

  if (text === 'today') return today;
  if (text === 'tomorrow' || text === 'tmr' || text === 'tmrw') {
    return addDays(today, 1);
  }
  if (text === 'day after tomorrow') return addDays(today, 2);

  // "monday", "next monday", "this friday"
  const weekdayMatch = /^(?:next |this |on )?([a-z]+)$/.exec(text);
  if (weekdayMatch && WEEKDAY_ALIASES.has(weekdayMatch[1])) {
    return nextWeekday(today, WEEKDAY_ALIASES.get(weekdayMatch[1]));
  }

  // "8/21", "08/21/2026", "8-21-26"
  const numeric = /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2}|\d{4}))?$/.exec(text);
  if (numeric) {
    const month = Number(numeric[1]);
    const day = Number(numeric[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) {
      throw new Error(`"${raw}" is not a valid month/day.`);
    }
    if (numeric[3]) {
      const year = numeric[3].length === 2 ? 2000 + Number(numeric[3]) : Number(numeric[3]);
      return fromParts(year, month, day);
    }
    return resolveYearless(month, day, today);
  }

  // "aug 21", "august 21 2026", "21 august"
  const monthFirst = /^([a-z]+)\.? (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?$/.exec(text);
  const dayFirst = /^(\d{1,2})(?:st|nd|rd|th)? ([a-z]+)\.?(?:,? (\d{4}))?$/.exec(text);
  const named = monthFirst
    ? { month: monthFirst[1], day: Number(monthFirst[2]), year: monthFirst[3] }
    : dayFirst
      ? { month: dayFirst[2], day: Number(dayFirst[1]), year: dayFirst[3] }
      : null;
  if (named && MONTHS.has(named.month)) {
    const month = MONTHS.get(named.month);
    if (named.year) return fromParts(Number(named.year), month, named.day);
    return resolveYearless(month, named.day, today);
  }

  throw new Error(
    `Could not read "${raw}" as a go-live date. Use a date like 2026-08-21, 8/21, "Aug 21", "Friday", or "tomorrow".`,
  );
}

/** "Friday, August 21, 2026" */
export function formatLong(ymd) {
  const { year, month, day } = toParts(ymd);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

/** "Fri, Aug 21" */
export function formatShort(ymd) {
  const { year, month, day } = toParts(ymd);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

export function weekdayName(ymd) {
  const name = WEEKDAYS[weekdayIndex(ymd)];
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** "today" / "tomorrow" / "in 3 days" / "3 days ago" — for the review embed. */
export function relativeLabel(ymd, todayYmd) {
  const delta = daysBetween(todayYmd, ymd);
  if (delta === 0) return 'today';
  if (delta === 1) return 'tomorrow';
  if (delta === -1) return 'yesterday';
  if (delta > 1) return `in ${delta} days`;
  return `${Math.abs(delta)} days ago`;
}

export function isWeekend(ymd) {
  const index = weekdayIndex(ymd);
  return index === 0 || index === 6;
}
