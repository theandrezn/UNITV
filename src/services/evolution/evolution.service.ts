import "server-only";
import { EvolutionClient } from "@/lib/evolution/client";

export class EvolutionService {
  constructor(private readonly evolutionClient = new EvolutionClient()) {}

  sendTextMessage(input: { phone: string; text: string }) {
    return this.evolutionClient.sendTextMessage(input);
  }

  getMediaBase64(input: { externalMessageId: string }) {
    return this.evolutionClient.getMediaBase64(input);
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

  sendListMessage(input: {
    phone: string;
    title: string;
    description: string;
    buttonText: string;
    footerText: string;
    sections: Array<{
      title: string;
      rows: Array<{ title: string; description: string; rowId: string }>;
    }>;
  }) {
    return this.evolutionClient.sendListMessage(input);
  }

  sendButtonMessage(input: {
    phone: string;
    title: string;
    description: string;
    footerText: string;
    buttons: Array<{ id: string; displayText: string }>;
  }) {
    return this.evolutionClient.sendButtonMessage(input);
  }

  getInstanceStatus() {
    return this.evolutionClient.getInstanceStatus();
  }
}
