import "server-only";
import { AuditLogsRepository } from "@/repositories/audit-logs.repository";
import { auditLogSchema, type AuditLog } from "@/types/domain";

export class AuditService {
  constructor(private readonly auditLogsRepository = new AuditLogsRepository()) {}

  createAuditLog(data: AuditLog) {
    return this.auditLogsRepository.createAuditLog(auditLogSchema.parse(data));
  }
}
