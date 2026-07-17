import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { Employee } from '@hrm/shared'
import { listEmployees } from '../api/employees'
import { useCanWrite } from '../auth/meContext'

type State =
  | { phase: 'loading' }
  | { phase: 'ok'; employees: Employee[] }
  | { phase: 'error'; message: string }

export function EmployeeListPage() {
  const [state, setState] = useState<State>({ phase: 'loading' })
  const navigate = useNavigate()
  const canWrite = useCanWrite()

  useEffect(() => {
    const controller = new AbortController()

    listEmployees(controller.signal)
      .then((employees) => setState({ phase: 'ok', employees }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'request failed',
        })
      })

    return () => controller.abort()
  }, [])

  return (
    <>
      <header className="page-head">
        <div>
          <h1>พนักงาน</h1>
          <p className="subtitle">Employee Master</p>
        </div>
        {canWrite && (
          <Link className="button primary" to="/employees/new">
            + เพิ่มพนักงาน
          </Link>
        )}
      </header>

      {state.phase === 'loading' && <p className="muted">กำลังโหลด…</p>}

      {state.phase === 'error' && (
        <div className="card error">
          <p className="headline">โหลดข้อมูลไม่สำเร็จ</p>
          <p className="detail">{state.message}</p>
        </div>
      )}

      {state.phase === 'ok' && state.employees.length === 0 && (
        <div className="card empty">
          <p className="headline">ยังไม่มีพนักงานในระบบ</p>
          <p className="muted">
            {canWrite ? 'กด “เพิ่มพนักงาน” เพื่อเริ่มต้น' : 'สิทธิ์ของคุณดูข้อมูลได้อย่างเดียว'}
          </p>
        </div>
      )}

      {state.phase === 'ok' && state.employees.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>รหัส</th>
              <th>ชื่อ-นามสกุล</th>
              <th>ชื่อเล่น</th>
              <th>ตำแหน่ง</th>
              <th>ประเภท</th>
              <th>สถานะ</th>
            </tr>
          </thead>
          <tbody>
            {state.employees.map((employee) => (
              <tr
                key={employee.id}
                onClick={() => void navigate(`/employees/${employee.id}`)}
              >
                <td className="mono">{employee.employeeCode}</td>
                <td>
                  {employee.title}
                  {employee.firstNameTh} {employee.lastNameTh}
                  <span className="sub-line">
                    {employee.firstNameEn} {employee.lastNameEn}
                  </span>
                </td>
                <td>{employee.nickname ?? '—'}</td>
                <td>{employee.employment.jobTitle}</td>
                <td>{employee.employment.employmentType}</td>
                <td>
                  <span className={`badge ${employee.employment.status.toLowerCase()}`}>
                    {employee.employment.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}
