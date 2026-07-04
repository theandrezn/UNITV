import "server-only";
import { AppSettingsRepository } from "@/repositories/app-settings.repository";
import { getServerEnv } from "@/lib/env";

export class AppSettingsService {
  constructor(private readonly appSettingsRepository = new AppSettingsRepository()) {}

  async getPaymentInstructions() {
    const envInstructions = getServerEnv().PAYMENT_INSTRUCTIONS;
    if (envInstructions?.trim()) {
      return envInstructions.trim();
    }

    const setting = await this.appSettingsRepository.getSetting("payment_instructions");
    const value = setting?.value as { text?: unknown } | string | null | undefined;

    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }

    if (value && typeof value === "object" && typeof value.text === "string" && value.text.trim()) {
      return value.text.trim();
    }

    return "Pagamento sob orientacao manual. Envie o comprovante por aqui apos pagar.";
  }
}
