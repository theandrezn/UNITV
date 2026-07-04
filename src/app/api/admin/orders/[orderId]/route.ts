import { NextRequest, NextResponse } from "next/server";
import { requireAdminApiKey } from "@/lib/admin/auth";
import { OrdersService } from "@/services/orders.service";
import { orderStatusSchema } from "@/types/domain";

export const dynamic = "force-dynamic";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ orderId: string }> }) {
  const unauthorized = requireAdminApiKey(request);
  if (unauthorized) return unauthorized;

  const { orderId } = await params;
  const body = (await request.json()) as { status?: string; notes?: string; metadata?: Record<string, unknown> };
  const status = orderStatusSchema.parse(body.status);
  const order = await new OrdersService().updateOrder(orderId, {
    status,
    notes: body.notes,
    metadata: body.metadata || {}
  });

  return NextResponse.json({ status: "ok", order });
}
