import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ActivationCodesRepository } from "@/repositories/activation-codes.repository";

type QueryResponse = {
  data?: unknown;
  count?: number | null;
  error?: unknown;
};

class FakeQuery {
  readonly filters: Array<{ method: "eq" | "is"; column: string; value: unknown }> = [];

  constructor(
    readonly table: string,
    private readonly response: QueryResponse
  ) {}

  select() {
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push({ method: "eq", column, value });
    return this;
  }

  is(column: string, value: unknown) {
    this.filters.push({ method: "is", column, value });
    return this;
  }

  order() {
    return this;
  }

  limit() {
    return this;
  }

  maybeSingle() {
    return Promise.resolve({ data: this.response.data ?? null, error: this.response.error ?? null });
  }

  then<TResult1 = QueryResponse, TResult2 = never>(
    onfulfilled?: ((value: QueryResponse) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ) {
    return Promise.resolve({
      count: this.response.count ?? null,
      error: this.response.error ?? null
    }).then(onfulfilled, onrejected);
  }
}

class FakeSupabase {
  readonly calls: FakeQuery[] = [];

  constructor(private readonly responses: QueryResponse[]) {}

  from(table: string) {
    const query = new FakeQuery(table, this.responses.shift() || {});
    this.calls.push(query);
    return query;
  }
}

describe("ActivationCodesRepository", () => {
  it("falls back to a universal product code when no plan-specific code is available", async () => {
    const supabase = new FakeSupabase([
      { data: null },
      { data: { id: "universal-code", plan_id: null, code: "1279320638952037" } }
    ]);
    const repository = new ActivationCodesRepository(supabase as never);

    const code = await repository.findAvailableCode("product-id", "monthly-plan-id");

    expect(code).toEqual({ id: "universal-code", plan_id: null, code: "1279320638952037" });
    expect(supabase.calls).toHaveLength(2);
    expect(supabase.calls[0].filters).toContainEqual({ method: "eq", column: "plan_id", value: "monthly-plan-id" });
    expect(supabase.calls[1].filters).toContainEqual({ method: "is", column: "plan_id", value: null });
  });

  it("uses the plan-specific code before falling back to universal stock", async () => {
    const supabase = new FakeSupabase([
      { data: { id: "specific-code", plan_id: "monthly-plan-id", code: "2420180485666071" } }
    ]);
    const repository = new ActivationCodesRepository(supabase as never);

    const code = await repository.findAvailableCode("product-id", "monthly-plan-id");

    expect(code).toEqual({ id: "specific-code", plan_id: "monthly-plan-id", code: "2420180485666071" });
    expect(supabase.calls).toHaveLength(1);
  });

  it("counts both plan-specific and universal available codes for a paid plan", async () => {
    const supabase = new FakeSupabase([{ count: 2 }, { count: 4 }]);
    const repository = new ActivationCodesRepository(supabase as never);

    const count = await repository.countAvailableCodes("product-id", "monthly-plan-id");

    expect(count).toBe(6);
    expect(supabase.calls[0].filters).toContainEqual({ method: "eq", column: "plan_id", value: "monthly-plan-id" });
    expect(supabase.calls[1].filters).toContainEqual({ method: "is", column: "plan_id", value: null });
  });
});
