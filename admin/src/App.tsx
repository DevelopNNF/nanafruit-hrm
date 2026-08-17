import {
  createBrowserRouter,
  Navigate,
  RouterProvider,
  useParams,
} from 'react-router-dom'
import { AppLayout } from './components/AppLayout'
import { DashboardPage } from './pages/DashboardPage'
import { EmployeeListPage } from './pages/employee/EmployeeListPage'
import { EmployeeFormPage } from './pages/employee/EmployeeFormPage'
import { JobListPage } from './pages/masters/job_title/JobListPage'
import { JobFormPage } from './pages/masters/job_title/JobFormPage'
import { DepartmentListPage } from './pages/masters/department/DepartmentListPage'
import { DepartmentFormPage } from './pages/masters/department/DepartmentFormPage'
import { ShiftListPage } from './pages/masters/shift/ShiftListPage'
import { ShiftFormPage } from './pages/masters/shift/ShiftFormPage'
import { LocationListPage } from './pages/masters/location/LocationListPage'
import { LocationFormPage } from './pages/masters/location/LocationFormPage'
import { LeaveTypeListPage } from './pages/masters/leave_type/LeaveTypeListPage'
import { LeaveTypeFormPage } from './pages/masters/leave_type/LeaveTypeFormPage'
import { HolidayGroupListPage } from './pages/masters/holiday_group/HolidayGroupListPage'
import { HolidayGroupFormPage } from './pages/masters/holiday_group/HolidayGroupFormPage'
import { OvertimeGroupListPage } from './pages/masters/overtime_group/OvertimeGroupListPage'
import { OvertimeGroupFormPage } from './pages/masters/overtime_group/OvertimeGroupFormPage'
import { LeaveBalanceBulkGrantPage } from './pages/LeaveBalanceBulkGrantPage'
import { AttendanceListPage } from './pages/AttendanceListPage'
import { AttendanceDailyListPage } from './pages/attendance_daily/AttendanceDailyListPage'
import { TimeCorrectionListPage } from './pages/time_correction/TimeCorrectionListPage'
import { TimeCorrectionDetailPage } from './pages/time_correction/TimeCorrectionDetailPage'
import { LeaveRequestListPage } from './pages/leave_requests/LeaveRequestListPage'
import { LeaveRequestDetailPage } from './pages/leave_requests/LeaveRequestDetailPage'
import { ShiftChangeRequestListPage } from './pages/shift_change_requests/ShiftChangeRequestListPage'
import { ShiftChangeRequestDetailPage } from './pages/shift_change_requests/ShiftChangeRequestDetailPage'
import { DayOffSwapRequestListPage } from './pages/day_off_swap_requests/DayOffSwapRequestListPage'
import { DayOffSwapRequestDetailPage } from './pages/day_off_swap_requests/DayOffSwapRequestDetailPage'
import { HealthPage } from './pages/HealthPage'

/**
 * The same element type backs both form routes, so React would otherwise keep
 * one instance alive across them and carry the previous employee's draft over.
 * Keying on the id forces a fresh mount per employee, and for "new".
 */
function KeyedEmployeeForm() {
  const { id } = useParams()
  return <EmployeeFormPage key={id ?? 'new'} />
}

function KeyedJobForm() {
  const { id } = useParams()
  return <JobFormPage key={id ?? 'new'} />
}

function KeyedDepartmentForm() {
  const { id } = useParams()
  return <DepartmentFormPage key={id ?? 'new'} />
}

function KeyedShiftForm() {
  const { id } = useParams()
  return <ShiftFormPage key={id ?? 'new'} />
}

function KeyedLocationForm() {
  const { id } = useParams()
  return <LocationFormPage key={id ?? 'new'} />
}

function KeyedLeaveTypeForm() {
  const { id } = useParams()
  return <LeaveTypeFormPage key={id ?? 'new'} />
}

function KeyedHolidayGroupForm() {
  const { id } = useParams()
  return <HolidayGroupFormPage key={id ?? 'new'} />
}

function KeyedOvertimeGroupForm() {
  const { id } = useParams()
  return <OvertimeGroupFormPage key={id ?? 'new'} />
}

// /employees/new is matched before /employees/:id so "new" is never read as an id.
const router = createBrowserRouter([
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: 'dashboard', element: <DashboardPage /> },
      { path: 'employees', element: <EmployeeListPage /> },
      { path: 'employees/new', element: <KeyedEmployeeForm /> },
      { path: 'employees/:id', element: <KeyedEmployeeForm /> },
      { path: 'attendance', element: <AttendanceListPage /> },
      { path: 'attendance/daily', element: <AttendanceDailyListPage /> },
      { path: 'time-corrections', element: <TimeCorrectionListPage /> },
      { path: 'time-corrections/:id', element: <TimeCorrectionDetailPage /> },
      { path: 'leave-requests', element: <LeaveRequestListPage /> },
      { path: 'leave-requests/:id', element: <LeaveRequestDetailPage /> },
      { path: 'shift-change-requests', element: <ShiftChangeRequestListPage /> },
      { path: 'shift-change-requests/:id', element: <ShiftChangeRequestDetailPage /> },
      { path: 'day-off-swap-requests', element: <DayOffSwapRequestListPage /> },
      { path: 'day-off-swap-requests/:id', element: <DayOffSwapRequestDetailPage /> },
      { path: 'leave-balances/bulk-grant', element: <LeaveBalanceBulkGrantPage /> },
      { path: 'master/jobs', element: <JobListPage /> },
      { path: 'master/jobs/new', element: <KeyedJobForm /> },
      { path: 'master/jobs/:id', element: <KeyedJobForm /> },
      { path: 'master/departments', element: <DepartmentListPage /> },
      { path: 'master/departments/new', element: <KeyedDepartmentForm /> },
      { path: 'master/departments/:id', element: <KeyedDepartmentForm /> },
      { path: 'master/shifts', element: <ShiftListPage /> },
      { path: 'master/shifts/new', element: <KeyedShiftForm /> },
      { path: 'master/shifts/:id', element: <KeyedShiftForm /> },
      { path: 'master/locations', element: <LocationListPage /> },
      { path: 'master/locations/new', element: <KeyedLocationForm /> },
      { path: 'master/locations/:id', element: <KeyedLocationForm /> },
      { path: 'master/leave-types', element: <LeaveTypeListPage /> },
      { path: 'master/leave-types/new', element: <KeyedLeaveTypeForm /> },
      { path: 'master/leave-types/:id', element: <KeyedLeaveTypeForm /> },
      { path: 'master/holidays', element: <HolidayGroupListPage /> },
      { path: 'master/holidays/new', element: <KeyedHolidayGroupForm /> },
      { path: 'master/holidays/:id', element: <KeyedHolidayGroupForm /> },
      { path: 'master/overtime-groups', element: <OvertimeGroupListPage /> },
      { path: 'master/overtime-groups/new', element: <KeyedOvertimeGroupForm /> },
      { path: 'master/overtime-groups/:id', element: <KeyedOvertimeGroupForm /> },
      { path: 'health', element: <HealthPage /> },
      { path: '*', element: <Navigate to="/dashboard" replace /> },
    ],
  },
])

export default function App() {
  return <RouterProvider router={router} />
}
