import { NextResponse } from "next/server"
import { db } from "@/lib/db"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    // Verify database connectivity
    await db.$queryRaw`SELECT 1`
    return NextResponse.json(
      {
        status: "healthy",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        database: "connected",
      },
      { status: 200 }
    )
  } catch (error: any) {
    return NextResponse.json(
      {
        status: "unhealthy",
        database: "disconnected",
        error: error?.message ?? "Database connection failed",
      },
      { status: 503 }
    )
  }
}
