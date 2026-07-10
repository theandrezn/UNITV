export type DailyAuditScheduleInput = {
  now?: Date;
  timezone?: string;
  hour: number;
  minute: number;
  lastRunKey?: string | null;
};

export function shouldRunDailyAudit(input: DailyAuditScheduleInput): {
  runKey: string;
  shouldRun: boolean;
};
