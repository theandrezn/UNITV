import "server-only";
import { AgentActionsRepository } from "@/repositories/agent-actions.repository";
import { agentActionSchema, type AgentAction } from "@/types/domain";

export class AgentActionsService {
  constructor(private readonly agentActionsRepository = new AgentActionsRepository()) {}

  createAgentAction(data: AgentAction) {
    return this.agentActionsRepository.createAgentAction(agentActionSchema.parse(data));
  }
}
