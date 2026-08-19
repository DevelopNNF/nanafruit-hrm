import type {
  AttendanceImportBatch,
  AttendanceImportBatchListResponse,
  AttendanceImportPreview,
  AttendanceImportPreviewResponse,
  AttendanceImportResponse,
  AttendanceImportResult,
} from '@hrm/shared'
import { apiFetch, unwrap } from './client'

/** The .xlsx goes up as the raw request body with its name in the query
 *  string, matching the server's two import routes — see their comment for why
 *  this is not multipart. */
async function postWorkbook<T>(path: string, file: File, signal?: AbortSignal): Promise<T> {
  const res = await apiFetch(`${path}?fileName=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
    ...(signal && { signal }),
  })
  return unwrap<T>(res)
}

/** Parses and matches the file without writing anything. */
export async function previewAttendanceImport(
  file: File,
  signal?: AbortSignal
): Promise<AttendanceImportPreview> {
  const body = await postWorkbook<AttendanceImportPreviewResponse>(
    '/api/attendance/import/preview',
    file,
    signal
  )
  return body.preview
}

/** Writes the same file's punches. Re-sends the workbook rather than the
 *  preview's rows: the server re-derives everything from the file. */
export async function commitAttendanceImport(
  file: File,
  signal?: AbortSignal
): Promise<AttendanceImportResult> {
  const body = await postWorkbook<AttendanceImportResponse>('/api/attendance/import', file, signal)
  return body.result
}

export async function listAttendanceImportBatches(
  signal?: AbortSignal
): Promise<AttendanceImportBatch[]> {
  const res = await apiFetch('/api/attendance/import/batches', { ...(signal && { signal }) })
  const body = await unwrap<AttendanceImportBatchListResponse>(res)
  return body.batches
}
