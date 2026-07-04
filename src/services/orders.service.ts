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

  updateOrder(orderId: string, data: Partial<Order>) {
    return this.ordersRepository.updateOrder(orderId, data);
  }

  transitionToPaid(orderId: string, paidAt: string, paymentReference: string) {
    return this.ordersRepository.transitionToPaid(orderId, paidAt, paymentReference);
  }

  transitionStatus(orderId: string, fromStatuses: string[], toStatus: string, data: Partial<Order> = {}) {
    return this.ordersRepository.transitionStatus(
      orderId,
      fromStatuses.map((status) => orderStatusSchema.parse(status)),
      orderStatusSchema.parse(toStatus),
      data
    );
  }

  findLatestOpenOrderByCustomerId(customerId: string) {
    return this.ordersRepository.findLatestOpenOrderByCustomerId(customerId);
  }

  listRecentOrders(limit?: number) {
    return this.ordersRepository.listRecentOrders(limit);
  }

  listOrdersByStatuses(statuses: string[], limit?: number) {
    return this.ordersRepository.listOrdersByStatuses(statuses.map((status) => orderStatusSchema.parse(status)), limit);
  }
}
