import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api";

/** The console's query defaults (a function so tests get a fresh cache each time). */
export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        refetchOnWindowFocus: true,
        // 4xx answers (permissions, validation, signed out) do not get better by asking again.
        retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      },
    },
  });
}
