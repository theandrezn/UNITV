import { NextResponse } from "next/server";
import { createOpenAIClient, getDefaultOpenAIModel } from "@/lib/openai/client";

export const dynamic = "force-dynamic";

export function GET() {
  try {
    createOpenAIClient();

    return NextResponse.json({
      status: "ok",
      ai: "configured",
      model: getDefaultOpenAIModel()
    });
  } catch (error) {
    return NextResponse.json(
      {
        status: "error",
        ai: "unavailable",
        message: error instanceof Error ? error.message : "Unknown AI configuration error"
      },
      { status: 500 }
    );
  }
}
