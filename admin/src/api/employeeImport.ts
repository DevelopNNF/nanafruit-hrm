import type {
  EmployeeImportPreview,
  EmployeeImportPreviewResponse,
  EmployeeImportResponse,
  EmployeeImportResult,
} from '@hrm/shared'
import { apiFetch, unwrap } from './client'

/** The .xlsx goes up as the raw request body with its name in the query
 *  string — same shape as attendanceImport.ts's postWorkbook, and for the
 *  same reason: nothing else in this API takes a file inline. */
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
export async function previewEmployeeImport(
  file: File,
  signal?: AbortSignal
): Promise<EmployeeImportPreview> {
  const body = await postWorkbook<EmployeeImportPreviewResponse>(
    '/api/employees/import/preview',
    file,
    signal
  )
  return body.preview
}

/** Writes the same file's create/update rows. Re-sends the workbook rather
 *  than the preview's rows — the server re-derives everything from the file. */
export async function commitEmployeeImport(
  file: File,
  signal?: AbortSignal
): Promise<EmployeeImportResult> {
  const body = await postWorkbook<EmployeeImportResponse>('/api/employees/import', file, signal)
  return body.result
}
