import type {
  AttendanceImportBatch,
  AttendanceImportBatchListResponse,
  AttendanceImportOverride,
  AttendanceImportPreview,
  AttendanceImportPreviewResponse,
  AttendanceImportResponse,
  AttendanceImportResult,
} from '@hrm/shared'
import { apiFetch, unwrap } from './client'

/** The .xlsx and any manual punch corrections go up as a multipart body —
 *  `file` plus an `overrides` text field, matching the server's two import
 *  routes. overrides used to ride the query string instead, but a long
 *  enough correction list pushed the request past Node's ~16KB header
 *  ceiling (431 Request Header Fields Too Large); a body has no such cap.
 *
 *  No explicit Content-Type here — fetch sets multipart/form-data with the
 *  right boundary itself from a FormData body, and setting one manually
 *  would strip that boundary and break the parse server-side. */
async function postWorkbook<T>(
  path: string,
  file: File,
  overrides: AttendanceImportOverride[],
  signal?: AbortSignal
): Promise<T> {
  const formData = new FormData()
  formData.set('file', file, file.name)
  if (overrides.length > 0) formData.set('overrides', JSON.stringify(overrides))
  const res = await apiFetch(path, {
    method: 'POST',
    body: formData,
    ...(signal && { signal }),
  })
  return unwrap<T>(res)
}

/** Parses and matches the file without writing anything. `overrides` are
 *  HR's manual in/out or work-date corrections from a previous preview of
 *  this same file — re-applied on top of a fresh classification, same as on
 *  confirm, so what the screen shows always reflects both the file and the
 *  corrections together. */
export async function previewAttendanceImport(
  file: File,
  overrides: AttendanceImportOverride[] = [],
  signal?: AbortSignal
): Promise<AttendanceImportPreview> {
  const body = await postWorkbook<AttendanceImportPreviewResponse>(
    '/api/attendance/import/preview',
    file,
    overrides,
    signal
  )
  return body.preview
}

/** Writes the same file's punches. Re-sends the workbook rather than the
 *  preview's rows: the server re-derives everything from the file, and
 *  reapplies the same `overrides` HR confirmed in the preview. */
export async function commitAttendanceImport(
  file: File,
  overrides: AttendanceImportOverride[] = [],
  signal?: AbortSignal
): Promise<AttendanceImportResult> {
  const body = await postWorkbook<AttendanceImportResponse>(
    '/api/attendance/import',
    file,
    overrides,
    signal
  )
  return body.result
}

export async function listAttendanceImportBatches(
  signal?: AbortSignal
): Promise<AttendanceImportBatch[]> {
  const res = await apiFetch('/api/attendance/import/batches', { ...(signal && { signal }) })
  const body = await unwrap<AttendanceImportBatchListResponse>(res)
  return body.batches
}
