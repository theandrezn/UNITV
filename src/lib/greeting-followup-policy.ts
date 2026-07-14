export const GREETING_FOLLOWUP_POLICY_VERSION = "greeting_zero_token_v1";
export const GREETING_FIRST_FOLLOWUP_DELAY_MS = 30 * 60 * 1000;
export const GREETING_MAX_FOLLOWUPS = 2;
export const GREETING_FIRST_MESSAGE = "Você quer fazer o teste grátis de 3 dias ou conhecer os planos?";
export const GREETING_SECOND_MESSAGE = "Se ainda tiver interesse, posso te ajudar por aqui. Quer fazer o teste grátis?";

const BUSINESS_TIME_ZONE = "America/Sao_Paulo";
const BUSINESS_OPEN_HOUR = 9;
const BUSINESS_CLOSE_HOUR = 20;
const BUSINESS_CLOSE_MINUTE = 30;
const SECOND_FOLLOWUP_HOUR = 10;

type LocalDateTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export function buildGreetingFollowupMessage(step: number) {
  return step <= 1 ? GREETING_FIRST_MESSAGE : GREETING_SECOND_MESSAGE;
}

export function isGreetingBusinessHours(now: Date) {
  const local = getLocalDateTime(now);
  const minutes = local.hour * 60 + local.minute;
  return minutes >= BUSINESS_OPEN_HOUR * 60 && minutes <= BUSINESS_CLOSE_HOUR * 60 + BUSINESS_CLOSE_MINUTE;
}

export function getNextGreetingBusinessOpening(now: Date) {
  const local = getLocalDateTime(now);
  const minutes = local.hour * 60 + local.minute;
  if (minutes < BUSINESS_OPEN_HOUR * 60) {
    return zonedDateTimeToUtc({ ...local, hour: BUSINESS_OPEN_HOUR, minute: 0, second: 0 });
  }

  const nextDay = addLocalDays(local, 1);
  return zonedDateTimeToUtc({ ...nextDay, hour: BUSINESS_OPEN_HOUR, minute: 0, second: 0 });
}

export function getNextGreetingRecoveryDueAt(stepJustSent: number, now: Date) {
  if (stepJustSent >= GREETING_MAX_FOLLOWUPS) return null;
  const nextDay = addLocalDays(getLocalDateTime(now), 1);
  return zonedDateTimeToUtc({ ...nextDay, hour: SECOND_FOLLOWUP_HOUR, minute: 0, second: 0 }).toISOString();
}

function getLocalDateTime(date: Date): LocalDateTime {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value || 0);
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second")
  };
}

function addLocalDays(value: LocalDateTime, days: number): LocalDateTime {
  const date = new Date(Date.UTC(value.year, value.month - 1, value.day + days, value.hour, value.minute, value.second));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: value.hour,
    minute: value.minute,
    second: value.second
  };
}

function zonedDateTimeToUtc(target: LocalDateTime) {
  const targetTimestamp = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute, target.second);
  let guess = targetTimestamp;
  for (let attempt = 0; attempt < 3; attempt++) {
    const actual = getLocalDateTime(new Date(guess));
    const actualTimestamp = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    guess += targetTimestamp - actualTimestamp;
  }
  return new Date(guess);
}
