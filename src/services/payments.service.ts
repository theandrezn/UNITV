import "server-only";
import { PaymentsRepository } from "@/repositories/payments.repository";
import { paymentSchema, type Payment } from "@/types/domain";

export class PaymentsService {
  constructor(private readonly paymentsRepository = new PaymentsRepository()) {}

  upsertProviderPayment(data: Payment) {
    return this.paymentsRepository.upsertProviderPayment(paymentSchema.parse(data));
  }
}
