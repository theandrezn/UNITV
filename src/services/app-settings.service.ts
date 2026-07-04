import "server-only";
import { AppSettingsRepository } from "@/repositories/app-settings.repository";
import { getServerEnv } from "@/lib/env";

export class AppSettingsService {
  constructor(private readonly appSettingsRepository = new AppSettingsRepository()) {}

  async getPaymentInstructions(planSlug?: string) {
    const envInstructions = getServerEnv().PAYMENT_INSTRUCTIONS;
    const setting = envInstructions?.trim()
      ? null
      : await this.appSettingsRepository.getSetting("payment_instructions");
    const value = setting?.value as { text?: unknown } | string | null | undefined;
    const baseInstructions = envInstructions?.trim() || readTextValue(value);
    const paymentLinksSetting = await this.appSettingsRepository.getSetting("payment_links");
    const paymentLinks = readPaymentLinks(paymentLinksSetting?.value);
    const selectedLink = planSlug ? paymentLinks[planSlug] : null;

    if (selectedLink?.checkout_url) {
      return `${baseInstructions || defaultInstructions()}\n\nCartao (${selectedLink.label || planSlug}):\n${selectedLink.checkout_url}`;
    }

    if (Object.keys(paymentLinks).length) {
      return `${baseInstructions || defaultInstructions()}\n\nCartao: me diga qual plano voce quer para eu enviar o link correto.`;
    }

    return baseInstructions || defaultInstructions();
  }
}

type PaymentLink = { checkout_url?: string; label?: string };

function readTextValue(value: { text?: unknown } | string | null | undefined) {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  if (value && typeof value === "object" && typeof value.text === "string" && value.text.trim()) {
    return value.text.trim();
  }

  return "";
}

function readPaymentLinks(value: unknown): Record<string, PaymentLink> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const plans = (value as { plans?: unknown }).plans;
  if (!plans || typeof plans !== "object" || Array.isArray(plans)) {
    return {};
  }

  return plans as Record<string, PaymentLink>;
}

function defaultInstructions() {
  return "Pagamento sob orientacao manual. Envie o comprovante por aqui apos pagar.";
}
