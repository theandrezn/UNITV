import "server-only";
import { ReceiptsRepository } from "@/repositories/receipts.repository";
import { receiptSchema, type Receipt } from "@/types/domain";

export class ReceiptsService {
  constructor(private readonly receiptsRepository = new ReceiptsRepository()) {}

  createReceipt(data: Receipt) {
    return this.receiptsRepository.createReceipt(receiptSchema.parse(data));
  }
}
