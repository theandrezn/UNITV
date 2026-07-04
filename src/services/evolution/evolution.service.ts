import "server-only";
import { EvolutionClient } from "@/lib/evolution/client";

export class EvolutionService {
  constructor(private readonly evolutionClient = new EvolutionClient()) {}

  sendTextMessage(input: { phone: string; text: string }) {
    return this.evolutionClient.sendTextMessage(input);
  }

  sendMediaMessage(input: {
    phone: string;
    base64: string;
    mimetype: string;
    fileName: string;
    caption: string;
  }) {
    return this.evolutionClient.sendMediaMessage(input);
  }

  getInstanceStatus() {
    return this.evolutionClient.getInstanceStatus();
  }
}
