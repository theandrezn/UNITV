import "server-only";
import { EvolutionClient } from "@/lib/evolution/client";

export class EvolutionService {
  constructor(private readonly evolutionClient = new EvolutionClient()) {}

  sendTextMessage(input: { phone: string; text: string }) {
    return this.evolutionClient.sendTextMessage(input);
  }

  getInstanceStatus() {
    return this.evolutionClient.getInstanceStatus();
  }
}
