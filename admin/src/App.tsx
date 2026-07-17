import {
  createBrowserRouter,
  Navigate,
  RouterProvider,
  useParams,
} from 'react-router-dom'
import { AppLayout } from './components/AppLayout'
import { DashboardPage } from './pages/DashboardPage'
import { EmployeeListPage } from './pages/EmployeeListPage'
import { EmployeeFormPage } from './pages/EmployeeFormPage'
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
      { path: 'health', element: <HealthPage /> },
      { path: '*', element: <Navigate to="/dashboard" replace /> },
    ],
  },
])

export default function App() {
  return <RouterProvider router={router} />
}
