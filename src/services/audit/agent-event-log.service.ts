import "server-only";
import {
  AgentEventLogsRepository,
  type CreateAgentEventLogInput
} from "@/repositories/agent-event-logs.repository";

export class AgentEventLogService {
  constructor(private readonly repository = new AgentEventLogsRepository()) {}

  async createEvent(input: CreateAgentEventLogInput) {
    return this.repository.createEvent(input);
  }

  async safeCreateEvent(input: CreateAgentEventLogInput) {
    try {
      return await this.createEvent(input);
    } catch {
      return null;
    }
  }
}
