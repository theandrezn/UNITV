import "server-only";
import { AppSettingsRepository } from "@/repositories/app-settings.repository";
import { getServerEnv } from "@/lib/env";

export class AppSettingsService {
  constructor(private readonly appSettingsRepository = new AppSettingsRepository()) {}

  async getPixInstructions() {
    const envInstructions = getServerEnv().PAYMENT_INSTRUCTIONS;
    const setting = envInstructions?.trim()
      ? null
      : await this.appSettingsRepository.getSetting("payment_instructions");
    const value = setting?.value as { text?: unknown } | string | null | undefined;
    const baseInstructions = envInstructions?.trim() || readTextValue(value);
    return baseInstructions || defaultInstructions();
  }

  getPaymentInstructions() {
    return this.getPixInstructions();
  }
}

function readTextValue(value: { text?: unknown } | string | null | undefined) {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  if (value && typeof value === "object" && typeof value.text === "string" && value.text.trim()) {
    return value.text.trim();
  }

  return "";
}

function defaultInstructions() {
  return "Pagamento sob orientação manual. Envie o comprovante por aqui após pagar.";
}
