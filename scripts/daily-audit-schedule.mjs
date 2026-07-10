export function shouldRunDailyAudit({ now = new Date(), timezone, hour, minute, lastRunKey = null }) {
  const parts = zonedParts(now, timezone);
  const runKey = `${parts.date}:${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const scheduledTimeReached = parts.hour > hour || (parts.hour === hour && parts.minute >= minute);
  return {
    runKey,
    shouldRun: scheduledTimeReached && lastRunKey !== runKey
  };
}

function zonedParts(now, timezone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  const values = Object.fromEntries(formatter.formatToParts(now)
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, part.value]));

  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    minute: Number(values.minute)
  };
}
