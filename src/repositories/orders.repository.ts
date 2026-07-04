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
    const { data, error } = await this.supabase.from("orders").select("*").eq("id", id).maybeSingle();
    return assertSupabaseSuccess(data, error);
  }

  async findOrderByOrderNumber(orderNumber: string) {
    const { data, error } = await this.supabase
      .from("orders")
      .select("*")
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
}
