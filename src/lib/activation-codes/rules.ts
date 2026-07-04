import { activationCodeStatusSchema } from "@/types/domain";

export function canReserveActivationCode(status: string | null | undefined) {
  return activationCodeStatusSchema.safeParse(status).success && status === "available";
}
