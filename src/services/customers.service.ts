import "server-only";
import { CustomersRepository } from "@/repositories/customers.repository";
import { customerSchema, type Customer } from "@/types/domain";

export class CustomersService {
  constructor(private readonly customersRepository = new CustomersRepository()) {}

  findCustomerByPhone(phone: string) {
    return this.customersRepository.findCustomerByPhone(phone);
  }

  createCustomer(data: Customer) {
    return this.customersRepository.createCustomer(customerSchema.parse(data));
  }

  upsertCustomerByPhone(data: Customer) {
    return this.customersRepository.upsertCustomerByPhone(customerSchema.parse(data));
  }
}
