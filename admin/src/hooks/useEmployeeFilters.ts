import { useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  EMPLOYMENT_TYPES,
  type Department,
  type EmployeeStatus,
  type Job,
  type PayrollGroup,
  type WorkLocation,
} from '@hrm/shared'
import { type EmployeeSearchFilter } from '../api/employees'
import { listDepartments } from '../api/departments'
import { listJobs } from '../api/jobs'
import { listPayrollGroups } from '../api/payrollGroups'
import { type TreeSelectOption } from '../components/TreeSelect'

/** The payroll-group filter's own value space: a group id, everybody, or the
 *  people no group covers — which during the parallel run with the previous
 *  HRM is the set HR is working through, and the reason this filter exists. */
export type GroupFilter = 'all' | 'none' | number

export type EmployeeFilterValues = {
  query: string
  departmentFilter: number[]
  jobFilter: number[]
  /** Indices into EMPLOYMENT_TYPES — TreeSelect needs numeric ids, and the
   *  enum itself has none, so the option list is built from the array's
   *  indices. */
  employmentTypeFilter: number[]
  groupFilter: GroupFilter
  workLocationFilter: 'all' | WorkLocation
  statusFilter: 'all' | EmployeeStatus
}

/** Everything an <EmployeeFilterBar /> needs to render the filter grid and
 *  drive the fields it owns — see that component for the markup. */
export type EmployeeFilterBarProps = {
  values: EmployeeFilterValues
  onChange: {
    query: (value: string) => void
    department: (value: number[]) => void
    job: (value: number[]) => void
    employmentType: (value: number[]) => void
    group: (value: GroupFilter) => void
    workLocation: (value: 'all' | WorkLocation) => void
    status: (value: 'all' | EmployeeStatus) => void
  }
  options: {
    departmentTreeOptions: TreeSelectOption[]
    jobOptions: TreeSelectOption[]
    employmentTypeOptions: TreeSelectOption[]
    payrollGroups: PayrollGroup[]
  }
  canWritePayroll: boolean
  fetching: boolean
  onSubmit: (e: FormEvent) => void
}

/** Owns every "which employees" filter field (department / job / employment
 *  type / payroll group / work location / status / free-text search) so a
 *  page only has to say what happens when a filter is applied — the pagey
 *  concerns (page/pageSize/fetching) stay with the caller since those differ
 *  per list (employees vs. requests vs. attendance rows). */
export function useEmployeeFilters(opts: {
  /** Status a freshly-loaded page should start filtered to. Employee list
   *  defaults to 'Active' — HR's day-to-day view is the people still
   *  working; other consumers may want 'all' since their records can belong
   *  to employees who've since left. */
  defaultStatus?: 'all' | EmployeeStatus
  canWritePayroll?: boolean
  /** Called after every filter is applied — including search submit — so
   *  the caller can reset its own page number and fetching flag. Not called
   *  while the search box is merely being typed into. */
  onApply?: () => void
} = {}) {
  const defaultStatus = opts.defaultStatus ?? 'Active'
  const onApply = opts.onApply

  // `query` tracks the search box as the user types. `appliedSearch` is what
  // was last submitted — a fresh object every submit (its `nonce` guarantees
  // that even when resubmitted with the same, possibly empty, text) — so
  // typing alone never re-triggers a request until ค้นหา is pressed (or
  // Enter), and useMemo below has exactly one dependency to key off of.
  const [query, setQuery] = useState('')
  const [appliedSearch, setAppliedSearch] = useState({ value: '', nonce: 0 })
  const [payrollGroups, setPayrollGroups] = useState<PayrollGroup[]>([])
  const [groupFilter, setGroupFilter] = useState<GroupFilter>('all')
  const [departments, setDepartments] = useState<Department[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  // Empty array means "everything" for all three multi-selects below — same
  // convention DepartmentListPage's own TreeSelect filter uses — rather than
  // pre-checking every option, so the trigger can show a neutral placeholder
  // until the user actually narrows something down.
  const [departmentFilter, setDepartmentFilter] = useState<number[]>([])
  const [jobFilter, setJobFilter] = useState<number[]>([])
  const [employmentTypeFilter, setEmploymentTypeFilter] = useState<number[]>([])
  const [workLocationFilter, setWorkLocationFilter] = useState<'all' | WorkLocation>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | EmployeeStatus>(defaultStatus)

  useEffect(() => {
    const controller = new AbortController()
    listPayrollGroups(controller.signal)
      .then(setPayrollGroups)
      .catch(() => {
        // Only used to label a filter — not worth failing the whole page over.
      })
    listDepartments(controller.signal)
      .then(setDepartments)
      .catch(() => {
        // Only used to label a filter — not worth failing the whole page over.
      })
    listJobs(controller.signal)
      .then(setJobs)
      .catch(() => {
        // Only used to label a filter — not worth failing the whole page over.
      })
    return () => controller.abort()
  }, [])

  const departmentTreeOptions: TreeSelectOption[] = useMemo(
    () => departments.map((d) => ({ id: d.id, label: d.deptName, parentId: d.parentDepartmentId })),
    [departments]
  )
  const jobOptions: TreeSelectOption[] = useMemo(
    () => jobs.map((j) => ({ id: j.id, label: j.jobTitle, parentId: null })),
    [jobs]
  )
  const employmentTypeOptions: TreeSelectOption[] = useMemo(
    () => EMPLOYMENT_TYPES.map((type, index) => ({ id: index, label: type, parentId: null })),
    []
  )

  function handleQueryChange(value: string) {
    setQuery(value)
  }

  function handleSearchSubmit(e: FormEvent) {
    e.preventDefault()
    setAppliedSearch((prev) => ({ value: query, nonce: prev.nonce + 1 }))
    onApply?.()
  }

  function handleDepartmentFilterChange(value: number[]) {
    setDepartmentFilter(value)
    onApply?.()
  }

  function handleJobFilterChange(value: number[]) {
    setJobFilter(value)
    onApply?.()
  }

  function handleEmploymentTypeFilterChange(value: number[]) {
    setEmploymentTypeFilter(value)
    onApply?.()
  }

  function handleGroupFilterChange(value: GroupFilter) {
    setGroupFilter(value)
    onApply?.()
  }

  function handleWorkLocationFilterChange(value: 'all' | WorkLocation) {
    setWorkLocationFilter(value)
    onApply?.()
  }

  function handleStatusFilterChange(value: 'all' | EmployeeStatus) {
    setStatusFilter(value)
    onApply?.()
  }

  const filtering =
    appliedSearch.value.trim() !== '' ||
    groupFilter !== 'all' ||
    departmentFilter.length > 0 ||
    jobFilter.length > 0 ||
    employmentTypeFilter.length > 0 ||
    workLocationFilter !== 'all' ||
    statusFilter !== defaultStatus

  const filter: EmployeeSearchFilter = useMemo(
    () => ({
      ...(appliedSearch.value.trim() !== '' && { query: appliedSearch.value.trim() }),
      ...(groupFilter !== 'all' && { payrollGroupId: groupFilter }),
      ...(departmentFilter.length > 0 && { departmentIds: departmentFilter }),
      ...(jobFilter.length > 0 && { jobIds: jobFilter }),
      ...(employmentTypeFilter.length > 0 && {
        employmentTypes: employmentTypeFilter.map((index) => EMPLOYMENT_TYPES[index]!),
      }),
      ...(workLocationFilter !== 'all' && { workLocation: workLocationFilter }),
      ...(statusFilter !== 'all' && { status: statusFilter }),
    }),
    [appliedSearch, groupFilter, departmentFilter, jobFilter, employmentTypeFilter, workLocationFilter, statusFilter]
  )

  const barProps: EmployeeFilterBarProps = {
    values: { query, departmentFilter, jobFilter, employmentTypeFilter, groupFilter, workLocationFilter, statusFilter },
    onChange: {
      query: handleQueryChange,
      department: handleDepartmentFilterChange,
      job: handleJobFilterChange,
      employmentType: handleEmploymentTypeFilterChange,
      group: handleGroupFilterChange,
      workLocation: handleWorkLocationFilterChange,
      status: handleStatusFilterChange,
    },
    options: { departmentTreeOptions, jobOptions, employmentTypeOptions, payrollGroups },
    canWritePayroll: opts.canWritePayroll ?? false,
    fetching: false,
    onSubmit: handleSearchSubmit,
  }

  return { filter, filtering, barProps }
}
