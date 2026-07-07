import "server-only";
import { ActivationCodesRepository } from "@/repositories/activation-codes.repository";

export class ActivationCodesService {
  constructor(private readonly activationCodesRepository = new ActivationCodesRepository()) {}

  countAvailableCodes(productId: string, planId?: string | null) {
    return this.activationCodesRepository.countAvailableCodes(productId, planId);
  }

  findAvailableCode(productId: string, planId?: string | null) {
    return this.activationCodesRepository.findAvailableCode(productId, planId);
  }

  findAvailableCodes(productId: string, planId: string | null | undefined, limit: number) {
    return this.activationCodesRepository.findAvailableCodes(productId, planId, limit);
  }

  reserveCode(codeId: string, orderId: string, customerId: string) {
    return this.activationCodesRepository.reserveCode(codeId, orderId, customerId);
  }

  markCodeAsSent(codeId: string) {
    return this.activationCodesRepository.markCodeAsSent(codeId);
  }

  releaseReservedCodesForOrder(orderId: string, codeIds: string[]) {
    return this.activationCodesRepository.releaseReservedCodesForOrder(orderId, codeIds);
  }
}
