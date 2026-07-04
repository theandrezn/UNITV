import "server-only";
import { OrdersRepository } from "@/repositories/orders.repository";
import { orderSchema, orderStatusSchema, type Order } from "@/types/domain";

export class OrdersService {
  constructor(private readonly ordersRepository = new OrdersRepository()) {}

  createOrder(data: Order) {
    return this.ordersRepository.createOrder(orderSchema.parse(data));
  }

  findOrderById(id: string) {
    return this.ordersRepository.findOrderById(id);
  }

  findOrderByOrderNumber(orderNumber: string) {
    return this.ordersRepository.findOrderByOrderNumber(orderNumber);
  }

  updateOrderStatus(orderId: string, status: string) {
    return this.ordersRepository.updateOrderStatus(orderId, orderStatusSchema.parse(status));
  }
}
