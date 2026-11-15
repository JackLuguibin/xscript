import { Button } from "./button";

/** Controlled pagination shared by bounded lists. Page numbers are one-based. */
export function Pagination({ page, pages, onPageChange, label, previousLabel, nextLabel, summary }: {
  page: number; pages: number; onPageChange: (page: number) => void;
  label: string; previousLabel: string; nextLabel: string; summary: string;
}) {
  return <nav className="ui-pagination" aria-label={label}>
    <span className="muted" aria-live="polite">{summary}</span>
    <Button size="sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>{previousLabel}</Button>
    <Button size="sm" disabled={page >= pages} onClick={() => onPageChange(page + 1)}>{nextLabel}</Button>
  </nav>;
}
