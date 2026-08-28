import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { OffSiteWorkRequest } from '@hrm/shared'
import {
  cancelOffSiteWorkRequest,
  fetchMyOffSiteWorkRequests,
  submitOffSiteWorkRequest,
} from '../api/offSiteRequests'
import { ApiRequestError } from '../api/client'
import { getCurrentCoordinates } from '../lib/geolocation'
import { RequestShell, type RequestListItem } from './RequestShell'
import { ConfirmModal } from './ConfirmModal'

type Props = {
  onBack: () => void
}

type ListState =
  | { phase: 'loading' }
  | { phase: 'ready'; requests: OffSiteWorkRequest[] }
  | { phase: 'error'; message: string }

function messageFor(err: unknown): string {
  if (err instanceof ApiRequestError) return err.message
  return 'เชื่อมต่อไม่สำเร็จ กรุณาลองใหม่อีกครั้ง'
}

/** Earliest date this request may use — today (local device time) + 1 day,
 *  the required minimum notice HR confirmed. Same local-timezone reasoning as
 *  the other request cards' today()/minRequestDate() helpers. */
function minRequestDate(): string {
  const now = new Date()
  now.setDate(now.getDate() + 1)
  const offsetMs = now.getTimezoneOffset() * 60_000
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, 10)
}

function formatDate(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString('th-TH', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

function formatDateRange(request: OffSiteWorkRequest): string {
  return request.startDate === request.endDate
    ? formatDate(request.startDate)
    : `${formatDate(request.startDate)} – ${formatDate(request.endDate)}`
}

/** Parses a coordinate text field to a finite number in range, or null for
 *  blank/invalid/out-of-range input — same bounds as the server's own
 *  parseCoordinate in routes/offSiteRequests.ts, checked again here only so
 *  canSubmit can gate on it before a round trip. */
function parseCoordinateInput(value: string, min: number, max: number): number | null {
  if (value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null
}

export function OffSiteRequestCard({ onBack }: Props) {
  const [listState, setListState] = useState<ListState>({ phase: 'loading' })
  const [mode, setMode] = useState<'list' | 'form'>('list')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cancelId, setCancelId] = useState<number | null>(null)

  const [placeName, setPlaceName] = useState('')
  // Free-text so the employee can type a coordinate for a place they are not
  // currently standing at (e.g. planning next week's off-site visit ahead of
  // time) — "ใช้ตำแหน่งปัจจุบัน" below is a convenience that fills these, not
  // the only way to set them.
  const [latitudeInput, setLatitudeInput] = useState('')
  const [longitudeInput, setLongitudeInput] = useState('')
  const [locatingState, setLocatingState] = useState<'idle' | 'locating' | 'error'>('idle')
  const [startDate, setStartDate] = useState(minRequestDate())
  const [endDate, setEndDate] = useState(minRequestDate())
  const [reason, setReason] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    fetchMyOffSiteWorkRequests(controller.signal)
      .then((requests) => setListState({ phase: 'ready', requests }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setListState({ phase: 'error', message: messageFor(err) })
      })
    return () => controller.abort()
  }, [])

  function openForm() {
    setPlaceName('')
    setLatitudeInput('')
    setLongitudeInput('')
    setLocatingState('idle')
    setStartDate(minRequestDate())
    setEndDate(minRequestDate())
    setReason('')
    setError(null)
    setMode('form')
  }

  function changeStartDate(value: string) {
    setStartDate(value)
    if (endDate < value) setEndDate(value)
  }

  async function captureCurrentLocation() {
    setLocatingState('locating')
    const result = await getCurrentCoordinates()
    if (result.ok) {
      setLatitudeInput(String(result.coordinates.latitude))
      setLongitudeInput(String(result.coordinates.longitude))
      setLocatingState('idle')
    } else {
      setLocatingState('error')
    }
  }

  const latitude = parseCoordinateInput(latitudeInput, -90, 90)
  const longitude = parseCoordinateInput(longitudeInput, -180, 180)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (latitude === null || longitude === null) return
    setBusy(true)
    setError(null)
    try {
      const request = await submitOffSiteWorkRequest({
        placeName,
        latitude,
        longitude,
        startDate,
        endDate,
        reason,
      })
      setListState((prev) => ({
        phase: 'ready',
        requests: [request, ...(prev.phase === 'ready' ? prev.requests : [])],
      }))
      setMode('list')
      toast('ส่งคำขอแล้ว รอผู้อนุมัติ')
    } catch (err) {
      setError(messageFor(err))
    } finally {
      setBusy(false)
    }
  }

  async function confirmCancel() {
    if (cancelId === null) return
    setBusy(true)
    try {
      const updated = await cancelOffSiteWorkRequest(cancelId)
      setListState((prev) => ({
        phase: 'ready',
        requests: prev.phase === 'ready' ? prev.requests.map((r) => (r.id === cancelId ? updated : r)) : [updated],
      }))
      toast('ยกเลิกคำขอแล้ว')
    } catch (err) {
      alert(messageFor(err))
    } finally {
      setBusy(false)
      setCancelId(null)
    }
  }

  const cancelTarget =
    listState.phase === 'ready' ? listState.requests.find((r) => r.id === cancelId) ?? null : null

  const items: RequestListItem[] =
    listState.phase === 'ready'
      ? listState.requests.map((request) => ({
          id: request.id,
          title: `${request.placeName} · ${formatDateRange(request)}`,
          meta: `ยื่น ${formatDate(request.createdAt.slice(0, 10))}`,
          status: request.status,
          reason: request.reason,
          decisionNote:
            request.status === 'rejected' ? `เหตุผลจากผู้อนุมัติ: ${request.decisionReason ?? ''}` : undefined,
          // Same locked-once-forwarded reasoning as LeaveRequestCard's onCancel.
          onCancel:
            request.status === 'pending' && request.supervisorApprovedByName === null
              ? () => setCancelId(request.id)
              : undefined,
        }))
      : []

  return (
    <>
      <RequestShell
        title="ทำงานนอกสถานที่"
        englishTag="OffSiteWorkScreen"
        ruleText="ต้องขอล่วงหน้าอย่างน้อย 1 วัน · ลงเวลานอกสถานที่ได้ก็ต่อเมื่อคำขอได้รับอนุมัติแล้วเท่านั้น หากยังไม่อนุมัติ ต้องลงเวลาที่พิกัดปกติตามเดิม"
        onBack={onBack}
        mode={mode}
        busy={busy}
        newLabel="ขอทำงานนอกสถานที่"
        onOpenForm={openForm}
        listPhase={listState.phase}
        listErrorMessage={listState.phase === 'error' ? listState.message : undefined}
        emptyText="ยังไม่มีคำขอทำงานนอกสถานที่"
        items={items}
        onSubmit={(e) => void submit(e)}
        onCloseForm={() => setMode('list')}
        formError={error}
        submitLabel="ส่งคำขอ"
        canSubmit={placeName.trim() !== '' && latitude !== null && longitude !== null && reason.trim() !== ''}
        reasonLabel="เหตุผล *"
        reason={reason}
        onReasonChange={setReason}
      >
        <label className="field">
          <span>ชื่อสถานที่</span>
          <input
            type="text"
            value={placeName}
            onChange={(e) => setPlaceName(e.target.value)}
            placeholder="เช่น บริษัท ABC สาขาลำพูน"
            required
            disabled={busy}
          />
        </label>

        <div className="field-row">
          <label className="field">
            <span>ละติจูด (Latitude)</span>
            <input
              type="number"
              inputMode="decimal"
              step="any"
              min={-90}
              max={90}
              value={latitudeInput}
              onChange={(e) => setLatitudeInput(e.target.value)}
              placeholder="เช่น 18.796143"
              required
              disabled={busy}
            />
          </label>
          <label className="field">
            <span>ลองจิจูด (Longitude)</span>
            <input
              type="number"
              inputMode="decimal"
              step="any"
              min={-180}
              max={180}
              value={longitudeInput}
              onChange={(e) => setLongitudeInput(e.target.value)}
              placeholder="เช่น 98.979263"
              required
              disabled={busy}
            />
          </label>
        </div>

        <div className="field">
          <button
            type="button"
            className="secondary-button"
            disabled={busy || locatingState === 'locating'}
            onClick={() => void captureCurrentLocation()}
          >
            {locatingState === 'locating' ? 'กำลังค้นหาตำแหน่ง…' : 'ใช้ตำแหน่งปัจจุบันแทนการพิมพ์'}
          </button>
          {locatingState === 'error' && (
            <p className="form-error">ค้นหาตำแหน่งไม่สำเร็จ กรุณาเปิดสิทธิ์ตำแหน่งที่ตั้งแล้วลองใหม่</p>
          )}
          {latitude !== null && longitude !== null && (
            <a
              className="attachment-link"
              href={`https://www.google.com/maps?q=${latitude},${longitude}`}
              target="_blank"
              rel="noreferrer"
            >
              ตรวจสอบตำแหน่งบนแผนที่
            </a>
          )}
        </div>

        <div className="field-row">
          <label className="field">
            <span>วันที่เริ่ม</span>
            <input
              type="date"
              value={startDate}
              min={minRequestDate()}
              onChange={(e) => changeStartDate(e.target.value)}
              required
              disabled={busy}
            />
          </label>
          <label className="field">
            <span>วันที่สิ้นสุด</span>
            <input
              type="date"
              value={endDate}
              min={startDate}
              onChange={(e) => setEndDate(e.target.value)}
              required
              disabled={busy}
            />
          </label>
        </div>
      </RequestShell>

      {cancelTarget && (
        <ConfirmModal
          title="ยกเลิกคำขอทำงานนอกสถานที่นี้?"
          message={`${cancelTarget.placeName} · ${formatDateRange(cancelTarget)} — ยกเลิกแล้วจะกู้คืนไม่ได้ ต้องยื่นใหม่`}
          confirmLabel="ยกเลิกคำขอ"
          busy={busy}
          onConfirm={() => void confirmCancel()}
          onCancel={() => setCancelId(null)}
        />
      )}
    </>
  )
}
