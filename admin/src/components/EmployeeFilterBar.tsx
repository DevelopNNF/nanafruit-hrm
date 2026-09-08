import { EMPLOYEE_STATUSES, WORK_LOCATIONS } from '@hrm/shared'
import { type EmployeeFilterBarProps } from '../hooks/useEmployeeFilters'
import { TreeSelect } from './TreeSelect'
import { button, fieldControl } from '../styles'

/** The label/control row style every field in this grid uses — exported so
 *  a page's own `extraFields` (a report's date range, its own status
 *  filter, …) can match it instead of guessing at the same classes. */
export const filterFieldRow = 'flex min-w-0 items-center gap-2 text-xs font-medium text-slate-600'
export const filterFieldLabel = 'w-28 shrink-0 text-right'

/** The "which employees" filter grid shared by every page that lists or
 *  scopes work by employee (employee registry, requests, attendance/OT
 *  reports) — paired with useEmployeeFilters, which owns the state this
 *  renders. */
export function EmployeeFilterBar({
  values,
  onChange,
  options,
  canWritePayroll,
  fetching,
  onSubmit,
  extraFields,
}: EmployeeFilterBarProps) {
  return (
    <>
      <div className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2.5 sm:grid-cols-2">
        {extraFields}
        <label className="flex min-w-0 items-center gap-2 text-xs font-medium text-slate-600">
          <span className="w-28 shrink-0 text-right">แผนก :</span>
          <TreeSelect
            mode="multiple"
            options={options.departmentTreeOptions}
            value={values.departmentFilter}
            onChange={onChange.department}
            placeholder="ทั้งหมด"
            className="w-full"
          />
        </label>
        <label className="flex min-w-0 items-center gap-2 text-xs font-medium text-slate-600">
          <span className="w-28 shrink-0 text-right">ตำแหน่งงาน :</span>
          <TreeSelect
            mode="multiple"
            options={options.jobOptions}
            value={values.jobFilter}
            onChange={onChange.job}
            placeholder="ทั้งหมด"
            className="w-full"
          />
        </label>
        <label className="flex min-w-0 items-center gap-2 text-xs font-medium text-slate-600">
          <span className="w-28 shrink-0 text-right">ประเภทการจ้าง :</span>
          <TreeSelect
            mode="multiple"
            options={options.employmentTypeOptions}
            value={values.employmentTypeFilter}
            onChange={onChange.employmentType}
            placeholder="ทั้งหมด"
            className="w-full"
          />
        </label>
        {canWritePayroll && (
          <label className="flex min-w-0 items-center gap-2 text-xs font-medium text-slate-600">
            <span className="w-28 shrink-0 text-right">กลุ่มเงินเดือน :</span>
            <select
              className={`${fieldControl} w-full`}
              value={typeof values.groupFilter === 'number' ? String(values.groupFilter) : values.groupFilter}
              onChange={(e) => {
                const value = e.target.value
                onChange.group(value === 'all' || value === 'none' ? value : Number(value))
              }}
            >
              <option value="all">— ทั้งหมด —</option>
              <option value="none">ยังไม่อยู่กลุ่มใด</option>
              {options.payrollGroups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.groupName}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex min-w-0 items-center gap-2 text-xs font-medium text-slate-600">
          <span className="w-28 shrink-0 text-right">สถานที่ปฏิบัติงาน :</span>
          <select
            className={`${fieldControl} w-full`}
            value={values.workLocationFilter}
            onChange={(e) => onChange.workLocation(e.target.value as (typeof values)['workLocationFilter'])}
          >
            <option value="all">ทั้งหมด</option>
            {WORK_LOCATIONS.map((location) => (
              <option key={location} value={location}>
                {location}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 items-center gap-2 text-xs font-medium text-slate-600">
          <span className="w-28 shrink-0 text-right">สถานะการทำงาน :</span>
          <select
            className={`${fieldControl} w-full`}
            value={values.statusFilter}
            onChange={(e) => onChange.status(e.target.value as (typeof values)['statusFilter'])}
          >
            <option value="all">ทั้งหมด</option>
            {EMPLOYEE_STATUSES.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 items-center gap-2 text-xs font-medium text-slate-600">
          <span className="w-28 shrink-0 text-right">ค้นหา :</span>
          <input
            type="search"
            value={values.query}
            onChange={(e) => onChange.query(e.target.value)}
            placeholder="ค้นหา รหัส ชื่อ ชื่อเล่น หรือตำแหน่ง"
            aria-label="ค้นหาพนักงาน"
            className="w-full rounded-md border border-slate-200 bg-white p-2 text-[0.825rem] text-slate-900 placeholder:text-slate-500"
          />
        </label>
      </div>
      <div className="mt-3 flex w-full justify-center">
        <button type="submit" className={button('default')} disabled={fetching} onClick={onSubmit}>
          ค้นหา
        </button>
      </div>
    </>
  )
}
