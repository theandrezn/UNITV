import { NextRequest, NextResponse } from "next/server";
import { requireAdminApiKey } from "@/lib/admin/auth";
import { OrdersService } from "@/services/orders.service";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const unauthorized = requireAdminApiKey(request);
  if (unauthorized) return unauthorized;

  const limit = Number(request.nextUrl.searchParams.get("limit") || 50);
  const orders = await new OrdersService().listOrdersByStatuses(
    ["manual_review", "receipt_under_review"],
    Math.min(Math.max(limit, 1), 100)
  );

  return NextResponse.json({ status: "ok", orders });
}
