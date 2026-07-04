import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import type { Order } from "@/types/domain";
import { assertSupabaseSuccess } from "./errors";

export class OrdersRepository {
  constructor(private readonly supabase: SupabaseClient = createSupabaseAdminClient()) {}

  async createOrder(data: Order) {
    const { data: order, error } = await this.supabase.from("orders").insert(data).select("*").single();
    return assertSupabaseSuccess(order, error);
  }

  async findOrderById(id: string) {
    const { data, error } = await this.supabase
      .from("orders")
      .select("*, customers(id, phone), plans(id, name, slug)")
      .eq("id", id)
      .maybeSingle();
    return assertSupabaseSuccess(data, error);
  }

  async findOrderByOrderNumber(orderNumber: string) {
    const { data, error } = await this.supabase
      .from("orders")
      .select("*, customers(id, phone), plans(id, name, slug)")
      .eq("order_number", orderNumber)
      .maybeSingle();
    return assertSupabaseSuccess(data, error);
  }

  async updateOrderStatus(orderId: string, status: string) {
    const { data, error } = await this.supabase
      .from("orders")
      .update({ status })
      .eq("id", orderId)
      .select("*")
      .single();
    return assertSupabaseSuccess(data, error);
  }

  async updateOrder(orderId: string, data: Partial<Order>) {
    const { data: order, error } = await this.supabase.from("orders").update(data).eq("id", orderId).select("*").single();
    return assertSupabaseSuccess(order, error);
  }

  async transitionToPaid(orderId: string, paidAt: string, paymentReference: string) {
    const { data, error } = await this.supabase
      .from("orders")
      .update({
        status: "paid",
        paid_at: paidAt,
        payment_provider: "mercado_pago",
        payment_reference: paymentReference
      })
      .eq("id", orderId)
      .in("status", ["pending_payment", "receipt_under_review", "manual_review"])
      .select("*, customers(id, phone), plans(id, name, slug)")
      .maybeSingle();

    return assertSupabaseSuccess(data, error);
  }

  async transitionStatus(
    orderId: string,
    fromStatuses: string[],
    toStatus: string,
    data: Partial<Order> = {}
  ) {
    const { data: order, error } = await this.supabase
      .from("orders")
      .update({ ...data, status: toStatus })
      .eq("id", orderId)
      .in("status", fromStatuses)
      .select("*, customers(id, phone), plans(id, name, slug)")
      .maybeSingle();

    return assertSupabaseSuccess(order, error);
  }

  async findLatestOpenOrderByCustomerId(customerId: string) {
    const { data, error } = await this.supabase
      .from("orders")
      .select("*, plans(id, name, slug)")
      .eq("customer_id", customerId)
      .in("status", ["draft", "pending_payment", "manual_review", "receipt_under_review"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    return assertSupabaseSuccess(data, error);
  }

  async listRecentOrders(limit = 50) {
    const { data, error } = await this.supabase
      .from("orders")
      .select("*, customers(id, name, phone), plans(id, name, slug, duration_days, price_cents, currency)")
      .order("created_at", { ascending: false })
      .limit(limit);

    return assertSupabaseSuccess(data || [], error);
  }

  async listOrdersByStatuses(statuses: string[], limit = 50) {
    const { data, error } = await this.supabase
      .from("orders")
      .select("*, customers(id, name, phone), plans(id, name, slug, duration_days, price_cents, currency)")
      .in("status", statuses)
      .order("created_at", { ascending: false })
      .limit(limit);

    return assertSupabaseSuccess(data || [], error);
  }
}
