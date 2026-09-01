import type {
  EmployeeFinanceImportPreview,
  EmployeeFinanceImportPreviewResponse,
  EmployeeFinanceImportResponse,
  EmployeeFinanceImportResult,
} from '@hrm/shared'
import { apiFetch, unwrap } from './client'

/** Same shape as employeeImport.ts's own postWorkbook — the .xlsx goes up as
 *  the raw request body with its name in the query string. */
async function postWorkbook<T>(path: string, file: File, signal?: AbortSignal): Promise<T> {
  const res = await apiFetch(`${path}?fileName=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
    ...(signal && { signal }),
  })
  return unwrap<T>(res)
}

/** Parses and matches the file against the database without writing anything. */
export async function previewEmployeeFinanceImport(
  file: File,
  signal?: AbortSignal
): Promise<EmployeeFinanceImportPreview> {
  const body = await postWorkbook<EmployeeFinanceImportPreviewResponse>(
    '/api/employee-finance/import/preview',
    file,
    signal
  )
  return body.preview
}

/** Writes the same file's update rows. Re-sends the workbook rather than the
 *  preview's rows — the server re-derives everything from the file. */
export async function commitEmployeeFinanceImport(
  file: File,
  signal?: AbortSignal
): Promise<EmployeeFinanceImportResult> {
  const body = await postWorkbook<EmployeeFinanceImportResponse>(
    '/api/employee-finance/import',
    file,
    signal
  )
  return body.result
}
